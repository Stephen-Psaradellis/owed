import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReminders, assessRisk, amountTier, rescheduleError } from '../src/schedule.js';
import { templateDraft, draftContext, acceptDraft } from '../src/drafts.js';

const dates = (p) => p.reminders.map((r) => [r.stage, r.scheduledAt, r.status]);

test('risk from history', () => {
  assert.equal(assessRisk(null).level, 'new');
  assert.equal(assessRisk({ invoices: 5, paidLate: 0 }).level, 'low');
  assert.equal(assessRisk({ invoices: 4, paidLate: 1, avgDaysLate: 2 }).level, 'medium');
  assert.equal(assessRisk({ invoices: 3, paidLate: 2, avgDaysLate: 12 }).level, 'high');
  assert.equal(assessRisk({ invoices: 6, paidLate: 1, avgDaysLate: 15 }).level, 'high');
  assert.equal(assessRisk({ invoices: 6, paidLate: 0, unpaidOverdue: 1 }).level, 'high');
});

test('amount tiers', () => {
  assert.equal(amountTier(300), 'small');
  assert.equal(amountTier(1800), 'medium');
  assert.equal(amountTier(4500), 'large');
});

test('new client, medium amount: polite before due, firm and final after', () => {
  const p = planReminders({ issueDate: '2026-10-13', dueDate: '2026-10-28', amount: 1800, today: '2026-10-13' });
  assert.deepEqual(dates(p), [['polite', '2026-10-26', 'planned'], ['firm', '2026-11-02', 'planned'], ['final', '2026-11-11', 'planned']]);
  assert.match(p.rationale, /new/);
});

test('risky clients are chased sooner than reliable ones', () => {
  const base = { issueDate: '2026-10-01', dueDate: '2026-10-31', amount: 1200, today: '2026-10-01' };
  const low = planReminders({ ...base, history: { invoices: 5, paidLate: 0 } });
  const high = planReminders({ ...base, history: { invoices: 3, paidLate: 2, avgDaysLate: 12 } });
  for (let i = 0; i < 3; i++) assert.ok(high.reminders[i].scheduledAt <= low.reminders[i].scheduledAt, `stage ${i}`);
  assert.equal(high.reminders[1].scheduledAt, '2026-11-03');
  assert.equal(low.reminders[1].scheduledAt, '2026-11-07');
});

test('large amounts get an earlier heads-up and a sooner final', () => {
  const base = { issueDate: '2026-10-01', dueDate: '2026-10-31', today: '2026-10-01', history: { invoices: 5, paidLate: 0 } };
  const medium = planReminders({ ...base, amount: 1500 });
  const large = planReminders({ ...base, amount: 4500 });
  assert.equal(medium.reminders[0].scheduledAt, '2026-10-30');
  assert.equal(large.reminders[0].scheduledAt, '2026-10-28');
  assert.ok(large.reminders[2].scheduledAt < medium.reminders[2].scheduledAt);
});

test('stages are strictly ordered with minimum gaps, even for due-on-receipt', () => {
  const p = planReminders({ issueDate: '2026-10-13', dueDate: '2026-10-13', amount: 200, today: '2026-10-13', history: { invoices: 2, paidLate: 0 } });
  const d = p.reminders.map((r) => r.scheduledAt);
  assert.ok(d[0] > '2026-10-13');
  assert.ok(d[0] < d[1] && d[1] < d[2]);
});

test('a plan made late collapses past stages: one catch-up today, no burst', () => {
  const p = planReminders({ issueDate: '2026-09-05', dueDate: '2026-10-05', amount: 2400, today: '2026-10-13', history: { invoices: 3, paidLate: 2, avgDaysLate: 12 } });
  assert.deepEqual(dates(p), [['polite', '2026-10-02', 'skipped'], ['firm', '2026-10-13', 'planned'], ['final', '2026-10-16', 'planned']]);
  assert.match(p.reminders[1].reason, /catch-up/);
  assert.equal(p.reminders.filter((r) => r.status === 'planned' && r.scheduledAt === '2026-10-13').length, 1);
});

test('reschedule validation', () => {
  const invoice = { status: 'SENT', issueDate: '2026-10-01' };
  const reminder = { status: 'planned' };
  const today = '2026-10-13';
  assert.equal(rescheduleError({ reminder, invoice, date: '2026-10-20', today }), null);
  assert.match(rescheduleError({ reminder, invoice, date: '2026-10-12', today }), /past/);
  assert.match(rescheduleError({ reminder: { status: 'sent' }, invoice, date: '2026-10-20', today }), /planned/);
  assert.match(rescheduleError({ reminder, invoice: { ...invoice, status: 'PAID' }, date: '2026-10-20', today }), /closed/);
  assert.match(rescheduleError({ reminder, invoice, date: 'soon', today }), /YYYY-MM-DD/);
  assert.match(rescheduleError({ reminder, invoice, date: '2027-06-01', today }), /six months/);
  assert.match(rescheduleError({ reminder: null, invoice, date: '2026-10-20', today }), /not found/);
});

const inv = { number: 'OWED-261013-0001', amount: 1800, currency: 'USD', dueDate: '2026-10-28', client: { contact: 'Jo Park', name: 'Acme' }, items: [{ name: 'Shopify theme' }], payLink: 'https://www.sandbox.paypal.com/invoice/p/#INV2-X' };

test('drafts change with the stage and the send date', () => {
  const before = templateDraft('polite', draftContext(inv, '2026-10-26'));
  assert.match(before.body, /due on Oct 28, 2026 \(in 2 days\)/);
  assert.match(before.body, /^Hi Jo,/);
  const late = templateDraft('firm', draftContext(inv, '2026-11-02'));
  assert.match(late.subject, /5 days overdue/);
  const fin = templateDraft('final', draftContext(inv, '2026-11-11'));
  assert.match(fin.subject, /^Final reminder/);
  for (const d of [before, late, fin]) {
    assert.ok(d.body.includes(inv.number) || d.subject.includes(inv.number));
    assert.ok(d.body.includes('$1,800') || d.subject.includes('$1,800'));
    assert.ok(d.body.includes(inv.payLink));
    assert.doesNotMatch(d.body, /legal|lawyer|collections agency|court/i);
  }
});

test('a model draft must keep the invoice number, amount and pay link', () => {
  const c = draftContext(inv, '2026-10-26');
  assert.ok(acceptDraft({ subject: `Invoice ${c.number}`, body: `Hi, ${c.amount} is due. ${c.payLink}` }, c));
  assert.equal(acceptDraft({ subject: 'Hello', body: `Please pay ${c.amount}: ${c.payLink}` }, c), null);
  assert.equal(acceptDraft({ subject: `Invoice ${c.number}`, body: 'Please pay soon.' }, c), null);
  assert.equal(acceptDraft(null, c), null);
});
