# Prioritised backlog

Status legend: ✅ done this session · ◐ API/foundation done, UI or integration missing · ○ not started

## Phase 1 — Foundation ✅
✅ Monorepo, strict TS · ✅ 70-table schema + forward-only migrations with checksums · ✅ OTP auth, sessions, RBAC (global + scoped) · ✅ append-only audit log · ✅ design tokens + shared UI kit · ✅ fictional seed · ✅ OpenAPI from live routes

## Phase 2 — Core ordering ✅
✅ Catalog, modifiers, branch availability/stock · ✅ server-authoritative quote · ✅ idempotent placement, authorise/capture/void · ✅ restaurant kitchen board (accept with prep time, reject, ready) · ✅ acceptance timeout job · ✅ order tracking (SSE + poll) · ✅ ratings · ◐ group ordering (API only) · ◐ favourites (API + toggle)

## Phase 3 — Delivery operations ✅
✅ Dynamic per-branch/zone coverage with capacity · ✅ explainable dispatch strategy, batching (≤2, 2 km, 7 min, deadlines) · ✅ courier app with pickup/handover codes, reject/reassign, failure + incidents · ✅ ops dispatch board & manual override · ✅ logistics portal (couriers, jobs, SLA, capacity responses) · ○ real routing provider · ○ courier map navigation in-app

## Phase 4 — Financial foundations ✅
✅ Double-entry ledger with DB-enforced balance & immutability · ✅ capture/refund/delivery-cost/payout/subscription postings · ✅ weekly/monthly settlements derived from the ledger · ✅ claims with dispute window · ✅ reconciliation checks · ○ live PSP · ○ ZATCA e-invoicing · ○ bank payouts

## Phase 5 — Growth ✅/◐
✅ Video feed (autoplay, likes, views, add-to-cart from video) · ✅ moderation queue · ✅ creator portal (upload, link dishes, referral codes, opt-in) · ✅ attribution · ✅ promotions with budget-safe reservation · ✅ loyalty (earn/redeem/expire/reverse, campaign budgets & funding split) · ✅ ABU9+ (price experiment, subscribe, cancel/resume, renewal, grace, refund, revenue recognition) · ◐ creator campaign creation UI · ○ personalised ranking

## Session 2 (this build) ✅
✅ `pg` + verified TLS · ✅ web apps under strict tsc · ✅ cookie sessions + CSRF, staff TOTP MFA, rate limits, strict CSP, self-hosted fonts, in-app dialogs · ✅ restaurant self-onboarding, modifier and hours editors, ops activation (trial at activation) · ✅ customer addresses, favourites, notifications, group-order UI · ✅ creator campaign creation with four-eyes approval · ✅ payout and large-refund separation of duties · ✅ Prometheus metrics, alert rules, runbooks · ✅ Docker image built and run; CI browser-smoke job · ✅ dev courier simulator

## Next priorities (recommended order)
1. **P0 Real integrations sandbox**: PSP sandbox (Moyasar or HyperPay) incl. 3-DS + Apple Pay + mada; SMS provider; replace in-repo DB driver with `pg`+TLS.
2. **P0 Remaining security** from LAUNCH_BLOCKERS §C: staff TOTP reset UI, upload scanning, secret manager, dependency scanning, pentest.
3. **P1 Expo apps** for customer and courier reusing `packages/domain` + API (background location for couriers, push).
4. **P1 Maps**: routing provider adapter, address picker, live courier map.
5. **P1 Restaurant portal depth**: staff invitations, menu item images, multi-branch menus, creator incentive payouts in the ledger and settlements.
6. **P1 Observability**: deploy Prometheus/Alertmanager and dashboards; add tracing.
7. **P2 Load test** dispatch & checkout at 10× launch peak; move jobs to a worker + Redis.
8. **P2 Analytics pipeline** (events → warehouse) for feed ranking and unit economics by zone.
9. **P2 ZATCA** e-invoicing and PSP settlement-file reconciliation.
