/**
 * Creator campaigns against a real database: restaurant proposal → four-eyes approval → creator
 * opt-in → ops approves creator → attributed delivered order accrues an incentive within budget.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestServer, Client, DEMO_PHONES, type TestServer } from "./helpers.ts";

let s: TestServer;
let owner: Client, ops: Client, ops2: Client, finance: Client, creator: Client, customer: Client, courier: Client;
const ctx: Record<string, any> = {};

before(async () => {
  s = await startTestServer();
  // A second ops manager (fictional) so four-eyes approval can be exercised.
  await s.db.query("insert into users(phone, name) values ('+966500000903', 'مدير عمليات ٢ (تجريبي)')");
  await s.db.query("insert into user_roles(user_id, role) select id, 'ops_manager' from users where phone = '+966500000903'");
  owner = await new Client(s.base).login(DEMO_PHONES.restaurantOwner);
  ops = await new Client(s.base).login(DEMO_PHONES.opsAdmin);
  ops2 = await new Client(s.base).login("0500000903");
  finance = await new Client(s.base).login(DEMO_PHONES.finance);
  creator = await new Client(s.base).login(DEMO_PHONES.creator);
  customer = await new Client(s.base).login(DEMO_PHONES.customer2);
  courier = await new Client(s.base).login(DEMO_PHONES.courier1);
  ctx.rid = (await s.db.query<{ id: string }>("select id from restaurants where slug = 'najd-burger-demo'")).rows[0]!.id;
});
after(() => s.close());

test("restaurant proposes a bounded campaign; invalid incentives are rejected", async () => {
  const base = { name: "صنّاع نجد", incentiveType: "fixed_per_order", incentiveValue: 500, budget: 1000 };
  assert.equal((await owner.post(`/api/v1/restaurant/${ctx.rid}/creator-campaigns`, { ...base, incentiveValue: 9000 })).body.error.code, "invalid_campaign");
  assert.equal((await owner.post(`/api/v1/restaurant/${ctx.rid}/creator-campaigns`, { ...base, budget: 0 })).body.error.code, "invalid_campaign");
  const r = await owner.post(`/api/v1/restaurant/${ctx.rid}/creator-campaigns`, base);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.campaign.status, "pending_approval");
  assert.equal(r.body.campaign.funded_by, "restaurant");
  ctx.cid = r.body.campaign.id;
  // Not visible to creators until approved.
  assert.ok(!(await creator.get("/api/v1/creator/me")).body.campaigns.some((c: any) => c.id === ctx.cid));
});

test("four-eyes: the proposer cannot approve; finance lacks the permission; another manager can", async () => {
  const abu9 = await ops.post("/api/v1/admin/creator-campaigns", { name: "حملة أبو9 للإطلاق", incentiveType: "percent_of_food", incentiveValue: 500, budget: 200_000, fundedBy: "abu9" });
  assert.equal(abu9.status, 201);
  assert.equal((await ops.post("/api/v1/admin/creator-campaigns", { name: "حملة مطعم", incentiveType: "none", incentiveValue: 0, budget: 0, fundedBy: "restaurant", restaurantId: ctx.rid })).status, 403, "ops cannot spend a restaurant's money");
  const self = await ops.post(`/api/v1/admin/creator-campaigns/${abu9.body.campaign.id}/approve`, {});
  assert.equal(self.status, 403);
  assert.equal(self.body.error.code, "four_eyes_required");
  assert.equal((await finance.post(`/api/v1/admin/creator-campaigns/${abu9.body.campaign.id}/approve`, {})).status, 403);
  assert.equal((await ops2.post(`/api/v1/admin/creator-campaigns/${abu9.body.campaign.id}/approve`, { reason: "launch budget approved" })).status, 200);
  // Pause the ABU9 one so the restaurant campaign is the one that pays in the next test.
  assert.equal((await ops.post(`/api/v1/admin/creator-campaigns/${abu9.body.campaign.id}/status`, { status: "paused", reason: "test isolation" })).status, 200);
  // The restaurant's proposal was made by the owner, so ops may approve it.
  assert.equal((await ops.post(`/api/v1/admin/creator-campaigns/${ctx.cid}/approve`, {})).status, 200);
  const audits = (await s.db.query<{ action: string }>("select action from audit_logs where entity_id = $1", [ctx.cid])).rows.map((r) => r.action);
  assert.deepEqual(audits.sort(), ["creator_campaign.approve", "creator_campaign.propose"]);
});

test("creator opts in; incentive accrues only after ops approves the creator; budget caps spend", async () => {
  assert.equal((await creator.post(`/api/v1/creator/campaigns/${ctx.cid}/opt-in`)).status, 200);
  const list = (await ops.get("/api/v1/admin/creator-campaigns")).body;
  const pending = list.pendingEnrollments.find((e: any) => e.campaign_id === ctx.cid);
  assert.ok(pending);
  assert.equal((await ops.post(`/api/v1/admin/creator-enrollments/${ctx.cid}/${pending.creator_id}/approve`)).status, 200);

  const menu = (await customer.get("/api/v1/restaurants/najd-burger-demo")).body;
  const smash = menu.menu.flatMap((c: any) => c.items).find((i: any) => i.name_en === "Classic Smash");
  const deliverOne = async () => {
    const placed = await customer.post("/api/v1/orders", { restaurantId: ctx.rid, lines: [{ itemId: smash.id, qty: 1, optionIds: [] }], dropoff: { lat: 24.6985, lng: 46.687 }, paymentToken: "tok_visa_test", referralCode: "NOURA10" }, { "idempotency-key": randomUUID() });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const oid = placed.body.orderId;
    assert.equal((await owner.post(`/api/v1/restaurant/${ctx.rid}/orders/${oid}/accept`, { prepMinutes: 10 })).status, 200);
    const job = (await s.db.query<{ id: string; courier_id: string | null; pickup_code: string; dropoff_code: string }>("select id, courier_id, pickup_code, dropoff_code from delivery_jobs where order_id = $1", [oid])).rows[0]!;
    const me = (await courier.get("/api/v1/me")).body;
    if (job.courier_id !== me.courierId) assert.equal((await ops.post(`/api/v1/admin/dispatch/jobs/${job.id}/assign`, { courierId: me.courierId, reason: "test: route to demo courier" })).status, 200);
    await owner.post(`/api/v1/restaurant/${ctx.rid}/orders/${oid}/ready`);
    await courier.post(`/api/v1/courier/jobs/${job.id}/arrive-pickup`);
    assert.equal((await courier.post(`/api/v1/courier/jobs/${job.id}/pickup`, { code: job.pickup_code })).status, 200);
    assert.equal((await courier.post(`/api/v1/courier/jobs/${job.id}/deliver`, { code: job.dropoff_code })).status, 200);
    return oid;
  };
  const o1 = await deliverOne();
  const o2 = await deliverOne();
  const o3 = await deliverOne();
  const inc = (await s.db.query<{ order_id: string; amount: number; status: string }>("select order_id, amount, status from creator_incentives where campaign_id = $1", [ctx.cid])).rows;
  assert.deepEqual(inc.map((i) => i.order_id).sort(), [o1, o2].sort(), "third order exceeds the SAR 10 budget");
  assert.ok(inc.every((i) => i.amount === 500 && i.status === "pending"));
  assert.ok(!inc.some((i) => i.order_id === o3));
  const camp = (await s.db.query<{ spent: number; budget: number }>("select spent, budget from creator_campaigns where id = $1", [ctx.cid])).rows[0]!;
  assert.equal(camp.spent, camp.budget);
});

test("restaurant can pause or end its own campaign but not restart it", async () => {
  assert.equal((await owner.post(`/api/v1/restaurant/${ctx.rid}/creator-campaigns/${ctx.cid}/status`, { status: "paused" })).status, 200);
  assert.equal((await owner.post(`/api/v1/restaurant/${ctx.rid}/creator-campaigns/${ctx.cid}/status`, { status: "active" })).status, 400);
  const mine = (await owner.get(`/api/v1/restaurant/${ctx.rid}/creator-campaigns`)).body.campaigns;
  assert.equal(mine.find((c: any) => c.id === ctx.cid).creators_approved, 1);
});
