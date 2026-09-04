# Phase 2 Plan: The Agent Loop

Status: proposed, not started.
Prerequisite: Phase 1 (messaging skeleton) is on `main`.

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

- Model: `claude-opus-5`.
- Thinking: `{ type: "adaptive" }`. **Do not disable it.** With thinking off,
  Opus 5 will occasionally write a tool call into its visible text instead of
  emitting a `tool_use` block. The turn succeeds, no error is raised, and the
  sale is never recorded while the owner is told it was. That failure mode is
  unacceptable for a bookkeeping tool. Lower `effort` instead if cost needs
  trimming.
- `output_config: { effort: "medium" }`. Routing a short message across five
  tools is not hard reasoning. Tunable.
- `max_tokens: 2048`. Deliberately low: replies are WhatsApp messages and nothing
  here produces long output.
- Non-streaming. WhatsApp receives one finished message; there is nothing to
  stream to.
- Prompt caching: frozen instructions and tool definitions go in the cacheable
  prefix, business name and date and history after it. Verify with
  `usage.cache_read_input_tokens`; if it stays zero, something volatile has
  leaked into the prefix.

At roughly 1.5K input and 200 output tokens per message, cost is around a cent
per message before caching. Not a constraint at demo volume.

### 4.5 New environment variables

`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-opus-5`), `AGENT_EFFORT`
(default `medium`), `AGENT_MAX_ITERATIONS` (default 3), `AGENT_HISTORY_TURNS`
(default 10). All validated in `src/env.ts`.

## 5. Store additions

Every method takes `businessId` first and filters on it. No exceptions.

```
findProductByName(businessId, name)         normalized match (case, whitespace, plural)
listProducts(businessId)
createProduct(businessId, {name, stockQty, lowStockThreshold})
adjustStock(businessId, productId, delta)   atomic; returns the new row
createTransaction(businessId, {...})
listRecentTransactions(businessId, limit)
voidTransaction(businessId, transactionId)
appendMessage(businessId, {waMessageId, role, content})
recentMessages(businessId, limit)
getState(businessId)                         parsed + validated, default on failure
putState(businessId, state)                   whole-document replace
```

Migration adds `transactions.voided_at TIMESTAMP NULL`, the `messages` table, and
`agent_state (business_id PK, document JSON, updated_at)`.

`putState` replaces the whole document rather than merging fields. `deriveState` is
the only thing that produces one, so a partial update has no meaning and merge
semantics would just hide bugs in it.
Voiding sets `voided_at`; every report filters `voided_at IS NULL`. A reversing
entry would also work but is harder to read in a demo.

`adjustStock` must be a single atomic `UPDATE ... SET stock_qty = stock_qty + ?`
rather than read-modify-write, since two messages can arrive concurrently.

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

1. `LlmClient` port, `ScriptedLlmClient`, env additions.
2. Migration: `voided_at`, `messages`, `agent_state`. Store methods.
3. `AgentState` schema and `deriveState`, unit tested on their own before
   anything depends on them.
4. Tool registry, `ToolContext`, Zod to JSON Schema, logging wrapper.
5. The loop, with tests against the scripted client. State read in, derived out,
   rendered after the cache breakpoint.
6. `add_stock` and `check_stock` (they make everything else testable by hand).
7. `record_sale` with the low stock flag. Acceptance test.
8. `list_recent_transactions` and `void_transaction`, with `focus.transactionRef`
   carrying "undo that".
9. Message history wired in, `mode` taking over from the `name IS NULL`
   onboarding hack, verified against a real number end to end.

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
