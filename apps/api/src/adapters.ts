import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { log } from "./log.ts";

// ════════════════════════════ SMS ════════════════════════════
export interface SmsProvider {
  readonly name: string;
  send(toE164: string, textAr: string): Promise<void>;
}

/**
 * MOCK SMS — does not send anything. Logs the message (code redacted).
 * Integration path: Unifonic / Taqnyat / Msegat (KSA sender-ID registration with CST required).
 */
export class MockSmsProvider implements SmsProvider {
  readonly name = "mock";
  sent: Array<{ to: string; text: string }> = [];
  async send(to: string, text: string) {
    this.sent.push({ to, text });
    log.info("sms.mock_send", { to: to.slice(0, 7) + "****" + to.slice(-2), length: text.length });
  }
}

// ════════════════════════════ PAYMENTS ════════════════════════════
export type PspStatus = "authorized" | "captured" | "voided" | "failed" | "requires_action" | "refunded";

export interface AuthorizeRequest {
  amount: number; // halalas
  currency: "SAR";
  idempotencyKey: string;
  method: { type: "card_token" | "apple_pay" | "mada_token" | "test"; token: string };
  description: string;
}
export interface PspResult {
  providerRef: string;
  status: PspStatus;
  failureReason?: string;
}

/**
 * Payment service provider abstraction (authorize → capture | void → refund).
 * Real candidates for KSA: Moyasar, HyperPay, Checkout.com, Tap — each needs merchant onboarding,
 * SAMA-compliant contracts and live credentials. None are integrated yet.
 */
export interface PaymentProvider {
  readonly name: string;
  authorize(r: AuthorizeRequest): Promise<PspResult>;
  capture(providerRef: string, amount: number, idempotencyKey: string): Promise<PspResult>;
  void(providerRef: string, idempotencyKey: string): Promise<PspResult>;
  refund(providerRef: string, amount: number, idempotencyKey: string): Promise<PspResult>;
  /** Verify a webhook signature over the raw request body. */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): boolean;
}

/**
 * MOCK PSP — NOT A LICENSED PAYMENT SERVICE. No money moves. Deterministic test behaviour:
 *   token "tok_decline" → declined, "tok_3ds" → requires_action, anything else → authorized.
 * Idempotent per key, like real PSPs.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  private byKey = new Map<string, PspResult>();
  private secret: string;
  constructor(webhookSecret: string) {
    this.secret = webhookSecret;
  }
  private once(key: string, f: () => PspResult): PspResult {
    const prev = this.byKey.get(key);
    if (prev) return prev;
    const r = f();
    this.byKey.set(key, r);
    return r;
  }
  async authorize(r: AuthorizeRequest) {
    return this.once(`auth:${r.idempotencyKey}`, () => {
      if (r.method.token === "tok_decline") return { providerRef: `mock_${randomUUID()}`, status: "failed", failureReason: "card_declined" };
      if (r.method.token === "tok_3ds") return { providerRef: `mock_${randomUUID()}`, status: "requires_action" };
      return { providerRef: `mock_${randomUUID()}`, status: "authorized" };
    });
  }
  async capture(ref: string, _amount: number, key: string) {
    return this.once(`cap:${key}`, () => ({ providerRef: ref, status: "captured" }));
  }
  async void(ref: string, key: string) {
    return this.once(`void:${key}`, () => ({ providerRef: ref, status: "voided" }));
  }
  async refund(ref: string, _amount: number, key: string) {
    return this.once(`ref:${key}`, () => ({ providerRef: ref, status: "refunded" }));
  }
  sign(rawBody: Buffer | string): string {
    return "sha256=" + createHmac("sha256", this.secret).update(rawBody).digest("hex");
  }
  verifyWebhook(rawBody: Buffer, header: string | undefined): boolean {
    if (!header) return false;
    const expected = Buffer.from(this.sign(rawBody));
    const got = Buffer.from(header);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
}

// ════════════════════════════ EVENT BUS ════════════════════════════
/**
 * In-process pub/sub for real-time updates (SSE). Single-instance only.
 * Multi-instance deployment needs Redis pub/sub (or Postgres LISTEN/NOTIFY) behind this interface.
 */
export class EventBus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(10_000);
  }
  publish(channel: string, event: Record<string, unknown>) {
    this.ee.emit(channel, { ...event, at: new Date().toISOString() });
  }
  subscribe(channel: string, fn: (e: Record<string, unknown>) => void): () => void {
    this.ee.on(channel, fn);
    return () => this.ee.off(channel, fn);
  }
}
