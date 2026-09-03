# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Phase 1 of the plan is scaffolded: WhatsApp webhook in/out, signature verification, message dedupe, deterministic business resolution with phone-format normalization, two-message onboarding, and a stub tool wired behind it. Phases 2-5 (`record_sale`, `run_report`, `record_expense` + OCR, weekly PDF) are not built.

The full specification lives in `plans/Alaje.md` — synopsis, data model, tool catalog, phased rollout, and production lessons from a prior WhatsApp agentic system. Read it before implementing a new phase.

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
npx vitest run tests/handler.test.ts
npx vitest run -t "replies exactly once"
```

Copy `.env.example` to `.env` before `npm run dev`. `src/env.ts` validates at boot and throws on anything missing — a missing app secret must never degrade into "signature check skipped".

## Code layout

`src/index.ts` builds the real dependencies and starts the server; `src/app.ts` builds the Express app from an injected `AppDeps`, which is what tests construct.

- `src/whatsapp/` — channel edge. `signature.ts` (HMAC over the raw body), `parse.ts` (payload → messages, ignoring delivery statuses), `client.ts` (outbound `WhatsAppSender` port + Cloud API implementation), `webhook.ts` (GET handshake, POST receive).
- `src/store.ts` — the `Store` persistence port. `src/db/store.ts` is the Drizzle implementation, `tests/fakes.ts` the in-memory one.
- `src/handler.ts` — the ordering that matters: dedupe → resolve → onboard → agent.
- `src/businesses/` — `resolve.ts` (deterministic lookup), `onboarding.ts` (copy + name parsing).
- `src/agent/` — `loop.ts` and `tools/`. Phase 2 replaces the loop body with LLM function calling; the surrounding contract stays.
- `src/phone.ts` — normalization and variant generation. Never bypass it.

### Why the ports exist

`Store` and `WhatsAppSender` are interfaces so the Phase 1 acceptance criteria — a duplicate webhook payload produces exactly one reply, a new number is walked through onboarding — are testable without a live MySQL or Meta account. Keep new I/O behind a port for the same reason; don't reach for Drizzle from `handler.ts`.

## What Alaje is

An AI business manager for Nigerian SMEs that lives entirely inside WhatsApp. The owner talks to it in plain language ("Sold 3 cartons of Indomie to Chika for ₦42,000") and it records the transaction, updates stock, and reports back. It is an **agentic system with tool access**, not a command/menu bot — the LLM decides which tool to call, calls it, and replies with the outcome.

## MVP architecture

Five components:

- **WhatsApp channel** — Meta Cloud API webhook. Text and image only. Signature verification and dedupe on WhatsApp's message id happen before anything else.
- **Business resolution** — deterministic lookup by `whatsapp_number` → `business_id`, done *before* the agent loop runs. A `Business` row with `name = null` doubles as the onboarding state; there is no separate onboarding table.
- **Agent orchestrator** — LLM function-calling loop, one tool call per message. No chaining: the three MVP tools are independent and none consumes another's output.
- **Tool layer** — `record_sale`, `record_expense`, `run_report`. Each deterministic and independently testable.
- **Media processing** — OCR on receipt images only; extracted text feeds `record_expense` exactly as a typed message would, differing only in the `source` field.

### Data model

`Business` (id, whatsapp_number, name nullable, created_at) · `Product` (id, business_id, name, stock_qty, low_stock_threshold) · `Transaction` (id, business_id, type sale/expense, amount, product_ref nullable, source typed/ocr, created_at) · `ToolCallLog` (id, business_id, tool_name, arguments, result, success, created_at).

Deliberately **out of scope for the MVP**: Customer, Invoice, and conversation-state tables. Nothing in scope touches balances owed, invoicing, or multi-step confirmation. Don't add them speculatively.

### Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `record_sale` | product, quantity, amount | transaction, plus a low-stock flag when `stock_qty` falls below `low_stock_threshold` (returned inline in the same reply, not a follow-up message) |
| `record_expense` | description, amount, vendor (optional) | transaction |
| `run_report` | period (`today`/`week`) | revenue, expenses, profit; `week` also returns a PDF link computed from the same numbers, never a second calculation path |

## Guardrails (non-negotiable)

- The agent never writes to the database outside the tool layer. No direct DB access from the reasoning step.
- Identity and multi-tenant scoping are never the model's decision. Resolve `business_id` in server-side code; the model decides *when* to act, never *whose* data it acts on.
- Every tool call is logged with input, output, and success/failure.
- The agent never invents numbers. A failed or empty tool result is reported as a failure, not papered over.
- Webhook messages are deduped on the WhatsApp message id before reaching the agent.
- Every query touching shared data is scoped by `business_id` — a missing scope is a silent cross-tenant leak.

## Error handling

OCR that can't extract amount or vendor → ask for the missing field; never log an incomplete expense. Tool throws → tell the owner it didn't go through, log `success: false`, don't claim success. Ambiguous intent → ask a clarifying question rather than guessing a tool. LLM call fails → retry once, then a plain failure reply; never a silent drop.

## Hard-won lessons to build in from day one

These come from a prior production WhatsApp agentic system (`plans/Alaje.md`, final section) — each was a real incident:

- **Never key off a raw phone-number string.** WhatsApp sends international-without-`+`; numbers stored elsewhere may be local format. Exact-match lookup silently treats a known business as new. Normalize to local/international/E.164 variants and match against any of them.
- **Give every terminal/error state a way back in.** A user already identified must never be pushed through onboarding again after a failure.
- **Cap repeated failures and off-topic churn separately.** A tight cap on genuine failures, a looser one on unproductive-but-valid turns.
- **Don't fact-check generated replies with exact string matching.** Normalize currency symbols, commas, decimal cents, and punctuation on both sides first.
- **Never expose an externally-sourced code (bank code, SKU) as a client-facing identifier.** Use your own row id and translate server-side; real-world codes are not unique.
- **A rich client can fail to render a schema-valid response with nothing in your logs.** "No error logged" ≠ "nothing went wrong."
- **Never let an unhandled exception surface as an opaque failure.** Log the real exception with message, stack, and enough context to know which call threw; degrade gracefully instead of going silent.
- **Structured logging with enough context to reproduce from the data alone.** Both of the worst prior bugs were invisible to code review and only findable by reading real data.

## Implementation phases

Build in this order; each phase has an acceptance criterion in `plans/Alaje.md`:

1. ~~Messaging skeleton + business resolution + two-message onboarding + dedupe, wired to a stub tool.~~ **Done.**
2. `record_sale` with inline low-stock warning. **Next** — replace the stub in `src/agent/loop.ts` with an LLM function-calling loop and add the tool under `src/agent/tools/`.
3. `run_report(today)` — numbers must match the day's transactions exactly.
4. `record_expense` + receipt OCR.
5. `run_report(week)` + PDF export.
