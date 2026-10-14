# API contracts

Full machine-readable contract: `docs/api/openapi.json` (OpenAPI 3.1, generated from the live route table by `npm run openapi`; CI fails on drift). Served at `GET /api/openapi.json`.

## Conventions
- Base path `/api/v1`. JSON. Auth: `Authorization: Bearer <token>` from `POST /auth/otp/verify`.
- **Money**: integer halalas. Consumer amounts are VAT-inclusive.
- **Time**: ISO-8601 UTC; clients display Asia/Riyadh.
- **Errors**: `{ "error": { "code", "message", "details?", "requestId" } }`. Messages are customer-safe Arabic where user-facing. Status codes: 400 validation, 401 auth, 402 payment failed, 403 permission, 404, 409 conflict/state, 422 business rule, 429 rate-limited.
- **Idempotency**: `POST /orders` and `POST /plus/subscribe` require `Idempotency-Key`; retries return the original result.
- **Real time**: `GET /orders/:id/stream` (SSE; `access_token` query param allowed only on stream routes).

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

Price line codes: `food_subtotal, food_discount, basic_delivery_fee, additional_distance_fee, abu9_plus_discount, service_fee, small_order_fee, vat_included (informational), total`.
