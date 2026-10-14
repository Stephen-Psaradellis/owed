// The ledger: Owed's own record of each invoice, its reminder plan and its history,
// plus client payment history. Stored as one JSON document (data/ledger.json, written
// atomically) or kept in memory for tests. PayPal stays the source of truth for status;
// the ledger mirrors it and adds what PayPal does not know (the plan, the drafts).
import fs from 'node:fs';
import path from 'node:path';
import { daysBetween } from './dates.js';
import { roundMoney } from './money.js';

export const CLOSED = new Set(['PAID', 'MARKED_AS_PAID', 'CANCELLED', 'REFUNDED', 'MARKED_AS_REFUNDED']);
export const PAID = new Set(['PAID', 'MARKED_AS_PAID']);

export function createStore({ file = null } = {}) {
  let doc = { invoices: [], clients: {}, seq: 0, version: 1 };
  if (file) {
    try {
      doc = { ...doc, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      /* first run */
    }
  }
  let timer = null;
  const writeNow = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
    fs.renameSync(tmp, file);
  };
  return {
    get doc() {
      return doc;
    },
    save() {
      if (!file) return;
      clearTimeout(timer);
      timer = setTimeout(writeNow, 50);
      if (timer.unref) timer.unref();
    },
    flush() {
      clearTimeout(timer);
      writeNow();
    },
    reset() {
      doc = { invoices: [], clients: {}, seq: 0, version: 1 };
      this.save();
    },
    nextSeq() {
      doc.seq += 1;
      return doc.seq;
    },
  };
}

export function clientKey(client) {
  const base = (client && (client.email || client.name)) || 'unknown';
  const domain = String(base).includes('@') ? String(base).split('@')[1] : String(base);
  return domain.toLowerCase().replace(/[^a-z0-9.]+/g, '-');
}

// Status a person would say out loud.
export function displayStatus(inv, today) {
  if (PAID.has(inv.status)) return { code: 'paid', label: inv.status === 'PAID' ? 'Paid via PayPal' : 'Marked paid' };
  if (inv.status === 'CANCELLED') return { code: 'cancelled', label: 'Cancelled' };
  if (inv.status === 'DRAFT') return { code: 'draft', label: 'Draft' };
  const d = daysBetween(today, inv.dueDate);
  if (d < 0) return { code: 'overdue', label: `Overdue ${-d} day${d === -1 ? '' : 's'}`, days: -d };
  if (d === 0) return { code: 'due', label: 'Due today', days: 0 };
  return { code: inv.status === 'PARTIALLY_PAID' ? 'partial' : 'sent', label: `${inv.status === 'PARTIALLY_PAID' ? 'Part paid, due' : 'Due'} in ${d} day${d === 1 ? '' : 's'}`, days: d };
}

export function nextAction(inv, today) {
  if (CLOSED.has(inv.status)) return { label: PAID.has(inv.status) ? 'Done: reminders stopped' : 'None', date: null };
  if (inv.status === 'DRAFT') return { label: 'Send the invoice', date: today };
  const next = (inv.reminders || []).filter((r) => r.status === 'planned').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
  if (next) return { label: `${next.stage[0].toUpperCase()}${next.stage.slice(1)} reminder`, date: next.scheduledAt, reminderId: next.id, stage: next.stage };
  if (daysBetween(today, inv.dueDate) < 0) return { label: 'All reminders sent: call the client', date: today };
  return { label: 'Waiting for payment', date: inv.dueDate };
}

export function invoiceView(inv, today) {
  return { ...inv, display: displayStatus(inv, today), next: nextAction(inv, today), outstanding: outstanding(inv) };
}

export function outstanding(inv) {
  if (CLOSED.has(inv.status) || inv.status === 'DRAFT') return 0;
  return roundMoney(inv.dueAmount ?? inv.amount, inv.currency);
}

// Totals per currency; `primary` is the currency with the most invoices.
export function totals(invoices, today) {
  const by = {};
  for (const inv of invoices) {
    const t = (by[inv.currency] ||= { currency: inv.currency, owed: 0, overdue: 0, paid: 0, count: 0, openCount: 0, overdueCount: 0, paidCount: 0 });
    t.count++;
    const out = outstanding(inv);
    if (out > 0) {
      t.owed += out;
      t.openCount++;
      if (daysBetween(today, inv.dueDate) < 0) {
        t.overdue += out;
        t.overdueCount++;
      }
    }
    if (PAID.has(inv.status)) {
      t.paid += inv.paidAmount ?? inv.amount;
      t.paidCount++;
    }
  }
  for (const t of Object.values(by)) for (const k of ['owed', 'overdue', 'paid']) t[k] = roundMoney(t[k], t.currency);
  const list = Object.values(by).sort((a, b) => b.count - a.count);
  const reminders = invoices.flatMap((i) => i.reminders || []);
  return {
    primary: list[0] || { currency: 'USD', owed: 0, overdue: 0, paid: 0, count: 0, openCount: 0, overdueCount: 0, paidCount: 0 },
    byCurrency: list,
    remindersPlanned: reminders.filter((r) => r.status === 'planned').length,
    remindersSent: reminders.filter((r) => r.status === 'sent').length,
  };
}

// Payment history for a client: seeded history plus invoices in this ledger.
export function clientHistory(doc, key, today, excludeId = null) {
  const seeded = (doc.clients[key] && doc.clients[key].history) || { invoices: 0, paidLate: 0, avgDaysLate: 0 };
  let invoices = seeded.invoices;
  let paidLate = seeded.paidLate;
  let lateDays = seeded.avgDaysLate * seeded.paidLate;
  let unpaidOverdue = 0;
  for (const inv of doc.invoices) {
    if (inv.clientKey !== key || inv.id === excludeId) continue;
    if (PAID.has(inv.status)) {
      invoices++;
      const late = inv.paidAt ? daysBetween(inv.dueDate, inv.paidAt) : 0;
      if (late > 0) {
        paidLate++;
        lateDays += late;
      }
    } else if (!CLOSED.has(inv.status) && daysBetween(today, inv.dueDate) < 0) unpaidOverdue++;
  }
  return { invoices, paidLate, avgDaysLate: paidLate ? Math.round(lateDays / paidLate) : 0, unpaidOverdue };
}
