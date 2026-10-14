// Money helpers. Amounts are numbers in the server and decimal strings on the wire, the
// way PayPal wants them ("1800.00"; "1800" for zero-decimal currencies).

// PayPal's zero-decimal currencies.
export const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD']);

export const SUPPORTED_CURRENCIES = new Set([
  'AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS', 'JPY', 'MYR', 'MXN',
  'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'SGD', 'SEK', 'CHF', 'THB', 'USD',
]);

export function decimalsFor(currency) {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

export function roundMoney(value, currency = 'USD') {
  const f = 10 ** decimalsFor(currency);
  return Math.round((Number(value) + Number.EPSILON) * f) / f;
}

export function toPayPalValue(value, currency = 'USD') {
  return roundMoney(value, currency).toFixed(decimalsFor(currency));
}

const SYMBOL = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'CA$', AUD: 'A$' };

export function formatMoney(value, currency = 'USD') {
  const n = roundMoney(value, currency);
  const d = decimalsFor(currency);
  const whole = Number.isInteger(n) && d > 0;
  const body = n.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : d, maximumFractionDigits: d });
  return SYMBOL[currency] ? `${SYMBOL[currency]}${body}` : `${body} ${currency}`;
}
