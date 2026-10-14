import { randomInt } from "node:crypto";
import type { Queryable } from "../../../../packages/db/src/pg.ts";
import { priceOrder, type PriceBreakdown, type Abu9PlusRules, DEFAULT_PLUS_RULES } from "../../../../packages/domain/src/pricing.ts";
import { evaluatePromotion, PROMO_REJECTION_TEXT, type Promotion } from "../../../../packages/domain/src/promotions.ts";
import { planRedemption, DEFAULT_LOYALTY, type LoyaltyProgramConfig, LoyaltyError } from "../../../../packages/domain/src/loyalty.ts";
import { plusBenefitsActive, type PlusSubscription } from "../../../../packages/domain/src/subscriptions.ts";
import { assertOrderTransition, ORDER_STATUS_TEXT, type Actor, type OrderStatus } from "../../../../packages/domain/src/order-state.ts";
import { COVERAGE_REASON_TEXT, type CoverageReason } from "../../../../packages/domain/src/coverage.ts";
import { postOrderCapture } from "../../../../packages/domain/src/ledger.ts";
import type { LatLng } from "../../../../packages/domain/src/geo.ts";
import type { AppContext } from "../context.ts";
import { ApiError, badRequest, conflict, notFound } from "../http/router.ts";
import { evaluateBranchCoverage, type BranchRow } from "./coverage.ts";
import { getPricingConfig, getSetting, notify, postEntry } from "./common.ts";

export interface CartLine {
  itemId: string;
  qty: number;
  optionIds: string[];
  note?: string;
  addedBy?: string;
}

export interface QuoteInput {
  customerId: string | null;
  branchId?: string;
  restaurantId?: string;
  lines: CartLine[];
  dropoff: LatLng;
  promoCode?: string;
  redeemPoints?: number;
}

export interface PricedLine {
  itemId: string;
  nameAr: string;
  nameEn: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  options: Array<{ id: string; nameAr: string; nameEn: string; priceDelta: number }>;
  note?: string;
  addedBy?: string;
}

export interface Quote {
  restaurant: { id: string; nameAr: string; nameEn: string; slug: string };
  branch: { id: string; nameAr: string; lat: number; lng: number; prepMinutes: number };
  zoneId: string | null;
  lines: PricedLine[];
  coverage: { eligible: boolean; reasons: Array<{ code: CoverageReason; ar: string; en: string }>; etaMinutes: number; etaRange: [number, number]; roadDistanceKm: number; routeSource: string };
  promo: { code: string; applied: boolean; discount: number; reasonAr?: string; funding?: { abu9: number; restaurant: number }; promotionId?: string } | null;
  points: { requested: number; redeemed: number; discount: number; error?: string; plan?: Array<{ lotId: string; points: number }> } | null;
  plus: { member: boolean; subscriptionId: string | null };
  pricing: PriceBreakdown;
}

/**
 * Build an authoritative quote from server-side data. Client-sent prices are never trusted.
 * The same function backs the checkout preview and order placement, so what the customer saw
 * is exactly what is charged (re-validated at placement).
 */
export async function buildQuote(app: AppContext, q: Queryable, input: QuoteInput): Promise<Quote> {
  if (input.lines.length === 0) throw badRequest("empty_cart", "السلة فارغة");
  const branches = (
    await q.query<BranchRow & { r_name_ar: string; r_name_en: string; slug: string; r_status: string }>(
      `select b.*, r.name_ar r_name_ar, r.name_en r_name_en, r.slug, r.status r_status from branches b join restaurants r on r.id = b.restaurant_id
       where ${input.branchId ? "b.id = $1" : "b.restaurant_id = $1"}`,
      [input.branchId ?? input.restaurantId],
    )
  ).rows;
  if (branches.length === 0) throw notFound("restaurant");
  if (branches[0]!.r_status !== "active") throw badRequest("restaurant_unavailable", "المطعم غير متاح حالياً");

  // Choose the branch: explicit, or the eligible branch with the shortest ETA.
  let best: { b: (typeof branches)[number]; cov: Awaited<ReturnType<typeof evaluateBranchCoverage>> } | null = null;
  for (const b of branches) {
    const cov = await evaluateBranchCoverage(app, q, b, input.dropoff);
    if (!best || (cov.eligible && !best.cov.eligible) || (cov.eligible === best.cov.eligible && cov.etaMinutes < best.cov.etaMinutes)) best = { b, cov };
  }
  const { b: branch, cov } = best!;

  // ── items, availability and modifiers ──
  const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
  const items = (
    await q.query<{ id: string; restaurant_id: string; name_ar: string; name_en: string; price: number; is_available: boolean; branch_available: boolean | null; stock_qty: number | null }>(
      `select m.*, a.is_available branch_available, a.stock_qty from menu_items m
       left join branch_item_availability a on a.item_id = m.id and a.branch_id = $2
       where m.id = any($1::uuid[])`,
      [itemIds, branch.id],
    )
  ).rows;
  const groups = (
    await q.query<{ id: string; item_id: string; name_ar: string; min_select: number; max_select: number }>("select * from modifier_groups where item_id = any($1::uuid[])", [itemIds])
  ).rows;
  const options = (
    await q.query<{ id: string; group_id: string; name_ar: string; name_en: string; price_delta: number; is_available: boolean }>(
      "select o.* from modifier_options o join modifier_groups g on g.id = o.group_id where g.item_id = any($1::uuid[])",
      [itemIds],
    )
  ).rows;

  const lines: PricedLine[] = [];
  for (const l of input.lines) {
    const it = items.find((i) => i.id === l.itemId);
    if (!it || it.restaurant_id !== branch.restaurant_id) throw badRequest("item_not_in_restaurant", "الطلب من مطعم واحد فقط", { itemId: l.itemId });
    if (!it.is_available || it.branch_available === false) throw badRequest("item_unavailable", `${it.name_ar} غير متوفر حالياً`, { itemId: it.id });
    if (it.stock_qty !== null && it.stock_qty < l.qty) throw badRequest("insufficient_stock", `الكمية المتاحة من ${it.name_ar}: ${it.stock_qty}`, { itemId: it.id });
    const chosen = [...new Set(l.optionIds)].map((oid) => {
      const o = options.find((x) => x.id === oid);
      const g = o && groups.find((x) => x.id === o.group_id);
      if (!o || !g || g.item_id !== it.id) throw badRequest("invalid_option", "اختيار غير صحيح", { optionId: oid });
      if (!o.is_available) throw badRequest("option_unavailable", `${o.name_ar} غير متوفر`, { optionId: oid });
      return o;
    });
    for (const g of groups.filter((x) => x.item_id === it.id)) {
      const n = chosen.filter((o) => o.group_id === g.id).length;
      if (n < g.min_select || n > g.max_select) throw badRequest("modifier_selection", `اختر ${g.name_ar}`, { groupId: g.id, min: g.min_select, max: g.max_select });
    }
    const unit = it.price + chosen.reduce((a, o) => a + o.price_delta, 0);
    lines.push({
      itemId: it.id,
      nameAr: it.name_ar,
      nameEn: it.name_en,
      qty: l.qty,
      unitPrice: unit,
      lineTotal: unit * l.qty,
      options: chosen.map((o) => ({ id: o.id, nameAr: o.name_ar, nameEn: o.name_en, priceDelta: o.price_delta })),
      note: l.note,
      addedBy: l.addedBy,
    });
  }
  const foodSubtotal = lines.reduce((a, l) => a + l.lineTotal, 0);

  // ── promotion ──
  let promo: Quote["promo"] = null;
  let promoDiscount = 0;
  if (input.promoCode) {
    const code = input.promoCode.trim().toUpperCase();
    const p = (await q.query<Record<string, unknown>>("select * from promotions where upper(code) = $1", [code])).rows[0];
    if (!p) promo = { code, applied: false, discount: 0, reasonAr: "الكود غير صحيح" };
    else {
      const uses = input.customerId ? (await q.query<{ n: number }>("select count(*)::int n from promotion_redemptions where promotion_id = $1 and user_id = $2 and status = 'applied'", [p.id, input.customerId])).rows[0]!.n : 0;
      const orders = input.customerId ? (await q.query<{ n: number }>("select count(*)::int n from orders where customer_id = $1 and status = 'delivered'", [input.customerId])).rows[0]!.n : 0;
      const res = evaluatePromotion(rowToPromotion(p), { restaurantId: branch.restaurant_id, foodSubtotal, at: app.now(), customerUses: uses, customerOrderCount: orders });
      promo = res.ok
        ? { code, applied: true, discount: res.discount, funding: res.funding, promotionId: p.id as string }
        : { code, applied: false, discount: 0, reasonAr: PROMO_REJECTION_TEXT[res.rejection!].ar };
      promoDiscount = res.discount;
    }
  }

  // ── loyalty redemption ──
  let points: Quote["points"] = null;
  let pointsDiscount = 0;
  if (input.redeemPoints && input.customerId) {
    const cfg = await getSetting<LoyaltyProgramConfig>(q, "loyalty", DEFAULT_LOYALTY);
    const lots = (await q.query<{ id: string; remaining: number; expires_at: Date }>("select id, remaining, expires_at from points_lots where user_id = $1 and remaining > 0", [input.customerId])).rows;
    const balance = (await q.query<{ b: number }>("select coalesce(sum(delta),0)::int b from points_transactions where user_id = $1", [input.customerId])).rows[0]!.b;
    try {
      if (balance < input.redeemPoints) throw new LoyaltyError("insufficient_points");
      const plan = planRedemption({ requestedPoints: input.redeemPoints, foodNet: foodSubtotal - promoDiscount, lots: lots.map((l) => ({ id: l.id, remaining: l.remaining, expiresAt: l.expires_at })), at: app.now(), cfg });
      points = { requested: input.redeemPoints, redeemed: plan.points, discount: plan.discount, plan: plan.consumed };
      pointsDiscount = plan.discount;
    } catch (e) {
      points = { requested: input.redeemPoints, redeemed: 0, discount: 0, error: (e as LoyaltyError).code ?? "redeem_failed" };
    }
  }

  // ── ABU9+ ──
  let plus: Quote["plus"] = { member: false, subscriptionId: null };
  if (input.customerId) {
    const s = (await q.query<Record<string, unknown>>("select * from plus_subscriptions where user_id = $1 and status in ('active','past_due','cancelled') order by created_at desc limit 1", [input.customerId])).rows[0];
    if (s && plusBenefitsActive(rowToPlus(s), app.now())) plus = { member: true, subscriptionId: s.id as string };
  }

  const cfg = await getPricingConfig(q, cov.zoneId);
  const plusRules = await getSetting<Abu9PlusRules>(q, "abu9_plus_rules", DEFAULT_PLUS_RULES);
  const pricing = priceOrder({
    foodSubtotal,
    foodDiscount: Math.min(foodSubtotal, promoDiscount + pointsDiscount),
    roadDistanceKm: cov.route.distanceKm,
    hasActivePlus: plus.member,
    inActiveCoverage: cov.eligible,
    config: cfg,
    plusRules,
  });

  return {
    restaurant: { id: branch.restaurant_id, nameAr: branch.r_name_ar, nameEn: branch.r_name_en, slug: branch.slug },
    branch: { id: branch.id, nameAr: branch.name_ar, lat: branch.lat, lng: branch.lng, prepMinutes: branch.prep_minutes_default },
    zoneId: cov.zoneId,
    lines,
    coverage: {
      eligible: cov.eligible,
      reasons: cov.reasons.map((c) => ({ code: c, ...COVERAGE_REASON_TEXT[c] })),
      etaMinutes: cov.etaMinutes,
      etaRange: cov.etaRange,
      roadDistanceKm: cov.route.distanceKm,
      routeSource: cov.route.source,
    },
    promo,
    points,
    plus,
    pricing,
  };
}

const foodSubtotalOf = (q: Quote) => q.lines.reduce((a, l) => a + l.lineTotal, 0);

export function rowToPromotion(p: Record<string, unknown>): Promotion {
  return {
    id: p.id as string, code: p.code as string | null, restaurantId: p.restaurant_id as string | null, kind: p.kind as "percent" | "fixed",
    value: p.value as number, maxDiscount: p.max_discount as number | null, minFoodSubtotal: p.min_food_subtotal as number,
    abu9ShareBps: p.abu9_share_bps as number, restaurantShareBps: p.restaurant_share_bps as number, budget: p.budget as number,
    spent: p.spent as number, perCustomerLimit: p.per_customer_limit as number, firstOrderOnly: p.first_order_only as boolean,
    startsAt: p.starts_at as Date, endsAt: p.ends_at as Date, active: p.active as boolean,
  };
}

export function rowToPlus(s: Record<string, unknown>): PlusSubscription {
  return {
    id: s.id as string, userId: s.user_id as string, status: s.status as PlusSubscription["status"], priceVariantId: s.price_variant_id as string,
    currentPeriodStart: s.current_period_start as Date, currentPeriodEnd: s.current_period_end as Date,
    cancelAtPeriodEnd: s.cancel_at_period_end as boolean, pastDueSince: (s.past_due_since as Date | null) ?? null,
  };
}

// ════════════════════════════ ORDER PLACEMENT ════════════════════════════

export interface PlaceOrderInput extends QuoteInput {
  customerId: string;
  idempotencyKey: string;
  address: Record<string, unknown>;
  paymentToken: string;
  notes?: string;
  videoId?: string;
  referralCode?: string;
  groupCartId?: string;
  /** Total the customer saw — placement fails if the authoritative total differs. */
  expectedTotal?: number;
}

export async function placeOrder(app: AppContext, input: PlaceOrderInput): Promise<{ orderId: string; status: OrderStatus; replayed: boolean }> {
  // Idempotency: the same checkout submission never creates two orders or two charges.
  const prev = (await app.db.query<{ id: string; status: OrderStatus }>("select id, status from orders where customer_id = $1 and idempotency_key = $2", [input.customerId, input.idempotencyKey])).rows[0];
  if (prev) return { orderId: prev.id, status: prev.status, replayed: true };

  // Phase 1 — create the order + reserve promo budget/points atomically.
  const created = await app.db.tx(async (q) => {
    const quote = await buildQuote(app, q, input);
    if (!quote.coverage.eligible) throw new ApiError(422, "not_deliverable", quote.coverage.reasons[0]?.ar ?? "التوصيل غير متاح", quote.coverage.reasons);
    if (input.promoCode && !quote.promo?.applied) throw new ApiError(422, "promo_rejected", quote.promo?.reasonAr ?? "الكود غير صالح");
    if (input.redeemPoints && quote.points?.error) throw new ApiError(422, "points_rejected", quote.points.error);
    if (input.expectedTotal !== undefined && input.expectedTotal !== quote.pricing.total)
      throw conflict("price_changed", "تغيّر السعر، راجع الطلب", { total: quote.pricing.total });

    let referralCodeId: string | null = null;
    if (input.referralCode) {
      referralCodeId = (await q.query<{ id: string }>("select id from referral_codes where upper(code) = upper($1) and active", [input.referralCode])).rows[0]?.id ?? null;
    }

    const promisedBy = new Date(app.now().getTime() + (quote.coverage.etaRange[1] + 4) * 60_000);
    const order = (
      await q.query<{ id: string; number: number }>(
        `insert into orders(customer_id, restaurant_id, branch_id, zone_id, group_cart_id, status, address, dropoff_lat, dropoff_lng, road_distance_km, route_source,
           food_subtotal, food_discount, total, pricing, plus_applied, promo_id, points_redeemed, prep_minutes, promised_by, eta_at, notes, video_id, referral_code_id, idempotency_key)
         values ($1,$2,$3,$4,$5,'pending_payment',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning id, number`,
        [
          input.customerId, quote.restaurant.id, quote.branch.id, quote.zoneId, input.groupCartId ?? null, input.address, input.dropoff.lat, input.dropoff.lng,
          quote.coverage.roadDistanceKm, quote.coverage.routeSource, foodSubtotalOf(quote),
          foodSubtotalOf(quote) - quote.pricing.foodNet,
          quote.pricing.total, { ...quote.pricing, promo: quote.promo, points: quote.points ? { redeemed: quote.points.redeemed, discount: quote.points.discount } : null },
          quote.pricing.plusDiscount > 0, quote.promo?.applied ? quote.promo.promotionId : null, quote.points?.redeemed ?? 0, quote.branch.prepMinutes,
          promisedBy, new Date(app.now().getTime() + quote.coverage.etaMinutes * 60_000), input.notes ?? null, input.videoId ?? null, referralCodeId, input.idempotencyKey,
        ],
      )
    ).rows[0]!;

    for (const l of quote.lines)
      await q.query(
        "insert into order_items(order_id, item_id, added_by, name_ar, name_en, qty, unit_price, options, line_total) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [order.id, l.itemId, l.addedBy ?? input.customerId, l.nameAr, l.nameEn, l.qty, l.unitPrice, l.options, l.lineTotal],
      );
    await q.query("insert into order_events(order_id, from_status, to_status, actor_type, actor_id) values ($1,null,'pending_payment','customer',$2)", [order.id, input.customerId]);

    if (quote.promo?.applied) {
      // Atomic budget reservation: fails rather than overspending the approved budget.
      const upd = await q.query("update promotions set spent = spent + $2 where id = $1 and spent + $2 <= budget", [quote.promo.promotionId, quote.promo.discount]);
      if (!upd.rowCount) throw new ApiError(422, "promo_budget_exhausted", "نفدت ميزانية العرض");
      await q.query(
        "insert into promotion_redemptions(promotion_id, user_id, order_id, discount, abu9_funded, restaurant_funded) values ($1,$2,$3,$4,$5,$6)",
        [quote.promo.promotionId, input.customerId, order.id, quote.promo.discount, quote.promo.funding!.abu9, quote.promo.funding!.restaurant],
      );
    }
    if (quote.points && quote.points.redeemed > 0) {
      for (const c of quote.points.plan!) {
        const upd = await q.query("update points_lots set remaining = remaining - $2 where id = $1 and remaining >= $2", [c.lotId, c.points]);
        if (!upd.rowCount) throw conflict("points_changed", "تغيّر رصيد النقاط");
        await q.query("insert into points_transactions(user_id, delta, kind, order_id, lot_id, cost) values ($1,$2,'redeem',$3,$4,$5)", [input.customerId, -c.points, order.id, c.lotId, c.points * DEFAULT_LOYALTY.pointValueHalalas]);
      }
    }
    if (quote.plus.member && quote.pricing.plusDiscount > 0)
      await q.query("insert into plus_benefit_uses(order_id, subscription_id, discount) values ($1,$2,$3)", [order.id, quote.plus.subscriptionId, quote.pricing.plusDiscount]);

    const payment = await q.query<{ id: string }>(
      "insert into payments(purpose, order_id, user_id, provider, status, amount, idempotency_key, method) values ('order',$1,$2,$3,'requires_action',$4,$5,$6) returning id",
      [order.id, input.customerId, app.payments.name, quote.pricing.total, `order:${order.id}:auth`, "card"],
    );

    // Attribution: explicit referral code wins; otherwise the video the customer ordered from.
    if (referralCodeId || input.videoId) {
      const creatorId =
        (referralCodeId && (await q.query<{ creator_id: string | null }>("select creator_id from referral_codes where id = $1", [referralCodeId])).rows[0]?.creator_id) ||
        (input.videoId && (await q.query<{ creator_id: string | null }>("select creator_id from videos where id = $1", [input.videoId])).rows[0]?.creator_id) ||
        null;
      await q.query("insert into attributions(order_id, creator_id, video_id, referral_code_id, model) values ($1,$2,$3,$4,$5)", [order.id, creatorId, input.videoId ?? null, referralCodeId, referralCodeId ? "referral_code" : "video_last_touch"]);
    }
    return { orderId: order.id, paymentId: payment.rows[0]!.id, total: quote.pricing.total, restaurantId: quote.restaurant.id };
  });

  // Phase 2 — authorize with the PSP (outside the DB transaction; idempotent by key).
  const auth = await app.payments.authorize({
    amount: created.total,
    currency: "SAR",
    idempotencyKey: `order:${created.orderId}:auth`,
    method: { type: "card_token", token: input.paymentToken },
    description: `ABU9 order ${created.orderId}`,
  });

  // Phase 3 — record the outcome. (A decline must COMMIT the cancellation before we report it.)
  const outcome = await app.db.tx(async (q) => {
    await q.query("update payments set status = $2, provider_ref = $3, failure_reason = $4, updated_at = now() where id = $1", [created.paymentId, auth.status === "authorized" ? "authorized" : auth.status === "requires_action" ? "requires_action" : "failed", auth.providerRef, auth.failureReason ?? null]);
    if (auth.status === "authorized") {
      await transitionOrder(app, q, created.orderId, "placed", "system", null, "payment authorized");
      await q.query("update orders set placed_at = now() where id = $1", [created.orderId]);
      app.bus.publish(`restaurant:${created.restaurantId}`, { type: "order.placed", orderId: created.orderId });
      return { orderId: created.orderId, status: "placed" as OrderStatus, replayed: false };
    }
    if (auth.status === "requires_action") {
      // 3-D Secure / Apple Pay challenge flow is not implemented in the mock — order waits for a webhook.
      return { orderId: created.orderId, status: "pending_payment" as OrderStatus, replayed: false };
    }
    await releaseOrderReservations(q, created.orderId);
    await transitionOrder(app, q, created.orderId, "cancelled", "system", null, `payment_failed:${auth.failureReason}`);
    return null;
  });
  if (!outcome) throw new ApiError(402, "payment_failed", "تم رفض الدفع، جرّب بطاقة أخرى");
  return outcome;
}

/** Return reserved promotion budget and redeemed points when an order does not go ahead. */
export async function releaseOrderReservations(q: Queryable, orderId: string): Promise<void> {
  const red = (await q.query<{ promotion_id: string; discount: number }>("update promotion_redemptions set status = 'reversed' where order_id = $1 and status = 'applied' returning promotion_id, discount", [orderId])).rows;
  for (const r of red) await q.query("update promotions set spent = spent - $2 where id = $1", [r.promotion_id, r.discount]);
  const pts = (await q.query<{ user_id: string; delta: number; lot_id: string }>("select user_id, delta, lot_id from points_transactions where order_id = $1 and kind = 'redeem'", [orderId])).rows;
  for (const p of pts) {
    await q.query("update points_lots set remaining = remaining + $2 where id = $1", [p.lot_id, -p.delta]);
    await q.query("insert into points_transactions(user_id, delta, kind, order_id, lot_id, note) values ($1,$2,'restore',$3,$4,'order did not proceed')", [p.user_id, -p.delta, orderId, p.lot_id]);
  }
  await q.query("delete from plus_benefit_uses where order_id = $1", [orderId]);
}

export async function transitionOrder(app: AppContext, q: Queryable, orderId: string, to: OrderStatus, actor: Actor, actorId: string | null, note?: string): Promise<{ from: OrderStatus }> {
  const o = (await q.query<{ status: OrderStatus; customer_id: string; restaurant_id: string; number: number }>("select status, customer_id, restaurant_id, number from orders where id = $1 for update", [orderId])).rows[0];
  if (!o) throw notFound("order");
  assertOrderTransition(o.status, to, actor);
  const stamp: Partial<Record<OrderStatus, string>> = { accepted: "accepted_at", picked_up: "picked_up_at", delivered: "delivered_at", cancelled: "cancelled_at", rejected: "cancelled_at" };
  await q.query(`update orders set status = $2 ${stamp[to] ? `, ${stamp[to]} = now()` : ""} ${to === "cancelled" || to === "rejected" ? ", cancel_reason = $3" : ""} where id = $1`, to === "cancelled" || to === "rejected" ? [orderId, to, note ?? null] : [orderId, to]);
  await q.query("insert into order_events(order_id, from_status, to_status, actor_type, actor_id, note) values ($1,$2,$3,$4,$5,$6)", [orderId, o.status, to, actor, actorId, note ?? null]);
  app.bus.publish(`order:${orderId}`, { type: "order.status", status: to, from: o.status });
  app.bus.publish("ops", { type: "order.status", orderId, status: to });
  app.bus.publish(`restaurant:${o.restaurant_id}`, { type: "order.status", orderId, status: to });
  if (to !== "pending_payment" && to !== "placed")
    await notify(app, q, o.customer_id, { kind: "order_status", titleAr: `طلبك #${o.number}: ${ORDER_STATUS_TEXT[to].ar}`, titleEn: `Order #${o.number}: ${ORDER_STATUS_TEXT[to].en}`, data: { orderId } });
  return { from: o.status };
}

// ════════════════════════════ RESTAURANT ACTIONS ════════════════════════════

export async function acceptOrder(app: AppContext, orderId: string, actorId: string, prepMinutes: number, actor: Actor = "restaurant"): Promise<{ jobId: string }> {
  const res = await app.db.tx(async (q) => {
    await transitionOrder(app, q, orderId, "accepted", actor, actorId);
    const o = (await q.query<Record<string, unknown>>("select o.*, b.lat blat, b.lng blng from orders o join branches b on b.id = o.branch_id where o.id = $1", [orderId])).rows[0]!;
    const now = app.now();
    const readyAt = new Date(now.getTime() + prepMinutes * 60_000);
    const travel = await app.routing.route({ lat: o.blat as number, lng: o.blng as number }, { lat: o.dropoff_lat as number, lng: o.dropoff_lng as number }, readyAt);
    // The promise can only move later (with notice to the customer), never silently earlier than what was quoted.
    const earliest = new Date(readyAt.getTime() + (travel.durationMin + 10) * 60_000);
    const promisedBy = (o.promised_by as Date) > earliest ? (o.promised_by as Date) : earliest;
    await q.query("update orders set prep_minutes = $2, ready_at = $3, promised_by = $4, eta_at = $5 where id = $1", [orderId, prepMinutes, readyAt, promisedBy, new Date(readyAt.getTime() + (travel.durationMin + 5) * 60_000)]);
    await transitionOrder(app, q, orderId, "preparing", "system", null);
    const job = await q.query<{ id: string }>(
      "insert into delivery_jobs(order_id, status, pickup_code, dropoff_code, distance_km) values ($1,'unassigned',$2,$3,$4) returning id",
      [orderId, String(randomInt(1000, 10000)), String(randomInt(1000, 10000)), o.road_distance_km],
    );
    return { jobId: job.rows[0]!.id, paymentCapture: o };
  });
  await capturePayment(app, orderId);
  return { jobId: res.jobId };
}

/** Capture the authorized amount and post the capture journal entry. Idempotent. */
export async function capturePayment(app: AppContext, orderId: string): Promise<void> {
  const p = (await app.db.query<{ id: string; provider_ref: string; amount: number; status: string }>("select id, provider_ref, amount, status from payments where order_id = $1 and purpose = 'order' order by created_at desc limit 1", [orderId])).rows[0];
  if (!p) throw new ApiError(409, "no_payment");
  if (p.status !== "authorized" && p.status !== "captured") throw new ApiError(409, "payment_not_capturable", p.status);
  const res = p.status === "captured" ? null : await app.payments.capture(p.provider_ref, p.amount, `order:${orderId}:capture`);
  if (res && res.status !== "captured") throw new ApiError(502, "capture_failed");
  await app.db.tx(async (q) => {
    await q.query("update payments set status = 'captured', captured_amount = amount, updated_at = now() where id = $1 and status = 'authorized'", [p.id]);
    const o = (await q.query<{ restaurant_id: string; pricing: Record<string, number> & { points?: { discount: number } | null }; food_subtotal: number; total: number }>("select restaurant_id, pricing, food_subtotal, total from orders where id = $1", [orderId])).rows[0]!;
    const promo = (await q.query<{ abu9_funded: number; restaurant_funded: number }>("select abu9_funded, restaurant_funded from promotion_redemptions where order_id = $1 and status = 'applied'", [orderId])).rows[0];
    const pr = o.pricing;
    await postEntry(
      q,
      postOrderCapture({
        orderId,
        restaurantId: o.restaurant_id,
        occurredAt: app.now(),
        totalCharged: o.total,
        foodSubtotal: o.food_subtotal,
        restaurantFundedDiscount: promo?.restaurant_funded ?? 0,
        abu9FundedDiscount: promo?.abu9_funded ?? 0,
        loyaltyRedemption: pr.points?.discount ?? 0,
        deliveryFeesCharged: pr.basicDeliveryFee! + pr.additionalDistanceFee! - pr.plusDiscount! + pr.smallOrderFee!,
        serviceFeesCharged: pr.serviceFee!,
        vatOnPlatformFees: pr.vatOnPlatformFees!,
      }),
    );
  });
}

export async function rejectOrder(app: AppContext, orderId: string, actor: Actor, actorId: string | null, reason: string): Promise<void> {
  await app.db.tx(async (q) => {
    await transitionOrder(app, q, orderId, "rejected", actor, actorId, reason);
    await releaseOrderReservations(q, orderId);
  });
  await voidPayment(app, orderId);
}

export async function voidPayment(app: AppContext, orderId: string): Promise<void> {
  const p = (await app.db.query<{ id: string; provider_ref: string; status: string }>("select id, provider_ref, status from payments where order_id = $1 and purpose = 'order'", [orderId])).rows[0];
  if (!p || p.status !== "authorized") return;
  const r = await app.payments.void(p.provider_ref, `order:${orderId}:void`);
  if (r.status === "voided") await app.db.query("update payments set status = 'voided', updated_at = now() where id = $1", [p.id]);
}

export async function customerCancel(app: AppContext, orderId: string, customerId: string): Promise<void> {
  const o = (await app.db.query<{ customer_id: string; status: OrderStatus }>("select customer_id, status from orders where id = $1", [orderId])).rows[0];
  if (!o || o.customer_id !== customerId) throw notFound("order");
  if (o.status !== "placed" && o.status !== "pending_payment") throw conflict("cannot_cancel", "لا يمكن الإلغاء بعد قبول المطعم، تواصل مع الدعم");
  await app.db.tx(async (q) => {
    await transitionOrder(app, q, orderId, "cancelled", "customer", customerId, "customer_cancelled_before_acceptance");
    await releaseOrderReservations(q, orderId);
  });
  await voidPayment(app, orderId);
}
