/**
 * Minimal PostgreSQL client implementing the v3 wire protocol.
 *
 * WHY THIS EXISTS: the build sandbox had no npm registry access, so `pg`/`postgres` could not be
 * installed. This client implements exactly what ABU9 needs — SCRAM-SHA-256/MD5/trust auth,
 * parameterised queries via the extended protocol (no string interpolation of values),
 * simple multi-statement queries for migrations, a small pool, and transactions.
 *
 * MIGRATION PATH: everything else in the codebase depends only on the `Db`/`Queryable`
 * interfaces below. To switch to `pg`, implement those interfaces with pg.Pool in one file.
 * Not supported here: TLS (`sslmode`), COPY, LISTEN/NOTIFY, cancellation. Production on a managed
 * Postgres REQUIRES TLS — see docs/LAUNCH_BLOCKERS.md.
 */
import net from "node:net";
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

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

export class PgError extends Error {
  code: string;
  detail: string | undefined;
  constraint: string | undefined;
  fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? "PostgreSQL error");
    this.fields = fields;
    this.code = fields.C ?? "XX000";
    this.detail = fields.D;
    this.constraint = fields.n;
  }
}

export interface PgConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  applicationName?: string;
}

export function parseDatabaseUrl(url: string): PgConfig {
  const u = new URL(url);
  return {
    host: u.hostname || "127.0.0.1",
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
  };
}

// ───────────────────────── serialisation helpers ─────────────────────────

function cstr(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
}
function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}
function int16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}
function msg(type: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type, "ascii"), int32(body.length + 4), body]);
}

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

// Type OIDs we parse; everything else is returned as text.
const OID = { bool: 16, int8: 20, int2: 21, int4: 23, oid: 26, json: 114, float4: 700, float8: 701, numeric: 1700, timestamp: 1114, timestamptz: 1184, date: 1082, jsonb: 3802, textArr: 1009, uuidArr: 2951, int4Arr: 1007, varcharArr: 1015 };

function parseArray(s: string, item: (x: string) => unknown): unknown[] {
  // 1-dimensional arrays only.
  const inner = s.slice(1, -1);
  if (inner === "") return [];
  const out: unknown[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '"') {
      let v = "";
      i++;
      while (inner[i] !== '"') {
        if (inner[i] === "\\") i++;
        v += inner[i];
        i++;
      }
      i++;
      out.push(item(v));
    } else {
      let j = inner.indexOf(",", i);
      if (j === -1) j = inner.length;
      const raw = inner.slice(i, j);
      out.push(raw === "NULL" ? null : item(raw));
      i = j;
    }
    if (inner[i] === ",") i++;
  }
  return out;
}

export function parseValue(oid: number, text: string): unknown {
  switch (oid) {
    case OID.bool:
      return text === "t";
    case OID.int2:
    case OID.int4:
    case OID.oid:
      return Number(text);
    case OID.int8: {
      const n = Number(text);
      // Money is stored as bigint halalas; values beyond 2^53 would indicate a bug, keep them exact as strings.
      return Number.isSafeInteger(n) ? n : text;
    }
    case OID.float4:
    case OID.float8:
      return Number(text);
    case OID.numeric:
      return text; // exact; callers convert deliberately
    case OID.json:
    case OID.jsonb:
      return JSON.parse(text);
    case OID.timestamptz:
    case OID.timestamp:
      return new Date(oid === OID.timestamp ? text.replace(" ", "T") + "Z" : text.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
    case OID.textArr:
    case OID.uuidArr:
    case OID.varcharArr:
      return parseArray(text, (x) => x);
    case OID.int4Arr:
      return parseArray(text, (x) => Number(x));
    default:
      return text;
  }
}

// ───────────────────────────── connection ─────────────────────────────

interface Pending {
  resolve: (r: QueryResult) => void;
  reject: (e: Error) => void;
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; oid: number }>;
  command: string;
  error: PgError | null;
  results: QueryResult[]; // simple query may yield several
}

export class PgConnection implements Queryable {
  private socket!: net.Socket;
  private buf = Buffer.alloc(0);
  private queue: Pending[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private scram: { clientNonce: string; clientFirstBare: string; serverSignature?: Buffer } | null = null;
  private cfg: PgConfig;
  closed = false;

  constructor(cfg: PgConfig) {
    this.cfg = cfg;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.socket = net.createConnection({ host: this.cfg.host, port: this.cfg.port });
      this.socket.setNoDelay(true);
      this.socket.on("connect", () => {
        const params = Buffer.concat([
          int32(196608),
          cstr("user"), cstr(this.cfg.user),
          cstr("database"), cstr(this.cfg.database),
          cstr("application_name"), cstr(this.cfg.applicationName ?? "abu9"),
          cstr("client_encoding"), cstr("UTF8"),
          cstr("TimeZone"), cstr("UTC"),
          Buffer.from([0]),
        ]);
        this.socket.write(Buffer.concat([int32(params.length + 4), params]));
      });
      this.socket.on("data", (d) => this.onData(d));
      this.socket.on("error", (e) => this.fail(e));
      this.socket.on("close", () => {
        this.closed = true;
        this.fail(new Error("connection closed"));
      });
    });
  }

  private fail(e: Error) {
    if (this.readyReject) {
      this.readyReject(e);
      this.readyReject = this.readyResolve = null;
    }
    for (const p of this.queue.splice(0)) p.reject(e);
  }

  private onData(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const type = String.fromCharCode(this.buf[0]!);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      try {
        this.handle(type, body);
      } catch (e) {
        this.fail(e as Error);
        this.socket.destroy();
        return;
      }
    }
  }

  private handle(type: string, body: Buffer) {
    const cur = this.queue[0];
    switch (type) {
      case "R":
        return this.handleAuth(body);
      case "S": // ParameterStatus
      case "K": // BackendKeyData
      case "N": // Notice
      case "1": // ParseComplete
      case "2": // BindComplete
      case "n": // NoData
      case "I": // EmptyQueryResponse
        return;
      case "Z":
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = this.readyReject = null;
          return;
        }
        if (cur) {
          this.queue.shift();
          if (cur.error) cur.reject(cur.error);
          else {
            const last = cur.results[cur.results.length - 1] ?? { rows: [], rowCount: 0, command: "" };
            cur.resolve(last);
          }
        }
        return;
      case "T": {
        if (!cur) return;
        const n = body.readInt16BE(0);
        let off = 2;
        cur.fields = [];
        cur.rows = [];
        for (let i = 0; i < n; i++) {
          const end = body.indexOf(0, off);
          const name = body.toString("utf8", off, end);
          off = end + 1;
          const oid = body.readInt32BE(off + 6);
          off += 18;
          cur.fields.push({ name, oid });
        }
        return;
      }
      case "D": {
        if (!cur) return;
        const n = body.readInt16BE(0);
        let off = 2;
        const row: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const len = body.readInt32BE(off);
          off += 4;
          const f = cur.fields[i]!;
          if (len === -1) row[f.name] = null;
          else {
            row[f.name] = parseValue(f.oid, body.toString("utf8", off, off + len));
            off += len;
          }
        }
        cur.rows.push(row);
        return;
      }
      case "C": {
        if (!cur) return;
        const tag = body.toString("utf8", 0, body.length - 1);
        const parts = tag.split(" ");
        const count = Number(parts[parts.length - 1]);
        cur.results.push({ rows: cur.rows, rowCount: Number.isFinite(count) ? count : cur.rows.length, command: parts[0] ?? "" });
        cur.rows = [];
        cur.fields = [];
        return;
      }
      case "E": {
        const fields: Record<string, string> = {};
        let off = 0;
        while (off < body.length && body[off] !== 0) {
          const code = String.fromCharCode(body[off]!);
          const end = body.indexOf(0, off + 1);
          fields[code] = body.toString("utf8", off + 1, end);
          off = end + 1;
        }
        const err = new PgError(fields);
        if (this.readyReject) {
          this.readyReject(err);
          this.readyReject = this.readyResolve = null;
          return;
        }
        if (cur && !cur.error) cur.error = err;
        return;
      }
      default:
        return;
    }
  }

  private handleAuth(body: Buffer) {
    const kind = body.readInt32BE(0);
    if (kind === 0) return; // AuthenticationOk
    if (kind === 3) {
      this.socket.write(msg("p", cstr(this.cfg.password)));
      return;
    }
    if (kind === 5) {
      const salt = body.subarray(4, 8);
      const inner = createHash("md5").update(this.cfg.password + this.cfg.user).digest("hex");
      const outer = createHash("md5").update(Buffer.concat([Buffer.from(inner), salt])).digest("hex");
      this.socket.write(msg("p", cstr("md5" + outer)));
      return;
    }
    if (kind === 10) {
      const mechs = body.toString("utf8", 4).split("\0");
      if (!mechs.includes("SCRAM-SHA-256")) throw new Error("server does not offer SCRAM-SHA-256");
      const clientNonce = randomBytes(18).toString("base64");
      const clientFirstBare = `n=*,r=${clientNonce}`;
      this.scram = { clientNonce, clientFirstBare };
      const first = Buffer.from("n,," + clientFirstBare, "utf8");
      this.socket.write(msg("p", Buffer.concat([cstr("SCRAM-SHA-256"), int32(first.length), first])));
      return;
    }
    if (kind === 11) {
      if (!this.scram) throw new Error("unexpected SASL continue");
      const serverFirst = body.toString("utf8", 4);
      const attrs = Object.fromEntries(serverFirst.split(",").map((kv) => [kv[0], kv.slice(2)]));
      const nonce = attrs.r!;
      if (!nonce.startsWith(this.scram.clientNonce)) throw new Error("SCRAM nonce mismatch");
      const salt = Buffer.from(attrs.s!, "base64");
      const iterations = Number(attrs.i);
      const salted = pbkdf2Sync(this.cfg.password.normalize("NFKC"), salt, iterations, 32, "sha256");
      const clientKey = createHmac("sha256", salted).update("Client Key").digest();
      const storedKey = createHash("sha256").update(clientKey).digest();
      const clientFinalNoProof = `c=biws,r=${nonce}`;
      const authMessage = `${this.scram.clientFirstBare},${serverFirst},${clientFinalNoProof}`;
      const clientSig = createHmac("sha256", storedKey).update(authMessage).digest();
      const proof = Buffer.from(clientKey.map((b, i) => b ^ clientSig[i]!));
      const serverKey = createHmac("sha256", salted).update("Server Key").digest();
      this.scram.serverSignature = createHmac("sha256", serverKey).update(authMessage).digest();
      this.socket.write(msg("p", Buffer.from(`${clientFinalNoProof},p=${proof.toString("base64")}`, "utf8")));
      return;
    }
    if (kind === 12) {
      const final = body.toString("utf8", 4);
      const v = Buffer.from(final.replace(/^v=/, ""), "base64");
      const expected = this.scram?.serverSignature;
      if (!expected || v.length !== expected.length || !timingSafeEqual(v, expected)) throw new Error("SCRAM server signature mismatch");
      return;
    }
    throw new Error(`unsupported auth method ${kind}`);
  }

  private enqueue(packet: Buffer): Promise<QueryResult> {
    const run = () =>
      new Promise<QueryResult>((resolve, reject) => {
        if (this.closed) return reject(new Error("connection closed"));
        this.queue.push({ resolve, reject, rows: [], fields: [], command: "", error: null, results: [] });
        this.socket.write(packet);
      });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const values = params.map(serializeParam);
    const bind = Buffer.concat([
      cstr(""), cstr(""),
      int16(0), // all params text format
      int16(values.length),
      ...values.map((v) => (v === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v, "utf8")]))),
      int16(0), // all results text
    ]);
    const packet = Buffer.concat([
      msg("P", Buffer.concat([cstr(""), cstr(sql), int16(0)])),
      msg("B", bind),
      msg("D", Buffer.concat([Buffer.from("P"), cstr("")])),
      msg("E", Buffer.concat([cstr(""), int32(0)])),
      msg("S", Buffer.alloc(0)),
    ]);
    return this.enqueue(packet) as Promise<QueryResult<T>>;
  }

  /** Simple-protocol query: multiple statements, no parameters. Use ONLY for trusted SQL (migrations). */
  async exec(sql: string): Promise<void> {
    await this.enqueue(msg("Q", cstr(sql)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.socket.end(msg("X", Buffer.alloc(0)), () => resolve());
    });
  }
}

// ─────────────────────────────── pool ───────────────────────────────

export class PgPool implements Db {
  private idle: PgConnection[] = [];
  private total = 0;
  private waiters: Array<(c: PgConnection) => void> = [];
  private cfg: PgConfig;
  private max: number;

  constructor(cfg: PgConfig, max = 10) {
    this.cfg = cfg;
    this.max = max;
  }

  private async acquire(): Promise<PgConnection> {
    while (this.idle.length) {
      const c = this.idle.pop()!;
      if (!c.closed) return c;
      this.total--;
    }
    if (this.total < this.max) {
      this.total++;
      const c = new PgConnection(this.cfg);
      try {
        await c.connect();
      } catch (e) {
        this.total--;
        throw e;
      }
      return c;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(c: PgConnection) {
    if (c.closed) {
      this.total--;
      return;
    }
    const w = this.waiters.shift();
    if (w) w(c);
    else this.idle.push(c);
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const c = await this.acquire();
    try {
      return await c.query<T>(sql, params);
    } finally {
      this.release(c);
    }
  }

  async exec(sql: string): Promise<void> {
    const c = await this.acquire();
    try {
      await c.exec(sql);
    } catch (e) {
      // A failing multi-statement script may leave an explicit transaction open; clear it on THIS connection.
      await c.exec("rollback").catch(() => undefined);
      throw e;
    } finally {
      this.release(c);
    }
  }

  /** Run `fn` in a transaction on a dedicated connection. Rolls back on any thrown error. */
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    try {
      await c.query("BEGIN");
      try {
        const r = await fn(c);
        await c.query("COMMIT");
        return r;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    } finally {
      this.release(c);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.idle.splice(0).map((c) => c.close()));
    this.total = 0;
  }
}

export function createDb(url = process.env.DATABASE_URL ?? "postgres://abu9:abu9_dev@127.0.0.1:5432/abu9", max = 10): PgPool {
  return new PgPool(parseDatabaseUrl(url), max);
}
