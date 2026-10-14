import { createWriteStream, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { ApiError, badRequest, conflict, forbidden, notFound, withStatus, type Ctx, type Router } from "../http/router.ts";
import { requireUser } from "../auth/rbac.ts";
import { config } from "../config.ts";

const MAX_UPLOAD = 60 * 1024 * 1024;

/**
 * Creator & marketing portal. Incentives are opt-in and require ABU9 approval — nothing is paid
 * automatically. Uploaded videos always enter moderation before reaching the feed.
 */
export function creatorRoutes(r: Router, app: AppContext) {
  const me = async (ctx: Ctx) => {
    const p = requireUser(ctx);
    const c = (await app.db.query<{ id: string; status: string; handle: string }>("select id, status, handle from creators where user_id = $1", [p.userId])).rows[0];
    if (!c) throw forbidden("not_a_creator");
    return c;
  };

  r.post("/api/v1/creator/apply", async (ctx) => {
    const p = requireUser(ctx);
    const b = await ctx.body(z.object({ handle: z.string().regex(/^[a-z0-9_.]{3,30}$/), displayName: z.string().min(2).max(60), bio: z.string().max(300).optional() }));
    const row = (await app.db.query<{ id: string }>("insert into creators(user_id, handle, display_name, bio) values ($1,$2,$3,$4) returning id", [p.userId, b.handle, b.displayName, b.bio ?? null])).rows[0]!;
    await app.db.query("insert into user_roles(user_id, role) values ($1,'creator') on conflict do nothing", [p.userId]);
    return withStatus(201, { creatorId: row.id, status: "pending" });
  });

  r.get("/api/v1/creator/me", async (ctx) => {
    const c = await me(ctx);
    const [stats, codes, videos, incentives, campaigns] = await Promise.all([
      app.db.query(
        `select (select coalesce(sum(view_count),0) from videos where creator_id = $1)::int views, (select coalesce(sum(like_count),0) from videos where creator_id = $1)::int likes,
                (select count(*) from attributions a join orders o on o.id = a.order_id where a.creator_id = $1 and o.status = 'delivered')::int orders,
                (select coalesce(sum(o.food_subtotal - o.food_discount),0) from attributions a join orders o on o.id = a.order_id where a.creator_id = $1 and o.status = 'delivered')::bigint attributed_food_value`,
        [c.id],
      ),
      app.db.query(
        `select rc.code, rc.active, (select count(*) from attributions a where a.referral_code_id = rc.id)::int uses from referral_codes rc where rc.creator_id = $1`,
        [c.id],
      ),
      app.db.query(
        `select v.id, v.status, v.caption_ar, v.poster_url, v.view_count, v.like_count, v.rejection_reason, v.created_at, r.name_ar restaurant,
                (select count(*) from attributions a join orders o on o.id = a.order_id where a.video_id = v.id and o.status = 'delivered')::int orders
         from videos v join restaurants r on r.id = v.restaurant_id where v.creator_id = $1 order by v.created_at desc`,
        [c.id],
      ),
      app.db.query("select ci.*, cc.name campaign from creator_incentives ci join creator_campaigns cc on cc.id = ci.campaign_id where ci.creator_id = $1 order by ci.created_at desc", [c.id]),
      app.db.query(
        `select cc.*, r.name_ar restaurant, e.status enrollment from creator_campaigns cc left join restaurants r on r.id = cc.restaurant_id
         left join creator_campaign_enrollments e on e.campaign_id = cc.id and e.creator_id = $1 where cc.status = 'active' order by cc.created_at desc`,
        [c.id],
      ),
    ]);
    return { creator: c, stats: stats.rows[0], referralCodes: codes.rows, videos: videos.rows, incentives: incentives.rows, campaigns: campaigns.rows, attributionModel: "Referral code wins; otherwise last video the order was placed from." };
  });

  r.post("/api/v1/creator/campaigns/:id/opt-in", async (ctx) => {
    const c = await me(ctx);
    if (c.status !== "approved") throw forbidden("creator_not_approved");
    const camp = (await app.db.query("select status from creator_campaigns where id = $1", [ctx.params.id])).rows[0];
    if (!camp || camp.status !== "active") throw notFound("campaign");
    await app.db.query("insert into creator_campaign_enrollments(campaign_id, creator_id, status) values ($1,$2,'opted_in') on conflict (campaign_id, creator_id) do nothing", [ctx.params.id, c.id]);
    return { status: "opted_in", note: "Awaiting ABU9 approval before incentives apply." };
  });

  r.post("/api/v1/creator/referral-codes", async (ctx) => {
    const c = await me(ctx);
    if (c.status !== "approved") throw forbidden("creator_not_approved");
    const { code } = await ctx.body(z.object({ code: z.string().regex(/^[A-Z0-9]{4,12}$/) }));
    const n = (await app.db.query<{ n: number }>("select count(*)::int n from referral_codes where creator_id = $1", [c.id])).rows[0]!.n;
    if (n >= 5) throw conflict("too_many_codes");
    await app.db.query("insert into referral_codes(code, creator_id) values ($1,$2)", [code, c.id]);
    return withStatus(201, { code });
  });

  /** Raw binary upload to object storage (local disk adapter in dev; S3-compatible in production). */
  r.post("/api/v1/media/upload", async (ctx) => {
    requireUser(ctx);
    const type = String(ctx.req.headers["content-type"] ?? "");
    const ext = type === "video/mp4" ? ".mp4" : type === "image/jpeg" ? ".jpg" : type === "image/png" ? ".png" : null;
    if (!ext) throw badRequest("unsupported_media_type", "mp4, jpeg or png only");
    const len = Number(ctx.req.headers["content-length"] ?? 0);
    if (len > MAX_UPLOAD) throw new ApiError(413, "too_large");
    mkdirSync(config.mediaDir, { recursive: true });
    const name = `u_${randomUUID()}${ext}`;
    let size = 0;
    const limit = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > MAX_UPLOAD) return cb(new ApiError(413, "too_large"));
        cb(null, chunk);
      },
    });
    await pipeline(ctx.req, limit, createWriteStream(path.join(config.mediaDir, name)));
    // Virus/content scanning and transcoding (HLS renditions) are NOT implemented — launch blocker.
    return withStatus(201, { url: `/media/${name}`, bytes: size });
  });

  r.post("/api/v1/creator/videos", async (ctx) => {
    const c = await me(ctx);
    if (c.status !== "approved") throw forbidden("creator_not_approved");
    const b = await ctx.body(z.object({ restaurantId: z.string().uuid(), videoUrl: z.string().max(500), posterUrl: z.string().max(500).optional(), captionAr: z.string().max(300), itemIds: z.array(z.string().uuid()).min(1).max(10) }));
    return app.db.tx(async (q) => {
      const own = (await q.query<{ n: number }>("select count(*)::int n from menu_items where id = any($1::uuid[]) and restaurant_id = $2", [b.itemIds, b.restaurantId])).rows[0]!.n;
      if (own !== b.itemIds.length) throw badRequest("items_must_belong_to_restaurant");
      const v = (await q.query<{ id: string }>("insert into videos(restaurant_id, creator_id, uploaded_by, caption_ar, video_url, poster_url, status) values ($1,$2,$3,$4,$5,$6,'pending_review') returning id", [b.restaurantId, c.id, ctx.principal!.userId, b.captionAr, b.videoUrl, b.posterUrl ?? null])).rows[0]!;
      for (const i of b.itemIds) await q.query("insert into video_items(video_id, item_id) values ($1,$2)", [v.id, i]);
      return withStatus(201, { videoId: v.id, status: "pending_review" });
    });
  });
}
