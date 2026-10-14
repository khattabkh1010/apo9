import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, PgError, serializeParam } from "../src/pg.ts";

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
