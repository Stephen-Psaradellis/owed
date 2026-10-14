# Owed: Devpost submission draft

**Tagline:** An AI collections agent for freelancers: paste the brief, it bills the client
through PayPal and chases the invoice until it is paid.

**Links (fill in before submitting):** demo `<Render URL or "run locally">` · repo
https://github.com/Stephen-Psaradellis/owed · video `<YouTube URL, under 3 minutes>`

**Prizes targeted:** Best Use of Agentic Commerce · Best Use of PayPal + AI · Bryntum
sponsor prize (Scheduler)

---

## Inspiration

Every freelancer has an invoice they are not chasing right now. Asking for money you are
owed feels awkward, so it slips: the invoice goes out a week late, the reminder never
goes out, and the client who always pays late keeps paying late. Accounting tools offer
one reminder schedule for everyone. A good bookkeeper does something smarter: nudges the
reliable retainer client gently, chases the habitually late one early, and gets firmer as
the amount and the days add up. We wanted that bookkeeper as an agent that does the work,
not a dashboard that tells you to do it.

## What it does

You paste what you already have: an email thread with the client, or a line like "Built
the Shopify theme for Acme, $1,800, net 15, contact jo@acme.test". Owed:

- **reads it**: client, contact, billing email, line items (fixed or hourly), currency,
  terms, due date, PO number;
- **bills it**: creates and sends a PayPal invoice, with PayPal's own payment terms and a
  payer link the client can pay by card or PayPal;
- **plans the chase**: a polite heads-up, a firm follow-up and a final reminder, timed by
  the client's payment history and how much is at stake, each email drafted for the exact
  day it will go out;
- **watches PayPal**: on a schedule (and on webhooks) it checks every open invoice. Paid?
  The remaining reminders are cancelled. Due? The right reminder goes out through PayPal;
- **answers**: "Who owes me what?", "What's overdue?", "What did I collect this month?"

The dashboard shows the ledger (owed, overdue, collected), a **Bryntum Scheduler**
timeline of every invoice's term, overdue stretch, reminders and payment, a chat box for
the agent, and a live trace of every agent step and every PayPal call. Drag a reminder on
the timeline and the agent re-validates the date and rewrites the email: "due in 2 days"
becomes "2 days overdue". **Run demo** bills four fictional clients in one click: a new
client, a habitually late one who is now overdue (the firm reminder goes out
immediately), one who pays during the demo (its reminders stop), and a reliable retainer.

## How we built it

- **Node 20+, no framework**: `node:http`, a JSON API and one Server-Sent Events stream
  that carries the trace. The ledger is a JSON document written atomically.
- **PayPal Invoicing v2** over OAuth 2.0 client credentials, sandbox only (the base URL is
  pinned in code). Idempotency keys on every POST, token caching, one retry on 401.
- **Any OpenAI-compatible LLM** for three tasks: extracting the brief, drafting reminders,
  and phrasing answers. Configured by three environment variables, so it runs on a free
  tier or a local model.
- **Bryntum Scheduler** (trial package) bundled with esbuild: one row per invoice, the
  payment term as a bar, reminders as draggable milestones, a today marker, tooltips with
  the drafted subject line.
- **Vanilla JS front end** with light and dark themes and a phone layout.
- **Demo mode**: with no keys, a faithful in-memory fake of the Invoicing endpoints (same
  request code path, same response shapes and status rules) and a deterministic demo
  model run the whole app, behind a visible banner.

## The PayPal + AI part

PayPal is where the money and the truth live; the agent never decides on its own that an
invoice is paid. It calls `create_invoice` and `send_invoice` to bill, `get_invoice` before
every reminder and on every tick, `send_invoice_reminder` to chase,
`record_payment_for_invoice` when you tell it "Juniper paid by bank transfer", and verifies
webhooks with PayPal before trusting them. The trace names each call with the same tool
names as the PayPal Agent Toolkit and MCP server.

The AI is kept on a short leash where money is involved. The model turns messy threads
into structured invoices, but every amount and email it returns must appear in the brief,
or that field is replaced by a rule-based reader. Its reminder drafts are kept only if they
still contain the invoice number, the amount and the pay link. Its answers are thrown away
if they mention a figure that is not in the ledger. The trace shows when any of these
guards fire.

## AI tools used and how

- **At runtime:** an OpenAI-compatible chat-completions model (provider chosen by
  environment variables) extracts invoice fields from briefs and threads, writes the
  polite, firm and final reminder emails for their send dates, and phrases answers to
  ledger questions. Without a model configured, a deterministic demo model stands in.
- **To build it:** the code, tests and documentation were written with **Claude Code**
  (Anthropic's AI coding agent), directed and reviewed by the team.
- **PayPal developer tools:** the PayPal Invoicing v2 REST API in the sandbox. We evaluated
  `@paypal/agent-toolkit` 1.11.0 and kept its tool names, but call the REST API directly
  because the toolkit's `create_invoice` has no payment-term or due-date field.
- **The demo video:** recorded by a scripted browser (Playwright) driving the real app, with
  a synthesized narration voice (Microsoft neural text-to-speech); the scripts are in `video/`.

## Challenges we ran into

- **Late plans and missed days.** If an invoice is entered after it is already overdue,
  or the server sleeps for a week, a naive scheduler fires every missed reminder at once.
  Owed collapses missed stages into one catch-up and skips the rest, out loud.
- **Words that depend on dates.** "Due in 2 days" is wrong the moment a reminder moves.
  Drafts are tied to their send date and rewritten whenever the date changes.
- **Trusting events.** A webhook saying "paid" is a hint. The agent re-reads the invoice
  from PayPal before cancelling anything, so a forged event changes nothing.
- **Making demo mode honest.** The fake PayPal follows the real contract (IDs, statuses,
  error bodies, `remind` refused on a paid invoice), so the same client code runs against
  both, and tests pin the contract.

## Accomplishments that we're proud of

- A complete loop, brief to paid, with no step where the AI can invent money.
- Reminders that adapt to the client: the habitually late client is chased days earlier
  than the reliable one, with the reasoning shown in plain English.
- A timeline you can manipulate: drag a reminder and the agent re-validates and rewrites it.
- 62 tests, including proof that no credential reaches a response, the trace or the logs.

## What we learned

Agentic commerce works best when the agent owns the tedious loop and the system of
record stays authoritative. Letting PayPal be the source of truth for status, and checking
it before every action, made the agent both simpler and safer.

## What's next

- A reply inbox so the agent can read "paying Friday" and reschedule itself.
- Partial-payment plans and balance reminders.
- Late-fee and early-payment-discount rules via PayPal's conditional invoice rules.
- Multi-user accounts with PayPal OAuth (Log in with PayPal) instead of app credentials.

## Built with

PayPal Invoicing API v2 (sandbox) · Node.js · Server-Sent Events · Bryntum Scheduler ·
esbuild · OpenAI-compatible LLM API · JavaScript
