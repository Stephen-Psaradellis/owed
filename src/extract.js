// Step 1 of the agent: turn a pasted thread or a one-line brief into invoice fields.
//
// Two paths produce the same shape:
//   - extractDeterministic(): a rule-based reader (regexes for money, terms, emails,
//     client names). It is the fallback for every field and the whole of demo mode.
//   - the LLM, whose JSON is checked by validateExtraction(). Any money amount or email
//     the model returns that does not appear in the brief is rejected, field by field,
//     and replaced from the deterministic reader. The model can tidy; it cannot invent.
import { addDays, isISODate, parseLooseDate, daysBetween } from './dates.js';
import { SUPPORTED_CURRENCIES, roundMoney } from './money.js';

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CODES = 'USD|EUR|GBP|CAD|AUD|JPY|CHF|NZD|SEK|NOK|DKK|MXN|SGD|HKD|PLN|CZK|BRL';
const WORDS = { dollars: 'USD', bucks: 'USD', euros: 'EUR', euro: 'EUR', pounds: 'GBP', quid: 'GBP' };
const PREFIX = { 'US$': 'USD', 'CA$': 'CAD', C$: 'CAD', 'A$': 'AUD', 'AU$': 'AUD', 'NZ$': 'NZD', $: null, '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const MONEY_RE = new RegExp(
  `(?:\\b(${CODES})\\s*)?(US\\$|CA\\$|C\\$|AU\\$|A\\$|NZ\\$|\\$|\\u20ac|\\u00a3|\\u00a5)?\\s?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?(\\s?[kK]\\b)?(?:\\s*(${CODES}|dollars|bucks|euros?|pounds|quid)\\b)?`,
  'g',
);
const GENERIC_LOCAL = new Set(['ap', 'ar', 'billing', 'accounts', 'accounting', 'invoices', 'invoice', 'finance', 'hello', 'info', 'admin', 'team', 'office', 'payables', 'contact', 'support', 'hi', 'mail']);
const LEAD_VERBS = /^(?:i\s+|we\s+)?(?:built|build|designed|design|developed|develop|wrote|write|made|created|delivered|did|finished|completed|shipped|redesigned|set\s+up|setup|produced|edited|shot|ran|provided|for)\s+/i;
const STOPWORDS_CAP = /^(?:Net|Due|Thanks|Hi|Hello|Dear|Invoice|Total|The|A|An|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)$/;
const NET_TERMS = new Set([10, 15, 30, 45, 60, 90]);

// ---------- money ----------

// Every amount in the text that carries a currency marker. Bare numbers ("6 pages",
// "net 15") are never money.
export function findMoney(text, defaultCurrency = 'USD') {
  const out = [];
  const s = String(text || '');
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(s))) {
    const [all, codeBefore, sym, intPart, frac, k, after] = m;
    if (!codeBefore && !sym && !after) continue;
    let value = Number(intPart.replace(/,/g, '') + (frac ? '.' + frac : ''));
    if (k) value *= 1000;
    if (!(value > 0)) continue;
    const afterCode = after ? (WORDS[after.toLowerCase()] || WORDS[after.toLowerCase().replace(/s$/, '')] || after.toUpperCase()) : null;
    const currency = codeBefore || afterCode || (sym ? PREFIX[sym] : null) || defaultCurrency;
    const lead = all.length - all.trimStart().length;
    out.push({ value: roundMoney(value, currency), currency, index: m.index + lead, end: m.index + all.trimEnd().length, raw: all.trim() });
  }
  return out;
}

// "12 hours at $55/hr", "$95 per hour x 10 hours"
function findRates(text, defaultCurrency) {
  const rates = [];
  const s = String(text || '');
  const moneyAt = (i) => findMoney(s.slice(i), defaultCurrency)[0];
  const a = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*(?:at|@|x|×)\s*/gi;
  let m;
  while ((m = a.exec(s))) {
    const money = moneyAt(m.index + m[0].length);
    if (!money || money.index !== 0) continue;
    const absEnd = m.index + m[0].length + money.end;
    const tail = s.slice(absEnd, absEnd + 12);
    const per = tail.match(/^\s*(?:\/|per\s*)\s*(?:hour|hr|h)\b/i);
    if (!per) continue;
    rates.push({ hours: Number(m[1]), rate: money.value, currency: money.currency, start: m.index, end: absEnd + per[0].length, moneyIndex: m.index + m[0].length + money.index });
  }
  const b = /(?:per\s*(?:hour|hr)|\/\s*(?:hour|hr|h))\s*(?:x|×|for)\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/gi;
  while ((m = b.exec(s))) {
    const before = findMoney(s.slice(0, m.index), defaultCurrency).at(-1);
    if (!before || s.slice(before.end, m.index).trim() !== '') continue;
    rates.push({ hours: Number(m[1]), rate: before.value, currency: before.currency, start: before.index, end: m.index + m[0].length, moneyIndex: before.index });
  }
  return rates;
}

// ---------- terms ----------

export function parseTerms(text, today) {
  const s = String(text || '');
  let m = s.match(/\bnet[\s-]*(\d{1,3})\b/i);
  if (m) return termsFromDays(Number(m[1]));
  if (/\b(?:due\s+(?:up)?on\s+receipt|upon\s+receipt|on\s+receipt|due\s+immediately|payable\s+immediately)\b/i.test(s)) return termsFromDays(0);
  m = s.match(/\b(?:due|payable|pay(?:ment)?)\s+(?:with)?in\s+(\d{1,3})\s*(day|week)s?\b/i) || s.match(/\bwithin\s+(\d{1,3})\s*(day|week)s?\b/i);
  if (m) return termsFromDays(Number(m[1]) * (m[2].toLowerCase() === 'week' ? 7 : 1));
  m = s.match(/\b(\d{1,3})[\s-]*days?\s+(?:terms|to\s+pay|payment\s+terms)\b/i);
  if (m) return termsFromDays(Number(m[1]));
  m = s.match(/\b(?:due|payable|pay)\s+(?:on|by|before)\s+([^\n,;.]{3,30})/i);
  if (m) {
    const date = parseLooseDate(m[1], today);
    if (date) return { type: 'DUE_ON_DATE', days: Math.max(0, daysBetween(today, date)), dueDate: date, label: `Due ${date}`, assumed: false };
  }
  return { ...termsFromDays(15), assumed: true };
}

export function termsFromDays(days) {
  const d = Math.max(0, Math.min(365, Math.round(Number(days) || 0)));
  if (d === 0) return { type: 'DUE_ON_RECEIPT', days: 0, dueDate: null, label: 'Due on receipt', assumed: false };
  return { type: 'NET', days: d, dueDate: null, label: `Net ${d}`, assumed: false };
}

// The PayPal payment_term for these terms. PayPal knows NET_10/15/30/45/60/90; any other
// day count becomes DUE_ON_DATE_SPECIFIED with the computed date.
export function paypalTermType(terms) {
  if (!terms || terms.type === 'DUE_ON_RECEIPT') return 'DUE_ON_RECEIPT';
  if (terms.type === 'NET' && NET_TERMS.has(terms.days)) return `NET_${terms.days}`;
  return 'DUE_ON_DATE_SPECIFIED';
}

export function dueDateFor(terms, invoiceDate) {
  if (terms && terms.type === 'DUE_ON_DATE' && isISODate(terms.dueDate)) {
    return terms.dueDate < invoiceDate ? invoiceDate : terms.dueDate;
  }
  return addDays(invoiceDate, terms && terms.type === 'NET' ? terms.days : 0);
}

// ---------- people and companies ----------

function titleCase(s) {
  return s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

function emailsIn(text, invoicerEmail) {
  const seen = new Set();
  const out = [];
  for (const e of String(text || '').match(EMAIL_RE) || []) {
    const low = e.toLowerCase().replace(/\.$/, '');
    if (seen.has(low) || (invoicerEmail && low === invoicerEmail.toLowerCase())) continue;
    seen.add(low);
    out.push(low);
  }
  return out;
}

function contactFor(text, email) {
  if (!email) return null;
  const s = String(text || '');
  const esc = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let m = s.match(new RegExp(`([A-Z][a-zA-Z'\\-]+(?:\\s+[A-Z][a-zA-Z'\\-]+){0,2})\\s*<${esc}>`, 'i'));
  if (m && /^[A-Z]/.test(m[1])) return m[1].trim();
  m = s.match(new RegExp(`${esc}\\s*\\(([A-Z][a-zA-Z'\\-]+(?:\\s+[A-Z][a-zA-Z'\\-]+){0,2})\\)`, 'i'));
  if (m) return m[1].trim();
  m = s.match(new RegExp(`([A-Z][a-zA-Z'\\-]+(?:\\s+[A-Z][a-zA-Z'\\-]+)?)\\s*\\(${esc}\\)`));
  if (m && !STOPWORDS_CAP.test(m[1].split(/\s+/)[0])) return m[1].trim();
  const local = email.split('@')[0];
  const first = local.split(/[._+-]/)[0];
  if (/^[a-z]{2,12}$/i.test(first) && !GENERIC_LOCAL.has(first.toLowerCase())) return titleCase(first.toLowerCase());
  return null;
}

const CAP_WORD = "[A-Z][A-Za-z0-9'\\-]*\\.?";
const CAP_PHRASE = `${CAP_WORD}(?:\\s+(?:&|and|of|${CAP_WORD}))*`;

function trimPhrase(p) {
  const words = p.trim().split(/\s+/);
  while (words.length && /^(?:&|and|of)$/i.test(words.at(-1))) words.pop();
  return words.slice(0, 5).join(' ').replace(/[.,]$/, '');
}

function companyFromDomain(text, email) {
  if (!email) return null;
  const domain = email.split('@')[1] || '';
  const label = domain.split('.')[0].toLowerCase();
  if (!label || /^(gmail|yahoo|outlook|hotmail|icloud|proton|protonmail|aol|live|me|mail)$/.test(label)) return null;
  const phrases = String(text).match(new RegExp(CAP_PHRASE, 'g')) || [];
  for (const p of phrases) {
    const words = trimPhrase(p).split(/\s+/);
    for (let n = words.length; n >= 1; n--) {
      const cand = words.slice(0, n).join(' ');
      const compact = cand.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (compact === label || (compact.length >= 4 && label.startsWith(compact) && label.length - compact.length <= 6)) return cand;
    }
  }
  return titleCase(splitDomainLabel(label.replace(/[-_]/g, ' ')));
}

const DOMAIN_SUFFIXES = ['dental', 'labs', 'lab', 'studio', 'studios', 'design', 'designs', 'media', 'films', 'bakery', 'group', 'tech', 'health', 'law', 'legal', 'consulting', 'creative', 'agency', 'digital', 'works', 'shop', 'store', 'foods', 'coffee', 'fitness', 'realty', 'homes', 'clinic', 'partners', 'ventures', 'brewing', 'builders', 'motors', 'outfitters', 'co', 'inc', 'hq', 'app', 'apps', 'cafe', 'kitchen', 'salon', 'yoga', 'press', 'books'];

// "brightlinedental" -> "brightline dental", using a short list of business-word endings.
function splitDomainLabel(label) {
  if (label.includes(' ')) return label;
  for (const suf of DOMAIN_SUFFIXES) {
    if (label.length > suf.length + 2 && label.endsWith(suf)) return `${label.slice(0, -suf.length)} ${suf}`;
  }
  return label;
}

export function findClientName(text, email) {
  const s = String(text || '');
  let m = s.match(/\b(?:bill\s+to|client|customer|company)\s*:\s*([^\n,;<]{2,80})/i);
  if (m) return trimPhrase(m[1]);
  m = s.match(new RegExp(`\\b[Ii]nvoice\\s+(${CAP_PHRASE})\\s+for\\b`));
  if (m && !STOPWORDS_CAP.test(m[1].split(/\s+/)[0])) return trimPhrase(m[1]);
  const re = new RegExp(`\\bfor\\s+(${CAP_PHRASE})`, 'g');
  while ((m = re.exec(s))) {
    const cand = trimPhrase(m[1]);
    if (!STOPWORDS_CAP.test(cand.split(/\s+/)[0])) return cand;
  }
  return companyFromDomain(s, email);
}

// ---------- line items ----------

function cleanLabel(raw, clientName) {
  let s = String(raw || '').replace(EMAIL_RE, ' ');
  if (clientName) s = s.split(clientName).join(' ').replace(/\s+(?:for|of)\s*(?=:)/gi, '');
  s = s
    .replace(/\b(?:net[\s-]*\d+|due\s+[^,;]*|contact\b.*|total\b.*|invoice\s*:?)\s*/gi, ' ')
    .replace(/[-–—:=@(]+\s*$/, '')
    .replace(/^\s*[-–—*•:>]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^(?:plus|and|also|with|including|then)\b\s*/i, '').replace(LEAD_VERBS, '').replace(/^(?:the|a|an|my|our|your)\s+/i, '').replace(/\s+(?:at|for|of|is|was|=)$/i, '').trim();
  return s;
}

function splitNameDesc(label) {
  const i = label.indexOf(':');
  if (i > 1 && i < label.length - 2) return { name: label.slice(0, i).trim(), description: label.slice(i + 1).trim() };
  return { name: label, description: '' };
}

function capFirst(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function findItems(text, { defaultCurrency = 'USD', clientName = null } = {}) {
  const s = String(text || '');
  const rates = findRates(s, defaultCurrency);
  const inRate = (idx) => rates.some((r) => idx >= r.start && idx < r.end);
  const money = findMoney(s, defaultCurrency);
  const items = [];
  let stated = null;
  // Clause boundaries: sentence punctuation, ", ", line breaks, and the end of any earlier
  // amount (text before an amount labels that amount, never the next one).
  const cuts = [];
  const boundaries = /[\n;!?]|\.(?!\d)|,(?=\s)/g;
  let bm;
  while ((bm = boundaries.exec(s))) cuts.push({ at: bm.index + bm[0].length, money: false });
  for (const mo of money) cuts.push({ at: mo.end, money: true });
  for (const r of rates) cuts.push({ at: r.end, money: true });
  cuts.sort((a, b) => a.at - b.at);
  const labelBefore = (idx, fallbackName) => {
    const before = cuts.filter((c) => c.at <= idx);
    const last = before.at(-1) || { at: 0, money: false };
    let label = cleanLabel(s.slice(last.at, idx), clientName);
    if (!label && !last.money && last.at > 0) {
      const prev = before.at(-2) || { at: 0 };
      label = cleanLabel(s.slice(prev.at, last.at - 1), clientName);
    }
    return splitNameDesc(label || fallbackName);
  };

  for (const r of rates) {
    const { name, description } = labelBefore(r.start, 'Additional hours');
    items.push({ name: capFirst(name), description, quantity: r.hours, unitAmount: r.rate, unit: 'HOURS', at: r.start });
  }
  for (const mo of money) {
    if (inRate(mo.index)) continue;
    // The words around this amount, stopping at the neighbouring clause boundaries.
    const clause = s.slice(Math.max(0, mo.index - 40), mo.index).split(/[;\n]|\.(?!\d)|,\s/).pop() + s.slice(mo.end, mo.end + 30).split(/[;,\n]|\.(?!\d)/)[0];
    if (/\b(?:total|in\s+all|altogether|grand\s+total|comes\s+to|overall)\b[^0-9]*$/i.test(s.slice(Math.max(0, mo.index - 30), mo.index))) {
      stated = mo.value;
      continue;
    }
    if (/\b(?:deposit|already\s+paid|paid\s+upfront|retainer\s+paid|received)\b/i.test(clause)) continue;
    const { name, description } = labelBefore(mo.index, 'Professional services');
    items.push({ name: capFirst(name).slice(0, 120), description: description.slice(0, 200), quantity: 1, unitAmount: mo.value, unit: 'QUANTITY', at: mo.index });
  }
  items.sort((a, b) => a.at - b.at);
  items.forEach((it) => delete it.at);
  return { items, stated, currencies: [...new Set([...money.map((m) => m.currency), ...rates.map((r) => r.currency)])] };
}

export function itemsTotal(items, currency = 'USD') {
  return roundMoney(items.reduce((sum, it) => sum + it.quantity * it.unitAmount, 0), currency);
}

// ---------- the deterministic reader ----------

// True when `who` is the invoicer: their full name, given name or surname.
export function isInvoicer(who, invoicerName = '') {
  const w = String(who || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const n = String(invoicerName || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!w || !n) return false;
  return w === n || n.split(' ').includes(w);
}

export function extractDeterministic(text, { today, defaultCurrency = 'USD', invoicerEmail = '', invoicerName = '' } = {}) {
  const s = String(text || '').slice(0, 8000);
  const warnings = [];
  const emails = emailsIn(s, invoicerEmail);
  const email = emails[0] || null;
  if (emails.length > 1) warnings.push(`Several emails in the brief; billing ${email}.`);
  const name = findClientName(s, email);
  const found = contactFor(s, email);
  const contact = isInvoicer(found, invoicerName) ? null : found;
  const { items, stated, currencies } = findItems(s, { defaultCurrency, clientName: name });
  const currency = currencies[0] || defaultCurrency;
  if (currencies.length > 1) warnings.push(`Mixed currencies (${currencies.join(', ')}); using ${currency}.`);
  let finalItems = items;
  if (!items.length && stated) finalItems = [{ name: 'Professional services', description: '', quantity: 1, unitAmount: stated, unit: 'QUANTITY' }];
  const total = itemsTotal(finalItems, currency);
  if (stated && items.length && Math.abs(stated - total) > 0.009) warnings.push(`Stated total ${stated} differs from line items ${total}; using the line items.`);
  const terms = parseTerms(s, today);
  if (terms.assumed) warnings.push('No payment terms found; assumed Net 15.');
  const ref = s.match(/\b(?:PO|P\.O\.|purchase\s+order)\s*(?:#|number|no\.?)?\s*:?\s*([A-Z0-9][A-Z0-9-]{2,19})\b/i);
  return {
    client: { name: name || (email ? email.split('@')[1] : null), contact, email },
    items: finalItems,
    currency,
    total,
    terms,
    reference: ref ? ref[1] : null,
    note: null,
    warnings,
  };
}

// ---------- the LLM path ----------

export const EXTRACT_SYSTEM = `You read freelancers' briefs and email threads and extract invoice fields.
Return ONLY a JSON object, no prose, with this shape:
{"client":{"name":string|null,"contact":string|null,"email":string|null},
 "items":[{"name":string,"description":string,"quantity":number,"unit_amount":number,"unit":"QUANTITY"|"HOURS"}],
 "currency":"USD"|ISO-4217,
 "terms":{"type":"NET"|"DUE_ON_RECEIPT"|"DUE_ON_DATE","days":number|null,"due_date":"YYYY-MM-DD"|null},
 "reference":string|null,"note":string|null}
Rules: the client is who PAYS, never the freelancer. Use only amounts and emails that appear
in the text; never invent them. Hourly work is quantity=hours and unit_amount=rate.
Exclude deposits already paid. If terms are absent use {"type":"NET","days":15}.
"note" is a one-line thank-you for the invoice, or null.`;

export function extractPrompt(text, today, { invoicerName = '', invoicerBusiness = '' } = {}) {
  const who = invoicerName
    ? `The invoicer (the freelancer sending this invoice, NOT the client) is ${invoicerName}${invoicerBusiness ? ` of ${invoicerBusiness}` : ''}. A greeting like "Hi ${invoicerName.split(/\s+/)[0]}" is addressed to the invoicer; never return them as the client name or contact.\n`
    : '';
  return `Today is ${today}.\n${who}\nBRIEF:\n"""\n${String(text).slice(0, 6000)}\n"""`;
}

function numbersInText(text, defaultCurrency) {
  const nums = new Set();
  for (const m of findMoney(text, defaultCurrency)) nums.add(m.value);
  for (const r of findRates(text, defaultCurrency)) {
    nums.add(r.rate);
    nums.add(roundMoney(r.rate * r.hours));
  }
  return nums;
}

// Check the model's JSON field by field against the brief and the fallback reader.
export function validateExtraction(raw, { text, today, defaultCurrency = 'USD', invoicerEmail = '', invoicerName = '', invoicerBusiness = '', fallback } = {}) {
  const fb = fallback || extractDeterministic(text, { today, defaultCurrency, invoicerEmail, invoicerName });
  const problems = [];
  const sources = { client: 'fallback', email: 'fallback', items: 'fallback', currency: 'fallback', terms: 'fallback' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { extraction: { ...fb, sources }, problems: ['model output was not a JSON object'] };
  }
  const out = structuredClone(fb);
  const lowText = String(text || '').toLowerCase();

  const c = raw.client && typeof raw.client === 'object' ? raw.client : {};
  const ownName = (v) => isInvoicer(v, invoicerName) || (invoicerBusiness && String(v).trim().toLowerCase() === invoicerBusiness.trim().toLowerCase());
  if (typeof c.name === 'string' && c.name.trim() && c.name.length <= 120 && ownName(c.name)) problems.push(`client "${c.name.trim()}" is the invoicer; kept ${fb.client.name || 'none'}`);
  else if (typeof c.name === 'string' && c.name.trim() && c.name.length <= 120) {
    out.client.name = c.name.trim();
    sources.client = 'llm';
  }
  if (typeof c.contact === 'string' && c.contact.trim() && c.contact.length <= 80) {
    if (ownName(c.contact)) problems.push(`contact "${c.contact.trim()}" is the invoicer; kept ${fb.client.contact || 'none'}`);
    else out.client.contact = c.contact.trim();
  }
  if (typeof c.email === 'string' && c.email.trim()) {
    const e = c.email.trim().toLowerCase();
    const valid = new RegExp(`^${EMAIL_RE.source}$`).test(e);
    if (valid && lowText.includes(e) && e !== String(invoicerEmail).toLowerCase()) {
      out.client.email = e;
      sources.email = 'llm';
    } else problems.push(`email "${e}" is not in the brief; kept ${fb.client.email || 'none'}`);
  }

  const cur = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
  if (SUPPORTED_CURRENCIES.has(cur)) {
    out.currency = cur;
    sources.currency = 'llm';
  }

  if (Array.isArray(raw.items) && raw.items.length) {
    const allowed = numbersInText(text, defaultCurrency);
    const items = [];
    let ok = true;
    for (const it of raw.items.slice(0, 20)) {
      const unitAmount = roundMoney(Number(it && (it.unit_amount ?? it.unitAmount ?? it.amount)), out.currency);
      const quantity = Number(it && (it.quantity ?? 1));
      const name = it && typeof it.name === 'string' ? it.name.trim().slice(0, 120) : '';
      if (!name || !(unitAmount > 0) || !(quantity > 0) || quantity > 10000) {
        ok = false;
        problems.push('an item was missing a name, quantity or amount');
        break;
      }
      if (!allowed.has(unitAmount) && !allowed.has(roundMoney(unitAmount * quantity))) {
        ok = false;
        problems.push(`amount ${unitAmount} is not in the brief`);
        break;
      }
      items.push({
        name,
        description: typeof it.description === 'string' ? it.description.trim().slice(0, 200) : '',
        quantity,
        unitAmount,
        unit: String(it.unit || '').toUpperCase() === 'HOURS' ? 'HOURS' : 'QUANTITY',
      });
    }
    if (ok && items.length) {
      out.items = items;
      sources.items = 'llm';
    }
  } else problems.push('model returned no line items');

  const t = raw.terms && typeof raw.terms === 'object' ? raw.terms : null;
  if (t) {
    const type = String(t.type || '').toUpperCase();
    const dueDate = t.due_date ?? t.dueDate ?? null;
    if (type === 'DUE_ON_DATE' && isISODate(dueDate) && daysBetween(today, dueDate) <= 365 && daysBetween(today, dueDate) >= -365) {
      out.terms = { type: 'DUE_ON_DATE', days: Math.max(0, daysBetween(today, dueDate)), dueDate, label: `Due ${dueDate}`, assumed: false };
      sources.terms = 'llm';
    } else if (type === 'DUE_ON_RECEIPT') {
      out.terms = termsFromDays(0);
      sources.terms = 'llm';
    } else if (type === 'NET' && Number.isInteger(Number(t.days)) && Number(t.days) > 0 && Number(t.days) <= 365) {
      // Keep the reader's "assumed" flag when both agree on the default.
      const days = Number(t.days);
      out.terms = fb.terms.assumed && days === 15 ? fb.terms : termsFromDays(days);
      sources.terms = 'llm';
    }
  }
  if (typeof raw.reference === 'string' && raw.reference.trim() && lowText.includes(raw.reference.trim().toLowerCase())) out.reference = raw.reference.trim().slice(0, 40);
  if (typeof raw.note === 'string' && raw.note.trim()) out.note = raw.note.trim().slice(0, 300);

  out.total = itemsTotal(out.items, out.currency);
  out.sources = sources;
  return { extraction: out, problems };
}

// What the agent still needs before it can bill.
export function missingFields(x) {
  const missing = [];
  if (!x || !x.items || !x.items.length || !(x.total > 0)) missing.push('amount');
  if (!x || !x.client || !x.client.email) missing.push('client email');
  if (!x || !x.client || !x.client.name) missing.push('client name');
  return missing;
}
