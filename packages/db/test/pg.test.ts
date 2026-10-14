import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, PgError, resolveDbConfig, serializeParam } from "../src/pg.ts";

const db = createDb(process.env.TEST_DATABASE_URL ?? "postgres://abu9:abu9_dev@127.0.0.1:5432/abu9_test", 3);
after(() => db.close());

test("parameterised query round-trips types without interpolation", async () => {
  const evil = "x'); drop table users; --";
  const r = await db.query<Record<string, unknown>>(
    `select $1::int as a, $2::text as b, now() as t, '{"x":1}'::jsonb as j, array['a','b c', null]::text[] as arr,
            null as n, $3::bigint as big, true as ok, 'مرحبا' as ar, $4::jsonb as payload`,
    [5, evil, 123456789012, { nested: ["ح", 1] }],
  );
  const row = r.rows[0]!;
  assert.equal(row.a, 5);
  assert.equal(row.b, evil);
  assert.ok(row.t instanceof Date && !Number.isNaN((row.t as Date).getTime()));
  assert.deepEqual(row.j, { x: 1 });
  assert.deepEqual(row.arr, ["a", "b c", null]);
  assert.equal(row.n, null);
  assert.equal(row.big, 123456789012);
  assert.equal(row.ok, true);
  assert.equal(row.ar, "مرحبا");
  assert.deepEqual(row.payload, { nested: ["ح", 1] });
});

test("errors carry SQLSTATE and connection stays usable", async () => {
  await assert.rejects(db.query("select * from definitely_missing"), (e: unknown) => e instanceof PgError && e.code === "42P01");
  const r = await db.query<{ one: number }>("select 1 as one");
  assert.equal(r.rows[0]!.one, 1);
});

test("transactions commit and roll back", async () => {
  await db.exec("create table if not exists _pg_tx_test (x int)");
  await db.query("truncate _pg_tx_test");
  await db.tx(async (q) => {
    await q.query("insert into _pg_tx_test values ($1)", [1]);
  });
  await assert.rejects(
    db.tx(async (q) => {
      await q.query("insert into _pg_tx_test values ($1)", [2]);
      throw new Error("boom");
    }),
  );
  const r = await db.query<{ s: number }>("select coalesce(sum(x),0)::int as s from _pg_tx_test");
  assert.equal(r.rows[0]!.s, 1);
  await db.exec("drop table _pg_tx_test");
});

test("concurrent queries through the pool", async () => {
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => db.query<{ v: number }>("select $1::int * 2 as v", [i])));
  assert.deepEqual(rs.map((r) => r.rows[0]!.v), Array.from({ length: 20 }, (_, i) => i * 2));
});

test("param serialisation", () => {
  assert.equal(serializeParam(["a", 'q"x']), '{"a","q\\"x"}');
  assert.equal(serializeParam(false), "f");
  assert.equal(serializeParam(undefined), null);
});

test("date, numeric, timestamp and bigint[] keep exact semantics", async () => {
  const r = await db.query<Record<string, unknown>>(
    "select '2026-03-01'::date d, 12.50::numeric n, '2026-03-01 10:00:00'::timestamp ts, array[1, 9007199254740993]::bigint[] ba, 9007199254740993::bigint huge",
  );
  const row = r.rows[0]!;
  assert.equal(row.d, "2026-03-01");
  assert.equal(row.n, "12.50");
  assert.equal((row.ts as Date).toISOString(), "2026-03-01T10:00:00.000Z");
  assert.deepEqual(row.ba, [1, "9007199254740993"]);
  assert.equal(row.huge, "9007199254740993");
});

test("jsonb params: arrays of objects go in as JSON, scalar arrays as Postgres arrays", async () => {
  const r = await db.query<{ j: unknown; a: string[] }>("select $1::jsonb j, $2::text[] a", [[{ k: 1 }], ["x", "y"]]);
  assert.deepEqual(r.rows[0]!.j, [{ k: 1 }]);
  assert.deepEqual(r.rows[0]!.a, ["x", "y"]);
});

test("sslmode resolution", () => {
  assert.equal(resolveDbConfig("postgres://u:p@h/db").ssl, false);
  const full = resolveDbConfig("postgres://u:p@db.internal/db?sslmode=verify-full", "-----BEGIN CERTIFICATE-----x");
  assert.equal(full.sslmode, "verify-full");
  assert.ok(full.ssl && full.ssl.rejectUnauthorized === true && full.ssl.ca);
  assert.ok(!full.connectionString.includes("sslmode"));
  const req = resolveDbConfig("postgres://u:p@h/db?sslmode=require");
  assert.ok(req.ssl && req.ssl.rejectUnauthorized === false);
  assert.throws(() => resolveDbConfig("postgres://u:p@h/db?sslmode=bogus"));
});
