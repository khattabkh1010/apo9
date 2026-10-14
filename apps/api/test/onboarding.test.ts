/**
 * Restaurant self-onboarding against a real database:
 * application → checklist → hours, menu, modifiers, terms → ops coverage → activation (trial starts)
 * → customer can order with modifiers.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, Client, DEMO_PHONES, type TestServer } from "./helpers.ts";

let s: TestServer;
let applicant: Client, ops: Client, otherOwner: Client, customer: Client;
const ctx: Record<string, any> = {};

before(async () => {
  s = await startTestServer();
  applicant = await new Client(s.base).login("0551234567");
  ops = await new Client(s.base).login(DEMO_PHONES.opsAdmin);
  otherOwner = await new Client(s.base).login(DEMO_PHONES.restaurantOwner);
  customer = await new Client(s.base).login(DEMO_PHONES.customer);
});
after(() => s.close());

const R = (p: string) => `/api/v1/restaurant/${ctx.rid}${p}`;

test("application creates an onboarding restaurant owned by the applicant, invisible to customers", async () => {
  const bad = await applicant.post("/api/v1/restaurant-applications", { nameAr: "مطبخ تجريبي", nameEn: "Test Kitchen", cuisineTags: ["سعودي"], crNumber: "123", branch: { nameAr: "العليا", nameEn: "Olaya", lat: 24.6962, lng: 46.6849 } });
  assert.equal(bad.status, 400);
  const r = await applicant.post("/api/v1/restaurant-applications", {
    nameAr: "مطبخ تجريبي (وهمي)", nameEn: "Test Kitchen", cuisineTags: ["سعودي"], crNumber: "1010999888", vatNumber: "300999888700003",
    branch: { nameAr: "فرع العليا", nameEn: "Olaya", lat: 24.6962, lng: 46.6849, district: "العليا" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  Object.assign(ctx, { rid: r.body.restaurantId, slug: r.body.slug, bid: r.body.branchId });
  assert.match(ctx.slug, /^test-kitchen-[0-9a-f]{6}$/);
  const mine = await applicant.get("/api/v1/restaurant/mine");
  assert.ok(mine.body.restaurants.some((x: any) => x.id === ctx.rid && x.status === "onboarding"));
  assert.equal((await customer.get(`/api/v1/restaurants/${ctx.slug}`)).status, 404, "not public before activation");
  assert.equal((await otherOwner.get(R("/onboarding"))).status, 403);

  const ob = await applicant.get(R("/onboarding"));
  const done = Object.fromEntries(ob.body.steps.map((x: any) => [x.key, x.done]));
  assert.deepEqual(done, { profile: true, branch: true, hours: false, menu: false, terms: false, coverage: false });
  assert.equal(ob.body.terms.auto_deduct_reason_codes.length, 0, "no automatic deductions until agreed");
});

test("activation is refused while the checklist is incomplete", async () => {
  const r = await ops.post(`/api/v1/admin/restaurants/${ctx.rid}/activate`, { reason: "launch" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "onboarding_incomplete");
  assert.deepEqual(r.body.error.details.sort(), ["coverage", "hours", "menu", "terms"]);
});

test("restaurant completes hours, menu with modifiers and terms", async () => {
  const badHours = await applicant.req("PUT", R(`/branches/${ctx.bid}/hours`), { hours: { "1": [["12:00", "15:00"], ["14:00", "18:00"]] } });
  assert.equal(badHours.status, 400);
  assert.equal(badHours.body.error.code, "invalid_hours");
  const all = Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), [["00:00", "24:00"]]]));
  assert.equal((await applicant.req("PUT", R(`/branches/${ctx.bid}/hours`), { hours: all })).status, 200);

  const cat = await applicant.post(R("/menu/categories"), { nameAr: "رئيسي", nameEn: "Mains" });
  assert.equal(cat.status, 201);
  ctx.items = [];
  for (const [ar, en, price] of [["كبسة لحم", "Lamb Kabsa", 4500], ["مندي دجاج", "Chicken Mandi", 3800], ["سلطة", "Salad", 1500]] as const) {
    const it = await applicant.post(R("/menu/items"), { categoryId: cat.body.category.id, nameAr: ar, nameEn: en, price });
    assert.equal(it.status, 201);
    ctx.items.push(it.body.item);
  }
  const kabsa = ctx.items[0];
  const size = await applicant.post(R(`/menu/items/${kabsa.id}/modifier-groups`), {
    nameAr: "الحجم", nameEn: "Size", minSelect: 1, maxSelect: 1,
    options: [{ nameAr: "عادي", nameEn: "Regular", priceDelta: 0 }, { nameAr: "كبير", nameEn: "Large", priceDelta: 1200 }],
  });
  assert.equal(size.status, 201, JSON.stringify(size.body));
  const extras = await applicant.post(R(`/menu/items/${kabsa.id}/modifier-groups`), { nameAr: "إضافات", nameEn: "Extras", minSelect: 0, maxSelect: 2 });
  assert.equal(extras.status, 201);
  const opt = await applicant.post(R(`/modifier-groups/${extras.body.group.id}/options`), { nameAr: "دقوس", nameEn: "Daqoos", priceDelta: 200 });
  assert.equal(opt.status, 201);
  assert.equal((await applicant.post(R(`/menu/items/${kabsa.id}/modifier-groups`), { nameAr: "x", nameEn: "x", minSelect: 2, maxSelect: 1 })).status, 400);

  const groups = (await applicant.get(R(`/menu/items/${kabsa.id}/modifier-groups`))).body.groups;
  assert.equal(groups.length, 2);
  ctx.sizeGroup = groups.find((g: any) => g.name_en === "Size");
  ctx.large = ctx.sizeGroup.options.find((o: any) => o.name_en === "Large");
  ctx.regular = ctx.sizeGroup.options.find((o: any) => o.name_en === "Regular");

  // Cannot make a required group unsatisfiable.
  assert.equal((await applicant.req("PATCH", R(`/modifier-groups/${ctx.sizeGroup.id}`), { minSelect: 3, maxSelect: 3 })).body.error.code, "not_enough_options");
  await applicant.req("PATCH", R(`/modifier-options/${ctx.regular.id}`), { isAvailable: false });
  const lastOne = await applicant.req("PATCH", R(`/modifier-options/${ctx.large.id}`), { isAvailable: false });
  assert.equal(lastOne.body.error.code, "not_enough_options");
  await applicant.req("PATCH", R(`/modifier-options/${ctx.regular.id}`), { isAvailable: true });

  // Another restaurant's owner cannot touch these modifiers.
  assert.equal((await otherOwner.req("PATCH", R(`/modifier-options/${ctx.large.id}`), { priceDelta: 1 })).status, 403);

  assert.equal((await applicant.post(R("/terms/accept"), { version: "wrong" })).status, 400);
  const ob = await applicant.get(R("/onboarding"));
  assert.equal((await applicant.post(R("/terms/accept"), { version: ob.body.termsVersion })).status, 200);
  const after = await applicant.get(R("/onboarding"));
  assert.equal(after.body.restaurantStepsDone, true);
  assert.equal(after.body.readyForActivation, false, "coverage is ABU9's step");
});

test("ops configures coverage and activates: 30-day trial starts at activation", async () => {
  const zone = (await s.db.query<{ id: string }>("select id from zones where code = 'RUH-OLAYA'")).rows[0]!;
  assert.equal((await ops.req("PUT", "/api/v1/admin/coverage-rules", { branchId: ctx.bid, zoneId: zone.id, enabled: true, maxRoadKm: 6, maxTravelMinutes: 22, reason: "onboarding coverage" })).status, 200);
  const review = await ops.get(`/api/v1/admin/restaurants/${ctx.rid}/onboarding`);
  assert.equal(review.body.readyForActivation, true);
  assert.equal((await applicant.post(`/api/v1/admin/restaurants/${ctx.rid}/activate`, { reason: "self" })).status, 403);
  const act = await ops.post(`/api/v1/admin/restaurants/${ctx.rid}/activate`, { reason: "checklist complete, training done" });
  assert.equal(act.status, 200, JSON.stringify(act.body));
  const sub = (await s.db.query<{ status: string; plan_code: string; trial_ends_at: Date }>("select status, plan_code, trial_ends_at from restaurant_subscriptions where restaurant_id = $1", [ctx.rid])).rows[0]!;
  assert.equal(sub.status, "trialing");
  assert.equal(sub.plan_code, "starter");
  const days = (sub.trial_ends_at.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `trial days ${days}`);
  assert.equal((await ops.post(`/api/v1/admin/restaurants/${ctx.rid}/activate`, { reason: "again" })).status, 409);
  const notes = (await applicant.get("/api/v1/me/notifications")).body.notifications;
  assert.ok(notes.some((n: any) => n.kind === "restaurant_activated"));
  const audits = (await s.db.query<{ action: string }>("select action from audit_logs where entity_id = $1 order by created_at", [ctx.rid])).rows.map((r) => r.action);
  for (const a of ["restaurant.application", "restaurant.terms_accepted", "restaurant.activate"]) assert.ok(audits.includes(a), a);
});

test("customers can now order, and modifier choices price correctly", async () => {
  const pub = await customer.get(`/api/v1/restaurants/${ctx.slug}`);
  assert.equal(pub.status, 200);
  const kabsa = ctx.items[0];
  const dropoff = { lat: 24.6985, lng: 46.6870 };
  const missing = await customer.post("/api/v1/checkout/quote", { restaurantId: ctx.rid, lines: [{ itemId: kabsa.id, qty: 1, optionIds: [] }], dropoff });
  assert.equal(missing.body.error.code, "modifier_selection");
  const q = await customer.post("/api/v1/checkout/quote", { restaurantId: ctx.rid, lines: [{ itemId: kabsa.id, qty: 2, optionIds: [ctx.large.id] }], dropoff });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.quote.pricing.lines.find((l: any) => l.code === "food_subtotal").amount, 2 * (4500 + 1200));
  assert.equal(q.body.quote.coverage.eligible, true, JSON.stringify(q.body.quote.coverage));
});

test("ops can suspend an active restaurant (audited); it disappears from discovery", async () => {
  assert.equal((await ops.post(`/api/v1/admin/restaurants/${ctx.rid}/status`, { status: "suspended", reason: "food safety complaint under review" })).status, 200);
  assert.equal((await customer.get(`/api/v1/restaurants/${ctx.slug}`)).status, 404);
  assert.equal((await ops.post(`/api/v1/admin/restaurants/${ctx.rid}/status`, { status: "active", reason: "cleared" })).status, 200);
});
