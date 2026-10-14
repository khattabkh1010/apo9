/**
 * End-to-end commercial flow against a real PostgreSQL database:
 * watch → discover → cart → quote → order → restaurant accepts → dispatch → courier pickup/deliver
 * → ledger, loyalty, ABU9+, support refund, compensation claim, settlement, reconciliation, RBAC.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestServer, Client, DEMO_PHONES, type TestServer } from "./helpers.ts";

let s: TestServer;
let customer: Client, owner: Client, courier: Client, ops: Client, finance: Client, logistics: Client, creator: Client, customer2: Client;
const ctx: Record<string, any> = {};

before(async () => {
  s = await startTestServer();
  customer = await new Client(s.base).login(DEMO_PHONES.customer);
  customer2 = await new Client(s.base).login(DEMO_PHONES.customer2);
  owner = await new Client(s.base).login(DEMO_PHONES.restaurantOwner);
  courier = await new Client(s.base).login(DEMO_PHONES.courier1);
  ops = await new Client(s.base).login(DEMO_PHONES.opsAdmin);
  finance = await new Client(s.base).login(DEMO_PHONES.finance);
  logistics = await new Client(s.base).login(DEMO_PHONES.logisticsAdmin);
  creator = await new Client(s.base).login(DEMO_PHONES.creator);
});
after(() => s.close());

test("auth: OTP rejects bad codes and locks after repeated failures", async () => {
  const c = new Client(s.base);
  const r1 = await c.post("/api/v1/auth/otp/request", { phone: "٠٥٥٩٨٧٦٥٤٣" });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.phone, "+966559876543");
  const wrong = r1.body.devCode === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await c.post("/api/v1/auth/otp/verify", { challengeId: r1.body.challengeId, code: wrong })).status, 400);
  const locked = await c.post("/api/v1/auth/otp/verify", { challengeId: r1.body.challengeId, code: r1.body.devCode });
  assert.equal(locked.status, 429);
  assert.equal((await c.post("/api/v1/auth/otp/request", { phone: "12345" })).status, 400);
});

test("RBAC: customers cannot reach admin, restaurant or courier APIs", async () => {
  assert.equal((await customer.get("/api/v1/admin/dashboard")).status, 403);
  assert.equal((await customer.get("/api/v1/courier/jobs")).status, 403);
  const rid = (await s.db.query<{ id: string }>("select id from restaurants where slug = 'najd-burger-demo'")).rows[0]!.id;
  ctx.rid = rid;
  assert.equal((await customer.get(`/api/v1/restaurant/${rid}/orders`)).status, 403);
  assert.equal((await new Client(s.base).get("/api/v1/me")).status, 401);
  // restaurant owner of Najd cannot read another restaurant
  const other = (await s.db.query<{ id: string }>("select id from restaurants where slug = 'liwan-sweets-demo'")).rows[0]!.id;
  assert.equal((await owner.get(`/api/v1/restaurant/${other}/orders`)).status, 403);
});

test("discovery: feed returns approved videos with linked, orderable dishes", async () => {
  const feed = await customer.get("/api/v1/feed?lat=24.693&lng=46.688");
  assert.equal(feed.status, 200);
  assert.ok(feed.body.videos.length >= 7);
  assert.ok(feed.body.videos.every((v: any) => v.items?.length > 0));
  const najd = feed.body.videos.find((v: any) => v.restaurant.slug === "najd-burger-demo" && v.items.some((i: any) => i.nameEn === "Classic Smash"));
  assert.ok(najd, "Najd video in feed");
  assert.equal(najd.deliverable, true);
  assert.ok(!feed.body.videos.some((v: any) => v.caption_ar.includes("بانتظار المراجعة")), "unmoderated video must not appear");
  ctx.videoId = najd.id;
  assert.equal((await customer.post(`/api/v1/videos/${najd.id}/events`, { kind: "add_to_cart" })).status, 202);
});

test("checkout quote: transparent breakdown, promo, one-restaurant rule, coverage", async () => {
  const menu = (await customer.get("/api/v1/restaurants/najd-burger-demo")).body;
  const items = menu.menu.flatMap((c: any) => c.items);
  const smash = items.find((i: any) => i.name_en === "Classic Smash");
  const fries = items.find((i: any) => i.name_en === "Duqqa Fries");
  const cheese = smash.modifierGroups[0].options.find((o: any) => o.name_en === "Extra cheese");
  const regular = fries.modifierGroups[0].options.find((o: any) => o.name_en === "Regular");
  Object.assign(ctx, { smash, fries, cheese, regular });
  const addr = (await customer.get("/api/v1/me/addresses")).body.addresses.find((a: any) => a.is_default);
  ctx.addressId = addr.id;
  ctx.lines = [
    { itemId: smash.id, qty: 1, optionIds: [cheese.id] },
    { itemId: fries.id, qty: 1, optionIds: [regular.id] },
  ];

  const q = await customer.post("/api/v1/checkout/quote", { restaurantId: ctx.rid, lines: ctx.lines, addressId: addr.id, promoCode: "AHLAN" });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const p = q.body.quote.pricing;
  assert.equal(q.body.quote.coverage.eligible, true);
  assert.equal(p.lines.find((l: any) => l.code === "food_subtotal").amount, 5000);
  assert.equal(p.lines.find((l: any) => l.code === "food_discount").amount, -1000); // 20% of 50
  assert.equal(p.basicDeliveryFee, 900);
  assert.equal(p.total, 4000 + 900 + p.additionalDistanceFee);
  ctx.expectedTotal = p.total;

  // Required modifier missing
  const bad = await customer.post("/api/v1/checkout/quote", { restaurantId: ctx.rid, lines: [{ itemId: fries.id, qty: 1, optionIds: [] }], addressId: addr.id });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "modifier_selection");

  // One restaurant per order
  const kunafa = (await customer.get("/api/v1/restaurants/liwan-sweets-demo")).body.menu[0].items[0];
  const mixed = await customer.post("/api/v1/checkout/quote", { restaurantId: ctx.rid, lines: [...ctx.lines, { itemId: kunafa.id, qty: 1 }], addressId: addr.id });
  assert.equal(mixed.body.error.code, "item_not_in_restaurant");

  // Outside every zone → not deliverable (no global radius)
  const far = await customer.post("/api/v1/checkout/quote", { restaurantId: ctx.rid, lines: ctx.lines, dropoff: { lat: 24.55, lng: 46.9 } });
  assert.equal(far.body.quote.coverage.eligible, false);
  assert.equal(far.body.quote.coverage.reasons[0].code, "no_zone");
});

test("place order: idempotent, payment authorized, reaches restaurant", async () => {
  const key = randomUUID();
  const body = { restaurantId: ctx.rid, lines: ctx.lines, addressId: ctx.addressId, promoCode: "AHLAN", paymentToken: "tok_visa_test", expectedTotal: ctx.expectedTotal, videoId: ctx.videoId };
  const r1 = await customer.post("/api/v1/orders", body, { "idempotency-key": key });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.status, "placed");
  const r2 = await customer.post("/api/v1/orders", body, { "idempotency-key": key });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.orderId, r1.body.orderId);
  assert.equal(r2.body.replayed, true);
  ctx.orderId = r1.body.orderId;
  const n = (await s.db.query<{ n: number }>("select count(*)::int n from payments where order_id = $1", [ctx.orderId])).rows[0]!.n;
  assert.equal(n, 1, "exactly one payment");
  // first-order promo cannot be reused
  const again = await customer.post("/api/v1/checkout/quote", { restaurantId: ctx.rid, lines: ctx.lines, addressId: ctx.addressId, promoCode: "AHLAN" });
  assert.equal(again.body.quote.promo.applied, false);
  // price-change protection
  const stale = await customer.post("/api/v1/orders", { ...body, promoCode: undefined, expectedTotal: 1 }, { "idempotency-key": randomUUID() });
  assert.equal(stale.status, 409);
});

test("declined card cancels the order and releases the promo budget", async () => {
  const spentBefore = (await s.db.query<{ spent: number }>("select spent from promotions where code = 'NAJD10'")).rows[0]!.spent;
  const r = await customer2.post("/api/v1/orders", { restaurantId: ctx.rid, lines: [{ itemId: ctx.smash.id, qty: 2, optionIds: [] }], dropoff: { lat: 24.694, lng: 46.686 }, promoCode: "NAJD10", paymentToken: "tok_decline" }, { "idempotency-key": randomUUID() });
  assert.equal(r.status, 402);
  const spentAfter = (await s.db.query<{ spent: number }>("select spent from promotions where code = 'NAJD10'")).rows[0]!.spent;
  assert.equal(spentAfter, spentBefore);
});

test("restaurant accepts → payment captured → courier dispatched with explanation", async () => {
  const queue = await owner.get(`/api/v1/restaurant/${ctx.rid}/orders`);
  assert.ok(queue.body.orders.some((o: any) => o.id === ctx.orderId));
  const acc = await owner.post(`/api/v1/restaurant/${ctx.rid}/orders/${ctx.orderId}/accept`, { prepMinutes: 12 });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal(acc.body.courierAssigned, true);
  const pay = (await s.db.query<{ status: string }>("select status from payments where order_id = $1", [ctx.orderId])).rows[0]!;
  assert.equal(pay.status, "captured");
  const dec = (await s.db.query<{ decision: any }>("select d.decision from dispatch_decisions d join delivery_jobs j on j.id = d.job_id where j.order_id = $1", [ctx.orderId])).rows[0]!.decision;
  assert.equal(dec.strategy, "nearest-feasible-v1");
  assert.ok(dec.assignment.explanation.length >= 3);
  ctx.assignedCourier = dec.assignment.courierId;
  assert.equal((await owner.post(`/api/v1/restaurant/${ctx.rid}/orders/${ctx.orderId}/ready`)).status, 200);
});

test("courier: pickup needs the restaurant code; delivery needs the customer code", async () => {
  // Make sure the demo courier we log in as holds the job (ops override is audited).
  const job = (await s.db.query<{ id: string; courier_id: string; pickup_code: string }>("select id, courier_id, pickup_code from delivery_jobs where order_id = $1", [ctx.orderId])).rows[0]!;
  const me = (await courier.get("/api/v1/me")).body;
  if (job.courier_id !== me.courierId) {
    const o = await ops.post(`/api/v1/admin/dispatch/jobs/${job.id}/assign`, { courierId: me.courierId, reason: "e2e: route to demo courier" });
    assert.equal(o.status, 200, JSON.stringify(o.body));
  }
  const jobs = await courier.get("/api/v1/courier/jobs");
  assert.ok(jobs.body.jobs.some((j: any) => j.id === job.id));
  assert.equal((await courier.post(`/api/v1/courier/jobs/${job.id}/arrive-pickup`)).status, 200);
  assert.equal((await courier.post(`/api/v1/courier/jobs/${job.id}/pickup`, { code: "0000" === job.pickup_code ? "1111" : "0000" })).status, 422);
  assert.equal((await courier.post(`/api/v1/courier/jobs/${job.id}/pickup`, { code: job.pickup_code })).status, 200);
  assert.equal((await courier.post("/api/v1/courier/location", { lat: 24.694, lng: 46.687 })).status, 202);
  const tracking = await customer.get(`/api/v1/orders/${ctx.orderId}`);
  assert.equal(tracking.body.order.status, "picked_up");
  assert.ok(tracking.body.delivery.courierLocation, "live location exposed while on the way");
  const code = tracking.body.delivery.dropoffCode;
  assert.match(code, /^\d{4}$/);
  assert.equal((await courier.post(`/api/v1/courier/jobs/${job.id}/deliver`, { code: code === "0000" ? "1111" : "0000" })).status, 422);
  const done = await courier.post(`/api/v1/courier/jobs/${job.id}/deliver`, { code });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await customer.get(`/api/v1/orders/${ctx.orderId}`)).body.order.status, "delivered");
});

test("ledger: balanced, food is merchant liability, delivery cost accrued, points earned", async () => {
  const tb = (await finance.get("/api/v1/admin/ledger/trial-balance")).body.accounts;
  const bal = (code: string) => Number(tb.find((a: any) => a.code === code)?.balance ?? 0);
  assert.equal(bal(`liability:merchant_payable:${ctx.rid}`), 5000, "full food value owed to restaurant (promo was ABU9-funded)");
  assert.equal(bal("expense:promotions"), 1000);
  const company = (await s.db.query<{ company_id: string }>("select company_id from delivery_jobs where order_id = $1", [ctx.orderId])).rows[0]!.company_id;
  assert.ok(bal(`liability:logistics_payable:${company}`) > 0);
  const rec = (await finance.get("/api/v1/admin/reconciliation")).body;
  assert.equal(rec.trialBalanced, true);
  assert.equal(rec.pspClearing.matches, true);
  assert.equal(rec.ordersMissingCaptureEntry.length, 0);
  assert.equal(rec.deliveriesMissingCostEntry.length, 0);
  // Immutability is enforced by the database itself.
  await assert.rejects(s.db.query("update journal_lines set debit = debit + 1"));
  const loyalty = (await customer.get("/api/v1/me/loyalty")).body;
  assert.equal(loyalty.balance, 80, "1 point per whole SAR of food net (SAR 40)");
  const attr = (await s.db.query<{ creator_id: string | null }>("select creator_id from attributions where order_id = $1", [ctx.orderId])).rows[0];
  assert.ok(attr, "order attributed to the video");
  assert.equal((await customer.post(`/api/v1/orders/${ctx.orderId}/rating`, { restaurantStars: 5, courierStars: 5 })).status, 201);
});

test("ABU9+: subscribe at assigned test price; basic fee waived only on eligible orders", async () => {
  const offer = (await customer.get("/api/v1/plus")).body;
  assert.ok([1999, 2499, 2999].includes(offer.offer.price));
  const sub = await customer.post("/api/v1/plus/subscribe", { paymentToken: "tok_visa_test" }, { "idempotency-key": randomUUID() });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  const q = await customer.post("/api/v1/checkout/quote", { restaurantId: ctx.rid, lines: ctx.lines, addressId: ctx.addressId });
  const p = q.body.quote.pricing;
  assert.equal(p.plus.eligible, true);
  assert.equal(p.plusDiscount, 900);
  assert.equal(p.total, 5000 + p.additionalDistanceFee);
  const small = await customer.post("/api/v1/checkout/quote", { restaurantId: ctx.rid, lines: [{ itemId: ctx.smash.id, qty: 1, optionIds: [] }], addressId: ctx.addressId });
  assert.equal(small.body.quote.pricing.plus.eligible, false, "SAR 32 is below the SAR 35 minimum");
  assert.equal(small.body.quote.pricing.plus.amountToQualify, 300);
  const tb = (await finance.get("/api/v1/admin/ledger/trial-balance")).body.accounts;
  assert.ok(Number(tb.find((a: any) => a.code === "liability:deferred_revenue:abu9_plus").balance) > 0, "subscription revenue is deferred");
});

test("support: instant refund funded by ABU9; restaurant claim opened, not deducted", async () => {
  const t = await customer.post("/api/v1/support/tickets", { orderId: ctx.orderId, reasonCode: "missing_item", affectedAmount: 1400, description: "البطاطس ناقصة" });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal(t.body.autoResolved, true);
  const claim = (await s.db.query<{ status: string; party_type: string; deductible_after: Date }>("select * from compensation_claims where order_id = $1", [ctx.orderId])).rows[0]!;
  assert.equal(claim.party_type, "restaurant");
  assert.equal(claim.status, "open");
  assert.ok(claim.deductible_after > new Date(), "not deductible until dispute window passes");
  const tb = (await finance.get("/api/v1/admin/ledger/trial-balance")).body.accounts;
  assert.equal(Number(tb.find((a: any) => a.code === `liability:merchant_payable:${ctx.rid}`).balance), 5000, "merchant balance untouched by the refund");
  assert.equal((await customer.get("/api/v1/me/loyalty")).body.balance < 80, true, "earned points reversed proportionally");

  // Restaurant disputes the claim → it's withheld from any deduction until ops decides.
  const claims = (await owner.get(`/api/v1/restaurant/${ctx.rid}/claims`)).body.claims;
  assert.equal((await owner.post(`/api/v1/restaurant/${ctx.rid}/claims/${claims[0].id}/dispute`, { note: "الطلب خرج كامل حسب الكاميرا" })).status, 200);
});

test("settlements: weekly statement pays undisputed balance, withholds only the disputed deduction", async () => {
  const g = await finance.post("/api/v1/admin/settlements/generate", { partyType: "restaurant" });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const list = (await finance.get("/api/v1/admin/settlements")).body.settlements;
  const st = list.find((x: any) => x.party_id === ctx.rid);
  assert.equal(Number(st.net_payable), 5000);
  assert.equal(Number(st.withheld_disputed) > 0, true);
  assert.equal((await finance.post(`/api/v1/admin/settlements/${st.id}/approve`)).status, 200);
  assert.equal((await finance.post(`/api/v1/admin/settlements/${st.id}/paid`, { payoutRef: "DEMO-SARIE-0001" })).status, 200);
  const tb = (await finance.get("/api/v1/admin/ledger/trial-balance")).body.accounts;
  assert.equal(Number(tb.find((a: any) => a.code === `liability:merchant_payable:${ctx.rid}`).balance), 0);
  assert.equal((await finance.get("/api/v1/admin/reconciliation")).body.trialBalanced, true);
  const lg = await finance.post("/api/v1/admin/settlements/generate", { partyType: "logistics" });
  assert.equal(lg.status, 200);
});

test("ops: sensitive changes are audited; batching cap of 2 cannot be raised", async () => {
  const zones = (await ops.get("/api/v1/admin/zones")).body.zones;
  const z = zones.find((x: any) => x.code === "RUH-YASMIN");
  assert.equal((await ops.req("PATCH", `/api/v1/admin/zones/${z.id}`, { status: "paused", reason: "e2e test" })).status, 200);
  const bad = await ops.req("PUT", "/api/v1/admin/settings/batching", { value: { enabled: true, maxOrdersPerCourier: 3, maxDetourKm: 2, maxAddedDelayMin: 7 }, reason: "try" });
  assert.equal(bad.status, 400);
  const logs = (await ops.get("/api/v1/admin/audit")).body.logs;
  for (const action of ["zone.update", "dispatch.manual_assign", "settlement.approve", "settlement.paid", "claim.disputed", "settlements.generate"])
    assert.ok(logs.some((l: any) => l.action === action), `audit has ${action}`);
  await assert.rejects(s.db.query("delete from audit_logs"));
  // finance cannot change pricing
  assert.equal((await finance.post("/api/v1/admin/pricing", { zoneId: null, basicFee: 1, baseDistanceKm: 2, additionalFeePerIncrement: 1, additionalIncrementKm: 0.5, serviceFee: 0, vatRateBps: 1500, reason: "x" })).status, 403);
});

test("partners & creators: logistics overview, creator stats, moderation queue", async () => {
  const mine = (await logistics.get("/api/v1/logistics/mine")).body.companies[0];
  const ov = await logistics.get(`/api/v1/logistics/${mine.id}/overview`);
  assert.equal(ov.status, 200);
  const other = (await s.db.query<{ id: string }>("select id from logistics_companies where id <> $1 limit 1", [mine.id])).rows[0]!.id;
  assert.equal((await logistics.get(`/api/v1/logistics/${other}/overview`)).status, 403);
  const me = await creator.get("/api/v1/creator/me");
  assert.equal(me.status, 200);
  assert.ok(me.body.referralCodes.some((c: any) => c.code === "NOURA10"));
  const queue = (await ops.get("/api/v1/admin/moderation/videos")).body.videos;
  assert.equal(queue.length, 1);
  assert.equal((await ops.post(`/api/v1/admin/moderation/videos/${queue[0].id}`, { decision: "rejected" })).status, 400, "rejection needs a reason");
  assert.equal((await ops.post(`/api/v1/admin/moderation/videos/${queue[0].id}`, { decision: "approved" })).status, 200);
});

test("webhooks: signature required, redelivery is idempotent", async () => {
  const pay = (await s.db.query<{ provider_ref: string }>("select provider_ref from payments where order_id = $1", [ctx.orderId])).rows[0]!;
  const body = JSON.stringify({ id: "evt_1", type: "refund.succeeded", data: { providerRef: pay.provider_ref } });
  const unsigned = await fetch(`${s.base}/api/v1/payments/webhooks/mock`, { method: "POST", body, headers: { "content-type": "application/json", "x-signature": "sha256=nope" } });
  assert.equal(unsigned.status, 401);
  const sig = (s.app.payments as any).sign(body);
  const a = await (await fetch(`${s.base}/api/v1/payments/webhooks/mock`, { method: "POST", body, headers: { "x-signature": sig } })).json();
  const b = await (await fetch(`${s.base}/api/v1/payments/webhooks/mock`, { method: "POST", body, headers: { "x-signature": sig } })).json();
  assert.equal(a.ok, true);
  assert.equal(b.duplicate, true);
});

test("dispatch batching: second order from the same branch is batched onto the busy courier", async () => {
  // Take every courier offline except one, then place two orders from the Olaya branch.
  const only = (await s.db.query<{ id: string; user_id: string }>("select c.id, c.user_id from couriers c join users u on u.id = c.user_id where u.phone = $1", [DEMO_PHONES.courier1])).rows[0]!;
  await s.db.query("update couriers set status = case when id = $1 then 'online' else 'offline' end, last_lat = 24.6965, last_lng = 46.6851, last_seen_at = now()", [only.id]);
  const lines = [{ itemId: ctx.smash.id, qty: 2, optionIds: [] }];
  const place = async (c: Client, dropoff: { lat: number; lng: number }) => {
    const r = await c.post("/api/v1/orders", { restaurantId: ctx.rid, lines, dropoff, paymentToken: "tok_visa_test" }, { "idempotency-key": randomUUID() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const acc = await owner.post(`/api/v1/restaurant/${ctx.rid}/orders/${r.body.orderId}/accept`, { prepMinutes: 10 });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    return r.body.orderId as string;
  };
  const o1 = await place(customer2, { lat: 24.7005, lng: 46.6905 });
  const o2 = await place(customer2, { lat: 24.7015, lng: 46.6912 });
  const jobs = (await s.db.query<{ order_id: string; courier_id: string; batched_with_job_id: string | null }>("select order_id, courier_id, batched_with_job_id from delivery_jobs where order_id = any($1::uuid[])", [[o1, o2]])).rows;
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((j) => j.courier_id === only.id), "both on the single courier");
  assert.ok(jobs.find((j) => j.order_id === o2)!.batched_with_job_id, "second order marked as batched");
  // With one courier carrying two orders, the zone is saturated: checkout refuses a third order
  // rather than making a delivery promise it cannot keep (the courier cap of 2 is unit-tested in the domain).
  const o3 = await customer2.post("/api/v1/orders", { restaurantId: ctx.rid, lines, dropoff: { lat: 24.7, lng: 46.69 }, paymentToken: "tok_visa_test" }, { "idempotency-key": randomUUID() });
  assert.equal(o3.status, 422);
  assert.equal(o3.body.error.details[0].code, "no_courier_capacity");
});
