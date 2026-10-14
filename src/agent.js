// The collections agent. A deterministic tool pipeline that an LLM steers, where every
// step and every PayPal call is published to the trace:
//
//   1. read the brief (LLM extraction, validated against the text, rule-based fallback)
//   2. build the PayPal invoice (amounts, currency, payment term, due date)
//   3. create_invoice + send_invoice on PayPal
//   4. plan follow-ups (polite -> firm -> final, tuned to amount and client history)
//      and draft each reminder
//   5. on every tick: get_invoice for each open invoice; paid -> stop the reminders;
//      due reminders -> send_invoice_reminder
//   6. answer questions over the ledger
import { randomUUID } from 'node:crypto';
import { addDays, toISODate, formatDate } from './dates.js';
import { formatMoney, toPayPalValue } from './money.js';
import { extractDeterministic, validateExtraction, missingFields, EXTRACT_SYSTEM, extractPrompt, findMoney, EMAIL_RE } from './extract.js';
import { buildInvoicePayload, makeInvoiceNumber } from './invoice-payload.js';
import { planReminders, rescheduleError } from './schedule.js';
import { draftContext, templateDraft, DRAFT_SYSTEM, draftPrompt, acceptDraft } from './drafts.js';
import { deterministicAnswer, ledgerFacts, ANSWER_SYSTEM, answerPrompt, acceptAnswer } from './answer.js';
import { clientKey, clientHistory, invoiceView, totals, CLOSED, PAID } from './ledger.js';
import { timelineData } from './timeline.js';
import { DEMO_CLIENTS } from './demo.js';

export class AgentError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const METHOD_WORDS = [
  [/\b(bank|ach|transfer|direct deposit)\b/i, 'BANK_TRANSFER'],
  [/\bwire\b/i, 'WIRE_TRANSFER'],
  [/\b(check|cheque)\b/i, 'CHECK'],
  [/\bcash\b/i, 'CASH'],
  [/\b(card|credit)\b/i, 'CREDIT_CARD'],
  [/\b(venmo|zelle|other)\b/i, 'OTHER'],
];

export function createAgent({ config, paypal, llm, store, bus, now = () => Date.now(), mock = null }) {
  const today = () => toISODate(now());
  const previews = new Map(); // previewId -> { extraction, text, at }
  let ticking = false;

  // ---------- trace helpers ----------
  function newRun(title, kind = 'run') {
    const runId = randomUUID().slice(0, 8);
    bus.trace({ runId, kind, title });
    return runId;
  }
  function step(runId, name) {
    const t0 = Date.now();
    bus.trace({ runId, kind: 'step', name, status: 'start' });
    const end = (status, detail, data) => bus.trace({ runId, kind: 'step', name, status, detail, ms: Date.now() - t0, ...(data ? { data } : {}) });
    return { ok: (d, data) => end('ok', d, data), warn: (d, data) => end('warn', d, data), fail: (d) => end('error', d) };
  }
  const traceFn = (entry) => bus.trace(entry);

  // ---------- ledger helpers ----------
  const doc = () => store.doc;
  const findInvoice = (id) => doc().invoices.find((i) => i.id === id || i.paypalId === id || i.number === id);
  const history = (inv, text) => (inv.history ||= []).push({ at: new Date(now()).toISOString(), text });
  const changed = (reason) => {
    store.save();
    bus.ledgerChanged(reason);
  };

  // ---------- 1. read the brief ----------
  async function readBrief(text, runId) {
    const s = step(runId, 'Read the brief');
    const ctx = { today: today(), defaultCurrency: config.currency, invoicerEmail: config.invoicer.email, invoicerName: config.invoicer.name, invoicerBusiness: config.invoicer.businessName };
    const fallback = extractDeterministic(text, ctx);
    const r = await llm.json({
      runId,
      task: 'extract_invoice',
      system: EXTRACT_SYSTEM,
      user: extractPrompt(text, ctx.today, ctx),
      mock: () => ({
        client: fallback.client,
        items: fallback.items.map((i) => ({ name: i.name, description: i.description, quantity: i.quantity, unit_amount: i.unitAmount, unit: i.unit })),
        currency: fallback.currency,
        terms: { type: fallback.terms.type, days: fallback.terms.days, due_date: fallback.terms.dueDate },
        reference: fallback.reference,
        note: null,
      }),
    });
    let extraction;
    let problems = [];
    if (r.ok) ({ extraction, problems } = validateExtraction(r.data, { text, ...ctx, fallback }));
    else {
      extraction = { ...fallback, sources: { client: 'fallback', email: 'fallback', items: 'fallback', currency: 'fallback', terms: 'fallback' } };
      problems = [`model unavailable (${r.error}); used the rule-based reader`];
    }
    const missing = missingFields(extraction);
    const summary = `${extraction.client.name || '?'} <${extraction.client.email || 'no email'}>, ${extraction.items.length} item${extraction.items.length === 1 ? '' : 's'}, ${formatMoney(extraction.total, extraction.currency)}, ${extraction.terms.label}`;
    const notes = [...problems, ...(extraction.warnings || [])];
    (missing.length || notes.length ? s.warn : s.ok)(summary + (notes.length ? ` | ${notes.join(' | ')}` : '') + (missing.length ? ` | missing: ${missing.join(', ')}` : ''), { sources: extraction.sources });
    return { extraction, missing, problems };
  }

  async function preview(text) {
    const t = String(text || '').trim();
    if (!t) throw new AgentError('Paste a brief or an email thread first.');
    if (t.length > 8000) throw new AgentError('That brief is too long (8,000 characters max).');
    const runId = newRun('Preview invoice from brief');
    const { extraction, missing, problems } = await readBrief(t, runId);
    const issueDate = today();
    let plan = null;
    let dueDate = null;
    if (!missing.includes('amount')) {
      const { dueDate: d } = safeBuild(extraction, issueDate);
      dueDate = d;
      const key = clientKey(extraction.client);
      plan = planReminders({ issueDate, dueDate, amount: extraction.total, currency: extraction.currency, history: clientHistory(doc(), key, issueDate), today: issueDate });
    }
    const previewId = randomUUID();
    previews.set(previewId, { extraction, text: t, at: Date.now() });
    for (const [k, v] of previews) if (Date.now() - v.at > 30 * 60000) previews.delete(k);
    return { previewId, runId, extraction, missing, problems, issueDate, dueDate, plan };
  }

  function safeBuild(extraction, issueDate) {
    try {
      return buildInvoicePayload({ extraction: { ...extraction, client: { ...extraction.client, email: extraction.client.email || 'pending@example.invalid' } }, invoicer: config.invoicer, invoiceNumber: 'PREVIEW', invoiceDate: issueDate });
    } catch {
      return { dueDate: null };
    }
  }

  // ---------- 2-4. create, send, plan, draft ----------
  async function createInvoice({ text, previewId, issueDate, historyOverride, runId: givenRun } = {}) {
    let extraction;
    let runId = givenRun;
    if (previewId) {
      const p = previews.get(previewId);
      if (!p) throw new AgentError('That preview expired. Paste the brief again.', 410);
      previews.delete(previewId);
      extraction = p.extraction;
      runId ||= newRun(`Create invoice for ${extraction.client.name || 'client'}`);
    } else {
      const t = String(text || '').trim();
      if (!t) throw new AgentError('Paste a brief or an email thread first.');
      runId ||= newRun('Create invoice from brief');
      ({ extraction } = await readBrief(t, runId));
    }
    const missing = missingFields(extraction);
    if (missing.length) throw new AgentError(`I need the ${missing.join(' and ')} before I can bill this.`, 422, { missing, extraction });

    const date = issueDate || today();
    const s2 = step(runId, 'Build the PayPal invoice');
    const seq = store.nextSeq();
    const suffix = config.paypal.mode === 'sandbox' ? `-${randomUUID().slice(0, 4).toUpperCase()}` : '';
    const number = makeInvoiceNumber(date, seq) + suffix;
    let built;
    try {
      built = buildInvoicePayload({ extraction, invoicer: config.invoicer, invoiceNumber: number, invoiceDate: date });
    } catch (err) {
      s2.fail(err.message);
      throw new AgentError(err.message, 422);
    }
    s2.ok(`${number}: ${built.payload.items.length} line item${built.payload.items.length === 1 ? '' : 's'}, total ${formatMoney(built.total, built.currency)}, ${built.payload.detail.payment_term.term_type}${built.payload.detail.payment_term.due_date ? ` due ${built.payload.detail.payment_term.due_date}` : ''}`);

    const s3 = step(runId, 'Create and send on PayPal');
    let remote;
    let payLink;
    try {
      remote = await paypal.createInvoice(built.payload, { runId });
      const sent = await paypal.sendInvoice(remote.id, { runId, subject: `Invoice ${number} from ${config.invoicer.businessName}`, note: built.payload.detail.note });
      payLink = (sent.links || []).find((l) => l.rel === 'payer-view')?.href || remote.detail?.metadata?.recipient_view_url || null;
      s3.ok(`${remote.id} sent to ${extraction.client.email}`);
    } catch (err) {
      s3.fail(err.message);
      throw new AgentError(`PayPal refused the invoice: ${err.message}`, 502);
    }

    const key = clientKey(extraction.client);
    if (historyOverride) doc().clients[key] = { ...(doc().clients[key] || {}), name: extraction.client.name, history: historyOverride };
    else doc().clients[key] ||= { name: extraction.client.name, history: { invoices: 0, paidLate: 0, avgDaysLate: 0 } };

    const inv = {
      id: `inv_${seq}`,
      paypalId: remote.id,
      number,
      clientKey: key,
      client: { ...extraction.client },
      items: extraction.items,
      currency: built.currency,
      amount: built.total,
      dueAmount: built.total,
      issueDate: date,
      dueDate: built.dueDate,
      terms: extraction.terms,
      status: 'SENT',
      payLink,
      createdAt: new Date(now()).toISOString(),
      reminders: [],
      history: [],
    };
    history(inv, `Invoice ${number} created and sent via PayPal (${remote.id})`);

    const s4 = step(runId, 'Plan follow-ups');
    const plan = planReminders({ issueDate: date, dueDate: inv.dueDate, amount: inv.amount, currency: inv.currency, history: clientHistory(doc(), key, today(), inv.id), today: today() });
    inv.risk = plan.risk;
    inv.tier = plan.tier;
    inv.rationale = plan.rationale;
    inv.reminders = plan.reminders.map((r, i) => ({ id: `${inv.id}-r${i + 1}`, ...r }));
    s4.ok(plan.rationale);

    await draftAll(inv, runId);
    doc().invoices.push(inv);
    changed('created');
    return invoiceView(inv, today());
  }

  async function draftReminder(inv, r, runId) {
    const c = draftContext(inv, r.scheduledAt, config.invoicer.givenName);
    const res = await llm.json({ runId, task: `draft_${r.stage}_reminder`, system: DRAFT_SYSTEM, user: draftPrompt(r.stage, c), mock: () => templateDraft(r.stage, c) });
    const accepted = res.ok ? acceptDraft(res.data, c) : null;
    const d = accepted || templateDraft(r.stage, c);
    r.subject = d.subject;
    r.body = d.body;
    r.draftSource = accepted ? (llm.mode === 'live' ? 'llm' : 'demo') : 'template';
    return !!accepted;
  }

  async function draftAll(inv, runId) {
    const s = step(runId, 'Draft reminders');
    const planned = inv.reminders.filter((r) => r.status === 'planned');
    let rejected = 0;
    for (const r of planned) if (!(await draftReminder(inv, r, runId))) rejected++;
    const line = planned.map((r) => `${r.stage} ${formatDate(r.scheduledAt)}: "${r.subject}"`).join(' | ');
    (rejected ? s.warn : s.ok)(rejected ? `${line} | ${rejected} model draft(s) missed the invoice facts; used the template` : line);
  }

  // ---------- 5. status checks and reminders ----------
  function syncFromRemote(inv, remote) {
    const before = inv.status;
    inv.status = remote.status;
    if (remote.due_amount) inv.dueAmount = Number(remote.due_amount.value);
    if (remote.detail && remote.detail.metadata && remote.detail.metadata.recipient_view_url) inv.payLink ||= remote.detail.metadata.recipient_view_url;
    if (PAID.has(remote.status)) {
      const tx = remote.payments && remote.payments.transactions ? remote.payments.transactions.at(-1) : null;
      inv.paidAt ||= (tx && tx.payment_date) || today();
      inv.paidVia = tx ? tx.method : inv.paidVia || 'PAYPAL';
      inv.paidAmount = remote.payments && remote.payments.paid_amount ? Number(remote.payments.paid_amount.value) : inv.amount;
    }
    return before !== inv.status;
  }

  function stopReminders(inv, reason) {
    let n = 0;
    for (const r of inv.reminders) {
      if (r.status === 'planned') {
        r.status = 'cancelled';
        r.reason = reason;
        n++;
      }
    }
    return n;
  }

  async function checkOne(inv, runId) {
    const remote = await paypal.getInvoice(inv.paypalId, { runId });
    const moved = syncFromRemote(inv, remote);
    if (CLOSED.has(inv.status)) {
      const n = stopReminders(inv, `stopped: invoice ${inv.status.toLowerCase().replace(/_/g, ' ')}`);
      if (moved || n) history(inv, `PayPal reports ${inv.status}; ${n} pending reminder${n === 1 ? '' : 's'} cancelled`);
      return { closed: true, stopped: n, moved };
    }
    return { closed: false, moved };
  }

  async function sendReminder(inv, r, runId) {
    await paypal.remind(inv.paypalId, { subject: r.subject, note: r.body, runId });
    r.status = 'sent';
    r.sentAt = new Date(now()).toISOString();
    history(inv, `${r.stage} reminder sent via PayPal`);
  }

  async function tick({ runId: givenRun, reason = 'manual' } = {}) {
    if (ticking) return { busy: true };
    ticking = true;
    const runId = givenRun || newRun(reason === 'auto' ? 'Scheduled status check' : 'Check payments and send due reminders');
    const result = { checked: 0, paid: [], remindersSent: [], errors: [] };
    try {
      const open = doc().invoices.filter((i) => i.paypalId && !CLOSED.has(i.status) && i.status !== 'DRAFT');
      const s1 = step(runId, 'Check payment status');
      for (const inv of open) {
        try {
          const r = await checkOne(inv, runId);
          result.checked++;
          if (r.closed) result.paid.push({ id: inv.id, client: inv.client.name, stopped: r.stopped });
        } catch (err) {
          result.errors.push(`${inv.number}: ${err.message}`);
        }
      }
      s1.ok(open.length ? `${result.checked} open invoice${result.checked === 1 ? '' : 's'} checked; ${result.paid.length ? result.paid.map((p) => `${p.client} paid, ${p.stopped} reminder${p.stopped === 1 ? '' : 's'} stopped`).join('; ') : 'no new payments'}` : 'no open invoices');

      const s2 = step(runId, 'Send due reminders');
      const t = today();
      for (const inv of doc().invoices) {
        if (CLOSED.has(inv.status) || !inv.paypalId) continue;
        const due = inv.reminders.filter((r) => r.status === 'planned' && r.scheduledAt <= t).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
        if (!due.length) continue;
        const send = due.at(-1); // never a burst: only the most advanced due stage goes out
        for (const r of due.slice(0, -1)) {
          r.status = 'skipped';
          r.reason = 'superseded by a later stage that was also due';
        }
        if (send.scheduledAt !== t) {
          // It was due while nobody was checking: reword it for the day it actually goes out.
          send.scheduledAt = t;
          await draftReminder(inv, send, runId);
        }
        try {
          await sendReminder(inv, send, runId);
          result.remindersSent.push({ id: inv.id, client: inv.client.name, stage: send.stage });
        } catch (err) {
          send.status = 'failed';
          send.reason = err.message;
          result.errors.push(`${inv.number}: ${err.message}`);
        }
      }
      (result.errors.length ? s2.warn : s2.ok)(
        (result.remindersSent.length ? result.remindersSent.map((r) => `${r.stage} reminder to ${r.client}`).join('; ') : 'nothing due today') + (result.errors.length ? ` | errors: ${result.errors.join('; ')}` : ''),
      );
    } finally {
      ticking = false;
    }
    changed('tick');
    return result;
  }

  async function remindNow(id) {
    const inv = findInvoice(id);
    if (!inv) throw new AgentError('Invoice not found', 404);
    const runId = newRun(`Remind ${inv.client.name} now`);
    const r = await checkOne(inv, runId);
    if (r.closed) {
      changed('remind');
      throw new AgentError(`${inv.client.name} has already paid (${inv.status}); no reminder sent.`, 409);
    }
    const next = inv.reminders.filter((x) => x.status === 'planned').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
    if (!next) throw new AgentError('No reminders left in the plan for this invoice.', 409);
    const s = step(runId, `Send ${next.stage} reminder early`);
    next.scheduledAt = today();
    await draftReminder(inv, next, runId);
    try {
      await sendReminder(inv, next, runId);
      s.ok(`"${next.subject}" to ${inv.client.email}`);
    } catch (err) {
      s.fail(err.message);
      throw new AgentError(err.message, 502);
    }
    changed('remind');
    return invoiceView(inv, today());
  }

  async function markPaid(id, { method = 'BANK_TRANSFER', note } = {}) {
    const inv = findInvoice(id);
    if (!inv) throw new AgentError('Invoice not found', 404);
    const m = String(method).toUpperCase();
    if (!['BANK_TRANSFER', 'CASH', 'CHECK', 'CREDIT_CARD', 'DEBIT_CARD', 'PAYPAL', 'WIRE_TRANSFER', 'OTHER'].includes(m)) throw new AgentError('Unknown payment method');
    if (CLOSED.has(inv.status)) throw new AgentError(`Invoice is already ${inv.status}`, 409);
    const runId = newRun(`Record payment from ${inv.client.name}`);
    const s = step(runId, 'Record payment on PayPal');
    try {
      await paypal.recordPayment(inv.paypalId, { method: m === 'PAYPAL' ? 'OTHER' : m, paymentDate: today(), amount: { currency_code: inv.currency, value: toPayPalValue(inv.dueAmount ?? inv.amount, inv.currency) }, note: note || 'Recorded by Owed', runId });
      const r = await checkOne(inv, runId);
      s.ok(`${inv.number} is ${inv.status}; ${r.stopped || 0} reminder${r.stopped === 1 ? '' : 's'} stopped`);
    } catch (err) {
      s.fail(err.message);
      throw new AgentError(err.message, 502);
    }
    changed('paid');
    return invoiceView(inv, today());
  }

  // Demo mode only: the client pays on the PayPal payer page.
  async function simulatePayment(id) {
    if (!mock) throw new AgentError('Simulated payments exist only in demo mode. In the sandbox, pay the invoice as a sandbox personal account from the payer link.', 400);
    const inv = findInvoice(id);
    if (!inv) throw new AgentError('Invoice not found', 404);
    const runId = newRun(`${inv.client.name} pays via PayPal (simulated)`);
    try {
      mock.simulatePayerPayment(inv.paypalId);
    } catch (err) {
      throw new AgentError(err.message, 409);
    }
    bus.trace({ runId, kind: 'info', text: `Demo: ${inv.client.email} paid ${formatMoney(inv.amount, inv.currency)} on the PayPal payer page. The agent has not been told; it finds out from PayPal.` });
    const s = step(runId, 'Check payment status');
    const r = await checkOne(inv, runId);
    s.ok(r.closed ? `PayPal reports ${inv.status}; ${r.stopped} reminder${r.stopped === 1 ? '' : 's'} stopped` : `still ${inv.status}`);
    changed('paid');
    return invoiceView(inv, today());
  }

  async function reschedule(reminderId, date) {
    const inv = doc().invoices.find((i) => i.reminders.some((r) => r.id === reminderId));
    const r = inv && inv.reminders.find((x) => x.id === reminderId);
    const err = rescheduleError({ reminder: r, invoice: inv, date, today: today() });
    if (err) throw new AgentError(err, r ? 422 : 404);
    const runId = newRun(`Move the ${r.stage} reminder for ${inv.client.name}`);
    const s = step(runId, 'Reschedule and redraft');
    const from = r.scheduledAt;
    r.scheduledAt = date;
    r.moved = true;
    await draftReminder(inv, r, runId);
    s.ok(`${r.stage}: ${formatDate(from)} -> ${formatDate(date)}; new subject "${r.subject}"`);
    history(inv, `${r.stage} reminder moved from ${from} to ${date}`);
    changed('reschedule');
    return invoiceView(inv, today());
  }

  // ---------- webhooks ----------
  async function handleWebhook(event, headers = {}) {
    const runId = newRun(`Webhook ${event && event.event_type ? event.event_type : '(unknown)'}`, 'webhook');
    const s = step(runId, 'Verify webhook');
    if (config.paypal.mode === 'sandbox') {
      if (!config.paypal.webhookId) {
        s.fail('PAYPAL_WEBHOOK_ID is not set; webhook ignored');
        throw new AgentError('Webhook not configured (set PAYPAL_WEBHOOK_ID).', 501);
      }
      const ok = await paypal.verifyWebhook({ headers, event, webhookId: config.paypal.webhookId, runId });
      if (!ok) {
        s.fail('signature verification failed');
        throw new AgentError('Webhook signature verification failed.', 400);
      }
      s.ok('signature verified by PayPal');
    } else s.warn('demo mode: signature not verified');
    const type = event && event.event_type;
    const id = event && event.resource && ((event.resource.invoice && event.resource.invoice.id) || event.resource.id);
    if (!/^INVOICING\.INVOICE\./.test(String(type)) || !id) return { ignored: true };
    const inv = findInvoice(id);
    if (!inv) return { ignored: true, reason: 'unknown invoice' };
    // Do not trust the payload: confirm the state with PayPal.
    const r = await checkOne(inv, runId);
    changed('webhook');
    return { ok: true, invoice: inv.id, status: inv.status, stopped: r.stopped || 0 };
  }

  // ---------- 6. questions ----------
  async function answer(question) {
    const runId = newRun('Answer a question');
    const s = step(runId, 'Answer from the ledger');
    const t = today();
    const det = deterministicAnswer(question, doc().invoices, t);
    const facts = ledgerFacts(doc().invoices, t);
    const r = await llm.complete({ runId, task: 'answer_question', system: ANSWER_SYSTEM, user: answerPrompt(question, facts), mock: () => det.text, maxTokens: 250 });
    const accepted = r.ok ? acceptAnswer(r.content, facts) : null;
    const text = accepted || det.text;
    (accepted || llm.mode !== 'live' ? s.ok : s.warn)(accepted ? `${det.rows.length} invoice${det.rows.length === 1 ? '' : 's'} in the answer` : 'model answer unavailable or cited a figure not in the ledger; used the computed answer');
    return { text, rows: det.rows, kind: det.kind };
  }

  // ---------- chat router ----------
  function matchInvoice(message, { openOnly = true } = {}) {
    const s = message.toLowerCase();
    const pool = doc().invoices.filter((i) => !openOnly || !CLOSED.has(i.status));
    return (
      pool.find((i) => s.includes(i.number.toLowerCase())) ||
      pool.find((i) => i.client.name && s.includes(i.client.name.toLowerCase())) ||
      pool.find((i) => i.client.name && i.client.name.split(/\s+/)[0].length > 2 && new RegExp(`\\b${i.client.name.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '')}\\b`).test(s)) ||
      null
    );
  }

  async function chat(message, { autoSend = false } = {}) {
    const m = String(message || '').trim().slice(0, 8000);
    if (!m) throw new AgentError('Say something first.');
    const question = /\?\s*$/.test(m) || /^(who|what|how|which|when|is|are|did|do|does|has|show|list)\b/i.test(m);
    if (/^(check|sync|poll|refresh)\b/i.test(m) || /\bany (new )?payments\b/i.test(m)) {
      const r = await tick();
      if (r.busy) return { type: 'action', text: 'A status check is already running.' };
      const parts = [`Checked ${r.checked} open invoice${r.checked === 1 ? '' : 's'} with PayPal.`];
      parts.push(r.paid.length ? r.paid.map((p) => `${p.client} paid; ${p.stopped} reminder${p.stopped === 1 ? '' : 's'} stopped.`).join(' ') : 'No new payments.');
      if (r.remindersSent.length) parts.push(`Sent: ${r.remindersSent.map((x) => `${x.stage} reminder to ${x.client}`).join(', ')}.`);
      return { type: 'action', text: parts.join(' '), data: r };
    }
    if (!question && /\b(remind|nudge|chase|follow up with)\b/i.test(m)) {
      const inv = matchInvoice(m);
      if (!inv) return { type: 'answer', text: 'Which client? Name them, or use the Remind button on their row.' };
      const v = await remindNow(inv.id);
      const sent = v.reminders.filter((r) => r.status === 'sent').at(-1);
      return { type: 'action', text: `Sent ${inv.client.name} the ${sent ? sent.stage : ''} reminder via PayPal: "${sent ? sent.subject : ''}".`, data: v };
    }
    if (!question && /\b(paid|has paid|sent (?:me )?the money|payment (?:came|received)|got (?:the )?payment)\b/i.test(m) && !findMoney(m).length) {
      const inv = matchInvoice(m);
      if (!inv) return { type: 'answer', text: 'Who paid? Name the client and I will record it.' };
      const method = (METHOD_WORDS.find(([re]) => re.test(m)) || [null, 'OTHER'])[1];
      const v = await markPaid(inv.id, { method, note: `Recorded from chat: ${m.slice(0, 120)}` });
      return { type: 'action', text: `Recorded ${formatMoney(inv.amount, inv.currency)} from ${inv.client.name} (${method.toLowerCase().replace(/_/g, ' ')}). PayPal shows ${v.status}; remaining reminders stopped.`, data: v };
    }
    const looksLikeBrief = !question && findMoney(m, config.currency).length > 0 && (new RegExp(EMAIL_RE.source).test(m) || /\b(invoice|bill|net\s*\d|due|built|designed|wrote|made|for|retainer|hours?)\b/i.test(m));
    if (looksLikeBrief) {
      if (autoSend) {
        try {
          const v = await createInvoice({ text: m });
          return { type: 'created', text: `Invoice ${v.number} for ${formatMoney(v.amount, v.currency)} sent to ${v.client.email} via PayPal. ${v.rationale}`, data: v };
        } catch (err) {
          if (err.missing) return { type: 'needs_input', text: err.message, data: { missing: err.missing } };
          throw err;
        }
      }
      const p = await preview(m);
      if (p.missing.length) return { type: 'needs_input', text: `I read ${p.extraction.client.name || 'this'} but I still need the ${p.missing.join(' and ')}. Add it to the brief and send again.`, data: p };
      return { type: 'preview', text: `Ready to bill ${p.extraction.client.name}: ${formatMoney(p.extraction.total, p.extraction.currency)}, ${p.extraction.terms.label.toLowerCase()} (due ${formatDate(p.dueDate)}). Check it and press Create & send.`, data: p };
    }
    const a = await answer(m);
    return { type: 'answer', text: a.text, data: a };
  }

  // ---------- demo ----------
  async function reset() {
    store.reset();
    previews.clear();
    if (mock) mock.reset();
    bus.clear();
    changed('reset');
  }

  async function seedDemo() {
    await reset();
    const runId = newRun('Run demo: four clients', 'demo');
    bus.trace({ runId, kind: 'info', text: `Demo: billing 4 fictional clients at different points in the cycle (${config.paypal.mode === 'mock' ? 'PayPal demo mode' : 'PayPal sandbox'}).` });
    const created = [];
    for (const c of DEMO_CLIENTS) {
      bus.trace({ runId, kind: 'info', text: `${c.story}` });
      const v = await createInvoice({ text: c.brief, issueDate: addDays(today(), -c.issuedDaysAgo), historyOverride: c.history, runId });
      created.push(v);
      if (c.paysDuringDemo) {
        if (mock) {
          mock.simulatePayerPayment(v.paypalId);
          bus.trace({ runId, kind: 'info', text: `Demo: ${v.client.name} pays ${formatMoney(v.amount, v.currency)} on the PayPal payer page. The agent will notice on its next status check.` });
        } else {
          await paypal.recordPayment(v.paypalId, { method: 'BANK_TRANSFER', paymentDate: today(), runId, note: 'Demo payment' });
        }
      }
    }
    const t = await tick({ runId });
    changed('demo');
    return { created: created.length, tick: t };
  }

  // ---------- read models ----------
  function ledger() {
    const t = today();
    const invoices = doc().invoices.map((i) => invoiceView(i, t)).sort((a, b) => (a.display.code === 'overdue' ? -1 : 0) - (b.display.code === 'overdue' ? -1 : 0) || b.createdAt.localeCompare(a.createdAt));
    return { today: t, totals: totals(doc().invoices, t), invoices };
  }

  return {
    preview,
    createInvoice,
    tick,
    remindNow,
    markPaid,
    simulatePayment,
    reschedule,
    handleWebhook,
    answer,
    chat,
    seedDemo,
    reset,
    ledger,
    timeline: () => timelineData(doc().invoices, today()),
    today,
    _trace: traceFn,
  };
}
