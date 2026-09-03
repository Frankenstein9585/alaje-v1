# alaje-v1

AI Business Manager for SMEs — a WhatsApp-native assistant that records sales and
expenses, tracks stock, and reports on the numbers, all through ordinary
conversation. See `plans/Alaje.md` for the full specification.

## Status

Phase 1 (messaging skeleton) is implemented: webhook in/out over the Meta Cloud
API, signature verification, dedupe on WhatsApp's message id, business
resolution with phone-format normalization, two-message onboarding, and a stub
tool behind it. The real tools (`record_sale`, `record_expense`, `run_report`)
come in Phases 2–5.

## Setup

```bash
npm install
cp .env.example .env       # fill in the Meta credentials and DATABASE_URL
npm run db:migrate         # apply migrations to a running MySQL
npm run dev
```

Point the Meta app's webhook at `https://<your-host>/webhook` and use the same
value for `WHATSAPP_VERIFY_TOKEN` as you enter in the dashboard. During local
development, tunnel the port (`ngrok http 3000` or similar) — Meta needs a
public HTTPS URL.

## Checks

```bash
npm test
npm run typecheck
npm run lint
```
