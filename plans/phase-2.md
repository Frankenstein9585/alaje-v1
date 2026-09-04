# Phase 2 Plan: The Agent Loop

**Status: mostly built.** Kept as the record of what was decided and why, with
each section marked against what actually shipped. Where the build diverged from
this plan, the divergence and its reason are noted inline rather than edited out.

| Section | Outcome |
| --- | --- |
| 2. Tool set | Built, and widened again after checking the landing page |
| 3.1 Transcript | Built |
| 3.2 Agent state | **Cut.** See the note in that section |
| 4. Architecture | Built as described |
| 5. Store additions | Built, plus customer methods and `voidLastEntry` |
| 6. Tool behaviour | Built as described |
| 7. Failure handling | Built |
| 8. Tests | Built, 97 passing |
| 9. Build order | Followed, with customers inserted after step 7 |

**Not built:** nothing from the agreed scope. `run_report` and invoicing shipped,
along with cost price, `undo_last` and `rename_business`.

**Known limitation:** one business, one phone number. See section 13.

**Never run:** no live model call, no applied migration, no real WhatsApp
message. Every test uses a scripted LLM client and an in-memory store.

## 1. What Phase 2 delivers

The MVP plan defines Phase 2 as "`record_sale`: sale creates a transaction,
decrements stock, flags low stock in the reply." That understates it. The larger
deliverable is the thing `record_sale` hangs off: replacing the Phase 1 stub
with a real LLM function-calling loop. Once that exists, each additional tool is
a small increment.

So Phase 2 is: **the agent loop, plus the tools required to make `record_sale`
actually demonstrable.**

## 2. On the tool set (read this first)

The MVP's three tools are `record_sale`, `record_expense`, `run_report`. That set
has two holes, one of which is a functional break rather than a missing nicety.

**Break: there is no way to get stock in.** `Product` has `stock_qty` and
`low_stock_threshold`. `record_sale` decrements the first and compares against
the second. Nothing creates or increases stock. Products are described as
"created on first mention in a sale", which means every product is born at
`stock_qty = 0` and goes negative on the sale that creates it. The low stock
warning then fires on literally every first sale, which makes the Phase 2
acceptance criterion ("selling past the threshold triggers the warning")
vacuously true and the demo beat meaningless. Restocking is also a real daily
activity for a shop owner, not a setup step. `add_stock` is required, not
optional.

**Hole: the agent can write but barely read.** The only read tool is
`run_report`, which returns aggregates. The single most natural question an owner
asks ("how much Indomie do I have left?") has no tool behind it, even though the
data is sitting in `Product`. `check_stock` is about twenty lines and closes it.

**Insurance: there is no correction path.** Amounts get mistyped, and voice notes
will get transcribed wrong once Phase 4 lands. Without a void, one bad number is
permanent and silently poisons every subsequent report. That is a bad property
for an accounting tool and a live demo risk.

What is correctly cut and should stay cut: customers, debts owed, invoices, and
multi-step confirmation. Those need `Customer` and `Invoice` tables and
conversation state machines. The plan's decision to drop them is sound and this
document does not reopen it.

Recommended Phase 2 tool set:

| Tool | Status | Why |
| --- | --- | --- |
| `record_sale` | planned | The phase deliverable. |
| `add_stock` | **added** | Without it `record_sale` cannot be demonstrated. |
| `check_stock` | **added** | Closes the read gap for the most common question. |
| `list_recent_transactions` | **added** | Prerequisite for correcting anything. |
| `void_transaction` | **added** | One mistyped amount otherwise corrupts every report. |
| `record_expense` | Phase 4 | Trivial once the loop exists, but stays in its phase. |
| `run_report` | Phase 3 | Unchanged. |

That is five tools in Phase 2 and seven by Phase 4. Three was thin; seven is a
coherent surface for "run a small shop from a chat window."

### What actually shipped, and why it grew again

Checking the landing page (`alaje.vercel.app`) after this section was written
found a worse gap than the ones above. "Know exactly who owes you what" is one
of four feature cards with nothing behind it, and the pitch's own canonical
example, *"Sold 3 cartons of Indomie to Chika for ₦42,000"*, would have silently
dropped Chika: the planned `record_sale(product, quantity, amount)` had nowhere
to put a customer.

So customers were pulled forward into Phase 2:

| Tool | Shipped | Note |
| --- | --- | --- |
| `add_stock` | yes | |
| `check_stock` | yes | |
| `record_sale` | yes | Gained optional `customer` and `paid` |
| `undo_last` | yes | Replaced the ref-based void; no `list_recent_transactions` |
| `record_payment` | yes | Added. Also covers forwarded bank credit alerts |
| `check_balance` | yes | Added |
| `run_report` | no | Still outstanding |

`list_recent_transactions` and ref-based voiding were dropped: "undo that" is how
people correct things in chat, and `undo_last` covers it without short references
or the agent state they would have needed.

## 3. The conversation-state problem

The MVP plan states there is no conversation state table because "nothing in
scope touches multi-step confirmation." But the same plan's error handling table
says: *"Ambiguous intent: agent asks a clarifying question instead of guessing
which tool to call."*

Those two decisions contradict each other. An agent with no memory asks "which
product did you mean?" and then receives "the Indomie" as a fresh message with no
recollection of having asked. It cannot act on the answer. The same gap breaks
every correction ("no, make that 4200"), which is exactly what
`void_transaction` exists to support.

The fix has two halves: a transcript for continuity, and a small structured
memory object for the things a transcript cannot guarantee.

### 3.1 Transcript

```
messages (id, business_id, wa_message_id, role, content, created_at)
```

Load the last N turns (start with N = 10, roughly one conversation) as message
history on each request. This carries tone and continuity.

### 3.2 Agent state

> **CUT, not built.** Kept because the reasoning still holds and this is the
> first thing to reach for when the transcript proves insufficient.
>
> Two of its three jobs were covered more cheaply. `focus.transactionRef`
> existed to make "undo that" resolvable; `undo_last` takes no arguments, so it
> needs no referent. `pending` existed to stop an incomplete record being
> written; nothing in the shipped tool set collects fields across turns, so
> there is nothing to hold half-finished yet.
>
> The remaining job, `counters` for capping repeated failures and off-topic
> churn, is genuinely unbuilt and remains a real gap. Nothing currently limits
> how many failing turns a conversation can burn.
>
> **Build this when Phase 4 lands.** Receipt OCR that extracts an amount but no
> vendor is exactly the slot-filling case `pending` was designed for, and at
> that point the guarantee is worth the table.

A transcript makes the model *likely* to remember. It does not make anything
*impossible*, and there are a few places where we want a guarantee. One row per
business, one validated JSON document:

```ts
interface AgentState {
  version: 1;
  mode: 'onboarding' | 'active';
  pending?: {                       // GATES: an incomplete record cannot be written
    kind: 'sale' | 'expense';
    args: Record<string, unknown>;
    missing: string[];
    expiresAt: string;
  };
  focus?: {                         // ADVISORY: reference resolution
    productId?: string;
    transactionRef?: string;
  };
  counters: { failures: number; offTopic: number };
  updatedAt: string;
}
```

**Why its own table, and why not a `conversations` table.** There is no
conversation entity in this system and there should not be one yet. A business is
a WhatsApp number and a number has exactly one thread with the bot, so business
and conversation are 1:1 and a `conversations` row would be pure indirection with
no payload of its own. Both `messages` and `agent_state` are therefore keyed on
`business_id`.

It stays out of the `businesses` row for a specific reason: `businesses` is the
identity table, read on the hot path of every inbound message by
`resolveBusiness`, while this document is a per-turn mutable scratchpad that
`getState` is explicitly allowed to find corrupt and reset. Those two things want
opposite properties. Keeping identity resolution lean and boring is worth one
extra table.

The day a shop wants a second phone on the same business (owner plus assistant,
one shared inventory, two threads) is the day a real conversation or participant
entity earns its place, and the state moves to be keyed on that. Today a second
number just becomes a second business with its own separate stock, which is a
genuine modeling limitation but a bigger change than Phase 2.

This is deliberately not a state machine graph. There are no transitions to
enumerate and no terminal states to get trapped in, which is the failure the
prior system hit when a dead conversation forced a known user back through
onboarding. Strictness is chosen per field rather than globally: `focus` and the
counters only advise, and exactly one field gates. `pending` prevents writing a
record with missing fields, which is the single guarantee the plan's own error
handling asks for ("does not log an incomplete expense").

**`focus` is why this lands in Phase 2 rather than Phase 4.** "Undo that" and
"make it 4200" are the natural way an owner corrects a mistake, and resolving
those references from transcript text alone is guesswork. `focus.transactionRef`
is what makes `void_transaction` usable in practice.

**Counters** cover the lessons file's requirement to cap repeated failures and
off-topic churn separately, with a tight cap on real failures and a looser one on
unproductive-but-valid turns.

### 3.3 Rules for agent state

These are the parts that decide whether this ages well or rots.

- **Code owns writes; the model only reads.** After each turn, a pure
  `deriveState(prev, turnOutcome): AgentState` computes the next value from
  what the tools actually returned. The model never emits a state patch. Letting
  it write the state that governs its own behavior is a drift and injection
  surface, and it edges toward the lesson about keeping consequential decisions
  out of the model's hands. If a later phase genuinely needs the model to stash
  something, that is one narrow tool with a tight schema, not a blob write.
  `deriveState` being pure is also what makes all of this unit testable.
- **Validate on read, never trust the column.** Parse with Zod on load. On a
  parse failure (shape drift after a deploy, hand-edited row), reset to the
  default and log it. A stale document must never be able to crash the loop.
- **Render it after the cache breakpoint.** The state changes every turn. If it
  lands in the cached prefix, the prefix changes every turn and prompt caching
  silently stops paying. Verify with `usage.cache_read_input_tokens`.
- **Bound it.** Cap the serialized size and give `pending` a TTL. Without expiry,
  a half-finished expense from Tuesday resurfaces on Friday and the agent asks
  about a receipt nobody remembers.
- **The transcript is authoritative for what was said; the state is authoritative
  for what is true.** When they disagree, the state wins, because it is derived
  from tool results rather than from generated text.

`mode` also subsumes the Phase 1 onboarding hack. Today onboarding state is
`Business.name IS NULL`, which works for exactly one flow and does not extend.

## 4. Architecture

### 4.1 The LLM port

Add an `LlmClient` port next to the existing `Store` and `WhatsAppSender`. Same
reason as those two: the agent loop must be testable without an API key or
network, and CI cannot depend on live model output being deterministic.

```ts
// src/agent/llm.ts
export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}
```

`AnthropicClient` implements it against the SDK. `ScriptedLlmClient` in
`tests/fakes.ts` returns a queued list of responses, so a test can say "the model
asks for `record_sale` with these arguments, then replies with this text" and
assert on what the tools actually did.

### 4.2 Manual loop vs the SDK Tool Runner

The SDK ships `client.beta.messages.toolRunner` with `betaZodTool`, which drives
the call cycle and builds tool schemas from Zod. It is a good fit on paper and
worth revisiting later.

The recommendation is still a **manual loop**, for one reason: the port above. A
manual loop over an injected `LlmClient` is about forty lines and gives fully
deterministic tests. Tool Runner would require mocking SDK internals to reach the
same coverage, and this is the component whose correctness matters most.

We keep the good half of Tool Runner anyway by defining every tool's arguments as
a Zod schema and deriving the JSON Schema from it, so runtime validation and the
wire schema cannot drift.

Loop shape:

```
build system prompt + tool definitions (stable, cacheable)
append business context + recent history + this message
loop up to MAX_ITERATIONS (3):
  call model
  if stop_reason != "tool_use": return the text
  for each tool_use block:
     validate args with the tool's Zod schema
     execute with a ToolContext bound to this business
     log the call (args, result, success)
     append tool_result (is_error: true on failure)
  return all tool_results in a single user message
return a fallback reply if the iteration cap is hit
```

The plan says "one tool call per message, no chaining." That was written when the
tools were independent. With `check_stock` in the set, "sell 3 cartons if I have
them" is a legitimate two-call turn, so the loop is bounded rather than
single-shot. Three iterations is enough for read-then-write and cheap to raise.

Parallel tool calls matter here: one assistant message can contain several
`tool_use` blocks, and all their results must go back in a **single** user
message. Splitting them across messages teaches the model to stop batching.

### 4.3 Tool registry

```ts
interface ToolDefinition<A> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  execute(ctx: ToolContext, args: A): Promise<unknown>;
}

interface ToolContext {
  business: BusinessRecord;   // injected by the loop, never by the model
  store: Store;
  logger: Logger;
}
```

`ToolContext` is what makes the identity guardrail structural rather than a
convention: a tool cannot be executed without a business, and the business comes
from `resolveBusiness`, not from anything the model produced. No tool takes a
`business_id` argument. There is no way for the model to name one.

Logging wraps `execute` in the registry rather than living inside each tool, so a
new tool cannot forget to log.

### 4.4 Model configuration

> **Superseded.** This section originally specified `claude-opus-5` with adaptive
> thinking. Under the demo deadline the provider decision was reopened and
> settled on an OpenAI-compatible gateway instead, so the loop can be pointed at
> DeepSeek, OpenRouter, Groq, Together or OpenAI by changing three environment
> variables. The reasoning is recorded here because the constraints still apply
> whichever provider is chosen.

Provider-independent decisions that held:

- **Non-streaming.** WhatsApp receives one finished message; there is nothing to
  stream to.
- **`max_tokens` 2048.** Deliberately low. Replies are chat messages and nothing
  here produces long output.
- **Low temperature (0.2, not 0).** Bookkeeping wants repeatable tool arguments,
  and a few gateways behave oddly at exactly zero.
- **Stable prompt prefix.** Frozen instructions and tool definitions first,
  business name and date and history after, so the cacheable prefix stays
  byte-identical. `allTools` has a fixed order for the same reason.

Carried over from the Anthropic-specific version, still worth knowing if the
provider changes again: on models with configurable thinking, do not disable it.
A model with reasoning off will occasionally write a tool call into its visible
text instead of emitting a tool call block. The turn succeeds, nothing errors,
and the sale is never recorded while the owner is told it was. Lower the effort
setting instead of turning reasoning off.

Cost is not a constraint at demo volume: a full demo including every test
message is a few hundred calls.

### 4.5 New environment variables

As built, all validated in `src/env.ts`:

`LLM_BASE_URL` (default OpenRouter), `LLM_MODEL`, `LLM_API_KEY`,
`LLM_MAX_TOKENS` (2048), `LLM_TEMPERATURE` (0.2), `LLM_TIMEOUT_MS` (30000),
`AGENT_MAX_ITERATIONS` (3), `AGENT_HISTORY_TURNS` (10).

**The model must support tool calling.** One that does not will answer in prose
and never emit a tool call, which looks like a broken agent rather than a config
error.

## 5. Store additions

Every method takes `businessId` first and filters on it. No exceptions.

As built:

```
findProductByName(businessId, name)         normalized match (case, whitespace, plural)
listProducts(businessId)
createProduct(businessId, product)
adjustStock(businessId, productId, delta)   single atomic relative UPDATE
findCustomerByName(businessId, name)
listCustomers(businessId)
createCustomer(businessId, name)
customerBalance(businessId, customerId)     summed from transactions, never stored
outstandingBalances(businessId)
createTransaction(businessId, tx)
listRecentTransactions(businessId, limit)   ordered by seq, excludes voided
voidTransaction(businessId, transactionId)
voidLastEntry(businessId)                   voids the newest entry and its group
appendMessage(businessId, turn)
recentMessages(businessId, limit)
```

`getState` / `putState` were dropped with agent state. The customer methods and
`voidLastEntry` were added.

`adjustStock` is a single `UPDATE ... SET stock_qty = stock_qty + ?` rather than
read-modify-write, since two messages can arrive concurrently and a lost update
corrupts the count invisibly.

`listRecentTransactions` orders by `seq`, not `created_at`. See section 11.

## 6. Tool behaviour worth deciding now

**`record_sale(product, quantity, amount)`**

- Unknown product: create it at `stock_qty = 0`, record the sale, say so in the
  reply. Do not block on it.
- Stock would go negative: **record the sale anyway** and flag it. A real shop
  sells what is physically on the shelf; a negative count means our number is
  stale, not that the sale did not happen. Refusing to record real revenue
  because of a bad count is the worse failure.
- The low stock flag is returned by the tool and rendered in the same reply,
  never as a follow-up message.

**`add_stock(product, quantity, low_stock_threshold?)`**

- Creates the product if new. Sets the threshold on creation only.
- Does not record an expense. Restocking and paying for stock are two events;
  conflating them would double count once `record_expense` lands.

**`check_stock(product?)`** returns one product or all, each with a low stock flag.

**`list_recent_transactions(limit)`** returns a short reference per row (first 8
characters of the id) so the owner can point at one in chat. Never expose the
full UUID.

**`void_transaction(ref)`** takes that short reference, resolves it **within the
business**, and marks it voided. Reversing the stock decrement on a voided sale
is in scope.

The short reference is generated by us and scoped to a business, so it does not
repeat the prior system's mistake of using an externally sourced code as an
identifier.

## 7. Failure handling

Per the plan's error table, plus what the SDK requires:

- Tool throws: return `tool_result` with `is_error: true` so the model can tell
  the owner; log `success: false` with the real exception and stack.
- Tool arguments fail Zod validation: same path. Do not coerce.
- LLM call fails: retry once, then a plain failure reply. Catch typed SDK errors
  most specific first (`RateLimitError`, then `APIError`), never string match.
- Iteration cap hit: reply that it did not go through. Never claim success.
- The agent never states a number it did not receive from a tool result.

## 8. Tests

Unit, against `InMemoryStore`:

- each tool handler, including the negative stock and unknown product paths
- Zod rejection of malformed arguments
- `deriveState` as a pure function: a successful sale sets `focus.transactionRef`,
  a failed tool increments `counters.failures`, an expired `pending` is cleared,
  a completed `pending` is cleared
- a corrupt or unknown-version state document parses to the default and logs,
  rather than throwing

Loop, against `ScriptedLlmClient`:

- single tool call then text reply
- two tool calls in one turn, results returned in one message
- tool throws, model is handed `is_error`, owner gets a failure reply
- iteration cap reached
- LLM failure retried once, then failing cleanly

Acceptance:

- add stock to 5 with threshold 3, sell 3, warning appears **in the same reply**
- a tool bound to business A cannot read or write business B's product, asserted
  directly rather than assumed
- record a sale, then "undo that" in the next message voids that exact
  transaction, resolved through `focus.transactionRef` rather than from the
  transcript text
- business A's agent state is never visible to business B

## 9. Build order

What was actually built, in order:

1. ~~`LlmClient` port, `ScriptedLlmClient`, env additions.~~ Plus the
   OpenAI-compatible adapter, which was not in the original plan.
2. ~~Migration.~~ `voided_at`, `messages`, `customers`, and later `seq` and
   `group_id`. No `agent_state`.
3. ~~`AgentState` and `deriveState`.~~ **Cut** — see section 3.2.
4. ~~Tool registry, `ToolContext`, Zod to JSON Schema, logging wrapper.~~
5. ~~The loop, with tests against the scripted client.~~
6. ~~`add_stock` and `check_stock`.~~
7. ~~`record_sale` with the low stock flag.~~
8. ~~Customers, `record_payment`, `check_balance`~~ — inserted here after the
   landing page check, and `record_sale` gained `customer` and `paid`.
9. ~~`undo_last`~~, replacing the planned `list_recent_transactions` plus
   ref-based void.
10. ~~Message history wired in.~~ The `name IS NULL` onboarding hack stayed,
    since `mode` lived on the cut agent state.
11. `run_report` — **not built**.

Never done: verified against a real number end to end.

## 10. Explicitly not in Phase 2

Customers, debts, invoices, OCR, voice notes, PDF export, `run_report`,
`record_expense`, and any tool that would need the model to name a business.

Two clarifications, since section 3 moved the line:

- **`pending` is slot filling, not confirmation.** It stops an incomplete record
  from being written. It does not add a "are you sure?" step before a complete
  one. `record_sale` still commits directly on a clear message, per the MVP plan,
  and `void_transaction` is the answer to a wrong number.
- **Agent state is not a workflow engine.** If a future phase wants a second
  `pending.kind` with materially different rules, that is the point to stop and
  design properly rather than growing this one by accretion.


## 11. Found while building

Two bugs the tests caught that code review would not have, both of which would
have surfaced live:

- **`undo_last` undid the wrong entry.** Ordering was on `created_at`, and MySQL
  `TIMESTAMP` is second-granularity, so two entries recorded in the same second
  sorted arbitrarily. Transactions now carry an auto-increment `seq` which is the
  ordering key; `created_at` is for display and date filtering only.
- **Undoing a paid-up-front sale left a phantom debt.** That sale writes two rows
  (a sale and a payment) and only one was being voided. Rows written from one
  thing the owner said now share a `group_id` and are voided together.

Both came from writing the test for the behaviour rather than for the
implementation. Worth remembering when the remaining tools get built.

## 12. Still outstanding

Code:

1. `run_report` — today, week, month. Every report filters `voided_at IS NULL`,
   and numbers must match the underlying transactions exactly.
2. In-chat invoice, since "clean invoice out automatically" is on the page.

Never run, and therefore unverified:

3. No live model call. Prompt quality, tool descriptions and whether the model
   picks the right tool are all untested. Highest-risk unknown.
4. Migration never applied. `bigint AUTO_INCREMENT` with a unique key is valid
   InnoDB but has not been watched to succeed.
5. No real WhatsApp message has reached the app. Signature verification, media
   handling and the typing indicator are tested only against synthetic payloads.

Landing page, where the build will not catch up in time:

6. Remove or soften the proactive alerts card. It needs a scheduler *and*
   pre-approved WhatsApp templates for business-initiated messages outside the
   24-hour window, which is a policy problem rather than a code one.
7. Drop "exportable as PDF".
8. Decide what to say about voice notes and receipt photos. Both are listed as
   input methods; the app declines them politely but does not support them.

Still deliberately out of scope: proactive alerts and any scheduler, PDF export,
the media pipeline for voice and OCR, and multi-step confirmation before a
complete record is written.

## 13. Known limitation: one business, one phone number

Recorded here rather than fixed, because fixing it is a data-model change and
nothing in the current scope needs it.

Today a phone number **is** a business. `resolveBusiness` maps a number to a
`business_id`, and `businesses.whatsapp_number` carries a unique index. An owner
and a shop assistant messaging from two handsets therefore become two separate
businesses, with separate stock, separate customers and separate books. Neither
can see the other's numbers, and nothing warns them.

For a single-owner shop, which is the whole MVP audience, this is invisible. It
stops being invisible the moment either of these arrives:

- **A second person needs access.** Most obvious with an assistant who records
  sales while the owner is out.
- **A web dashboard.** Browser access needs an identity that is not "Meta
  delivered this message", and the natural login is a code sent to the owner's
  WhatsApp thread. That immediately raises "which numbers may log in to this
  business", which is the same question.

### The change, when it comes

Split identity from the business:

```
businesses          (id, name, created_at)
business_numbers    (id, business_id, whatsapp_number, role, created_at)
```

`resolveBusiness` looks up `business_numbers` and returns the owning business.
Everything downstream is unchanged, because every table is already scoped by
`business_id` rather than by phone number, and no tool has ever taken a number
as an argument. That is the part worth protecting: the current shortcut is
confined to one function, so this stays a small migration rather than a rewrite.

Do it as one migration that backfills a `business_numbers` row per existing
business, then drops `businesses.whatsapp_number`.

### Not the same thing as a conversations table

Section 3.2 discusses a `conversations` entity and concludes it earns nothing
while business and conversation are 1:1. This is the change that would break
that assumption: two numbers on one business means two threads, and the
transcript and any per-thread state would key on the number, not the business.
Revisit that section at the same time, not before.
