import type { Db } from "../../../packages/db/src/pg.ts";
import { HeuristicRiyadhRouting, type RoutingProvider } from "../../../packages/domain/src/geo.ts";
import { NearestFeasibleStrategy, type DispatchStrategy } from "../../../packages/domain/src/dispatch.ts";
import { EventBus, MockPaymentProvider, MockSmsProvider, type PaymentProvider, type SmsProvider } from "./adapters.ts";
import { config } from "./config.ts";
import { RateLimiter } from "./security/http.ts";
import { Metrics } from "./observability/metrics.ts";

export interface AppContext {
  db: Db;
  bus: EventBus;
  payments: PaymentProvider;
  sms: SmsProvider;
  routing: RoutingProvider;
  dispatch: DispatchStrategy;
  now: () => Date;
  /** null disables rate limiting (RATE_LIMIT=0). */
  limiter: RateLimiter | null;
  metrics: Metrics;
}

export function createAppContext(db: Db, overrides: Partial<AppContext> = {}): AppContext {
  return {
    db,
    bus: new EventBus(),
    payments: new MockPaymentProvider(config.paymentWebhookSecret),
    sms: new MockSmsProvider(),
    routing: new HeuristicRiyadhRouting(),
    dispatch: new NearestFeasibleStrategy(),
    now: () => new Date(),
    limiter: config.rateLimit ? new RateLimiter() : null,
    metrics: new Metrics(),
    ...overrides,
  };
}
