import { randomBytes } from "node:crypto";
import { z } from "zod";
import { reasonByCode, REASON_CODES } from "../../../../packages/domain/src/refunds.ts";
import type { AppContext } from "../context.ts";
import { badRequest, conflict, notFound, withStatus, type Ctx, type Router } from "../http/router.ts";
import { hasPermission, requireUser } from "../auth/rbac.ts";
import { buildQuote, customerCancel, placeOrder, type CartLine } from "../services/orders.ts";
import { autoResolveTicketIfEligible } from "../services/support.ts";

const Line = z.object({ itemId: z.string().uuid(), qty: z.number().int().min(1).max(50), optionIds: z.array(z.string().uuid()).max(20).default([]), note: z.string().max(140).optional() });
const Dropoff = z.object({ lat: z.number().min(15).max(33), lng: z.number().min(34).max(56) });
const QuoteBody = z.object({
  restaurantId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  lines: z.array(Line).min(1).max(40),
  addressId: z.string().uuid().optional(),
  dropoff: Dropoff.optional(),
  promoCode: z.string().max(30).optional(),
  redeemPoints: z.number().int().min(0).optional(),
});

async function resolveDropoff(app: AppContext, userId: string | null, b: { addressId?: string; dropoff?: { lat: number; lng: number } }) {
  if (b.addressId) {
    if (!userId) throw badRequest("login_required_for_address");
    const a = (await app.db.query<Record<string, unknown>>("select * from addresses where id = $1 and user_id = $2", [b.addressId, userId])).rows[0];
    if (!a) throw notFound("address");
    return { dropoff: { lat: a.lat as number, lng: a.lng as number }, address: a };
  }
  if (!b.dropoff) throw badRequest("dropoff_required", "حدّد عنوان التوصيل");
  return { dropoff: b.dropoff, address: { lat: b.dropoff.lat, lng: b.dropoff.lng, label: "موقع محدد" } };
}

async function loadOrderFor(app: AppContext, ctx: Ctx, id: string) {
  const p = requireUser(ctx);
  const o = (await app.db.query<Record<string, unknown>>(
    `select o.*, r.name_ar restaurant_name_ar, r.name_en restaurant_name_en, r.slug restaurant_slug, b.name_ar branch_name_ar, b.lat branch_lat, b.lng branch_lng
     from orders o join restaurants r on r.id = o.restaurant_id join branches b on b.id = o.branch_id where o.id = $1`,
    [id],
  )).rows[0];
  if (!o) throw notFound("order");
  if (o.customer_id !== p.userId && !hasPermission(p, "orders.read_all")) throw notFound("order");
  return o;
}

export function orderRoutes(r: Router, app: AppContext) {
  r.post("/api/v1/checkout/quote", async (ctx) => {
    const b = await ctx.body(QuoteBody);
    if (!b.restaurantId && !b.branchId) throw badRequest("restaurant_required");
    const userId = ctx.principal?.userId ?? null;
    const { dropoff } = await resolveDropoff(app, userId, b);
    return { quote: await buildQuote(app, app.db, { ...b, customerId: userId, lines: b.lines as CartLine[], dropoff }) };
  });

  r.post("/api/v1/orders", async (ctx) => {
    const p = requireUser(ctx);
    const key = (ctx.req.headers["idempotency-key"] as string | undefined) ?? "";
    if (key.length < 8 || key.length > 100) throw badRequest("idempotency_key_required", "Idempotency-Key header is required");
    const b = await ctx.body(
      QuoteBody.extend({
        paymentToken: z.string().min(3).max(200),
        notes: z.string().max(300).optional(),
        videoId: z.string().uuid().optional(),
        referralCode: z.string().max(30).optional(),
        expectedTotal: z.number().int().optional(),
        groupCartId: z.string().uuid().optional(),
      }),
    );
    if (!b.restaurantId && !b.branchId) throw badRequest("restaurant_required");
    const { dropoff, address } = await resolveDropoff(app, p.userId, b);
    let lines = b.lines as CartLine[];
    if (b.groupCartId) {
      const g = (await app.db.query<{ host_user_id: string; status: string; branch_id: string }>("select host_user_id, status, branch_id from group_carts where id = $1", [b.groupCartId])).rows[0];
      if (!g || g.host_user_id !== p.userId) throw notFound("group cart");
      if (g.status !== "open" && g.status !== "locked") throw conflict("group_cart_closed");
      lines = (await app.db.query<{ item_id: string; qty: number; option_ids: string[]; note: string | null; user_id: string }>("select * from group_cart_items where group_cart_id = $1", [b.groupCartId])).rows.map((x) => ({
        itemId: x.item_id, qty: x.qty, optionIds: x.option_ids, note: x.note ?? undefined, addedBy: x.user_id,
      }));
    }
    const res = await placeOrder(app, { ...b, lines, dropoff, address, customerId: p.userId, idempotencyKey: key });
    if (b.groupCartId && !res.replayed) await app.db.query("update group_carts set status = 'ordered' where id = $1", [b.groupCartId]);
    return withStatus(res.replayed ? 200 : 201, res);
  });

  r.get("/api/v1/orders", async (ctx) => {
    const p = requireUser(ctx);
    return {
      orders: (await app.db.query(
        `select o.id, o.number, o.status, o.total, o.created_at, o.eta_at, o.delivered_at, r.name_ar restaurant_name_ar, r.slug restaurant_slug, r.brand_color,
                (select count(*) from order_items i where i.order_id = o.id)::int item_count, (select 1 from ratings x where x.order_id = o.id) is not null rated
         from orders o join restaurants r on r.id = o.restaurant_id where o.customer_id = $1 order by o.created_at desc limit 50`,
        [p.userId],
      )).rows,
    };
  });

  r.get("/api/v1/orders/:id", async (ctx) => {
    const o = await loadOrderFor(app, ctx, ctx.params.id!);
    const [items, events, job] = await Promise.all([
      app.db.query("select name_ar, name_en, qty, unit_price, options, line_total from order_items where order_id = $1", [o.id]),
      app.db.query("select from_status, to_status, actor_type, created_at from order_events where order_id = $1 order by id", [o.id]),
      app.db.query<Record<string, unknown>>(
        `select j.status, j.eta_at, j.dropoff_code, c.display_name courier_name, c.vehicle_type, c.last_lat, c.last_lng
         from delivery_jobs j left join couriers c on c.id = j.courier_id where j.order_id = $1 order by j.created_at desc limit 1`,
        [o.id],
      ),
    ]);
    const isCustomer = o.customer_id === ctx.principal!.userId;
    const j = job.rows[0];
    return {
      order: o,
      items: items.rows,
      events: events.rows,
      delivery: j
        ? {
            status: j.status,
            etaAt: j.eta_at,
            courierName: j.courier_name,
            vehicleType: j.vehicle_type,
            // Courier position is only exposed while the order is on its way.
            courierLocation: o.status === "picked_up" && j.last_lat ? { lat: j.last_lat, lng: j.last_lng } : null,
            // The customer gives this code to the courier at handover.
            dropoffCode: isCustomer ? j.dropoff_code : undefined,
          }
        : null,
    };
  });

  // Real-time order tracking (Server-Sent Events).
  r.get("/api/v1/orders/:id/stream", async (ctx) => {
    const o = await loadOrderFor(app, ctx, ctx.params.id!);
    ctx.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    ctx.res.write(`event: hello\ndata: ${JSON.stringify({ status: o.status })}\n\n`);
    const unsub = app.bus.subscribe(`order:${o.id}`, (e) => ctx.res.write(`event: update\ndata: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => ctx.res.write(": ping\n\n"), 20_000);
    ctx.req.on("close", () => {
      clearInterval(ping);
      unsub();
    });
    ctx.handled = true;
  });

  r.post("/api/v1/orders/:id/cancel", async (ctx) => {
    const p = requireUser(ctx);
    await customerCancel(app, ctx.params.id!, p.userId);
    return { ok: true };
  });

  r.post("/api/v1/orders/:id/rating", async (ctx) => {
    const p = requireUser(ctx);
    const b = await ctx.body(z.object({ restaurantStars: z.number().int().min(1).max(5), courierStars: z.number().int().min(1).max(5).optional(), comment: z.string().max(500).optional() }));
    return app.db.tx(async (q) => {
      const o = (await q.query<{ customer_id: string; status: string; restaurant_id: string }>("select customer_id, status, restaurant_id from orders where id = $1", [ctx.params.id])).rows[0];
      if (!o || o.customer_id !== p.userId) throw notFound("order");
      if (o.status !== "delivered") throw conflict("not_delivered", "يمكن التقييم بعد التوصيل");
      await q.query("insert into ratings(order_id, user_id, restaurant_stars, courier_stars, comment) values ($1,$2,$3,$4,$5)", [ctx.params.id, p.userId, b.restaurantStars, b.courierStars ?? null, b.comment ?? null]);
      await q.query("update restaurants set rating_sum = rating_sum + $2, rating_count = rating_count + 1 where id = $1", [o.restaurant_id, b.restaurantStars]);
      return withStatus(201, { ok: true });
    });
  });

  // ── support ──
  r.get("/api/v1/support/reasons", () => ({ reasons: REASON_CODES.map((x) => ({ code: x.code, ar: x.ar, en: x.en, evidence: x.evidence })) }));
  r.post("/api/v1/support/tickets", async (ctx) => {
    const p = requireUser(ctx);
    const b = await ctx.body(z.object({ orderId: z.string().uuid(), reasonCode: z.string(), description: z.string().max(1000).optional(), affectedAmount: z.number().int().min(0).optional(), evidence: z.array(z.object({ type: z.string(), url: z.string().max(500) })).max(5).default([]) }));
    const reason = reasonByCode(b.reasonCode);
    const o = (await app.db.query<{ customer_id: string; total: number }>("select customer_id, total from orders where id = $1", [b.orderId])).rows[0];
    if (!o || o.customer_id !== p.userId) throw notFound("order");
    const affected = Math.min(b.affectedAmount ?? o.total, o.total);
    const t = (await app.db.query<{ id: string }>(
      "insert into support_tickets(order_id, user_id, reason_code, fault_party, description, evidence, affected_amount) values ($1,$2,$3,$4,$5,$6,$7) returning id",
      [b.orderId, p.userId, reason.code, reason.defaultFault, b.description ?? null, b.evidence, affected],
    )).rows[0]!;
    const auto = await autoResolveTicketIfEligible(app, t.id);
    return withStatus(201, { ticketId: t.id, autoResolved: auto });
  });
  r.get("/api/v1/support/tickets", async (ctx) => {
    const p = requireUser(ctx);
    return { tickets: (await app.db.query("select t.*, o.number from support_tickets t left join orders o on o.id = t.order_id where t.user_id = $1 order by t.created_at desc", [p.userId])).rows };
  });

  // ── group ordering (same restaurant; host checks out and pays) ──
  r.post("/api/v1/group-carts", async (ctx) => {
    const p = requireUser(ctx);
    const b = await ctx.body(z.object({ branchId: z.string().uuid() }));
    const br = (await app.db.query<{ restaurant_id: string }>("select restaurant_id from branches where id = $1", [b.branchId])).rows[0];
    if (!br) throw notFound("branch");
    const code = randomBytes(4).toString("hex").toUpperCase();
    const g = (await app.db.query("insert into group_carts(code, host_user_id, restaurant_id, branch_id, expires_at) values ($1,$2,$3,$4, now() + interval '2 hours') returning *", [code, p.userId, br.restaurant_id, b.branchId])).rows[0];
    return withStatus(201, { groupCart: g });
  });
  r.get("/api/v1/group-carts/:code", async (ctx) => {
    requireUser(ctx);
    const g = (await app.db.query<Record<string, unknown>>("select g.*, r.name_ar restaurant_name_ar, r.slug from group_carts g join restaurants r on r.id = g.restaurant_id where g.code = $1", [ctx.params.code])).rows[0];
    if (!g) throw notFound("group cart");
    const items = (await app.db.query("select gi.*, u.name user_name, m.name_ar, m.price from group_cart_items gi join users u on u.id = gi.user_id join menu_items m on m.id = gi.item_id where gi.group_cart_id = $1 order by gi.created_at", [g.id])).rows;
    return { groupCart: g, items };
  });
  r.post("/api/v1/group-carts/:code/items", async (ctx) => {
    const p = requireUser(ctx);
    const b = await ctx.body(Line);
    const g = (await app.db.query<{ id: string; status: string; restaurant_id: string; expires_at: Date }>("select id, status, restaurant_id, expires_at from group_carts where code = $1", [ctx.params.code])).rows[0];
    if (!g) throw notFound("group cart");
    if (g.status !== "open" || g.expires_at < new Date()) throw conflict("group_cart_closed", "السلة الجماعية مغلقة");
    const it = (await app.db.query<{ restaurant_id: string }>("select restaurant_id from menu_items where id = $1", [b.itemId])).rows[0];
    if (!it || it.restaurant_id !== g.restaurant_id) throw badRequest("item_not_in_restaurant", "الطلب الجماعي من نفس المطعم فقط");
    const row = (await app.db.query("insert into group_cart_items(group_cart_id, user_id, item_id, qty, option_ids, note) values ($1,$2,$3,$4,$5,$6) returning *", [g.id, p.userId, b.itemId, b.qty, b.optionIds, b.note ?? null])).rows[0];
    return withStatus(201, { item: row });
  });
  r.delete("/api/v1/group-carts/:code/items/:itemRowId", async (ctx) => {
    const p = requireUser(ctx);
    const r2 = await app.db.query(
      "delete from group_cart_items gi using group_carts g where gi.id = $1 and gi.group_cart_id = g.id and g.code = $2 and g.status = 'open' and (gi.user_id = $3 or g.host_user_id = $3)",
      [ctx.params.itemRowId, ctx.params.code, p.userId],
    );
    if (!r2.rowCount) throw notFound("item");
    return undefined;
  });
  r.post("/api/v1/group-carts/:code/lock", async (ctx) => {
    const p = requireUser(ctx);
    const r2 = await app.db.query("update group_carts set status = 'locked' where code = $1 and host_user_id = $2 and status = 'open'", [ctx.params.code, p.userId]);
    if (!r2.rowCount) throw notFound("group cart");
    return { ok: true };
  });
}
