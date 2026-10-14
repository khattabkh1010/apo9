import { z } from "zod";
import { RESTAURANT_PLANS } from "../../../../packages/domain/src/subscriptions.ts";
import type { AppContext } from "../context.ts";
import { conflict, forbidden, notFound, withStatus, type Ctx, type Router } from "../http/router.ts";
import { requireRestaurantAccess, requireUser, restaurantScopes } from "../auth/rbac.ts";
import { audit } from "../audit.ts";
import { acceptOrder, rejectOrder, transitionOrder } from "../services/orders.ts";
import { dispatchJob } from "../services/dispatch.ts";
import { disputeClaim } from "../services/support.ts";
import { log } from "../log.ts";

/** Restaurant portal API. Every route is scoped to a restaurant the caller is a member of. */
export function restaurantRoutes(r: Router, app: AppContext) {
  const scope = (ctx: Ctx) => {
    const id = ctx.params.rid!;
    requireRestaurantAccess(ctx, id);
    return id;
  };
  const orderInRestaurant = async (rid: string, orderId: string) => {
    const o = (await app.db.query<{ id: string; status: string }>("select id, status from orders where id = $1 and restaurant_id = $2", [orderId, rid])).rows[0];
    if (!o) throw notFound("order");
    return o;
  };

  r.get("/api/v1/restaurant/mine", async (ctx) => {
    const p = requireUser(ctx);
    const ids = restaurantScopes(p);
    return { restaurants: ids.length ? (await app.db.query("select id, slug, name_ar, name_en, status, brand_color, is_demo from restaurants where id = any($1::uuid[])", [ids])).rows : [] };
  });

  // ── kitchen queue ──
  r.get("/api/v1/restaurant/:rid/orders", async (ctx) => {
    const rid = scope(ctx);
    const status = ctx.query.get("status");
    const rows = (
      await app.db.query(
        `select o.id, o.number, o.status, o.total, o.food_subtotal, o.notes, o.created_at, o.placed_at, o.accepted_at, o.ready_at, o.prep_minutes, o.promised_by, b.name_ar branch_name,
                u.name customer_name,
                (select json_agg(json_build_object('nameAr', i.name_ar, 'qty', i.qty, 'options', i.options)) from order_items i where i.order_id = o.id) items,
                (select json_build_object('status', j.status, 'pickupCode', j.pickup_code, 'courierName', c.display_name, 'etaAt', j.eta_at, 'suggestedDepartAt', j.suggested_depart_at)
                   from delivery_jobs j left join couriers c on c.id = j.courier_id where j.order_id = o.id order by j.created_at desc limit 1) delivery
         from orders o join branches b on b.id = o.branch_id join users u on u.id = o.customer_id
         where o.restaurant_id = $1 and ($2::text is null and o.status in ('placed','accepted','preparing','ready_for_pickup') or o.status = $2)
         order by o.created_at desc limit 100`,
        [rid, status],
      )
    ).rows;
    return { orders: rows };
  });

  r.post("/api/v1/restaurant/:rid/orders/:oid/accept", async (ctx) => {
    const rid = scope(ctx);
    await orderInRestaurant(rid, ctx.params.oid!);
    const { prepMinutes } = await ctx.body(z.object({ prepMinutes: z.number().int().min(3).max(90) }));
    const { jobId } = await acceptOrder(app, ctx.params.oid!, ctx.principal!.userId, prepMinutes);
    // Dispatch starts immediately; courier arrival is aligned to the food-ready time by the strategy.
    const decision = await dispatchJob(app, jobId).catch((e) => {
      log.warn("dispatch_after_accept_failed", { jobId, error: String(e) });
      return null;
    });
    return { ok: true, jobId, courierAssigned: !!decision?.assignment };
  });

  r.post("/api/v1/restaurant/:rid/orders/:oid/reject", async (ctx) => {
    const rid = scope(ctx);
    await orderInRestaurant(rid, ctx.params.oid!);
    const { reason } = await ctx.body(z.object({ reason: z.enum(["too_busy", "item_unavailable", "closing", "other"]) }));
    await rejectOrder(app, ctx.params.oid!, "restaurant", ctx.principal!.userId, reason);
    return { ok: true };
  });

  r.post("/api/v1/restaurant/:rid/orders/:oid/ready", async (ctx) => {
    const rid = scope(ctx);
    await orderInRestaurant(rid, ctx.params.oid!);
    await app.db.tx((q) => transitionOrder(app, q, ctx.params.oid!, "ready_for_pickup", "restaurant", ctx.principal!.userId));
    return { ok: true };
  });

  // ── menu management ──
  r.get("/api/v1/restaurant/:rid/menu", async (ctx) => {
    const rid = scope(ctx);
    const [cats, items, branches] = await Promise.all([
      app.db.query("select * from menu_categories where restaurant_id = $1 order by sort", [rid]),
      app.db.query("select m.*, (select json_agg(json_build_object('branchId', a.branch_id, 'available', a.is_available, 'stock', a.stock_qty)) from branch_item_availability a where a.item_id = m.id) branch_overrides from menu_items m where restaurant_id = $1 order by sort", [rid]),
      app.db.query("select id, name_ar, accepting_orders, prep_minutes_default, opening_hours from branches where restaurant_id = $1 order by created_at", [rid]),
    ]);
    return { categories: cats.rows, items: items.rows, branches: branches.rows };
  });

  const ItemBody = z.object({
    categoryId: z.string().uuid().nullable().optional(),
    nameAr: z.string().min(1).max(80),
    nameEn: z.string().min(1).max(80),
    descriptionAr: z.string().max(300).optional(),
    price: z.number().int().min(0).max(1_000_000),
    calories: z.number().int().min(0).max(5000).optional(),
    tags: z.array(z.string().max(20)).max(10).optional(),
  });
  r.post("/api/v1/restaurant/:rid/menu/items", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(ItemBody);
    return app.db.tx(async (q) => {
      const row = (await q.query<{ id: string }>("insert into menu_items(restaurant_id, category_id, name_ar, name_en, description_ar, price, calories, tags) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *", [rid, b.categoryId ?? null, b.nameAr, b.nameEn, b.descriptionAr ?? null, b.price, b.calories ?? null, b.tags ?? []])).rows[0]!;
      await audit(q, ctx, { action: "menu_item.create", entityType: "menu_item", entityId: row.id, after: row });
      return withStatus(201, { item: row });
    });
  });
  r.patch("/api/v1/restaurant/:rid/menu/items/:iid", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(ItemBody.partial().extend({ isAvailable: z.boolean().optional() }));
    return app.db.tx(async (q) => {
      const before = (await q.query("select * from menu_items where id = $1 and restaurant_id = $2 for update", [ctx.params.iid, rid])).rows[0];
      if (!before) throw notFound("item");
      const after = (await q.query(
        `update menu_items set name_ar = coalesce($3, name_ar), name_en = coalesce($4, name_en), description_ar = coalesce($5, description_ar),
           price = coalesce($6, price), is_available = coalesce($7, is_available), category_id = coalesce($8, category_id)
         where id = $1 and restaurant_id = $2 returning *`,
        [ctx.params.iid, rid, b.nameAr ?? null, b.nameEn ?? null, b.descriptionAr ?? null, b.price ?? null, b.isAvailable ?? null, b.categoryId ?? null],
      )).rows[0];
      // Price changes are commercially sensitive → audited.
      if (b.price !== undefined || b.isAvailable !== undefined) await audit(q, ctx, { action: "menu_item.update", entityType: "menu_item", entityId: ctx.params.iid!, before, after });
      return { item: after };
    });
  });
  r.put("/api/v1/restaurant/:rid/branches/:bid/items/:iid/availability", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(z.object({ isAvailable: z.boolean(), stockQty: z.number().int().min(0).nullable().optional() }));
    const ok = await app.db.query("select 1 from branches br join menu_items m on m.restaurant_id = br.restaurant_id where br.id = $1 and m.id = $2 and br.restaurant_id = $3", [ctx.params.bid, ctx.params.iid, rid]);
    if (!ok.rowCount) throw notFound("branch item");
    await app.db.query(
      "insert into branch_item_availability(branch_id, item_id, is_available, stock_qty) values ($1,$2,$3,$4) on conflict (branch_id, item_id) do update set is_available = $3, stock_qty = $4, updated_at = now()",
      [ctx.params.bid, ctx.params.iid, b.isAvailable, b.stockQty ?? null],
    );
    return { ok: true };
  });
  r.patch("/api/v1/restaurant/:rid/branches/:bid", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(z.object({ acceptingOrders: z.boolean().optional(), prepMinutesDefault: z.number().int().min(3).max(90).optional() }));
    return app.db.tx(async (q) => {
      const before = (await q.query("select accepting_orders, prep_minutes_default from branches where id = $1 and restaurant_id = $2", [ctx.params.bid, rid])).rows[0];
      if (!before) throw notFound("branch");
      const after = (await q.query("update branches set accepting_orders = coalesce($2, accepting_orders), prep_minutes_default = coalesce($3, prep_minutes_default) where id = $1 returning accepting_orders, prep_minutes_default", [ctx.params.bid, b.acceptingOrders ?? null, b.prepMinutesDefault ?? null])).rows[0];
      await audit(q, ctx, { action: "branch.update", entityType: "branch", entityId: ctx.params.bid!, before, after });
      return { branch: after };
    });
  });

  // ── analytics ──
  r.get("/api/v1/restaurant/:rid/analytics", async (ctx) => {
    const rid = scope(ctx);
    const days = Math.min(Number(ctx.query.get("days") ?? 14), 90);
    const [daily, totals, top] = await Promise.all([
      app.db.query(
        `select to_char(date_trunc('day', o.created_at at time zone 'Asia/Riyadh'), 'YYYY-MM-DD') day, count(*) filter (where o.status = 'delivered')::int delivered,
                count(*) filter (where o.status in ('rejected','cancelled'))::int lost, coalesce(sum(o.food_subtotal - o.food_discount) filter (where o.status = 'delivered'),0)::bigint sales
         from orders o where o.restaurant_id = $1 and o.created_at > now() - ($2 || ' days')::interval group by 1 order by 1`,
        [rid, String(days)],
      ),
      app.db.query(
        `select count(*) filter (where status = 'delivered')::int delivered, count(*)::int total,
                coalesce(avg(extract(epoch from (ready_at - accepted_at))/60) filter (where ready_at is not null),0)::float avg_prep_planned,
                coalesce(avg(extract(epoch from (accepted_at - placed_at))) filter (where accepted_at is not null),0)::float avg_accept_seconds,
                coalesce(sum(food_subtotal - food_discount) filter (where status = 'delivered'),0)::bigint sales
         from orders where restaurant_id = $1 and created_at > now() - ($2 || ' days')::interval`,
        [rid, String(days)],
      ),
      app.db.query(
        `select i.name_ar, sum(i.qty)::int qty from order_items i join orders o on o.id = i.order_id where o.restaurant_id = $1 and o.status = 'delivered' and o.created_at > now() - ($2 || ' days')::interval
         group by 1 order by 2 desc limit 5`,
        [rid, String(days)],
      ),
    ]);
    return { daily: daily.rows, totals: totals.rows[0], topItems: top.rows, note: "sales = food value after discounts (not ABU9 revenue)" };
  });

  // ── subscription & plan changes (consent-gated, effective at renewal) ──
  r.get("/api/v1/restaurant/:rid/subscription", async (ctx) => {
    const rid = scope(ctx);
    const sub = (await app.db.query("select * from restaurant_subscriptions where restaurant_id = $1 and status <> 'cancelled'", [rid])).rows[0];
    const orders = (await app.db.query<{ n: number }>("select count(*)::int n from orders where restaurant_id = $1 and status = 'delivered' and created_at >= $2", [rid, sub?.current_period_start ?? new Date(0)])).rows[0]!.n;
    const proposals = (await app.db.query("select * from plan_change_proposals where restaurant_id = $1 order by created_at desc limit 5", [rid])).rows;
    const invoices = (await app.db.query("select * from restaurant_invoices where restaurant_id = $1 order by period_start desc limit 12", [rid])).rows;
    return { subscription: sub ?? null, ordersThisCycle: orders, plans: RESTAURANT_PLANS, proposals, invoices, notes: ["No percentage commission on food basket value.", "Plan prices are proposals pending validation."] };
  });
  r.post("/api/v1/restaurant/:rid/plan-proposals/:pid/decision", async (ctx) => {
    const rid = scope(ctx);
    const p = ctx.principal!;
    if (!p.roles.some((x) => x.role === "restaurant_owner" && x.scopeId === rid)) throw forbidden("owner_only", "only the restaurant owner can consent to plan changes");
    const { accept } = await ctx.body(z.object({ accept: z.boolean() }));
    return app.db.tx(async (q) => {
      const r2 = await q.query("update plan_change_proposals set status = $3, decided_by = $4, decided_at = now() where id = $1 and restaurant_id = $2 and status = 'pending' returning *", [ctx.params.pid, rid, accept ? "accepted" : "declined", p.userId]);
      if (!r2.rowCount) throw conflict("proposal_not_pending");
      await audit(q, ctx, { action: accept ? "plan_change.consented" : "plan_change.declined", entityType: "restaurant", entityId: rid, after: r2.rows[0] });
      return { proposal: r2.rows[0] };
    });
  });

  // ── settlements, claims, content ──
  r.get("/api/v1/restaurant/:rid/settlements", async (ctx) => {
    const rid = scope(ctx);
    const payable = (await app.db.query<{ balance: number }>("select balance from account_balances where code = $1", [`liability:merchant_payable:${rid}`])).rows[0]?.balance ?? 0;
    return { currentPayable: payable, settlements: (await app.db.query("select * from settlements where party_type = 'restaurant' and party_id = $1 order by period_start desc", [rid])).rows };
  });
  r.get("/api/v1/restaurant/:rid/claims", async (ctx) => {
    const rid = scope(ctx);
    return { claims: (await app.db.query("select c.*, o.number from compensation_claims c join orders o on o.id = c.order_id where c.party_type = 'restaurant' and c.party_id = $1 order by c.created_at desc", [rid])).rows };
  });
  r.post("/api/v1/restaurant/:rid/claims/:cid/dispute", async (ctx) => {
    const rid = scope(ctx);
    const { note } = await ctx.body(z.object({ note: z.string().min(5).max(1000) }));
    await disputeClaim(app, ctx.params.cid!, rid, note);
    await audit(app.db, ctx, { action: "claim.disputed", entityType: "compensation_claim", entityId: ctx.params.cid!, after: { note } });
    return { ok: true };
  });
  r.get("/api/v1/restaurant/:rid/videos", async (ctx) => {
    const rid = scope(ctx);
    return { videos: (await app.db.query("select v.*, c.handle creator_handle from videos v left join creators c on c.id = v.creator_id where v.restaurant_id = $1 order by v.created_at desc", [rid])).rows };
  });
  r.post("/api/v1/restaurant/:rid/videos", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(z.object({ videoUrl: z.string().max(500), posterUrl: z.string().max(500).optional(), captionAr: z.string().max(300), itemIds: z.array(z.string().uuid()).min(1).max(10) }));
    return app.db.tx(async (q) => {
      const own = (await q.query<{ n: number }>("select count(*)::int n from menu_items where id = any($1::uuid[]) and restaurant_id = $2", [b.itemIds, rid])).rows[0]!.n;
      if (own !== b.itemIds.length) throw notFound("menu items");
      const v = (await q.query<{ id: string }>("insert into videos(restaurant_id, uploaded_by, caption_ar, video_url, poster_url, status) values ($1,$2,$3,$4,$5,'pending_review') returning id", [rid, ctx.principal!.userId, b.captionAr, b.videoUrl, b.posterUrl ?? null])).rows[0]!;
      for (const i of b.itemIds) await q.query("insert into video_items(video_id, item_id) values ($1,$2)", [v.id, i]);
      return withStatus(201, { videoId: v.id, status: "pending_review" });
    });
  });
  r.get("/api/v1/restaurant/:rid/promotions", async (ctx) => {
    const rid = scope(ctx);
    return {
      promotions: (await app.db.query("select * from promotions where restaurant_id = $1 order by created_at desc", [rid])).rows,
      loyaltyCampaigns: (await app.db.query("select * from loyalty_campaigns where restaurant_id = $1 order by created_at desc", [rid])).rows,
    };
  });
  r.post("/api/v1/restaurant/:rid/promotions", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(z.object({ code: z.string().regex(/^[A-Z0-9]{4,16}$/), titleAr: z.string().max(80), kind: z.enum(["percent", "fixed"]), value: z.number().int().positive(), maxDiscount: z.number().int().positive().optional(), minFoodSubtotal: z.number().int().min(0), budget: z.number().int().positive(), days: z.number().int().min(1).max(90) }));
    // 100% restaurant-funded promos go live immediately; co-funded promos need ABU9 approval.
    return app.db.tx(async (q) => {
      const row = (await q.query<{ id: string }>(
        `insert into promotions(code, restaurant_id, title_ar, kind, value, max_discount, min_food_subtotal, abu9_share_bps, restaurant_share_bps, budget, per_customer_limit, starts_at, ends_at, active)
         values ($1,$2,$3,$4,$5,$6,$7,0,10000,$8,3,now(), now() + ($9 || ' days')::interval, true) returning *`,
        [b.code, rid, b.titleAr, b.kind, b.value, b.maxDiscount ?? null, b.minFoodSubtotal, b.budget, String(b.days)],
      )).rows[0]!;
      await audit(q, ctx, { action: "promotion.create", entityType: "promotion", entityId: row.id, after: row });
      return withStatus(201, { promotion: row });
    });
  });
}
