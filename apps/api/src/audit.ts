import type { Queryable } from "../../../packages/db/src/pg.ts";
import type { Ctx } from "./http/router.ts";

/**
 * Audit log for every sensitive operational or financial change. The table is append-only
 * (DB trigger). Call inside the same transaction as the change so they commit together.
 */
export async function audit(
  q: Queryable,
  ctx: Ctx | null,
  e: { action: string; entityType: string; entityId: string | null; before?: unknown; after?: unknown; reason?: string; actorId?: string | null },
): Promise<void> {
  await q.query(
    `insert into audit_logs(actor_id, actor_roles, action, entity_type, entity_id, before, after, reason, ip, request_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      e.actorId ?? ctx?.principal?.userId ?? null,
      ctx?.principal?.roles.map((r) => (r.scopeType === "global" ? r.role : `${r.role}@${r.scopeType}`)) ?? ["system"],
      e.action,
      e.entityType,
      e.entityId,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.reason ?? null,
      ctx?.ip ?? null,
      ctx?.requestId ?? null,
    ],
  );
}
