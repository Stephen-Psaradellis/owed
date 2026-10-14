// Step 3b: write each reminder. The wording depends on the stage and on the date the
// reminder will actually go out (before due, on the day, N days overdue), so moving a
// reminder on the timeline rewrites it. Templates are the fallback and the demo model;
// a live LLM may rewrite them, and its draft is kept only if it still names the invoice
// number, the amount and the pay link.
import { daysBetween, formatDate, addDays } from './dates.js';
import { formatMoney } from './money.js';

export function draftContext(invoice, sendDate, me = 'Sam') {
  const overdue = daysBetween(invoice.dueDate, sendDate);
  return {
    first: (invoice.client.contact || '').split(/\s+/)[0] || 'there',
    company: invoice.client.name || '',
    number: invoice.number,
    amount: formatMoney(invoice.amount, invoice.currency),
    dueDate: formatDate(invoice.dueDate),
    payLink: invoice.payLink || '(PayPal link)',
    project: (invoice.items && invoice.items[0] && invoice.items[0].name) || 'the project',
    overdue,
    me,
    sendDate,
    replyBy: formatDate(addDays(sendDate, 5)),
  };
}

function whenLine(c) {
  if (c.overdue < 0) return `is due on ${c.dueDate} (in ${-c.overdue} day${c.overdue === -1 ? '' : 's'})`;
  if (c.overdue === 0) return `is due today, ${c.dueDate}`;
  return `was due on ${c.dueDate} and is now ${c.overdue} day${c.overdue === 1 ? '' : 's'} overdue`;
}

export function templateDraft(stage, c) {
  if (stage === 'polite') {
    return {
      subject: c.overdue <= 0 ? `Friendly reminder: invoice ${c.number} ${c.overdue === 0 ? 'is due today' : `due ${c.dueDate}`}` : `Quick nudge on invoice ${c.number}`,
      body:
        `Hi ${c.first},\n\nHope all is well. A quick heads-up that invoice ${c.number} for ${c.amount} (${c.project}) ${whenLine(c)}.\n\n` +
        `You can pay by card or PayPal here: ${c.payLink}\n\nThanks so much,\n${c.me}`,
    };
  }
  if (stage === 'firm') {
    return {
      subject: `Invoice ${c.number} is ${c.overdue > 0 ? `${c.overdue} days overdue` : 'coming due'}`,
      body:
        `Hi ${c.first},\n\nFollowing up on invoice ${c.number} for ${c.amount}, which ${whenLine(c)}. ` +
        `Could you let me know when payment is scheduled? If something on the invoice needs fixing, reply and I will sort it out today.\n\n` +
        `Pay online: ${c.payLink}\n\nThank you,\n${c.me}`,
    };
  }
  return {
    subject: `Final reminder: invoice ${c.number} (${c.amount})`,
    body:
      `Hi ${c.first},\n\nInvoice ${c.number} for ${c.amount} ${whenLine(c)}, and I have not been able to reach anyone about it. ` +
      `Please arrange payment by ${c.replyBy}: ${c.payLink}\n\n` +
      `If paying in full by then is not possible, reply with a date that works and I will hold further reminders until then.\n\nRegards,\n${c.me}`,
  };
}

export const DRAFT_SYSTEM = `You write short payment reminder emails for a freelancer.
Return ONLY JSON: {"subject": string, "body": string}. Body under 110 words, plain text,
warm and professional, never threatening, no legal claims, no late fees unless given.
Keep the invoice number, the amount and the payment link exactly as given.`;

export function draftPrompt(stage, c) {
  const tone = { polite: 'friendly and light', firm: 'clear and direct, still courteous', final: 'serious and specific, still respectful' }[stage];
  return JSON.stringify({ stage, tone, client_first_name: c.first, company: c.company, invoice_number: c.number, amount: c.amount, due_date: c.dueDate, days_overdue: Math.max(0, c.overdue), days_until_due: Math.max(0, -c.overdue), pay_link: c.payLink, project: c.project, sign_off_name: c.me, reply_by: c.replyBy });
}

// Keep a model draft only if it carries the facts that make it actionable.
export function acceptDraft(data, c) {
  if (!data || typeof data.subject !== 'string' || typeof data.body !== 'string') return null;
  const subject = data.subject.trim().slice(0, 140);
  const body = data.body.trim().slice(0, 1500);
  if (!subject || !body) return null;
  if (!body.includes(c.number) && !subject.includes(c.number)) return null;
  if (!body.includes(c.amount) && !subject.includes(c.amount)) return null;
  if (c.payLink && !body.includes(c.payLink)) return null;
  return { subject, body };
}
