# Owed: demo video script (target 2:45, hard limit 3:00)

A human records this. One take per scene is fine; cut between scenes.

## Before recording

1. `npm install` then `npm start` (demo mode is fine; with sandbox keys the header chip
   reads "PayPal sandbox", which is better if you have them).
2. Browser window about 1440 x 900, zoom 100%, light theme (moon button toggles).
3. Click **Reset** so the ledger is empty. Clear the chat box.
4. Have this brief in the clipboard:
   `Built a landing page for Fernhill Yoga, $950, due in 10 days, contact mia@fernhillyoga.test`
5. Hide bookmarks bar and notifications. Record the browser window only.

## Script

| Time | On screen / what to click | Narration |
|---|---|---|
| 0:00-0:15 | Empty dashboard. Slowly point at the KPI tiles (all $0). | "Freelancers lose real money to invoices that go out late and never get chased. Owed is an AI collections agent that does the chasing for you, through PayPal." |
| 0:15-0:40 | Click the agent box, paste the brief, press **Send**. The preview card appears. Point at client, $950, "Net 10, due <date>" and the follow-up chips. | "I paste what I already have, a line or a whole email thread. The agent pulls out the client, the amount, the terms and the due date, and plans the follow-ups before anything is sent. It can't invent money: every amount has to appear in what I pasted." |
| 0:40-0:55 | Click **Create & send via PayPal**. Point at the Live trace: `create_invoice 201`, `send_invoice 200`, then "Plan follow-ups". | "One click: it creates and sends a real PayPal invoice. Every step and every PayPal call shows up live in this trace." |
| 0:55-1:20 | Click **Run demo**. Wait for the toast. Point at the ledger: Brightline Dental "Overdue 8 days", Juniper & Rye "Paid via PayPal", the KPI tiles. | "Run demo bills four fictional clients at different stages. Brightline is eight days late and has paid late before, so the firm reminder already went out. Juniper paid through PayPal, so the agent noticed and cancelled its reminders." |
| 1:20-1:35 | Click the Brightline row to expand it. Point at the plan sentence and open the **firm** reminder draft. | "Each plan is tuned to the client and the amount, and it says why. Every reminder is written for the day it goes out." |
| 1:35-2:00 | Scroll to **Collections timeline** (Bryntum Scheduler). Hover Acme's teal envelope (tooltip shows the subject). Drag it three or four days to the right, past the due date (the end of the blue bar). Point at the toast with the new subject. | "This is the whole collections plan on a Bryntum Scheduler timeline. If I want Acme's reminder later, I drag it. The agent checks the date and rewrites the email: it said 'due in two days', now it says 'overdue'." |
| 2:00-2:20 | Back to the ledger. On **Northwind Labs** click **Client pays**. Point at the trace: `get_invoice ... PAID`, "3 reminders stopped". Point at the Collected tile going up. | "When a client pays, I don't have to remember to call off the reminders. The agent checks PayPal before every reminder, sees the invoice is paid, and stops." |
| 2:20-2:40 | Click the sample chip **Who owes me what?**, then type `What's overdue?` and send. | "And I can just ask. The numbers come straight from the ledger, and the AI isn't allowed to quote a figure that isn't in it." |
| 2:40-2:55 | Point at the header chips and the demo banner, then the trace filter **PayPal**. | "It runs on the PayPal sandbox with any OpenAI-compatible model, or fully offline in demo mode. Owed: send the invoice, get paid, stop chasing." |

## Notes for the editor

- If the demo dates differ on recording day, the narration still holds: Brightline is
  always 8 days overdue and Juniper always pays (the demo is relative to today).
- Keep the cursor still while narrating numbers; zoom in on the trace in post if it is
  hard to read.
- Upload to YouTube as Unlisted or Public, under 3:00, and paste the link into Devpost.
