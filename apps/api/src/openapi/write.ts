// Writes docs/api/openapi.json from the live route table (no DB connection needed).
import { mkdirSync, writeFileSync } from "node:fs";
import { buildApp } from "../app.ts";
import type { Db } from "../../../../packages/db/src/pg.ts";

const fakeDb = {} as Db;
const { router } = buildApp(fakeDb);
const { openApiDocument } = await import("./spec.ts");
const out = new URL("../../../../docs/api/openapi.json", import.meta.url).pathname;
mkdirSync(new URL("../../../../docs/api/", import.meta.url).pathname, { recursive: true });
writeFileSync(out, JSON.stringify(openApiDocument(router), null, 2));
console.log(`wrote ${out} (${router.routes.length} operations)`);
