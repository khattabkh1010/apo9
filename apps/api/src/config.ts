/**
 * Runtime configuration from environment. Secrets are NEVER hardcoded for production:
 * in production every secret must be provided or the process refuses to start.
 */
const env = process.env;
const isProd = env.NODE_ENV === "production";

function secret(name: string, devDefault: string): string {
  const v = env[name];
  if (v) return v;
  if (isProd) throw new Error(`missing required secret ${name}`);
  return devDefault;
}

export const config = {
  isProd,
  port: Number(env.PORT ?? 8080),
  databaseUrl: env.DATABASE_URL ?? "postgres://abu9:abu9_dev@127.0.0.1:5432/abu9",
  otpSecret: secret("OTP_HMAC_SECRET", "dev-only-otp-secret"),
  paymentWebhookSecret: secret("PAYMENT_WEBHOOK_SECRET", "dev-only-webhook-secret"),
  /** Dev only: return the OTP in the API response so local testing needs no SMS. Forced off in production. */
  otpDevEcho: !isProd && env.OTP_DEV_ECHO !== "0",
  paymentProvider: (env.PAYMENT_PROVIDER ?? "mock") as "mock",
  smsProvider: (env.SMS_PROVIDER ?? "mock") as "mock",
  sessionDays: Number(env.SESSION_DAYS ?? 30),
  jobsEnabled: env.JOBS_ENABLED !== "0",
  /** Demo courier movement simulator (development only). */
  simulateCouriers: !isProd && env.SIMULATE_COURIERS === "1",
  webDist: env.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname,
  mediaDir: env.MEDIA_DIR ?? new URL("../storage/media", import.meta.url).pathname,
};

// Production databases must be reached over verified TLS unless they are on the same host.
if (isProd) {
  const u = new URL(config.databaseUrl);
  const mode = u.searchParams.get("sslmode") ?? "disable";
  const local = ["localhost", "127.0.0.1", "::1", ""].includes(u.hostname);
  if (!local && mode !== "verify-full" && mode !== "verify-ca") throw new Error("production DATABASE_URL must use sslmode=verify-full (or verify-ca)");
}

if (isProd && (config.paymentProvider === "mock" || config.smsProvider === "mock")) {
  throw new Error("mock payment/SMS providers cannot run with NODE_ENV=production");
}
