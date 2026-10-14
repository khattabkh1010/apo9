# Deployment

> Not deployed anywhere yet. The Dockerfile and CI workflow are written but were not executed in the build sandbox (no Docker daemon / registry). Treat this as the target plan.

## Recommended topology (KSA data residency)
Host in a Saudi region (e.g. Google Cloud Dammam `me-central2`, Oracle Jeddah/Riyadh, or a local provider) to simplify PDPL. Components:
- **API**: container (Dockerfile) on Cloud Run / Kubernetes / ECS-equivalent, ≥2 instances behind a load balancer + WAF. Until Redis is introduced, run **one** instance with `JOBS_ENABLED=1`, or N instances with SSE sticky sessions and jobs on exactly one.
- **PostgreSQL 16** managed, HA, PITR backups, `sslmode=verify-full` (requires swapping to `pg`).
- **Object storage + CDN** for media (`MEDIA_DIR` → S3-compatible adapter, backlog).
- **Secrets** in a secret manager: `OTP_HMAC_SECRET`, `PAYMENT_WEBHOOK_SECRET`, DB credentials, PSP/SMS keys.

## Release steps
1. `npm install` with registry access → commit `package-lock.json` → switch Docker/CI to `npm ci`.
2. CI: typecheck → tests against Postgres → web build → OpenAPI drift check → image build.
3. Migrations: run `node packages/db/src/migrate.ts` as a release job before rolling the API (forward-only; checksum-guarded; `--reset` is refused in production).
4. Deploy API; health check `GET /healthz` (verifies DB).
5. Smoke: OTP request, feed, quote.

## Environment
See `.env.example`. With `NODE_ENV=production` the API **refuses to start** if secrets are missing or if the payment/SMS provider is `mock`, and OTP dev echo is forced off.

## Observability
Structured JSON logs (one line per request with `requestId`, route, status, latency, user). Ship stdout/stderr to the platform log sink. Metrics/tracing/alerts are backlog P1.
