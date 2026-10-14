# ABU9 (أبو9)

Saudi food discovery, ordering and delivery platform — **watch food → discover a dish → add to cart → order → track delivery** — launching in selected Riyadh neighbourhoods.

This repository is a working MVP foundation, not a mock-up: a TypeScript modular-monolith API on PostgreSQL, a pure domain core (pricing, coverage, dispatch, double-entry ledger, subscriptions, loyalty, refunds, settlements), and six Arabic-first RTL web apps. **All restaurants, people, companies and media in the seed data are fictional demo data.** Payments and SMS run on clearly labelled **mock** adapters — no money moves and no SMS is sent.

![Customer feed, checkout, tracking](docs/screenshots/01-customer-feed.png)

## Quick start

Requirements: Node ≥ 22.18 (runs TypeScript natively), PostgreSQL 16, ffmpeg (optional, renders placeholder demo clips).

```bash
npm ci                           # pinned by package-lock.json
createdb abu9 && createdb abu9_test   # or: docker compose up postgres
cp .env.example .env             # optional; dev defaults work locally
npm run db:reset                 # migrate + seed fictional Riyadh demo data
npm run build:web
npm start                        # http://localhost:8080
```

| App | URL | Demo login (OTP is auto-filled in dev) |
|---|---|---|
| Customer (mobile) | `/customer` | 0500000001 (Sara), 0500000002 (Fahad) |
| Courier (mobile) | `/courier` | 0500000201 (Sahm), 0500000204 (Rawahel) |
| Restaurant dashboard | `/restaurant` | 0500000101 (Najd Burger), 0500000102 (Al Deera) |
| Logistics partner portal | `/logistics` | 0500000301 |
| Creator portal | `/creator` | 0500000401 |
| Admin & operations | `/admin` | 0500000901 (ops/admin), 0500000902 (finance). Staff must set up TOTP on first login; in dev the code is auto-filled |
| New restaurant | `/restaurant` | any new number (e.g. 0551234567) → application form → onboarding checklist |

API docs: `GET /api/openapi.json` (also committed at `docs/api/openapi.json`, 131 operations).

## Commands

| | |
|---|---|
| `npm test` | 90 tests: domain unit tests, Postgres driver tests, and end-to-end API suites against a real database (`abu9_test`) covering the commercial flow, security (MFA, CSRF, rate limits, headers, metrics), onboarding, customer features and campaigns |
| `node scripts/smoke-web.mjs` | Browser smoke test of all six apps against a running seeded API: real UI logins with cookie sessions and staff MFA, restaurant onboarding → activation, campaign proposal → approval, a two-customer group order. Start the API with `RATE_LIMIT=0 OTP_MAX_PER_HOUR=1000` for repeated local runs |
| `npm run typecheck` | strict TypeScript over domain, db, API and all six web apps |
| `npm run dev` | build web + API with `--watch` |
| `npm run openapi` | regenerate `docs/api/openapi.json` from the live route table |
| `npm run screenshots` | capture real screenshots of all six apps with headless Chromium |

## Repository layout

```
packages/domain        pure business rules (no I/O) — pricing, ABU9+, coverage, dispatch, ledger, loyalty, …
packages/db            Postgres wire-protocol client, SQL migrations, migration runner, fictional seed
packages/design-tokens brand tokens (single source of truth)
apps/api               modular-monolith HTTP API, background jobs, OpenAPI
apps/web               six React apps sharing one design system (esbuild)
docs/                  PRD, architecture, design system, API, deployment, launch blockers, backlog
```

## Read next

- [docs/PRD.md](docs/PRD.md) — product requirements and decisions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, data model, money flows
- [docs/LAUNCH_BLOCKERS.md](docs/LAUNCH_BLOCKERS.md) — **what is mocked, unfinished or risky; read before any launch planning**
- [docs/BACKLOG.md](docs/BACKLOG.md) — prioritised next work
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md), [docs/API.md](docs/API.md)
- [docs/RUNBOOKS.md](docs/RUNBOOKS.md): first response for production alerts
