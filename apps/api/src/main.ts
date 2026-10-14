import { createDb } from "../../../packages/db/src/pg.ts";
import { migrate } from "../../../packages/db/src/migrate.ts";
import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { startJobs } from "./jobs.ts";
import { log } from "./log.ts";

const db = createDb(config.databaseUrl, Number(process.env.DB_POOL_MAX ?? 10));
if (process.env.MIGRATE_ON_START === "1") await migrate(db, { log: (s) => log.info("migrate", { step: s }) });
const { app, server } = buildApp(db);
const stopJobs = config.jobsEnabled ? startJobs(app) : () => {};

server.listen(config.port, () => log.info("listening", { port: config.port, env: process.env.NODE_ENV ?? "development", payments: app.payments.name, sms: app.sms.name }));

const shutdown = async (sig: string) => {
  log.info("shutdown", { sig });
  stopJobs();
  server.close();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
