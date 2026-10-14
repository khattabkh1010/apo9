# Deployment

> Not deployed anywhere yet. The image has been built and run locally (see LAUNCH_BLOCKERS §D). The CI workflow has not run on GitHub yet. Treat this as the target plan.

## Recommended topology (KSA data residency)
Host in a Saudi region (e.g. Google Cloud Dammam `me-central2`, Oracle Jeddah/Riyadh, or a local provider) to simplify PDPL. Components:
- **API**: container (Dockerfile) on Cloud Run / Kubernetes / ECS-equivalent, ≥2 instances behind a load balancer + WAF. Until Redis is introduced, run **one** instance with `JOBS_ENABLED=1`, or N instances with SSE sticky sessions and jobs on exactly one.
- **PostgreSQL 16** managed, HA, PITR backups. `DATABASE_URL=…?sslmode=verify-full`, plus `DATABASE_CA_CERT` (PEM or path) for the provider's CA. Production refuses a non-local DB without verified TLS.
- **Object storage + CDN** for media (`MEDIA_DIR` → S3-compatible adapter, backlog).
- **Secrets** in a secret manager: `OTP_HMAC_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `MFA_ENCRYPTION_KEY`, `METRICS_TOKEN`, DB credentials, PSP/SMS keys.
- **Edge**: TLS termination and WAF in front of the API. Set `TRUST_PROXY=1` only when the load balancer overwrites `X-Forwarded-For`. Cookies get `Secure` automatically in production.

## Release steps
1. Dependencies are pinned by the committed `package-lock.json`; Docker and CI install with `npm ci`.
2. CI: typecheck → tests against Postgres → web build → OpenAPI drift check → browser smoke of all six apps → image build. Build arg `NODE_IMAGE` lets you point the image at a registry mirror.
3. Migrations: run `node packages/db/src/migrate.ts` as a release job before rolling the API (forward-only; checksum-guarded; `--reset` is refused in production).
4. Deploy API; health check `GET /healthz` (verifies DB).
5. Smoke: OTP request, feed, quote.

## Environment
See `.env.example`. With `NODE_ENV=production` the API **refuses to start** if secrets are missing, if the payment/SMS provider is `mock`, or if a remote database is used without verified TLS (all verified in the container). OTP/TOTP dev echo, the courier simulator and relaxed OTP limits are forced off.

## Observability
- Structured JSON logs: one line per request with `requestId`, route pattern, status, latency and user. Ship stdout/stderr to the platform log sink.
- Prometheus: scrape `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN` (the endpoint returns 404 in production without the token). It exposes request counts and latency by route pattern, dispatch outcomes, and live gauges: active orders, orders awaiting acceptance, unassigned jobs and the oldest one's age, couriers online, rejections, open tickets, moderation queue.
- Alerts: `infra/prometheus/alerts.yml`. First response: `docs/RUNBOOKS.md`.
- Not yet: tracing, dashboards.
