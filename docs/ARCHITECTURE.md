# ABU9 — System Architecture

## 1. Shape
A **modular monolith**: one deployable API process, one PostgreSQL database, strict module boundaries. Business rules live in a pure `packages/domain` package with no I/O, so they are unit-tested in isolation and reusable by future NestJS services, React Native apps and workers.

```
 Customer / Courier (mobile web)   Restaurant · Logistics · Creator · Admin (web)
                 │  HTTPS JSON + SSE (order tracking)
         ┌───────▼───────────────────────────────────────────────┐
         │ apps/api  (node:http router, zod validation, RBAC)    │
         │  modules/  identity · catalog/feed · orders · restaurant · courier
         │            logistics · creator · plus · payments · admin
         │  services/ orders · coverage · dispatch · support · settlements · plus · ledger posting
         │  jobs.ts   acceptance timeout · dispatch retry · renewals · revenue recognition
         │            points expiry · restaurant billing · claim deductibility
         │            onboarding · campaigns (four-eyes)
         │  security  cookie sessions + CSRF · staff TOTP · rate limits · CSP
         │  observability  /metrics (Prometheus) · JSON logs
         │  adapters  PaymentProvider(mock) · SmsProvider(mock) · RoutingProvider(heuristic) · EventBus
         └───────┬──────────────────────────────┬────────────────┘
                 │ packages/domain (pure)       │ packages/db (wire client, migrations)
                 └──────────────► PostgreSQL 16 ◄┘     object storage: local disk adapter (/media)
```

### Stack decisions and deviations from the brief
| Brief preference | This build | Why / path |
|---|---|---|
| TypeScript throughout | ✅ Node 22 native TS (type stripping), strict `tsc` | — |
| NestJS | Plain `node:http` router + zod, module-per-domain | No npm registry in the build sandbox. Modules map 1:1 to Nest modules (routes → controllers, services → providers). |
| `pg` driver | `pg` (node-postgres) behind the in-house `Db`/`Queryable` interface (`packages/db/src/pg.ts`) | Session 2 replaced the offline wire-protocol client. The interface pins value semantics explicitly (bigint, numeric, date, timestamp, json params). TLS is set through `sslmode` and `DATABASE_CA_CERT`. |
| Next.js dashboards | React 19 SPAs bundled with esbuild | Next.js unavailable offline. Components are framework-agnostic; port into Next app router pages. |
| React Native / Expo | Mobile-first responsive web (customer, courier) | Domain and API are ready (Bearer-token transport exists for native clients); RN screens are backlog P1. |
| Redis + queue | In-process EventBus + Postgres advisory-locked jobs | Correct for one instance. Redis pub/sub + BullMQ needed for horizontal scale. |
| Object storage | Local disk adapter served at `/media` (Range support) | S3-compatible storage + CDN + transcoding in backlog. |

## 2. Domain boundaries
| Domain | Tables | Code |
|---|---|---|
| Identity | users, user_roles, otp_challenges, sessions, addresses | modules/identity, auth/rbac |
| Restaurants | restaurants, branches, restaurant_members, contract terms, subscriptions, plan proposals, invoices | modules/restaurant, jobs (billing) |
| Catalog | menu_categories, menu_items, modifier_groups/options, branch_item_availability, favorites | modules/catalog, services/orders (validation) |
| Content | videos, video_items, video_events, creators, referral_codes, creator_campaigns(+enrollments), creator_incentives, attributions | modules/catalog (feed), modules/creator, admin moderation |
| Coverage | zones, branch_zone_rules | domain/coverage, services/coverage |
| Pricing | delivery_pricing_configs (versioned), platform_settings | domain/pricing |
| Orders | orders, order_items, order_events, group_carts(+items), ratings, support_tickets, incidents | services/orders, modules/orders |
| Dispatch | delivery_jobs, dispatch_decisions, courier_job_rejections, courier_locations | domain/dispatch, services/dispatch |
| Logistics | logistics_companies, logistics_contracts, couriers, zone_capacity_commitments, capacity_requests | modules/logistics, modules/courier |
| Payments | payments, payment_events, refunds | adapters, modules/payments |
| Ledger | ledger_accounts, journal_entries, journal_lines, view account_balances | domain/ledger, services/common.postEntry |
| Subscriptions | plus_price_variants, plus_subscriptions, plus_invoices, plus_benefit_uses | domain/subscriptions, services/plus |
| Loyalty | loyalty_campaigns, points_lots, points_transactions | domain/loyalty |
| Promotions | promotions, promotion_redemptions | domain/promotions |
| Settlements | settlements, compensation_claims | domain/settlements, services/settlements |
| Notifications | notifications (+ EventBus/SSE) | services/common.notify |
| Analytics | queries over the above (admin/restaurant/logistics dashboards) | — |
| Platform | audit_logs (append-only), idempotency_keys, fraud_flags | audit.ts |

Schema: `packages/db/migrations/*.sql` (70 tables). Money is `bigint` halalas everywhere; timestamps `timestamptz` UTC, displayed Asia/Riyadh.

## 3. Order and delivery state machines
```
order:  pending_payment → placed → accepted → preparing → ready_for_pickup → picked_up → delivered
                       ↘ cancelled   ↘ rejected (restaurant / 240 s timeout)          ↘ delivery_failed
job:    unassigned ⇄ assigned → at_pickup → picked_up → at_dropoff → delivered | failed
        (assigned → unassigned = courier reject / ops reassignment; never changes order state)
```
Transitions are enforced by `domain/order-state.ts` with an actor whitelist (customer/restaurant/courier/system/ops) and recorded in `order_events`.

## 4. Dispatch
`DispatchStrategy` interface; current implementation **NearestFeasibleStrategy (v1)** — deterministic, explainable, no ML:
- candidates: online couriers seen in the last 10 min within 10 km of pickup, under cap, not previously rejecting the job;
- idle courier: plan pickup→dropoff, waiting at the restaurant until `readyAt`; reject if ETA > `promisedBy`;
- one active order: try every valid stop sequence (incl. "finish first, then chain"); keep only those with detour ≤ limit and added delay ≤ limit for the existing order, and both deadlines met;
- score = delivery minutes + 0.5×idle wait + added delay − 2 (committed-capacity bonus); ties by courier id;
- every decision (assignment + reasons + rejected candidates) is stored in `dispatch_decisions` and shown in the admin order view;
- `suggestedDepartAt` aligns courier arrival with food-ready time (dispatch starts at acceptance).
Retries every 20 s for unassigned jobs. Ops can override (audited; hard cap still enforced).

Routing is the **HeuristicRiyadhRouting** adapter (straight line × 1.35 circuity, time-of-day speeds). It is labelled `heuristic` in quotes and UI. A real provider (Google Routes / HERE / OSRM with KSA OSM) plugs into `RoutingProvider`.

## 5. Money
Payment lifecycle: authorise at placement → capture at acceptance → void on rejection/cancel → refunds against captured. All PSP calls are idempotency-keyed; webhooks verified by HMAC over the raw body and de-duplicated by `provider_event_id`.

Ledger postings (all balanced; DB trigger enforces balance at commit; entries/lines immutable):
| Event | Debit | Credit |
|---|---|---|
| Order captured | PSP clearing (total); promotions expense (ABU9-funded discount); loyalty expense (points) | **Merchant payable** (food − restaurant-funded discount); delivery/service fee revenue (net of VAT); VAT payable |
| Delivery completed | Delivery cost | Logistics payable (per order; batched second order at batch rate) |
| Refund (ABU9-funded) | Customer compensation expense (food part); fee revenue + VAT (fee part) | PSP clearing |
| Claim recovered (on settlement approval) | Merchant/logistics payable | Compensation recovery (contra-expense) |
| ABU9+ paid | PSP clearing | Deferred revenue; VAT payable |
| ABU9+ recognised (hourly job, straight-line) | Deferred revenue | ABU9+ revenue |
| Restaurant plan invoiced | Merchant receivable | Restaurant subscription revenue; VAT payable |
| Payout | Merchant/logistics payable | Bank |

GMV, food collected for restaurants, ABU9 revenue and costs are reported separately on the admin dashboard. Reconciliation checks: trial balance, PSP net captured vs PSP-clearing balance, orders without capture entries, deliveries without cost entries.

## 6. Security model
- **Login**: OTP with HMAC-hashed codes, a 5-minute TTL, 5 attempts, and 5 requests per hour per phone. Sessions are opaque tokens stored hashed (SHA-256) with a 30-day expiry, and are revocable.
- **Transport**: native apps use a Bearer token. Web apps use an httpOnly `SameSite=Lax` cookie scoped to `/api`, plus a CSRF token derived from the session token (`sha256("csrf:"+token)`, double-submit, no server state) that is required on every cookie-authenticated write. Tokens are never placed in URLs.
- **Staff MFA**: any session holding a global staff role gets **no** staff permission until it passes TOTP in that session. Secrets are sealed with AES-256-GCM, and the last accepted time-step is stored to stop replay.
- **Four-eyes**: a campaign proposer cannot approve it, and a settlement approver cannot record its payout (enforced by both the API and a DB constraint).
- **Rate limits**: fixed windows per IP and per user (in-process; Redis when scaled out).
- **Headers**: strict CSP (`script-src 'self'`), `frame-ancestors 'none'`, COOP, Permissions-Policy, nosniff, HSTS in production. Fonts are self-hosted.
- RBAC: global roles (`ops_agent`, `ops_manager`, `finance`, `admin`) → permission sets; scoped roles (`restaurant_owner@restaurant`, `logistics_admin@company`, `courier@company`) checked per resource.
- Server-side authoritative pricing; client totals only used as "price changed" guard.
- Append-only ledger, points transactions and audit log enforced by DB triggers.
- Courier location stored only while on an active job.
- Production refuses to start with mock PSP/SMS or missing secrets.

## 7. Restaurant onboarding
Application (any user, CR/VAT validated) → the restaurant is `onboarding` and the applicant becomes its owner → a checklist (pure rules in `domain/onboarding.ts`): profile, branch, hours, ≥3 priced items, draft terms accepted, then branch coverage, which is ABU9's step → ops activation sets the restaurant `active` and starts the 30-day trial on the Starter plan. Contract terms start with **no** automatic deductions.

## 8. Observability
`GET /metrics` renders Prometheus text without a client library. Request metrics are keyed by route **pattern**, so label cardinality stays bounded. Operational gauges are computed from OLTP at scrape time. Alert rules live in `infra/prometheus/alerts.yml`, runbooks in `docs/RUNBOOKS.md`.

## 9. Scaling path (in order)
1. ~~Swap in `pg` with TLS~~ (done). Managed Postgres with PITR; read replica for dashboards.
2. Move jobs to a worker process; Redis for EventBus fan-out (SSE across instances) and BullMQ queues.
3. S3 + CloudFront/Akamai for media, HLS transcoding pipeline, upload virus scanning.
4. Real routing provider + travel-time cache; then learned ETAs once there is trip data.
5. Extract services only where load or team boundaries demand it (dispatch first).
