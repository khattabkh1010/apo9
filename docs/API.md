# API contracts

Full machine-readable contract: `docs/api/openapi.json` (OpenAPI 3.1, generated from the live route table by `npm run openapi`; CI fails on drift). Served at `GET /api/openapi.json`.

## Conventions
- Base path `/api/v1`. JSON.
- **Auth**: `POST /auth/otp/verify {transport}`.
  - `transport: "token"` (native apps): returns a Bearer token.
  - `transport: "cookie"` (web): sets an httpOnly `abu9_session` cookie plus a readable `abu9_csrf` cookie, and every non-GET request must echo that value in `X-CSRF-Token`.
  - Staff accounts must also pass TOTP: `GET /auth/mfa`, `POST /auth/mfa/totp/enroll`, `POST /auth/mfa/totp/activate {code}`, `POST /auth/mfa/verify {code}`. Until then, staff routes return `403 mfa_required`.
- **Money**: integer halalas. Consumer amounts are VAT-inclusive.
- **Time**: ISO-8601 UTC; clients display Asia/Riyadh.
- **Errors**: `{ "error": { "code", "message", "details?", "requestId" } }`. Messages are customer-safe Arabic where user-facing. Status codes: 400 validation, 401 auth, 402 payment failed, 403 permission, 404, 409 conflict/state, 422 business rule, 429 rate-limited.
- **Idempotency**: `POST /orders` and `POST /plus/subscribe` require `Idempotency-Key`; retries return the original result.
- **Real time**: `GET /orders/:id/stream` (SSE). Web uses the session cookie. Native clients send the Bearer header (EventSource polyfill). Tokens are never accepted in URLs.
- **Rate limits**: `429 rate_limited` with `Retry-After` and `details.rule`.
- **Four-eyes**: `403 four_eyes_required` when the same person tries to approve their own creator campaign or record the payout of a settlement they approved.

## Core flow
| Step | Call |
|---|---|
| Login | `POST /auth/otp/request {phone}` → `POST /auth/otp/verify {challengeId, code}` |
| Discover | `GET /feed?lat&lng` · `POST /videos/:id/events {kind}` · `GET /restaurants?q&tag&lat&lng` · `GET /restaurants/:slug` |
| Quote | `POST /checkout/quote {restaurantId, lines[], addressId|dropoff, promoCode?, redeemPoints?}` → `{quote: {coverage, pricing.lines[], plus, promo, points}}` |
| Order | `POST /orders` (+ `paymentToken`, `expectedTotal`, `videoId?`, `referralCode?`, `groupCartId?`) |
| Restaurant | `GET /restaurant/:rid/orders` · `POST …/orders/:oid/accept {prepMinutes}` · `…/reject {reason}` · `…/ready` |
| Courier | `GET /courier/jobs` · `POST /courier/jobs/:id/{arrive-pickup|pickup|arrive-dropoff|deliver|fail|reject}` · `POST /courier/location` |
| Track | `GET /orders/:id` · `GET /orders/:id/stream` |
| Help | `POST /support/tickets {orderId, reasonCode, affectedAmount?}` |
| Group order | `POST /group-carts {branchId}` · `GET /group-carts/:code` · `POST /group-carts/:code/items` · `DELETE …/items/:id` · `POST …/lock` → host `POST /orders {groupCartId}` (the server uses the group's items) |
| Onboarding | `POST /restaurant-applications` · `GET /restaurant/:rid/onboarding` · `PATCH /restaurant/:rid/profile` · `POST /restaurant/:rid/terms/accept` · `PUT /restaurant/:rid/branches/:bid/hours` · categories and modifier-group/option CRUD · ops `POST /admin/restaurants/:id/activate` |
| Campaigns | `POST /restaurant/:rid/creator-campaigns` · ops `POST /admin/creator-campaigns` · `POST /admin/creator-campaigns/:id/approve` (four-eyes) |
| Ops | `GET /metrics` (Prometheus; Bearer `METRICS_TOKEN` in production) |

Price line codes: `food_subtotal, food_discount, basic_delivery_fee, additional_distance_fee, abu9_plus_discount, service_fee, small_order_fee, vat_included (informational), total`.
