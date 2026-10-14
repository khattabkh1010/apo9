# What is mocked, unfinished, risky — and what blocks a launch

This is the honest status as of this build. Nothing here is a live licensed integration. Last updated: session 2, after the security hardening, onboarding, customer features, campaigns and ops work.

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

## C. Security risks
### Closed in this build (implemented and covered by tests)
| Risk | Resolution |
|---|---|
| Postgres connection had no TLS | `pg` driver; `sslmode=verify-full`/`verify-ca` + `DATABASE_CA_CERT`; production refuses a non-local DB without verified TLS (verified against a TLS Postgres with a private CA) |
| Session tokens in `localStorage` | Web apps use an httpOnly `SameSite=Lax` session cookie; a CSRF token derived from the session is required on every cookie-authenticated write; SSE uses the cookie (no tokens in URLs). Native clients keep Bearer tokens |
| No staff MFA | TOTP (RFC 6238) is required before any ops/finance/admin permission applies; the secret is sealed with AES-256-GCM (`MFA_ENCRYPTION_KEY`); codes can't be replayed; enrolment is audited |
| No rate limiting beyond OTP | In-app fixed-window limits: OTP per IP and per phone, MFA, checkout and writes per user, global per IP. `X-Forwarded-For` is trusted only with `TRUST_PROXY=1` |
| No CSP; Google Fonts third party | Strict CSP (`script-src 'self'`, no inline scripts), COOP, Permissions-Policy, HSTS in production; fonts self-hosted |
| `window.prompt` for reasons | Accessible in-app dialogs everywhere |
| Payouts approved and released by the same person | Separation of duties: settlement approver ≠ payout recorder (API + DB constraint). Creator campaigns: proposer ≠ approver |

### Still open
| Risk | Next step |
|---|---|
| Rate-limit counters are in-process | Move to Redis when running >1 instance; also enforce at the WAF |
| Uploads not virus-scanned or content-sniffed; no transcoding | Scan and transcode before moderation |
| Large refunds: a single agent with `refunds.issue_large` can refund | Add a second-approver queue above a threshold (payouts and campaigns already have four-eyes) |
| Staff TOTP reset has no UI | Admin reset flow with a second approver |
| WebAuthn/passkeys for staff | Stronger than TOTP against phishing |
| Secrets via env | Use a secret manager; rotate `OTP_HMAC_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `MFA_ENCRYPTION_KEY` |
| No dependency/container scanning, no pentest | Add to CI; external pentest before launch |
| Fraud controls are basic (refund velocity, self-referral, promo limits) | Device fingerprinting, promo abuse graph, courier GPS spoofing checks |

## D. Unfinished features (built foundations exist unless noted)
- **Native apps** (Expo customer + courier) — not started; web apps are mobile-first stand-ins.
- **Maps**: address picking on a map, live courier map tiles (tracking uses a schematic route).
- ~~Restaurant onboarding, hours editor, modifier editor~~: done this session (application → checklist → ops activation; the trial starts at activation). Still missing: multi-branch management beyond adding branches, staff invitations, image uploads for menu items.
- ~~Customer addresses, favourites, notifications, group-order UI~~: done this session. Addresses use device location or approximate district centres until a maps provider exists. Ratings history is still missing.
- English: i18n infrastructure + customer core strings; dashboards are Arabic-only.
- ~~Creator campaign creation~~: done (restaurant and ops proposal, four-eyes approval, creator enrolment approval). Creator incentive **payouts** are recorded as `pending` and are not yet posted to the ledger or paid.
- Capacity requests: admin creation endpoint exists, no admin UI form.
- Pricing versions: API exists; admin UI shows history only.
- PSP settlement-file ingestion and bank reconciliation.
- Customer cancellation after acceptance (support-only today) and partial refunds UI for agents (amount prompt).
- Courier earnings for the individual courier (company-level only, by design pending decision).
- Analytics: no event warehouse; dashboards query OLTP directly.
- Observability: JSON logs with request IDs, plus Prometheus `/metrics` (HTTP + operational gauges), alert rules (`infra/prometheus/alerts.yml`) and runbooks (`docs/RUNBOOKS.md`). Not yet: distributed tracing, dashboards, a deployed Prometheus/Alertmanager.
- Accessibility: keyboard focus, labels, reduced motion done; no formal WCAG audit or screen-reader pass.
- ~~TSX not type-checked~~: all six web apps are under strict `tsc`.
- Docker: the image was **built and run** in this environment (production fail-closed checks verified; dev container migrates and serves). `npm ci` *inside* the Docker build could not be exercised here (sandbox network policy), so it was validated with host-installed dependencies. The GitHub Actions workflow (tests, browser smoke, image build) **has not run yet**: it triggers on pull requests and `main`.

## E. Operational readiness gaps
On-call/runbooks, backup & restore drill, load test of dispatch at peak (Thursday/Friday nights, Ramadan iftar/suhoor), courier-app offline behaviour, ops staffing for the 240-second acceptance window.
