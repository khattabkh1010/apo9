/**
 * Forward-only SQL migration runner.
 *   node packages/db/src/migrate.ts            apply pending migrations
 *   node packages/db/src/migrate.ts --reset    DROP everything, then apply (dev/test only; refused when NODE_ENV=production)
 */
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDb, type Db } from "./pg.ts";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

export async function migrate(db: Db, opts: { reset?: boolean; log?: (s: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? console.log;
  if (opts.reset) {
    if (process.env.NODE_ENV === "production") throw new Error("refusing to reset a production database");
    await db.exec("drop schema public cascade; create schema public;");
    log("schema reset");
  }
  await db.exec(`create table if not exists schema_migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const applied = new Map(
    (await db.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations")).rows.map((r) => [r.name, r.checksum]),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const f of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, f), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const prev = applied.get(f);
    if (prev) {
      if (prev !== checksum) throw new Error(`migration ${f} was modified after being applied — create a new migration instead`);
      continue;
    }
    // Simple protocol runs the whole file; wrap in a transaction so a failure leaves nothing half-applied.
    await db.exec(`begin;\n${sql}\n;insert into schema_migrations(name, checksum) values ('${f.replace(/'/g, "''")}', '${checksum}');\ncommit;`).catch((e) => {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    });
    log(`applied ${f}`);
    ran.push(f);
  }
  return ran;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = createDb();
  migrate(db, { reset: process.argv.includes("--reset") })
    .then((r) => console.log(r.length ? `done (${r.length} applied)` : "up to date"))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}
