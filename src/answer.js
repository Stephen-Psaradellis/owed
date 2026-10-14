// Step 5: answer questions about the ledger ("who owes me what?"). The facts are always
// computed in code; the LLM only phrases them, and an answer that mentions a dollar
// figure not in the facts is thrown away in favour of the deterministic one.
import { formatMoney, roundMoney } from './money.js';
import { formatDate, daysBetween } from './dates.js';
import { displayStatus, outstanding, PAID, totals as computeTotals } from './ledger.js';

export function classifyQuestion(q) {
  const s = String(q || '').toLowerCase();
  if (/\boverdue|late\b|past due|behind/.test(s)) return 'overdue';
  if (/\b(paid|received|collected|came in|got paid)\b/.test(s) && !/\bun ?paid\b/.test(s)) return 'paid';
  if (/\b(this week|next week|coming up|due soon|upcoming|next 7)\b/.test(s)) return 'due_soon';
  if (/\b(biggest|largest|most)\b/.test(s)) return 'biggest';
  if (/\b(reminder|follow[- ]?up|nudge|chase)\b/.test(s)) return 'reminders';
  return 'owed';
}

export function ledgerFacts(invoices, today) {
  const t = computeTotals(invoices, today);
  const rows = invoices.map((inv) => ({
    client: inv.client.name,
    number: inv.number,
    amount: formatMoney(inv.amount, inv.currency),
    outstanding: formatMoney(outstanding(inv), inv.currency),
    outstandingValue: outstanding(inv),
    currency: inv.currency,
    status: displayStatus(inv, today).label,
    due: formatDate(inv.dueDate),
    dueISO: inv.dueDate,
    paid: PAID.has(inv.status),
    nextReminder: (inv.reminders || []).filter((r) => r.status === 'planned').map((r) => `${r.stage} on ${formatDate(r.scheduledAt)}`)[0] || null,
  }));
  return { today, totals: { owed: formatMoney(t.primary.owed, t.primary.currency), overdue: formatMoney(t.primary.overdue, t.primary.currency), paid: formatMoney(t.primary.paid, t.primary.currency), open: t.primary.openCount, overdueCount: t.primary.overdueCount }, rows };
}

function byClient(rows) {
  const m = new Map();
  for (const r of rows) {
    if (r.paid || !(r.outstandingValue > 0)) continue;
    const e = m.get(r.client) || { client: r.client, total: 0, currency: r.currency, items: [] };
    e.total = roundMoney(e.total + r.outstandingValue, r.currency);
    e.items.push(r);
    m.set(r.client, e);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

export function deterministicAnswer(question, invoices, today) {
  const facts = ledgerFacts(invoices, today);
  const kind = classifyQuestion(question);
  const s = String(question || '').toLowerCase();
  const named = facts.rows.filter((r) => r.client && s.includes(r.client.toLowerCase().split(/\s+/)[0]));
  if (!invoices.length) return { kind, text: 'The ledger is empty. Paste a brief to bill a client, or click Run demo.', rows: [] };

  if (named.length) {
    const lines = named.map((r) => `${r.number}: ${r.amount}, ${r.status.toLowerCase()}${r.nextReminder ? `; next ${r.nextReminder}` : ''}`);
    return { kind: 'client', text: `${named[0].client}: ${lines.join('. ')}.`, rows: named };
  }
  if (kind === 'overdue') {
    const rows = facts.rows.filter((r) => !r.paid && r.dueISO < today && r.outstandingValue > 0);
    if (!rows.length) return { kind, text: 'Nothing is overdue. Every open invoice is still inside its terms.', rows };
    return { kind, text: `${rows.length} overdue, ${facts.totals.overdue} in total: ` + rows.map((r) => `${r.client} ${r.outstanding} (${r.status.toLowerCase()})`).join('; ') + '.', rows };
  }
  if (kind === 'paid') {
    const rows = facts.rows.filter((r) => r.paid);
    if (!rows.length) return { kind, text: 'No payments recorded yet.', rows };
    return { kind, text: `Collected ${facts.totals.paid}: ` + rows.map((r) => `${r.client} ${r.amount} (${r.status.toLowerCase()})`).join('; ') + '.', rows };
  }
  if (kind === 'due_soon') {
    const rows = facts.rows.filter((r) => !r.paid && r.outstandingValue > 0 && daysBetween(today, r.dueISO) >= 0 && daysBetween(today, r.dueISO) <= 7);
    if (!rows.length) return { kind, text: 'Nothing falls due in the next 7 days.', rows };
    return { kind, text: 'Due in the next 7 days: ' + rows.map((r) => `${r.client} ${r.outstanding} on ${r.due}`).join('; ') + '.', rows };
  }
  if (kind === 'biggest') {
    const top = byClient(facts.rows)[0];
    if (!top) return { kind, text: 'Nobody owes you anything right now.', rows: [] };
    return { kind, text: `${top.client} owes the most: ${formatMoney(top.total, top.currency)} across ${top.items.length} invoice${top.items.length === 1 ? '' : 's'}.`, rows: top.items };
  }
  if (kind === 'reminders') {
    const rows = facts.rows.filter((r) => r.nextReminder);
    if (!rows.length) return { kind, text: 'No reminders are scheduled.', rows };
    return { kind, text: 'Next reminders: ' + rows.map((r) => `${r.client}, ${r.nextReminder}`).join('; ') + '.', rows };
  }
  const groups = byClient(facts.rows);
  if (!groups.length) return { kind, text: `Nobody owes you anything right now. Collected so far: ${facts.totals.paid}.`, rows: [] };
  return {
    kind,
    text: `You are owed ${facts.totals.owed} across ${facts.totals.open} invoice${facts.totals.open === 1 ? '' : 's'} (${facts.totals.overdue} overdue): ` + groups.map((g) => `${g.client} ${formatMoney(g.total, g.currency)} (${g.items.map((i) => i.status.toLowerCase()).join(', ')})`).join('; ') + '.',
    rows: groups.flatMap((g) => g.items),
  };
}

export const ANSWER_SYSTEM = `You answer a freelancer's questions about who owes them money.
Use ONLY the JSON facts given. Quote amounts exactly as written in the facts. Two or three
short sentences, plain English, no markdown. If the facts cannot answer, say so.`;

export function answerPrompt(question, facts) {
  const slim = { ...facts, rows: facts.rows.map(({ outstandingValue, dueISO, ...r }) => r) };
  return `FACTS:\n${JSON.stringify(slim)}\n\nQUESTION: ${String(question).slice(0, 500)}`;
}

// An LLM answer survives only if every money figure in it is one of the facts' figures.
export function acceptAnswer(text, facts) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/^["']|["']$/g, '');
  if (!t || t.length > 900) return null;
  const allowed = new Set([facts.totals.owed, facts.totals.overdue, facts.totals.paid, ...facts.rows.flatMap((r) => [r.amount, r.outstanding])].map((x) => x.replace(/[^0-9.]/g, '')));
  for (const m of t.match(/[$€£]\s?\d[\d,]*(?:\.\d+)?/g) || []) {
    if (!allowed.has(m.replace(/[^0-9.]/g, ''))) return null;
  }
  return t;
}
