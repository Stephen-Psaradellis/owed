# Owed

**An AI collections agent for freelancers.** Paste the email thread or a one-line brief
("Built the Shopify theme for Acme, $1,800, net 15, contact jo@acme.test"). Owed reads it,
bills the client through **PayPal Invoicing**, plans a polite-to-final follow-up schedule
tuned to the amount and the client's payment history, drafts every reminder, sends each
one through PayPal when it falls due, notices when the client pays and stops chasing, and
answers "who owes me what?" in plain English. Every agent step and every PayPal call is
shown live in a trace.

Built for the PayPal AI Hackathon. MIT licensed. PayPal **sandbox** only: no real money
moves.

## The problem

Freelancers lose real money to invoices that are late, forgotten or never sent. Chasing
is awkward, so it gets put off; when it finally happens it is either too soft to work or
too sharp for a client you want to keep. Accounting suites have reminder settings, but
they are one schedule for everyone. A freelancer does it by feel: a gentle heads-up for
the reliable retainer client, an early nudge for the one who always pays three weeks
late, a firmer note when the amount is big enough to matter.

## Who it is for

Solo designers, developers, writers, photographers and consultants who bill a handful of
clients a month, already use PayPal, and do not want to become their own accounts
receivable department.

## What the agent does

| Step | What happens | Where |
|---|---|---|
| 1. Read the brief | An LLM extracts client, contact, email, line items (hourly or fixed), currency, terms, due date and PO reference into strict JSON. A rule-based reader runs alongside it; every amount and email the model returns must appear in the brief, or that field is replaced from the reader. | `src/extract.js` |
| 2. Build the invoice | A pure function turns the extraction into a PayPal Invoicing v2 payload: decimal-string amounts in the right currency (zero-decimal for JPY, HUF, TWD), `payment_term` with PayPal's `NET_10/15/30/45/60/90` or `DUE_ON_DATE_SPECIFIED`, and the due date computed from the invoice date. | `src/invoice-payload.js` |
| 3. Bill | `create_invoice` (draft) then `send_invoice`; PayPal emails the client a payer link. | `src/paypal.js` |
| 4. Plan and draft | Three reminders (polite, firm, final) timed against the due date and tuned by client risk (new / low / medium / high, from payment history) and amount tier. A plan made late collapses missed stages into one catch-up instead of a burst. Each reminder is drafted for the day it will actually go out. | `src/schedule.js`, `src/drafts.js` |
| 5. Watch and chase | On every tick (every 60 s by default, or "Check payments") the agent calls `get_invoice` for each open invoice. Paid: remaining reminders are cancelled. Otherwise the most advanced due reminder goes out with `send_invoice_reminder`. A webhook endpoint does the same on `INVOICING.INVOICE.PAID`, and confirms with PayPal before acting. | `src/agent.js` |
| 6. Answer | "Who owes me what?", "What's overdue?", "What did I collect?", "Next reminders?", or a client by name. The figures are computed in code; the LLM only phrases them, and an answer that cites a figure not in the ledger is replaced by the computed one. | `src/answer.js` |

You can also: record an off-PayPal payment ("Juniper paid me by bank transfer" in chat, or
**Mark paid**), send the next reminder early (**Remind now**), and drag a reminder on the
timeline to a new day. The server checks the new date and rewrites the email for it: a
reminder moved past the due date changes from "due in 2 days" to "2 days overdue".

## How PayPal is used

All calls go to `https://api-m.sandbox.paypal.com`, authenticated with OAuth 2.0 client
credentials (token cached until shortly before expiry, one retry on 401, a
`PayPal-Request-Id` idempotency key on every POST). The base URL is pinned to the sandbox
in code; pointing it anywhere else is refused at startup.

| Endpoint | Tool name in the trace | When |
|---|---|---|
| `POST /v1/oauth2/token` | `oauth2_token` | first call, then on expiry |
| `POST /v2/invoicing/invoices` | `create_invoice` | step 3 (draft, `Prefer: return=representation`) |
| `POST /v2/invoicing/invoices/{id}/send` | `send_invoice` | step 3 |
| `GET /v2/invoicing/invoices/{id}` | `get_invoice` | every tick, before every reminder, after a webhook |
| `POST /v2/invoicing/invoices/{id}/remind` | `send_invoice_reminder` | when a reminder falls due, or Remind now |
| `POST /v2/invoicing/invoices/{id}/payments` | `record_payment_for_invoice` | Mark paid / "X paid me by cheque" |
| `GET /v2/invoicing/invoices` | `list_invoices` | available to the client; not used by the UI yet |
| `POST /v1/notifications/verify-webhook-signature` | `verify_webhook_signature` | incoming webhooks in sandbox mode |

The tool names match the **PayPal Agent Toolkit / MCP server** tools on purpose, so the
trace reads the same as an agent using those tools. Owed calls the REST API directly
instead of importing `@paypal/agent-toolkit`: in v1.11.0 the toolkit's `create_invoice`
has no `payment_term` or due-date field, and payment terms are the core of this product.
A direct client also lets demo mode run the exact same request code against the fake.

## How AI is used

The LLM never touches money directly. It steers a deterministic pipeline and every output
is checked in code:

| Task | Model's job | Guard |
|---|---|---|
| `extract_invoice` | brief to JSON | amounts and emails must appear in the brief; field-by-field fallback to the rule-based reader |
| `draft_{stage}_reminder` | write the email in the stage's tone for its send date | kept only if it still contains the invoice number, the amount and the pay link; template otherwise |
| `answer_question` | phrase the computed facts | every money figure must be one of the facts' figures |

Any OpenAI-compatible endpoint works (OpenAI, Groq, OpenRouter, Together, Mistral, a local
Ollama or LM Studio), set with three environment variables. With none set, a deterministic
demo model answers, and its output goes through the same JSON parser and validators as a
real model's. Model JSON is parsed tolerantly (code fences, leading prose, trailing commas,
smart quotes), and a failed or slow call degrades one step, never the run.

`llm-relay/` is a 90-line Cloudflare Worker that puts that same OpenAI interface over
Workers AI (Llama 3.3 70B, Llama 3.1 8B) behind a bearer token: `npx wrangler deploy`,
`npx wrangler secret put RELAY_TOKEN`, then `LLM_BASE_URL=https://<worker>/v1`,
`LLM_API_KEY=<the token>`, `LLM_MODEL=llama-3.3-70b,llama-3.1-8b`. The submitted demo uses it.

## Architecture

```
 Browser  public/  index.html, app.js (vanilla JS), styles.css
          public/build/timeline.js  (Bryntum Scheduler, bundled by esbuild)
    |  JSON API  +  GET /api/stream (Server-Sent Events: trace, ledger changes)
    v
 Node >= 20, node:http, no framework   src/server.js -> src/app.js (routes, SSE,
    |                                  static files, rate limit, redaction)
    |-- agent  src/agent.js   readBrief -> build -> create/send -> plan -> draft
    |                         tick: get_invoice -> stop | send_invoice_reminder
    |-- llm    src/llm.js     OpenAI-compatible /chat/completions, or demo model
    |-- paypal src/paypal.js  OAuth + Invoicing v2 over an injectable fetch
    |            '-- demo mode: src/mock/paypal-mock.js (in-memory fake, same contract)
    '-- ledger src/ledger.js  JSON document in data/ledger.json (atomic writes)
```

| File | Role |
|---|---|
| `src/config.js` | environment, sandbox pin, demo-mode detection, browser-safe mode |
| `src/extract.js` | rule-based reader, LLM prompt and field-by-field validation |
| `src/invoice-payload.js` | PayPal create-invoice payload (pure) |
| `src/schedule.js` | risk, amount tier, reminder plan, reschedule validation (pure) |
| `src/drafts.js` | reminder templates, LLM prompt, draft acceptance |
| `src/answer.js` | ledger facts, deterministic answers, LLM answer guard |
| `src/paypal.js` | PayPal REST client, traced, idempotent POSTs |
| `src/mock/paypal-mock.js` | the in-memory PayPal fake used in demo mode and tests |
| `src/agent.js` | the pipeline, tick, chat router, demo seed |
| `src/timeline.js` | ledger to Bryntum resources/events |
| `src/client/timeline.js` | the Bryntum Scheduler view (drag to reschedule) |
| `src/redact.js`, `src/bus.js` | secret redaction, trace ring buffer and pub/sub |

### API

| Method | Path | |
|---|---|---|
| GET | `/api/health` | mode (`paypal: sandbox|mock`, `llm: live|mock`), sample prompts |
| GET | `/api/ledger` | totals (owed / overdue / collected) and invoices with status and next action |
| GET | `/api/timeline` | Bryntum-ready resources and events |
| GET | `/api/stream` | SSE: `hello` (mode + recent trace), `trace`, `ledger`, `clear` |
| POST | `/api/chat` | `{ message, autoSend? }`: routes to preview, create, remind, mark paid, check, or answer |
| POST | `/api/invoices/preview` | `{ text }`: extraction, due date and reminder plan, no billing |
| POST | `/api/invoices` | `{ previewId }` or `{ text }`: create and send |
| POST | `/api/invoices/:id/remind` | send the next reminder now |
| POST | `/api/invoices/:id/mark-paid` | `{ method }`: record an external payment on PayPal |
| POST | `/api/invoices/:id/simulate-payment` | demo mode only: the client pays on the payer page |
| PATCH | `/api/reminders/:id` | `{ date: "YYYY-MM-DD" }`: reschedule and redraft |
| POST | `/api/agent/tick` | check every open invoice, send due reminders |
| POST | `/api/demo/seed`, `/api/demo/reset` | Run demo / clear |
| POST | `/api/webhooks/paypal` | PayPal webhook receiver (see below) |

## Run locally

Requires Node 20 or newer.

```bash
npm install     # also runs the build (bundles the Bryntum view into public/build/)
npm start       # http://localhost:3000
```

With no keys the app runs in **demo mode** and says so in a banner: invoices go to an
in-memory copy of the PayPal Invoicing endpoints above (same requests, same response
shapes, same status rules, nothing is emailed) and a deterministic demo model stands in
for the LLM. Click **Run demo** to bill four fictional clients at four points in the cycle.

`npm run dev` restarts on file changes. `npm run build` rebuilds the timeline bundle.

### With the PayPal sandbox

1. On developer.paypal.com, open **Apps & Credentials**, switch to **Sandbox**, and create
   (or open) an app. Copy its client ID and secret.
2. `cp .env.example .env` and set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
   Optionally set `INVOICER_EMAIL` to the sandbox business account's email.
3. `npm start`. The header chip now reads **PayPal sandbox**, the demo banner reflects it,
   and invoices appear in the sandbox business account. Pay one as a sandbox personal
   account from its payer link, then click **Check payments**: Owed sees it and stops the
   reminders.

### With a real LLM

Set `LLM_BASE_URL`, `LLM_MODEL` and (if the provider needs one) `LLM_API_KEY`, for example
`https://api.groq.com/openai/v1` with a Llama model, or `http://localhost:11434/v1` with
Ollama. Use a model that follows "return only JSON" instructions reliably; anything it
gets wrong falls back per field and is shown in the trace.

### Environment

| Name | Default | Purpose |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | empty | sandbox app credentials; absent = demo mode |
| `PAYPAL_WEBHOOK_ID` | empty | enables webhook signature verification in sandbox mode |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | empty | OpenAI-compatible endpoint; absent = demo model |
| `LLM_TIMEOUT_MS` | 25000 | per LLM call |
| `LLM_REASONING_EFFORT` | empty | sent as `reasoning_effort`; `minimal` keeps Gemini 3.x thinking short (some models refuse `none`) |
| `LLM_COOLDOWN_MS` | 60000 | after every model is busy (free-tier quota), skip the LLM this long and use the rule/template fallback |
| `INVOICER_NAME`, `INVOICER_BUSINESS`, `INVOICER_EMAIL` | Sam Rivera, Rivera Studio, empty | shown on invoices and reminder sign-offs |
| `DEFAULT_CURRENCY` | USD | when a brief uses a bare `$` |
| `POLL_INTERVAL_SECONDS` | 60 | background status checks (0 = off) |
| `PORT`, `HOST` | 3000, 127.0.0.1 (0.0.0.0 on Render) | |
| `DATA_DIR`, `OWED_PERSIST` | ./data, 1 | ledger storage; `OWED_PERSIST=0` keeps it in memory |
| `RATE_LIMIT_PER_MINUTE` | 60 | per IP, mutating requests only |
| `OWED_MOCK` | empty | `1` forces demo mode even with keys |

Secrets are read on the server only. They are never sent to the browser, never put in a
prompt, and every response, SSE message and log line passes through a redactor that strips
the configured secrets, bearer and basic auth headers and access tokens. Tests prove it.

### Webhooks

`POST /api/webhooks/paypal` accepts `INVOICING.INVOICE.*` events. In sandbox mode it needs
`PAYPAL_WEBHOOK_ID` and verifies each event with PayPal's
`/v1/notifications/verify-webhook-signature`; without it, it answers 501. In demo mode
events are accepted unverified (the trace says so). In both modes the event is only a
hint: the agent calls `get_invoice` and acts on what PayPal reports, so a forged "paid"
event cannot stop the reminders for an unpaid invoice. Register the URL
`https://<your-host>/api/webhooks/paypal` in the sandbox app's webhook settings with the
event *Invoicing invoice paid*. Polling keeps working without webhooks.

## Deploy (Render or similar)

`render.yaml` describes a free web service:

- Build command: `npm install` (the postinstall builds the timeline bundle)
- Start command: `npm start`
- Environment: Node 20+, plus the variables above as secrets. Render sets `PORT` and
  `RENDER`, so the server binds `0.0.0.0` automatically.

The free tier's disk is ephemeral and the service sleeps when idle: the ledger resets on
redeploy, and background polling pauses while asleep (the next request wakes it, and the
first tick catches up without sending a burst). For a judged demo that is fine; for real
use, point `DATA_DIR` at a persistent disk. Any Node host works the same way (Railway,
Fly.io, a VM).

## Tests

```bash
npm test        # node --test, no extra dependencies
```

62 tests cover brief extraction and its fallbacks (one-liners, email threads, hourly
work, currencies, deposits, invented amounts and emails rejected), invoice payload building
(decimal strings, zero-decimal currencies, PayPal term types, due dates from back-dated
invoice dates), reminder planning (risk, amount tiers, ordering, catch-up without bursts,
reschedule validation, drafts that change with the date), the PayPal fake's contract
(OAuth, both `Prefer` modes, error bodies, status rules), the agent end to end (create,
send, remind, the client pays, reminders stop; late ticks; mark paid; webhook
verification; chat routing; Run demo), the HTTP surface (headers, SSE, limits, rate
limiting, path traversal) and that no secret appears in any response, stream, error or log.

## Bryntum licensing

The timeline uses **Bryntum Scheduler** from the public trial package, installed as
Bryntum recommends:

```bash
npm i @bryntum/scheduler@npm:@bryntum/scheduler-trial
```

The trial is for evaluation, shows Bryntum's trial notice, and is not covered by this
repository's MIT licence; it is a dependency fetched from npm, not redistributed here.
The built bundle in `public/build/` is gitignored. Bryntum's trial code loads a
verification image from `bryntum.com`, which the Content-Security-Policy allows. A
production deployment beyond evaluation needs a Bryntum licence; switching is a one-line
change of the npm alias, with no code changes.

## Demo mode and data policy

All demo clients, people, emails (reserved `.test` domains) and amounts are invented. The
PayPal fake reproduces the response shapes and rules the agent depends on (IDs like
`INV2-XXXX-XXXX-XXXX-XXXX`, `DRAFT -> SENT -> PAID / MARKED_AS_PAID`, `remind` refused on a
paid invoice, duplicate invoice numbers refused, PayPal-style error bodies with
`debug_id`), and nothing in it comes from real PayPal data. The page shows a banner
whenever any part of the app is in demo mode.

## Limitations and next steps

- One freelancer per deployment; no login. Do not expose a deployment with real sandbox
  keys without putting it behind auth.
- Reminders go out through PayPal's own reminder email (with Owed's subject and note); a
  direct email channel with a reply inbox would let the agent read "paying Friday" replies
  and reschedule itself.
- Partial payments are mirrored but not planned for (no "remaining balance" reminders yet).
- Multi-currency ledgers show totals for the main currency; the API returns every currency.

## Licence

MIT, see `LICENSE`. Bryntum Scheduler is commercial software under its own licence.
