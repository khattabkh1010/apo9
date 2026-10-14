# What is mocked, unfinished, risky — and what blocks a launch

Honest status as of this build. Nothing here is a live licensed integration.

## A. Mocks (must be replaced before real customers)
| Mock | File | Integration path |
|---|---|---|
| **Payment provider** — `MockPaymentProvider`, test tokens only, no money moves | apps/api/src/adapters.ts | Moyasar / HyperPay / Checkout.com / Tap: merchant onboarding, SAMA-compliant contract, mada + Apple Pay + cards, 3-DS flow (webhook path exists), saved-card tokens for ABU9+ renewals |
| **SMS / OTP delivery** — logs only, dev echoes the code | adapters.ts | Unifonic / Taqnyat / Msegat; CST sender-ID registration |
| **Routing** — straight line × 1.35 heuristic | packages/domain/src/geo.ts | Google Routes / HERE / self-hosted OSRM with KSA data; traffic-aware |
| **Demo media** — ffmpeg-generated abstract clips | packages/db/src/demo-media.ts | Real creator/restaurant uploads |
| **Bank payouts** — finance records a manual transfer reference | services/settlements.ts | Bank API / SARIE bulk payouts |
| **Push notifications** — in-app list + SSE only | services/common.ts | APNs/FCM via Expo push or direct |

## B. Launch blockers (legal, regulatory, financial)
1. **Commercial registration, municipal and food-delivery licensing** for ABU9; contracts with logistics partners confirming their courier licensing/insurance obligations.
2. **Payment licensing model** — collecting money on behalf of restaurants may require a licensed PSP/marketplace structure (SAMA). Confirm escrow / payout flows with the PSP.
3. **VAT and ZATCA** — tax advisor must confirm marketplace treatment (food as agent vs principal, delivery fee VAT, restaurant plan VAT) and **ZATCA Phase 2 e-invoicing** for every invoice ABU9 issues. Not implemented.
4. **PDPL (Saudi Personal Data Protection Law)** — privacy notice, consent, data retention schedule, data-subject requests, cross-border transfer review for any non-KSA hosting/vendors, DPO.
5. **Terms**: customer T&Cs, ABU9+ terms (cancellation/refund policy assumptions in PRD §5), restaurant subscription agreement (including the open overage decision), logistics SLA contract with the auto-deduction reason codes the system expects.
6. Consumer-protection review of displayed pricing (VAT-inclusive display, fee transparency already implemented).

## C. Security risks to close
| Risk | Status |
|---|---|
| Postgres connection has **no TLS** (in-repo driver) | Blocker — move to `pg` with `sslmode=verify-full` |
| No rate limiting beyond OTP | Add per-IP/per-user limits at the edge (WAF) and in-app |
| Session tokens in `localStorage` (XSS → token theft) | Move to httpOnly, SameSite cookies + CSRF tokens for web; secure storage on native |
| No CSP header; Google Fonts loaded from third party | Add strict CSP; self-host fonts |
| Uploads not virus-scanned or content-type sniffed; no transcoding | Scan + transcode before moderation |
| Admin "reason" prompts use `window.prompt` | Replace with proper modals; consider 4-eyes approval for payouts and large refunds |
| No MFA for staff | Add TOTP/WebAuthn for admin/finance roles |
| Secrets via env | Use a secret manager; rotate `OTP_HMAC_SECRET`, `PAYMENT_WEBHOOK_SECRET` |
| No dependency/container scanning, pentest | Add to CI; external pentest before launch |
| Fraud controls are basic (refund velocity, self-referral, promo limits) | Device fingerprinting, promo abuse graph, courier GPS spoofing checks |

## D. Unfinished features (built foundations exist unless noted)
- **Native apps** (Expo customer + courier) — not started; web apps are mobile-first stand-ins.
- **Maps**: address picking on a map, live courier map tiles (tracking uses a schematic route).
- Restaurant **onboarding wizard** (restaurants are created by seed/ops today), branch hours editor, modifier group editor UI (API supports items/availability; modifier CRUD API is not built).
- Customer address creation UI (API exists), favorites screen, notifications screen, group-order UI (API exists and is idempotent; no screens), ratings history.
- English: i18n infrastructure + customer core strings; dashboards are Arabic-only.
- Creator campaign creation UI for restaurants/ops (tables + approval endpoints exist; campaigns are created via API/SQL).
- Capacity requests: admin creation endpoint exists, no admin UI form.
- Pricing versions: API exists; admin UI shows history only.
- PSP settlement-file ingestion and bank reconciliation.
- Customer cancellation after acceptance (support-only today) and partial refunds UI for agents (amount prompt).
- Courier earnings for the individual courier (company-level only, by design pending decision).
- Analytics: no event warehouse; dashboards query OLTP directly.
- Observability: structured JSON logs + request IDs only — no metrics/tracing/alerting yet.
- Accessibility: keyboard focus, labels, reduced motion done; no formal WCAG audit or screen-reader pass.
- `@types/react` was unavailable offline, so **TSX files are bundled but not type-checked** (`npm run typecheck` covers domain/db/API). Add `@types/react` and include `apps/web` in tsconfig.
- Docker image and CI workflow are written but **were not executed** here (no Docker daemon/registry in the sandbox). No `package-lock.json` yet.

## E. Operational readiness gaps
On-call/runbooks, backup & restore drill, load test of dispatch at peak (Thursday/Friday nights, Ramadan iftar/suhoor), courier-app offline behaviour, ops staffing for the 240-second acceptance window.
