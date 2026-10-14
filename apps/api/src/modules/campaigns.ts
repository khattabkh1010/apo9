import { z } from "zod";
import { canApprove, validateCampaign } from "../../../../packages/domain/src/creators.ts";
import type { Queryable } from "../../../../packages/db/src/pg.ts";
import type { AppContext } from "../context.ts";
import { ApiError, badRequest, conflict, forbidden, notFound, withStatus, type Ctx, type Router } from "../http/router.ts";
import { requirePermission, requireRestaurantAccess } from "../auth/rbac.ts";
import { audit } from "../audit.ts";

/**
 * Creator campaigns: proposed by a restaurant (self-funded) or by ABU9 ops (ABU9-funded or shared),
 * always approved by a DIFFERENT staff member (four-eyes). Creators opt in; ops approves each creator.
 */
const CampaignBody = z.object({
  name: z.string().min(3).max(80),
  descriptionAr: z.string().max(300).optional(),
  incentiveType: z.enum(["none", "fixed_per_order", "percent_of_food"]),
  incentiveValue: z.number().int().min(0).max(1_000_000),
  budget: z.number().int().min(0).max(100_000_000),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
});
type CampaignInput = z.infer<typeof CampaignBody>;

function checkDraft(b: CampaignInput, now: Date) {
  const problems = validateCampaign({ ...b, startsAt: b.startsAt ? new Date(b.startsAt) : null, endsAt: b.endsAt ? new Date(b.endsAt) : null }, now);
  if (problems.length) throw badRequest("invalid_campaign", problems[0], problems);
}

async function insertCampaign(q: Queryable, b: CampaignInput, restaurantId: string | null, fundedBy: string, createdBy: string) {
  return (await q.query<{ id: string }>(
    `insert into creator_campaigns(restaurant_id, name, description_ar, incentive_type, incentive_value, funded_by, budget, status, starts_at, ends_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,'pending_approval',$8,$9,$10) returning *`,
    [restaurantId, b.name, b.descriptionAr ?? null, b.incentiveType, b.incentiveValue, fundedBy, b.budget, b.startsAt ?? null, b.endsAt ?? null, createdBy],
  )).rows[0]!;
}

const CAMPAIGN_STATS = `(select count(*) from creator_campaign_enrollments e where e.campaign_id = cc.id and e.status = 'approved')::int creators_approved,
  (select count(*) from creator_campaign_enrollments e where e.campaign_id = cc.id and e.status = 'opted_in')::int creators_pending,
  (select count(*) from creator_incentives i where i.campaign_id = cc.id and i.status <> 'rejected')::int attributed_orders`;

export function campaignRoutes(r: Router, app: AppContext) {
  // ── restaurant-funded campaigns ──
  const scope = (ctx: Ctx) => {
    requireRestaurantAccess(ctx, ctx.params.rid!);
    return ctx.params.rid!;
  };

  r.get("/api/v1/restaurant/:rid/creator-campaigns", async (ctx) => {
    const rid = scope(ctx);
    return { campaigns: (await app.db.query(`select cc.*, ${CAMPAIGN_STATS} from creator_campaigns cc where cc.restaurant_id = $1 order by cc.created_at desc`, [rid])).rows };
  });

  r.post("/api/v1/restaurant/:rid/creator-campaigns", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(CampaignBody);
    checkDraft(b, app.now());
    const st = (await app.db.query<{ status: string }>("select status from restaurants where id = $1", [rid])).rows[0];
    if (st?.status !== "active") throw conflict("restaurant_not_active", "الحملات متاحة بعد تفعيل المطعم");
    return app.db.tx(async (q) => {
      const c = await insertCampaign(q, b, rid, "restaurant", ctx.principal!.userId);
      await audit(q, ctx, { action: "creator_campaign.propose", entityType: "creator_campaign", entityId: c.id, after: c });
      return withStatus(201, { campaign: c });
    });
  });

  r.post("/api/v1/restaurant/:rid/creator-campaigns/:cid/status", async (ctx) => {
    const rid = scope(ctx);
    // Restaurants can stop spending on their own campaign at any time, but restarting needs ops.
    const { status } = await ctx.body(z.object({ status: z.enum(["paused", "ended"]) }));
    return app.db.tx(async (q) => {
      const c = (await q.query<{ status: string }>("select status from creator_campaigns where id = $1 and restaurant_id = $2 and funded_by = 'restaurant' for update", [ctx.params.cid, rid])).rows[0];
      if (!c) throw notFound("campaign");
      if (c.status === "ended") throw conflict("campaign_ended");
      await q.query("update creator_campaigns set status = $2 where id = $1", [ctx.params.cid, status]);
      await audit(q, ctx, { action: `creator_campaign.${status}`, entityType: "creator_campaign", entityId: ctx.params.cid!, before: c, after: { status } });
      return { ok: true };
    });
  });

  // ── ops ──
  r.post("/api/v1/admin/creator-campaigns", async (ctx) => {
    const p = requirePermission(ctx, "promotions.approve");
    const b = await ctx.body(CampaignBody.extend({ restaurantId: z.string().uuid().nullable().optional(), fundedBy: z.enum(["abu9", "shared", "restaurant"]) }));
    checkDraft(b, app.now());
    // Funding by a restaurant requires that restaurant's own proposal (it is their money).
    if (b.fundedBy !== "abu9" && !b.restaurantId) throw badRequest("restaurant_required", "shared/restaurant funding needs a restaurant");
    if (b.fundedBy === "restaurant") throw forbidden("restaurant_must_propose", "restaurant-funded campaigns are proposed by the restaurant");
    return app.db.tx(async (q) => {
      const c = await insertCampaign(q, b, b.restaurantId ?? null, b.fundedBy, p.userId);
      await audit(q, ctx, { action: "creator_campaign.propose", entityType: "creator_campaign", entityId: c.id, after: c });
      return withStatus(201, { campaign: c });
    });
  });

  r.get("/api/v1/admin/creator-campaigns", async (ctx) => {
    requirePermission(ctx, "creators.approve");
    const [campaigns, enrollments] = await Promise.all([
      app.db.query(
        `select cc.*, r.name_ar restaurant, u.name created_by_name, ${CAMPAIGN_STATS}
         from creator_campaigns cc left join restaurants r on r.id = cc.restaurant_id left join users u on u.id = cc.created_by order by cc.created_at desc`,
      ),
      app.db.query(
        `select e.campaign_id, e.creator_id, e.created_at, c.handle, c.display_name, cc.name campaign
         from creator_campaign_enrollments e join creators c on c.id = e.creator_id join creator_campaigns cc on cc.id = e.campaign_id
         where e.status = 'opted_in' order by e.created_at`,
      ),
    ]);
    return { campaigns: campaigns.rows, pendingEnrollments: enrollments.rows };
  });

  r.post("/api/v1/admin/creator-campaigns/:id/approve", async (ctx) => {
    const p = requirePermission(ctx, "promotions.approve");
    const { reason } = await ctx.body(z.object({ reason: z.string().min(3).max(300).optional() }));
    return app.db.tx(async (q) => {
      const c = (await q.query<{ status: string; created_by: string | null }>("select status, created_by from creator_campaigns where id = $1 for update", [ctx.params.id])).rows[0];
      if (!c) throw notFound("campaign");
      if (c.status !== "pending_approval") throw conflict("not_pending");
      if (!canApprove(c.created_by, p.userId)) throw new ApiError(403, "four_eyes_required", "لا يمكنك اعتماد حملة اقترحتها بنفسك");
      const after = (await q.query("update creator_campaigns set status = 'active', approved_by = $2 where id = $1 returning *", [ctx.params.id, p.userId])).rows[0];
      await audit(q, ctx, { action: "creator_campaign.approve", entityType: "creator_campaign", entityId: ctx.params.id!, before: c, after, reason });
      return { ok: true };
    });
  });

  r.post("/api/v1/admin/creator-campaigns/:id/status", async (ctx) => {
    requirePermission(ctx, "promotions.approve");
    const b = await ctx.body(z.object({ status: z.enum(["active", "paused", "ended"]), reason: z.string().min(3).max(300) }));
    return app.db.tx(async (q) => {
      const c = (await q.query<{ status: string }>("select status from creator_campaigns where id = $1 for update", [ctx.params.id])).rows[0];
      if (!c) throw notFound("campaign");
      const allowed: Record<string, string[]> = { active: ["paused"], paused: ["active"], ended: ["active", "paused", "pending_approval", "draft"] };
      if (!allowed[b.status]!.includes(c.status)) throw conflict("invalid_transition", `${c.status} → ${b.status}`);
      await q.query("update creator_campaigns set status = $2 where id = $1", [ctx.params.id, b.status]);
      await audit(q, ctx, { action: `creator_campaign.${b.status}`, entityType: "creator_campaign", entityId: ctx.params.id!, before: c, after: { status: b.status }, reason: b.reason });
      return { ok: true };
    });
  });
}
