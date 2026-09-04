# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Phase 1 and most of Phase 2 are built: WhatsApp channel, agent loop, and six tools covering stock, sales, customers, debts and corrections.

**Nothing has ever run against a real model, a real database, or a real WhatsApp message.** All 97 tests use a scripted LLM client and an in-memory store. The migration has never been applied. Treat every integration point as unverified until someone watches it work.

Outstanding: `run_report` (today/week/month) and an in-chat invoice. See `plans/phase-2.md` for what was consciously cut and why.

## Stack and commands

Node 20+ / TypeScript (ESM, `NodeNext`) · Express 5 · MySQL via Drizzle ORM · Vitest · pino.

```bash
npm run dev          # tsx watch, reloads on change
npm run build        # tsc -> dist/
npm start            # run the build
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest run (all tests)
npm run db:generate  # regenerate SQL migrations from src/db/schema.ts
npm run db:migrate   # apply migrations (needs a live DATABASE_URL)
```

Run a single test file or case:

```bash
npx vitest run tests/undo-tool.test.ts
npx vitest run -t "replies exactly once"
```

Copy `.env.example` to `.env` first. `src/env.ts` validates at boot and throws on anything missing — a missing app secret must never degrade into "signature check skipped".

The migration in `drizzle/` is a single `0000` file that has not been applied anywhere. While that stays true, schema changes are made by editing `src/db/schema.ts`, deleting `drizzle/`, and regenerating. **Once it has been applied to any database, stop doing that** and generate incremental migrations instead.

## Code layout

`src/index.ts` builds the real dependencies and starts the server; `src/app.ts` builds the Express app from an injected `AppDeps`, which is what tests construct.

- `src/whatsapp/` — channel edge. `signature.ts` (HMAC over the raw body), `parse.ts` (payload → messages, ignoring delivery statuses), `client.ts` (outbound port + Cloud API implementation, including the read receipt and typing indicator), `webhook.ts`.
- `src/store.ts` — the `Store` persistence port. `src/db/store.ts` is the Drizzle implementation, `tests/fakes.ts` the in-memory one.
- `src/handler.ts` — the ordering that matters: dedupe → acknowledge → resolve → onboard → agent → record history.
- `src/agent/` — `llm.ts` (provider-neutral port), `openai-compat.ts` (the adapter), `loop.ts`, `prompt.ts` (the reply-style contract), `tools/`.
- `src/businesses/` — `resolve.ts` (deterministic lookup), `onboarding.ts` (all owner-facing copy).
- `src/format.ts` / `src/money.ts` — display formatting and integer-kobo arithmetic. Never bypass either.
- `src/phone.ts` — normalization and variant generation. Never bypass it.

### Why the ports exist

`Store`, `WhatsAppSender` and `LlmClient` are interfaces so behaviour is testable without MySQL, a Meta account, or an API key — and so model output can be scripted rather than hoped for. Keep new I/O behind a port for the same reason; don't reach for Drizzle or `fetch` from a handler or a tool.

## What Alaje is

An AI business manager for Nigerian SMEs that lives entirely inside WhatsApp. The owner talks to it in plain language ("Sold 3 cartons of Indomie to Chika for ₦42,000") and it records the sale, updates stock, tracks what Chika owes, and reports back. It is an **agentic system with tool access**, not a command bot.

## Architecture

- **WhatsApp channel** — Meta Cloud API webhook. Signature verification and dedupe on the message id happen before anything else.
- **Business resolution** — deterministic lookup by phone variants → `business_id`, done *before* the agent loop. A `Business` row with `name = null` doubles as the onboarding state.
- **Agent orchestrator** — LLM function-calling loop over the `LlmClient` port, bounded by `AGENT_MAX_ITERATIONS`. Executes all tool calls in a turn and returns their results in one message.
- **Tool layer** — parse → validate with Zod → execute → log, all in `tools/registry.ts`.
- **Conversation history** — the last `AGENT_HISTORY_TURNS` turns replayed as context. A transcript, not a state machine.

### Data model

`businesses` · `products` (with `normalized_name` carrying the unique index) · `customers` · `transactions` (sale/expense/payment, with `seq`, `group_id`, `voided_at`) · `messages` · `tool_call_logs` · `processed_messages`.

Three schema decisions that exist for a reason:

- **`products.normalized_name`** carries uniqueness, not `name`. "Indomie", "indomie " and "Indomies" are one product; three rows would quietly break every stock count.
- **`transactions.seq`** (auto-increment) is the ordering key, not `created_at`. MySQL `TIMESTAMP` is second-granularity, so same-second entries sort arbitrarily and `undo_last` undoes the wrong one. `created_at` is for display and date filtering only.
- **`transactions.group_id`** ties rows written from one thing the owner said. A sale paid up front is a sale plus a payment; undoing must void both or it leaves a phantom debt.

Balances are always **computed from transactions**, never stored. A running-balance column and a voided transaction drift apart the moment anyone corrects anything.

### Tools

| Tool | Notes |
| --- | --- |
| `add_stock` | Creates the product if new. Restocking only, does not record what it cost. |
| `check_stock` | One product, all products, unknown product, or empty shop. |
| `record_sale` | Logs money, decrements stock, optional `customer` and `paid`. Low-stock warning inline in the same reply. |
| `record_payment` | Money in against a debt. Also covers forwarded bank credit alerts. |
| `check_balance` | One customer, or everyone who owes, largest first. |
| `undo_last` | Voids the most recent entry and its group, restoring stock. |

## Guardrails (non-negotiable)

- The agent never writes to the database outside the tool layer.
- **Identity is never the model's decision.** `ToolContext` carries the business resolved by `resolveBusiness`; no tool takes a business id argument, so the model has no way to express acting on another tenant's data. Keep it that way.
- Every tool call is logged with input, output and success. Logging lives in the registry wrapper so a new tool cannot forget.
- The agent never invents numbers. Tools return a `display` string built in code, and the prompt tells the model to relay it verbatim rather than reformat.
- Invalid tool arguments are **rejected, never coerced**. A guessed amount is worse than an asked question.
- Every query touching shared data is scoped by `business_id`.
- Every path returns a reply. Provider failure, iteration cap, empty response and thrown tools all reach the owner as words.

## Conversational UX

This is judged on how it reads, so these are requirements, not polish:

- One or two short lines. It is a chat on a phone.
- **Echo the numbers back.** That echo is how the owner catches a misparsed amount, which makes formatting a correctness concern. `formatNaira` gives `₦42,000`, not `₦42,000.00`.
- Read receipt and typing indicator fire before the agent runs; an agent turn takes seconds and silence reads as broken.
- Never a dead end. Unsupported media says what is not supported *and* what to do instead.
- Never expose tool names, ids, or JSON.

The full reply-style contract lives in `src/agent/prompt.ts`, with each rule annotated with the failure it prevents. Don't tidy those without knowing what you're re-enabling.

## Error handling

Tool throws → `tool_result` with `is_error`, real exception logged, owner told plainly. LLM call fails → adapter retries transient once, then a plain failure reply. Ambiguous intent → ask one question. OCR missing a field → ask for it, never log an incomplete record.

## Hard-won lessons to build in from day one

From a prior production WhatsApp agentic system (`plans/Alaje.md`, final section). Each was a real incident:

- **Never key off a raw phone-number string.** Normalize to variants and match against any of them. See `src/phone.ts`.
- **Give every terminal state a way back in.** An identified number must never be pushed through onboarding again.
- **Cap repeated failures and off-topic churn separately.** Not yet implemented; would live alongside conversation state.
- **Don't fact-check generated replies with exact string matching.** Normalize currency and punctuation on both sides first.
- **Never expose an externally-sourced code as a client-facing identifier.** Use your own row id.
- **A rich client can fail to render a schema-valid response with nothing in your logs.** "No error logged" ≠ "nothing went wrong."
- **Never let an unhandled exception surface as an opaque failure.** Log message, stack, and enough context to know which call threw.
- **Structured logging with enough context to reproduce from data alone.** Both of the worst prior bugs were invisible to code review.

## Phases

1. ~~Messaging skeleton, business resolution, onboarding, dedupe.~~ **Done.**
2. ~~Agent loop, tool registry, stock tools, customers, payments, undo.~~ **Done** except `run_report` and the in-chat invoice.
3. `run_report` — today, week, month. Numbers must match the underlying transactions exactly, and every report filters `voided_at IS NULL`.
4. `record_expense` + receipt OCR.
5. PDF export.

Voice notes, proactive alerts and a scheduler are out of scope; see `plans/phase-2.md`.
