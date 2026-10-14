/**
 * PostgreSQL access for ABU9, backed by the `pg` driver (node-postgres).
 *
 * The rest of the codebase depends only on the `Db` / `Queryable` interfaces and `PgError` below,
 * so the driver stays swappable. Value semantics are pinned here (not left to driver defaults):
 *   - bigint (money in halalas) → number when it is a safe integer, else exact string
 *   - numeric → exact string (callers convert deliberately)
 *   - timestamptz / timestamp → Date (timestamp without zone is read as UTC)
 *   - date → 'YYYY-MM-DD' string (no local-time shifting)
 *   - json/jsonb → parsed; 1-D arrays → JS arrays
 * Parameters are serialised by `serializeParam` so jsonb/array behaviour is identical everywhere.
 *
 * TLS: controlled by `sslmode` in DATABASE_URL — disable | require | verify-ca | verify-full —
 * plus DATABASE_CA_CERT (PEM text or a file path) for private CAs. In production `verify-full`
 * (or `verify-ca`) is mandatory unless the host is local (see apps/api/src/config.ts).
 */
import { readFileSync, existsSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import pg from "pg";

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  command: string;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** Database error with SQLSTATE, independent of the driver's own error class. */
export class PgError extends Error {
  code: string;
  detail: string | undefined;
  constraint: string | undefined;
  constructor(message: string, code: string, detail?: string, constraint?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.constraint = constraint;
  }
}

function wrapError(e: unknown): unknown {
  if (e instanceof pg.DatabaseError) return new PgError(e.message, e.code ?? "XX000", e.detail, e.constraint);
  return e;
}

// ───────────────────────── parameter serialisation ─────────────────────────

function arrayLiteral(arr: unknown[]): string {
  return (
    "{" +
    arr
      .map((v) => {
        if (v === null || v === undefined) return "NULL";
        if (Array.isArray(v)) return arrayLiteral(v);
        const s = v instanceof Date ? v.toISOString() : String(v);
        return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
      })
      .join(",") +
    "}"
  );
}

/** Wrap a value to force JSON serialisation (e.g. a string[] going into a jsonb column). */
export class JsonParam {
  value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}
export const asJson = (v: unknown) => new JsonParam(v);

export function serializeParam(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof JsonParam) return JSON.stringify(v.value);
  // Arrays of objects can only be JSON; arrays of scalars become Postgres array literals.
  if (Array.isArray(v) && v.some((x) => x !== null && typeof x === "object" && !(x instanceof Date) && !Array.isArray(x))) return JSON.stringify(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "boolean") return v ? "t" : "f";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return "\\x" + v.toString("hex");
  if (Array.isArray(v)) return arrayLiteral(v);
  return JSON.stringify(v);
}

// ───────────────────────────── type parsing ─────────────────────────────

const OID = { int8: 20, numeric: 1700, timestamp: 1114, timestamptz: 1184, date: 1082, int8Arr: 1016 };

function parseInt8(text: string): number | string {
  const n = Number(text);
  // Money is stored as bigint halalas; values beyond 2^53 would indicate a bug, keep them exact as strings.
  return Number.isSafeInteger(n) ? n : text;
}

const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    switch (oid) {
      case OID.int8:
        return parseInt8;
      case OID.numeric:
      case OID.date:
        return (t: string) => t;
      case OID.timestamp:
        return (t: string) => new Date(t.replace(" ", "T") + "Z");
      case OID.int8Arr: {
        const arr = (pg.types.getTypeParser as (oid: number) => unknown)(1009) as (t: string) => Array<string | null>;
        return (t: string) => arr(t).map((x) => (x === null ? null : parseInt8(x)));
      }
      default:
        return pg.types.getTypeParser(oid, format as "text");
    }
  },
};

// ─────────────────────────────── TLS ───────────────────────────────

export type SslMode = "disable" | "require" | "verify-ca" | "verify-full";

export interface ResolvedDbConfig {
  connectionString: string;
  sslmode: SslMode;
  ssl: false | ConnectionOptions;
  host: string;
}

function loadCa(ca: string | undefined): string | undefined {
  if (!ca) return undefined;
  if (ca.includes("-----BEGIN")) return ca;
  if (existsSync(ca)) return readFileSync(ca, "utf8");
  throw new Error("DATABASE_CA_CERT is neither PEM text nor a readable file path");
}

/** Interpret `sslmode` ourselves (pg's own parsing of `require` changed across versions). */
export function resolveDbConfig(url: string, caCert = process.env.DATABASE_CA_CERT): ResolvedDbConfig {
  const u = new URL(url);
  const raw = (u.searchParams.get("sslmode") ?? "disable").toLowerCase();
  for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"]) u.searchParams.delete(k);
  const sslmode: SslMode = raw === "prefer" || raw === "allow" ? "disable" : (raw as SslMode);
  if (!["disable", "require", "verify-ca", "verify-full"].includes(sslmode)) throw new Error(`unsupported sslmode ${raw}`);
  const ca = loadCa(caCert);
  let ssl: false | ConnectionOptions = false;
  if (sslmode === "require") ssl = { rejectUnauthorized: false };
  else if (sslmode === "verify-ca") ssl = { rejectUnauthorized: true, ...(ca ? { ca } : {}), checkServerIdentity: () => undefined };
  else if (sslmode === "verify-full") ssl = { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  return { connectionString: u.toString(), sslmode, ssl, host: u.hostname };
}

// ─────────────────────────────── pool ───────────────────────────────

function toResult<T>(r: pg.QueryResult): QueryResult<T> {
  return { rows: r.rows as T[], rowCount: r.rowCount ?? 0, command: r.command };
}

async function run<T>(c: pg.Pool | pg.PoolClient, sql: string, params?: unknown[]): Promise<QueryResult<T>> {
  try {
    const r = await c.query({ text: sql, values: params?.map(serializeParam), types } as pg.QueryConfig);
    return toResult<T>(r);
  } catch (e) {
    throw wrapError(e);
  }
}

export class PgPool implements Db {
  readonly pool: pg.Pool;
  readonly sslmode: SslMode;

  constructor(url: string, max = 10) {
    const cfg = resolveDbConfig(url);
    this.sslmode = cfg.sslmode;
    this.pool = new pg.Pool({ connectionString: cfg.connectionString, ssl: cfg.ssl, max, application_name: "abu9", idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    // An idle client losing its connection must not crash the process; the pool replaces it.
    this.pool.on("error", (e) => process.stderr.write(JSON.stringify({ level: "error", msg: "pg_idle_client_error", error: e.message }) + "\n"));
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return run<T>(this.pool, sql, params);
  }

  /** Multi-statement script via the simple protocol (migrations, seed). */
  async exec(sql: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query(sql);
    } catch (e) {
      // A failing script may leave an explicit transaction open; clear it on THIS connection.
      await c.query("rollback").catch(() => undefined);
      throw wrapError(e);
    } finally {
      c.release();
    }
  }

  /** Run `fn` in a transaction on a dedicated connection. Rolls back on any thrown error. */
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let broken = false;
    try {
      await c.query("BEGIN");
      try {
        const r = await fn({ query: <R>(sql: string, params?: unknown[]) => run<R>(c, sql, params) });
        await c.query("COMMIT");
        return r;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => (broken = true));
        throw wrapError(e);
      }
    } finally {
      c.release(broken);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDb(url = process.env.DATABASE_URL ?? "postgres://abu9:abu9_dev@127.0.0.1:5432/abu9", max = 10): PgPool {
  return new PgPool(url, max);
}
