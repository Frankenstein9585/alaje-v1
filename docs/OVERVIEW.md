# Alaje

**An AI business manager that lives inside WhatsApp.**

A shop owner writes *"Sold 3 cartons of Indomie to Chika for 42k"* and that one
message records the sale, drops the stock count, works out what Chika now owes,
and replies with the numbers. No app, no forms, no setup.

- Repository: <https://github.com/Frankenstein9585/alaje-v1>
- Landing page: <https://alaje.vercel.app>
- System flow diagrams: <https://claude.ai/code/artifact/f101f751-449b-458a-bb27-f63378393388>
  (private by default; share it from the page's own menu before sending it on)

---

## 1. The problem

Most Nigerian SMEs are not running on any system. They run on WhatsApp, memory,
an exercise book, and sometimes a spreadsheet. ERP systems that could fix this
exist and do not get adopted: too expensive, too slow to learn, and built for a
much bigger company than a shop selling provisions.

**What we are actually competing with is a paper notebook, a bad memory, and a
WhatsApp history nobody ever reads back.** Not Odoo, not Zoho. That framing
decides almost everything below. The product wins by asking nothing new of the
owner, not by having more features than the alternatives.

## 2. What it does

The owner talks to it the way they would talk to an employee who keeps the
books. It is an agentic system with tool access, not a command bot: there is no
syntax to learn and no menu to navigate.

| The owner says | What happens |
| --- | --- |
| "I got 20 cartons of Indomie, 12k each" | Stock recorded, cost price captured |
| "Sold 3 to Chika for 42k" | Sale logged, stock down to 17, Chika owes 42,000 |
| "How much Indomie remain?" | Reads the live count back |
| "Chika don pay 20k" | Payment recorded, balance now 22,000 |
| "Who dey owe me?" | Everyone owing, largest first |
| "Wetin I make today?" | Revenue, cost of goods, real profit |
| "Send Chika her invoice" | PDF invoice arrives in the chat, ready to forward |
| "No, undo that" | Entry voided, stock restored, reports corrected |

All of the above are verified working against a live model on exactly that
phrasing. The pidgin is not decoration: it is how the users actually type.

## 3. How a message becomes a ledger entry

See the [flow diagrams](https://claude.ai/code/artifact/f101f751-449b-458a-bb27-f63378393388)
for this visually. In short:

```
WhatsApp Cloud API
  -> POST /webhook
  -> verify X-Hub-Signature-256          (401 and stop if bad)
  -> return 200 immediately              (Meta retries anything slow)
  -> claim the message id                (a retry stops here: one reply, ever)
  -> read receipt + typing indicator     (an agent turn takes seconds)
  -> resolve the business by phone       (deterministic, in code, not the model)
  -> onboarding? name it and stop
  -> no text? say what is not supported and stop
  -> load the last 10 turns
  -> agent loop
  -> reply, then store both turns
```

The agent loop itself is bounded. Each round the model may call tools; every
call is parsed, validated with Zod, executed, and logged. When the model stops
calling tools, its text is the reply.

**Four guards run before any reasoning happens**, and each one short-circuits.
The ordering is the security model: by the time the model sees anything, which
business this is has already been decided by code.

## 4. Architecture

Node 20 and TypeScript, Express 5, MySQL via Drizzle, Vitest, pino.

```
src/whatsapp/    channel edge: signature, parsing, sending, webhook
src/handler.ts   dedupe -> ack -> resolve -> onboard -> agent -> history
src/agent/       llm port, provider adapter, loop, prompt, tools
src/businesses/  resolution and onboarding copy
src/db/          schema and the Drizzle store
src/store.ts     the persistence port
```

### Three ports, one reason

`Store`, `WhatsAppSender` and `LlmClient` are interfaces. That is what makes the
system testable without MySQL, a Meta account, or an API key, and it is what
lets model output be scripted rather than hoped for. It also made switching LLM
providers a one file change when the deadline forced that decision.

### Provider independence

The LLM adapter speaks the OpenAI chat completions format, which DeepSeek,
OpenRouter, Groq, Together and OpenAI all accept. Changing provider is three
environment variables. Currently running DeepSeek.

## 5. Data model, and the decisions inside it

`businesses` `products` `customers` `transactions` `messages` `tool_call_logs`
`processed_messages`

Five decisions worth defending:

**`products.normalized_name` carries uniqueness, not `name`.** "Indomie",
"indomie " and "Indomies" are one product to a shop owner. Three rows would
quietly break every stock count.

**`transactions.seq` is the ordering key, not `created_at`.** MySQL `TIMESTAMP`
is second granularity, so two entries in the same second sort arbitrarily. We
found this when "undo that" reversed the wrong sale.

**`transactions.group_id` ties rows written from one thing the owner said.**
Undoing has to reverse all of them or it leaves half an entry behind.

**Balances are computed from transactions, never stored.** A running balance
column and a voided transaction drift apart the moment anyone corrects
anything, and a debt figure nobody trusts is worse than no figure.

**Cost of goods is snapshotted onto the sale.** Restocking at a new price must
not silently rewrite last month's profit.

Money is `DECIMAL` in the database and integer kobo in every calculation. There
is a test that sums ten 10 kobo sales and expects exactly 1.00, which floating
point would not give.

## 6. Guardrails

These are the things a judge is most likely to probe.

**Identity is never the model's decision.** The tool context carries the
business resolved from the phone number. No tool accepts a business id, so
there is no way for a model to express acting on another shop, even if
instructed to. There is a test where the model tries to smuggle one in and it
is stripped.

**The reasoning step has no database access.** Every write goes through a
named, validated, logged tool.

**Every tool call is logged** with arguments, result and success, by the
registry wrapper rather than by each tool, so a new tool cannot forget.

**Invalid arguments are rejected, never coerced.** A guessed amount is worse
than an asked question.

**The agent never invents numbers.** Tools return a `display` string built in
code; the model takes the figures from it exactly and writes its own sentence
around them.

**Every path returns a reply.** Provider outage, iteration cap, empty model
turn, thrown tool, unsupported voice note. The owner always gets words.

## 7. Conversational UX

This is judged on how it reads, so these are requirements rather than polish.

- One or two short lines. It is a chat on a phone.
- **The echoed numbers are the error catching mechanism.** Reading "42,000"
  back is how the owner notices "42k" was misheard, which makes formatting a
  correctness concern rather than a cosmetic one.
- Read receipt and typing indicator fire before the agent runs. An agent turn
  takes three to five seconds and silence reads as broken.
- Never a dead end. An unsupported voice note says what is not supported *and*
  what to do instead.
- Markdown is stripped on the way out, since WhatsApp renders `**stars**`
  literally.
- Never expose tool names, ids or JSON.

## 8. What it can and cannot do

### Can

Two message onboarding. Stock in and out with low stock alerts. Customers and
what they owe. Payments, including forwarded bank credit alerts. Undo. Reports
for today, the last seven days, and the month, with real profit. PDF invoices
sent through WhatsApp. Renaming the business, correcting a product's unit,
cost, or alert level.

### Cannot

- **Expenses.** No tool writes one, so "profit" is really gross margin: revenue
  minus cost of goods. Worth saying out loud rather than being caught on it.
- **Voice notes and receipt photos.** Declined politely, not supported.
- **Proactive alerts.** Nothing is ever sent unprompted. Needs a scheduler and
  approved WhatsApp message templates, which is a policy problem as much as a
  code one.
- **Editing a recorded sale.** Only undo of the most recent entry, then
  re-record.
- **Renaming or deleting a product or customer.** A typo becomes a permanent
  second row.
- **Web dashboard, PDF reports, multiple phone numbers per business.**

The last one is documented with its migration in `plans/phase-2.md` section 13.
Today a phone number *is* a business, so an owner and an assistant on two
handsets would be two separate shops.

## 9. How we know it works

**146 automated tests** covering the tools, the loop, the adapter, phone
normalisation, signature verification, money arithmetic and multi tenant
scoping. They script the model and use an in memory store, so they are fast and
deterministic.

**A live smoke test** (`npx tsx scripts/smoke.ts`) runs the real loop, real
tools and real prompt against the real model and the real database, on messages
written the way owners actually type.

That distinction earned its keep. The tests were green and the smoke test
immediately found three bugs they could not:

1. **Every tool call was failing with a 400.** Schemas were being emitted in
   the OpenAPI 3.0 dialect, where an exclusive minimum is `exclusiveMinimum:
   true`, and the provider validates draft 7, which wants a number. Every tool
   broke at once, which looked like a model that had stopped calling tools.
2. **The model claimed success without acting.** Told a customer had paid, it
   replied "Recorded Chika's 20,000 payment" having called nothing. That is
   worse than an error because it looks right.
3. **`record_sale` had a `paid` flag and the model set it on a message that
   never mentioned payment**, inventing money that never arrived.

Then the first real WhatsApp messages found three more: a duplicate insert race
between parallel tool calls, an iteration cap that threw away completed work,
and a token limit hit with no text returned.

**The lesson worth repeating on stage: none of these were reachable by code
review or by unit tests.** They needed a real model and real traffic.

## 10. How this makes money

### The constraint that decides everything

A provisions shop nets somewhere around 150,000 to 900,000 naira a month.
Realistic software tolerance is **1,000 to 5,000 naira a month**, and even that
has to be collected without a card, since recurring card billing barely works
in this market.

The cost side is where the model choice already did business work. On DeepSeek
at roughly 1,500 tokens in and 200 out, a message costs well under a naira, so
a thousand messages a month lands around 900 naira. On a premium model the same
shop costs 15,000 a month and the subscription is underwater before anything
else is paid for.

**Cheap model tool routing is not a corner cut, it is what makes the unit
economics work at all.**

Meta helps too. User initiated service conversations are free, and the entire
core loop is user initiated. Proactive alerts would move into paid template
messages, which is a second reason that feature is not free to add. Meta
pricing changes; verify before relying on it.

### The wedge: freemium at 2,500 naira a month

Free tier capped at around 100 messages a month, enough for a shop to feel the
value and not enough to run a business on. Paid is unlimited, plus invoices and
reports.

This is the wedge, not the business. At 2,500 naira with perhaps 30 percent
converting, it takes tens of thousands of shops to make real revenue, and SME
churn in this market is punishing.

### The actual business

**1. Lending.** Alaje generates the thing that makes Nigerian SME lending
impossible today: verified cashflow. Daily revenue, inventory turnover,
receivables, and who actually pays on time. Most SME credit here dies on "no
financials", and a shop with six months of Alaje history has financials. The
assistant stays free or near free and the revenue is origination fees or a
share of interest on working capital lent against the ledger. An order of
magnitude per user above any subscription, and the incentives align: more usage
means better data means better underwriting. This is also the market our own
team already works in.

**2. Restocking, which is already half built.** `check_stock` knows what is
running low. The natural next message is "You are down to 3 cartons of Indomie.
Order 20 from your supplier for 240,000?" Distributors pay for that placement,
or we take margin. Highest revenue per user of the three, and it turns an
existing feature into a business line.

**3. Payments.** We already know Chika owes 22,000. "Send Chika a reminder with
a payment link" is a small feature and a merchant fee on every collection. The
caveat is that it drags toward payments licensing, so partner rather than
build.

### The moat is the ledger

Six months of history makes switching genuinely painful, and unlike the
assistant itself, that history cannot be copied by a competitor with the same
model and the same API. **The product is the wedge; the data is the asset.**

### The risk to name first

Distribution. Nobody discovers a WhatsApp number organically. Realistically the
route is through people who already hold shop networks: FMCG distributors,
microfinance banks, POS agent networks. That is also a fourth revenue line,
since those partners will pay for visibility into their own merchants.

## 11. Running it

```bash
npm install
cp .env.example .env          # fill in Meta credentials, DATABASE_URL, LLM key
npm run db:migrate            # apply the schema
npm run dev                   # tsx watch on :3000
npx ngrok http 3000           # public HTTPS for the Meta webhook
```

Webhook callback URL is `https://<host>/webhook`, verify token must match
`WHATSAPP_VERIFY_TOKEN`, and the `messages` field must be subscribed.

```bash
npm test                      # 146 tests
npx tsx scripts/smoke.ts      # live end to end against model + database
```

`src/env.ts` validates everything at boot and throws on anything missing. That
is deliberate: a missing app secret must never quietly degrade into "signature
check skipped".

---

# Slide outline

Fourteen slides, roughly six minutes. Each has the point to make, what to show,
and the line worth saying out loud.

**1. Title**
Alaje. An AI business manager that lives inside WhatsApp.
*Say:* "Everything you are about to see happens in a chat window."

**2. The problem**
A photo or mock of a paper exercise book next to a WhatsApp thread.
*Say:* "We are not competing with Odoo. We are competing with a notebook, a bad
memory, and a chat history nobody reads back."

**3. Why ERPs do not fix it**
Cost, training time, built for a bigger company.
*Say:* "The tools that could fix this exist. They do not get adopted."

**4. The one message**
Big on screen: *Sold 3 cartons of Indomie to Chika for 42k.*
Then the reply: *Sold 3 cartons of Indomie to Chika for 42,000. 17 cartons
left. Chika owes 42,000.*
*Say:* "One message. Sale recorded, stock updated, debt tracked, all three."

**5. Live demo**
Restock, sell, ask stock, record a payment, ask who owes, run the report, send
the invoice, undo. Eight messages.
*Say, while it is thinking:* "That typing indicator is real. It is calling a
model and a database."

**6. It learns the shop as you talk**
No catalogue, no customer list, no setup screen.
*Say:* "There is no setup step. The first time you mention Indomie, Indomie
exists."

**7. What is under it**
The flow diagram from the artifact, second figure.
*Say:* "Four guards run before the model sees anything. Which business this is
gets decided by code, never by the model."

**8. The guardrails**
Identity never the model's call. No writes outside the tool layer. Every call
logged. Never invents a number. Every path replies.
*Say:* "This is bookkeeping. The failure that matters is not a crash, it is
confidently wrong numbers."

**9. Correcting mistakes**
Show the undo.
*Say:* "Re-recording a right number after a wrong one double counts. So we
void, and voided entries stop counting everywhere: reports, balances,
invoices."

**10. What real testing found**
The three bugs the 146 green tests missed.
*Say:* "Our tests were green and the system was completely broken. Every tool
call was failing. You only find that by running it for real."

**11. How this makes money**
Free to start, 2,500 naira a month unlimited. Then the real line.
*Say:* "The subscription is the wedge, not the business. A shop with six months
of Alaje history is a shop a lender can finally underwrite, and that is the
market our team already works in."

**12. Why the economics work**
One number on screen: under 1 naira per message.
*Say:* "We route with a cheap model on purpose. On a premium model this shop
costs us 15,000 a month and the subscription is underwater. The engineering
choice is the business model."

**13. Honest limits**
Expenses, voice notes, receipt OCR, proactive alerts. Named as next, not hidden.
*Say:* "Profit here is gross margin. We track what stock costs, not rent and
diesel. That is the next tool, not a hard problem."

**14. Close**
Back to the chat window.
*Say:* "If they can already use WhatsApp, they can already use this. That is
the whole bet."

### Notes for whoever presents

- **Rehearse the demo against a fresh business.** Send the messages once
  beforehand and check the replies, then reset.
- **Have a screenshot of every demo message.** A tunnel dropping or a provider
  rate limit at the wrong moment is the one risk you cannot code around.
- **Do not promise anything on the landing page you cannot show.** Proactive
  alerts and PDF export are not built.
- **If a reply comes back wrong, use it.** Say "no, undo that" and let the undo
  do the work. A recovery is a better demo than a perfect run.
- **Expect "how do you make money" and "how do you reach these shops".** Slide
  11 answers the first. For the second: nobody finds a WhatsApp number on their
  own, so distribution runs through people who already hold shop networks, which
  means FMCG distributors, microfinance banks and POS agent networks. Naming
  that risk first is stronger than being handed it.
