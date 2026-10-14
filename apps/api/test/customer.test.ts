/**
 * Customer features against a real database: group ordering (two customers, host pays),
 * saved addresses, favourites, notifications.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestServer, Client, DEMO_PHONES, type TestServer } from "./helpers.ts";

let s: TestServer;
let host: Client, guest: Client, stranger: Client;
const ctx: Record<string, any> = {};

before(async () => {
  s = await startTestServer();
  host = await new Client(s.base).login(DEMO_PHONES.customer);
  guest = await new Client(s.base).login(DEMO_PHONES.customer2);
  stranger = await new Client(s.base).login("0557654321");
});
after(() => s.close());

test("addresses: create (default switches), list, delete only own", async () => {
  const a1 = await host.post("/api/v1/me/addresses", { label: "العمل", lat: 24.6935, lng: 46.6855, district: "العليا", isDefault: true });
  assert.equal(a1.status, 201);
  const a2 = await host.post("/api/v1/me/addresses", { label: "البيت", lat: 24.6985, lng: 46.687, district: "العليا", isDefault: true });
  const list = (await host.get("/api/v1/me/addresses")).body.addresses;
  assert.equal(list.filter((a: any) => a.is_default).length, 1);
  assert.equal(list[0].id, a2.body.address.id, "new default first");
  assert.equal((await host.post("/api/v1/me/addresses", { label: "x", lat: 51.5, lng: -0.1 })).status, 400, "outside KSA bounds");
  assert.equal((await stranger.req("DELETE", `/api/v1/me/addresses/${a1.body.address.id}`)).status, 404);
  assert.equal((await host.req("DELETE", `/api/v1/me/addresses/${a1.body.address.id}`)).status, 204);
  ctx.addressId = a2.body.address.id;
});

test("favourites: toggle and list", async () => {
  const r = (await host.get("/api/v1/restaurants/najd-burger-demo")).body;
  ctx.rest = r;
  assert.equal((await host.req("PUT", `/api/v1/me/favorites/${r.restaurant.id}`)).status, 200);
  assert.equal((await host.req("PUT", `/api/v1/me/favorites/${r.restaurant.id}`)).status, 200, "idempotent");
  assert.equal((await host.get("/api/v1/restaurants/najd-burger-demo")).body.favorite, true);
  assert.deepEqual((await host.get("/api/v1/me/favorites")).body.favorites.map((f: any) => f.slug), ["najd-burger-demo"]);
  await host.req("DELETE", `/api/v1/me/favorites/${r.restaurant.id}`);
  assert.equal((await host.get("/api/v1/me/favorites")).body.favorites.length, 0);
});

test("group order: guest and host add items, host locks and pays, items attributed per person", async () => {
  const branchId = ctx.rest.branches.find((b: any) => b.name_en === "Olaya").id;
  const g = await host.post("/api/v1/group-carts", { branchId });
  assert.equal(g.status, 201);
  const code = g.body.groupCart.code;
  const items = ctx.rest.menu.flatMap((c: any) => c.items);
  const smash = items.find((i: any) => i.name_en === "Classic Smash");
  const fries = items.find((i: any) => i.name_en === "Duqqa Fries");
  const friesSize = fries.modifierGroups.find((m: any) => m.min_select > 0);
  const extra = smash.modifierGroups.find((m: any) => m.min_select === 0)?.options[0];

  assert.equal((await guest.post(`/api/v1/group-carts/${code}/items`, { itemId: fries.id, qty: 1, optionIds: [friesSize.options[0].id] })).status, 201);
  assert.equal((await host.post(`/api/v1/group-carts/${code}/items`, { itemId: smash.id, qty: 2, optionIds: extra ? [extra.id] : [] })).status, 201);
  const kunafa = (await host.get("/api/v1/restaurants/liwan-sweets-demo")).body.menu[0].items[0];
  assert.equal((await guest.post(`/api/v1/group-carts/${code}/items`, { itemId: kunafa.id, qty: 1 })).body.error.code, "item_not_in_restaurant");

  const view = await guest.get(`/api/v1/group-carts/${code}`);
  assert.equal(view.body.isHost, false);
  assert.equal(view.body.items.length, 2);
  const guestRow = view.body.items.find((i: any) => i.item_id === fries.id);
  assert.equal(guestRow.options[0].id, friesSize.options[0].id, "options are returned with names/prices");
  // Only the item's owner or the host can remove it.
  const hostRow = view.body.items.find((i: any) => i.item_id === smash.id);
  assert.equal((await guest.req("DELETE", `/api/v1/group-carts/${code}/items/${hostRow.id}`)).status, 404);

  assert.equal((await guest.post(`/api/v1/group-carts/${code}/lock`)).status, 404, "only the host locks");
  assert.equal((await host.post(`/api/v1/group-carts/${code}/lock`)).status, 200);
  assert.equal((await guest.post(`/api/v1/group-carts/${code}/items`, { itemId: fries.id, qty: 1, optionIds: [friesSize.options[0].id] })).body.error.code, "group_cart_closed");

  // Guest cannot check out the host's group.
  const lines = view.body.items.map((i: any) => ({ itemId: i.item_id, qty: i.qty, optionIds: i.option_ids }));
  const base = { restaurantId: ctx.rest.restaurant.id, lines, addressId: ctx.addressId, paymentToken: "tok_visa_test", groupCartId: g.body.groupCart.id };
  assert.equal((await guest.post("/api/v1/orders", { ...base, addressId: undefined, dropoff: { lat: 24.6985, lng: 46.687 } }, { "idempotency-key": randomUUID() })).status, 404);

  // Client-sent lines are ignored for group orders: the server uses the group's items.
  const placed = await host.post("/api/v1/orders", { ...base, lines: [{ itemId: fries.id, qty: 9, optionIds: [friesSize.options[0].id] }] }, { "idempotency-key": randomUUID() });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const rows = (await s.db.query<{ added_by: string; qty: number }>("select added_by, qty from order_items where order_id = $1 order by qty", [placed.body.orderId])).rows;
  const ids = (await s.db.query<{ id: string; phone: string }>("select id, phone from users where phone = any($1)", [["+966500000001", "+966500000002"]])).rows;
  const hostId = ids.find((u) => u.phone === "+966500000001")!.id;
  const guestId = ids.find((u) => u.phone === "+966500000002")!.id;
  assert.deepEqual(rows.map((r) => [r.qty, r.added_by === hostId ? "host" : r.added_by === guestId ? "guest" : "?"]), [[1, "guest"], [2, "host"]]);
  assert.equal((await host.get(`/api/v1/group-carts/${code}`)).body.groupCart.status, "ordered");
  ctx.orderId = placed.body.orderId;
});

test("notifications: order events notify the customer; marking read", async () => {
  const owner = await new Client(s.base).login(DEMO_PHONES.restaurantOwner);
  assert.equal((await owner.post(`/api/v1/restaurant/${ctx.rest.restaurant.id}/orders/${ctx.orderId}/accept`, { prepMinutes: 12 })).status, 200);
  const n = (await host.get("/api/v1/me/notifications")).body.notifications;
  assert.ok(n.some((x: any) => x.kind === "order_status" && x.data.orderId === ctx.orderId && !x.read_at));
  await host.post("/api/v1/me/notifications/read");
  assert.ok((await host.get("/api/v1/me/notifications")).body.notifications.every((x: any) => x.read_at));
});

test("dev courier simulator: keeps demo couriers alive and moves them toward their job", async () => {
  const { COURIER_SIMULATOR } = await import("../src/jobs.ts");
  await s.db.query("update couriers set last_seen_at = now() - interval '30 minutes'");
  const busy = (await s.db.query<{ id: string; last_lat: number; last_lng: number }>(
    "select c.id, c.last_lat, c.last_lng from couriers c join delivery_jobs j on j.courier_id = c.id where j.status in ('assigned','at_pickup','picked_up','at_dropoff') limit 1",
  )).rows[0];
  await COURIER_SIMULATOR.run(s.app);
  const stale = (await s.db.query<{ n: number }>("select count(*)::int n from couriers c join logistics_companies lc on lc.id = c.company_id where lc.is_demo and c.status = 'online' and c.last_seen_at < now() - interval '1 minute'")).rows[0]!.n;
  assert.equal(stale, 0);
  if (busy) {
    const after = (await s.db.query<{ last_lat: number; last_lng: number }>("select last_lat, last_lng from couriers where id = $1", [busy.id])).rows[0]!;
    assert.ok(after.last_lat !== busy.last_lat || after.last_lng !== busy.last_lng, "busy courier moved");
  }
});
