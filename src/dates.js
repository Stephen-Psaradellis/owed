// Calendar-date helpers. Invoices live on whole days, so dates are ISO strings
// (YYYY-MM-DD) in UTC throughout the server. No time zones, no DST surprises.

export const DAY_MS = 86400000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function toISODate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && toISODate(t) === s;
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

// b - a, in whole days.
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}

export function maxDate(...dates) {
  return dates.filter(Boolean).sort().at(-1);
}

export function formatDate(iso) {
  if (!isISODate(iso)) return String(iso || '');
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${d}, ${y}`;
}

// Parse a date written by a person: 2026-10-30, Oct 30, October 30 2026, 30 Oct,
// 10/30/2026 (US order). Without a year, the next occurrence on or after `todayISO`.
export function parseLooseDate(text, todayISO) {
  const s = String(text || '').trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return build(+m[1], +m[2], +m[3]);
  m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) return withYear(+m[1], +m[2], m[3] ? normYear(+m[3]) : null, todayISO);
  const mon = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  m = s.match(new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`));
  if (m) return withYear(monthIndex(m[1]), +m[2], m[3] ? +m[3] : null, todayISO);
  m = s.match(new RegExp(`\\b(\\d{1,2})\\s+${mon}(?:,?\\s+(\\d{4}))?\\b`));
  if (m) return withYear(monthIndex(m[2]), +m[1], m[3] ? +m[3] : null, todayISO);
  return null;
}

function normYear(y) {
  return y < 100 ? 2000 + y : y;
}

function monthIndex(name) {
  return MONTHS.indexOf(name.slice(0, 3)) + 1;
}

function build(y, m, d) {
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isISODate(iso) ? iso : null;
}

function withYear(m, d, y, todayISO) {
  if (y) return build(y, m, d);
  const ty = Number(String(todayISO).slice(0, 4));
  const thisYear = build(ty, m, d);
  if (!thisYear) return null;
  return thisYear >= todayISO ? thisYear : build(ty + 1, m, d);
}
