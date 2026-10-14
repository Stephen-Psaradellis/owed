// Step 3: plan the follow-ups. Three stages (polite -> firm -> final), timed against the
// due date and tuned by two things a freelancer would weigh: how the client has paid
// before, and how much is at stake. Pure functions, unit-tested.
import { addDays, daysBetween, maxDate } from './dates.js';
import { formatMoney } from './money.js';

export const STAGES = ['polite', 'firm', 'final'];

// Offsets in days relative to the due date, per client risk level.
const OFFSETS = {
  low: { polite: -1, firm: 7, final: 21 },
  new: { polite: -2, firm: 5, final: 14 },
  medium: { polite: -2, firm: 4, final: 12 },
  high: { polite: -3, firm: 3, final: 10 },
};
const MIN_GAP = { polite: 1, firm: 2, final: 3 }; // days after the previous event

export function assessRisk(history) {
  const h = history || {};
  const n = Number(h.invoices) || 0;
  if (!n) return { level: 'new', reason: 'first invoice for this client' };
  const late = Number(h.paidLate) || 0;
  const avg = Number(h.avgDaysLate) || 0;
  if ((Number(h.unpaidOverdue) || 0) > 0) return { level: 'high', reason: 'another invoice from this client is already overdue' };
  if (avg >= 10 || late / n >= 0.5) return { level: 'high', reason: `paid ${late} of ${n} past invoices late, ${avg} days on average` };
  if (late > 0 || avg >= 3) return { level: 'medium', reason: `paid ${late} of ${n} past invoices late` };
  return { level: 'low', reason: `paid all ${n} past invoices on time` };
}

export function amountTier(amount) {
  const a = Number(amount) || 0;
  if (a >= 2500) return 'large';
  if (a < 500) return 'small';
  return 'medium';
}

// Returns { risk, tier, reminders: [{ stage, scheduledAt, status, reason }], rationale }.
// Stages already in the past when the plan is made collapse: the latest becomes due
// today ("catch-up"), earlier ones are skipped, so a late plan never fires a burst.
export function planReminders({ issueDate, dueDate, amount, currency = 'USD', history, today }) {
  const risk = assessRisk(history);
  const tier = amountTier(amount);
  const off = { ...OFFSETS[risk.level] };
  if (tier === 'large') {
    off.polite -= 2; // a heads-up early enough for an accounts-payable cycle
    off.firm -= 1;
    off.final -= 3;
  } else if (tier === 'small' && risk.level === 'low') {
    off.polite = 0;
  }

  let prev = issueDate;
  const planned = STAGES.map((stage) => {
    const ideal = addDays(dueDate, off[stage]);
    const date = maxDate(ideal, addDays(prev, MIN_GAP[stage]));
    prev = date;
    return { stage, scheduledAt: date, status: 'planned', reason: null };
  });

  const past = planned.filter((r) => r.scheduledAt < today);
  if (past.length) {
    const catchUp = past.at(-1);
    for (const r of past) {
      if (r === catchUp) {
        r.reason = `catch-up: was due ${r.scheduledAt}, plan made later`;
        r.scheduledAt = today;
      } else {
        r.status = 'skipped';
        r.reason = 'superseded: the invoice was already past this stage when the plan was made';
      }
    }
    // Keep the spacing after a catch-up.
    let last = today;
    for (const r of planned) {
      if (r.status !== 'planned' || r === catchUp) continue;
      if (r.scheduledAt <= last || daysBetween(last, r.scheduledAt) < MIN_GAP[r.stage]) r.scheduledAt = addDays(last, Math.max(MIN_GAP[r.stage], 3));
      last = r.scheduledAt;
    }
  }

  const desc = (r) => {
    const d = daysBetween(dueDate, r.scheduledAt);
    return d === 0 ? 'on the due date' : d < 0 ? `${-d} day${d === -1 ? '' : 's'} before due` : `${d} day${d === 1 ? '' : 's'} after due`;
  };
  const active = planned.filter((r) => r.status === 'planned');
  const rationale =
    `Client risk ${risk.level} (${risk.reason}), ${tier} amount (${formatMoney(amount, currency)}): ` +
    (active.length ? active.map((r) => `${r.stage} ${desc(r)}`).join(', ') : 'nothing left to schedule') +
    '.';
  return { risk, tier, reminders: planned, rationale };
}

// Validate a manual reschedule (the timeline drag). Returns an error string or null.
export function rescheduleError({ reminder, invoice, date, today }) {
  if (!reminder) return 'Reminder not found';
  if (reminder.status !== 'planned') return `Only planned reminders can move (this one is ${reminder.status})`;
  if (!invoice || ['PAID', 'MARKED_AS_PAID', 'CANCELLED'].includes(invoice.status)) return 'This invoice is closed';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return 'Date must be YYYY-MM-DD';
  if (date < today) return 'A reminder cannot be moved into the past';
  if (date <= invoice.issueDate) return 'A reminder must come after the invoice was sent';
  if (daysBetween(today, date) > 180) return 'That is more than six months out';
  return null;
}
