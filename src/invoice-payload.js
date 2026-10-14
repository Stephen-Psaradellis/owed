// Step 2: build the PayPal Invoicing v2 create-invoice request from an extraction.
// Pure function, unit-tested. Amounts become decimal strings in the invoice currency, the
// due date comes from the terms, and the payment_term uses PayPal's term types.
import { dueDateFor, paypalTermType } from './extract.js';
import { toPayPalValue, roundMoney, SUPPORTED_CURRENCIES } from './money.js';
import { isISODate } from './dates.js';

export function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.length === 1 ? { given_name: parts[0] } : { given_name: parts[0], surname: parts.slice(1).join(' ') };
}

// PayPal requires a unique invoice_number per merchant account.
export function makeInvoiceNumber(date, seq, prefix = 'OWED') {
  return `${prefix}-${String(date).replace(/-/g, '').slice(2)}-${String(seq).padStart(4, '0')}`;
}

export function buildInvoicePayload({ extraction, invoicer = {}, invoiceNumber, invoiceDate }) {
  if (!extraction) throw new Error('extraction is required');
  if (!isISODate(invoiceDate)) throw new Error('invoiceDate must be YYYY-MM-DD');
  const currency = String(extraction.currency || 'USD').toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(currency)) throw new Error(`Currency ${currency} is not supported by PayPal invoicing`);
  const items = (extraction.items || []).map((it) => {
    const quantity = Number(it.quantity);
    const unit = Number(it.unitAmount);
    if (!(quantity > 0) || !(unit > 0)) throw new Error(`Invalid line item: ${it.name}`);
    return {
      name: String(it.name || 'Professional services').slice(0, 200),
      ...(it.description ? { description: String(it.description).slice(0, 1000) } : {}),
      quantity: String(roundMoney(quantity, 'USD')),
      unit_amount: { currency_code: currency, value: toPayPalValue(unit, currency) },
      unit_of_measure: it.unit === 'HOURS' ? 'HOURS' : 'QUANTITY',
    };
  });
  if (!items.length) throw new Error('An invoice needs at least one line item');
  const client = extraction.client || {};
  if (!client.email) throw new Error('A client email is required to send a PayPal invoice');

  const dueDate = dueDateFor(extraction.terms, invoiceDate);
  const termType = paypalTermType(extraction.terms);
  const contactName = splitName(client.contact);
  const billing = {
    email_address: client.email,
    ...(contactName ? { name: contactName } : {}),
    ...(client.name ? { business_name: String(client.name).slice(0, 300) } : {}),
  };
  const invoicerName = splitName(invoicer.name);
  const payload = {
    detail: {
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      currency_code: currency,
      ...(extraction.reference ? { reference: String(extraction.reference) } : {}),
      note: extraction.note || `Thank you for your business${client.name ? `, ${client.name}` : ''}.`,
      term: extraction.terms && extraction.terms.label ? extraction.terms.label : undefined,
      memo: 'Created by Owed (AI collections agent)',
      payment_term: termType === 'DUE_ON_RECEIPT' ? { term_type: termType } : { term_type: termType, due_date: dueDate },
    },
    invoicer: {
      ...(invoicerName ? { name: invoicerName } : {}),
      ...(invoicer.businessName ? { business_name: invoicer.businessName } : {}),
      ...(invoicer.email ? { email_address: invoicer.email } : {}),
    },
    primary_recipients: [{ billing_info: billing }],
    items,
    configuration: {
      partial_payment: { allow_partial_payment: false },
      allow_tip: false,
      tax_calculated_after_discount: true,
      tax_inclusive: false,
    },
  };
  if (payload.detail.term === undefined) delete payload.detail.term;
  return { payload, dueDate, total: payloadTotal(payload), currency };
}

export function payloadTotal(payload) {
  const currency = payload.detail.currency_code;
  return roundMoney(payload.items.reduce((s, it) => s + Number(it.quantity) * Number(it.unit_amount.value), 0), currency);
}
