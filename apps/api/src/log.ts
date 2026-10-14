/** Structured JSON logs (one line per event) — ship to any log pipeline (CloudWatch, Loki, Datadog). */
type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;
const quiet = () => process.env.LOG_QUIET === "1";

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (quiet() || LEVELS[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, service: "abu9-api", ...fields });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
