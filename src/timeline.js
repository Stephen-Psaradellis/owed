// Ledger -> Bryntum Scheduler data. One row (resource) per invoice; on it the payment
// term as a bar (issued -> due), the overdue stretch, each reminder as a milestone
// (draggable while planned) and the payment as a milestone.
import { addDays, daysBetween } from './dates.js';
import { formatMoney } from './money.js';
import { PAID, displayStatus } from './ledger.js';

const STAGE_COLOR = { polite: 'teal', firm: 'amber', final: 'red' };
const STAGE_ICON = { polite: 'fa fa-envelope', firm: 'fa fa-bell', final: 'fa fa-triangle-exclamation' };

export function timelineData(invoices, today) {
  const resources = [];
  const events = [];
  let min = today;
  let max = addDays(today, 21);
  for (const inv of invoices) {
    const ds = displayStatus(inv, today);
    resources.push({ id: inv.id, name: inv.client.name, number: inv.number, amount: formatMoney(inv.amount, inv.currency), status: ds.code, statusLabel: ds.label });
    const termEnd = inv.dueDate > inv.issueDate ? inv.dueDate : addDays(inv.issueDate, 1);
    events.push({ id: `${inv.id}:term`, resourceId: inv.id, kind: 'term', name: `${inv.terms && inv.terms.label ? inv.terms.label : 'Terms'} · ${formatMoney(inv.amount, inv.currency)}`, startDate: inv.issueDate, endDate: termEnd, draggable: false, resizable: false, eventColor: PAID.has(inv.status) ? 'green' : ds.code === 'overdue' ? 'gray' : 'blue', iconCls: 'fa fa-file-invoice-dollar' });
    if (ds.code === 'overdue') {
      events.push({ id: `${inv.id}:overdue`, resourceId: inv.id, kind: 'overdue', name: ds.label, startDate: inv.dueDate, endDate: addDays(today, 1), draggable: false, resizable: false, eventColor: 'red', iconCls: 'fa fa-hourglass-end' });
    }
    for (const r of inv.reminders || []) {
      if (r.status === 'skipped') continue;
      const date = r.status === 'sent' && r.sentAt ? r.sentAt.slice(0, 10) : r.scheduledAt;
      events.push({
        id: r.id,
        resourceId: inv.id,
        kind: 'reminder',
        stage: r.stage,
        reminderStatus: r.status,
        name: `${r.stage[0].toUpperCase()}${r.stage.slice(1)}${r.status === 'sent' ? ' (sent)' : r.status === 'cancelled' ? ' (stopped)' : ''}`,
        startDate: date,
        duration: 0,
        durationUnit: 'day',
        draggable: r.status === 'planned',
        resizable: false,
        eventColor: r.status === 'planned' ? STAGE_COLOR[r.stage] : 'gray',
        iconCls: STAGE_ICON[r.stage],
        subject: r.subject,
      });
      if (date < min) min = date;
      if (date > max) max = date;
    }
    if (PAID.has(inv.status) && inv.paidAt) {
      events.push({ id: `${inv.id}:paid`, resourceId: inv.id, kind: 'paid', name: 'Paid', startDate: inv.paidAt, duration: 0, durationUnit: 'day', draggable: false, resizable: false, eventColor: 'green', iconCls: 'fa fa-circle-check' });
    }
    if (inv.issueDate < min) min = inv.issueDate;
    if (inv.dueDate > max) max = inv.dueDate;
  }
  const start = addDays(min, -3);
  let end = addDays(max, 7);
  if (daysBetween(start, end) < 35) end = addDays(start, 35);
  return { today, startDate: start, endDate: end, resources, events };
}
