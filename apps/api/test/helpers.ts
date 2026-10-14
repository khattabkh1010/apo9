import type { AddressInfo } from "node:net";
import { createDb, type PgPool } from "../../../packages/db/src/pg.ts";
import { migrate } from "../../../packages/db/src/migrate.ts";
import { seed, DEMO_PHONES } from "../../../packages/db/src/seed.ts";
import { buildApp } from "../src/app.ts";
import type { AppContext } from "../src/context.ts";
import { currentStep, totpAt } from "../src/security/totp.ts";

export { DEMO_PHONES };

export interface TestServer {
  base: string;
  db: PgPool;
  app: AppContext;
  close(): Promise<void>;
}

/** Fresh schema + fictional seed in the TEST database, then an in-process server on a random port. */
export async function startTestServer(): Promise<TestServer> {
  process.env.LOG_QUIET = "1";
  const db = createDb(process.env.TEST_DATABASE_URL ?? "postgres://abu9:abu9_dev@127.0.0.1:5432/abu9_test", 8);
  await migrate(db, { reset: true, log: () => {} });
  const origLog = console.log;
  console.log = () => {};
  await seed(db);
  console.log = origLog;
  const { app, server } = buildApp(db);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    app,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await db.close();
    },
  };
}

export class Client {
  token: string | null = null;
  totpSecret: string | null = null;
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(this.base + path, {
      method,
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }
  get = <T = any>(p: string) => this.req<T>("GET", p);
  post = <T = any>(p: string, b?: unknown, h?: Record<string, string>) => this.req<T>("POST", p, b ?? {}, h);
  async login(phone: string): Promise<this> {
    const r1 = await this.post("/api/v1/auth/otp/request", { phone });
    if (r1.status !== 200) throw new Error(`otp request failed: ${JSON.stringify(r1.body)}`);
    const r2 = await this.post("/api/v1/auth/otp/verify", { challengeId: r1.body.challengeId, code: r1.body.devCode });
    if (r2.status !== 201) throw new Error(`otp verify failed: ${JSON.stringify(r2.body)}`);
    this.token = r2.body.token;
    // Staff accounts must complete TOTP before staff permissions apply (enrol on first login).
    const mfa = await this.get("/api/v1/auth/mfa");
    if (mfa.body.required && !mfa.body.verified) {
      if (!mfa.body.enrolled) {
        const en = await this.post("/api/v1/auth/mfa/totp/enroll");
        this.totpSecret = en.body.secret;
        const act = await this.post("/api/v1/auth/mfa/totp/activate", { code: totpAt(en.body.secret, currentStep()) });
        if (act.status !== 200) throw new Error(`mfa activate failed: ${JSON.stringify(act.body)}`);
      } else {
        const v = await this.post("/api/v1/auth/mfa/verify", { code: mfa.body.devCode });
        if (v.status !== 200) throw new Error(`mfa verify failed: ${JSON.stringify(v.body)}`);
      }
    }
    return this;
  }
}
