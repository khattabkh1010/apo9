// Captures real screenshots of the running apps (requires a running API on BASE and a seeded DB).
// Usage: node scripts/screenshots.mjs [outDir]
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? (existsSync("/opt/node-tools/node_modules/playwright") ? "/opt/node-tools/node_modules/playwright" : "playwright"));

const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
const OUT = process.argv[2] ?? "docs/screenshots";
mkdirSync(OUT, { recursive: true });

// One cookie session per user, used by both the API setup calls and the browser (as the web apps do).
async function login(phone) {
  const r1 = await (await fetch(`${BASE}/api/v1/auth/otp/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) })).json();
  const res = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: r1.challengeId, code: r1.devCode, transport: "cookie" }) });
  const cookies = Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0].split("=")).map(([k, v]) => [k, decodeURIComponent(v)]));
  const sess = { session: cookies.abu9_session, csrf: cookies.abu9_csrf };
  // Staff: pass TOTP (dev echo) so staff permissions apply to this session.
  const call = api(sess);
  const m = await call("GET", "/auth/mfa");
  if (m.required && !m.verified) {
    if (m.enrolled) await call("POST", "/auth/mfa/verify", { code: m.devCode });
    else await call("POST", "/auth/mfa/totp/activate", { code: (await call("POST", "/auth/mfa/totp/enroll")).devCode });
  }
  return sess;
}
const api = (sess) => async (method, path, body, headers = {}) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "content-type": "application/json", cookie: `abu9_session=${encodeURIComponent(sess.session)}; abu9_csrf=${encodeURIComponent(sess.csrf)}`, "x-csrf-token": sess.csrf, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
};

const chrome = process.env.CHROME ?? "/opt/pw-browsers/chromium";
const browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome } : {});
async function shot(name, url, token, { mobile = false, wait = 900, before } = {}) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  if (token) {
    const url = new URL(BASE);
    await ctx.addCookies([
      { name: "abu9_session", value: token.session, domain: url.hostname, path: "/api", httpOnly: true, sameSite: "Lax" },
      { name: "abu9_csrf", value: token.csrf, domain: url.hostname, path: "/", sameSite: "Strict" },
    ]);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(wait);
  if (before) await before(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: !mobile });
  if (errors.length) console.log(`  ⚠ ${name}: ${errors.join(" | ")}`);
  console.log(`✓ ${name}`);
  await ctx.close();
}

const cust = await login("0500000001");
const owner = await login("0500000101");
const courier = await login("0500000201");
const ops = await login("0500000901");
const logi = await login("0500000301");
const creator = await login("0500000401");

// Set up a realistic state: one order in the kitchen, one on the way.
const C = api(cust), O = api(owner), K = api(courier);
const rest = await C("GET", "/restaurants/najd-burger-demo");
const items = rest.menu.flatMap((c) => c.items);
const smash = items.find((i) => i.name_en === "Classic Smash");
const fries = items.find((i) => i.name_en === "Duqqa Fries");
const addr = (await C("GET", "/me/addresses")).addresses.find((a) => a.is_default);
const lines = [{ itemId: smash.id, qty: 2, optionIds: [smash.modifierGroups[0].options[0].id] }, { itemId: fries.id, qty: 1, optionIds: [fries.modifierGroups[0].options[1].id] }];
const o1 = await C("POST", "/orders", { restaurantId: rest.restaurant.id, lines, addressId: addr.id, paymentToken: "tok_visa_test" }, { "idempotency-key": crypto.randomUUID() });
const o2 = await C("POST", "/orders", { restaurantId: rest.restaurant.id, lines: [{ itemId: smash.id, qty: 1, optionIds: [] }], addressId: addr.id, paymentToken: "tok_visa_test", notes: "بدون بصل لو سمحت" }, { "idempotency-key": crypto.randomUUID() });
await O("POST", `/restaurant/${rest.restaurant.id}/orders/${o1.orderId}/accept`, { prepMinutes: 12 });
await O("POST", `/restaurant/${rest.restaurant.id}/orders/${o1.orderId}/ready`);
const me = await K("GET", "/me");
let job = (await K("GET", "/courier/jobs")).jobs.find((j) => j.order_id === o1.orderId);
if (!job) {
  const admin = (await api(ops)("GET", "/admin/dispatch")).jobs.find((j) => true);
  await api(ops)("POST", `/admin/dispatch/jobs/${admin.id}/assign`, { courierId: me.courierId, reason: "screenshot setup" });
  job = (await K("GET", "/courier/jobs")).jobs[0];
}
await K("POST", `/courier/jobs/${job.id}/arrive-pickup`);
const pickupCode = (await O("GET", `/restaurant/${rest.restaurant.id}/orders?status=ready_for_pickup`)).orders.find((x) => x.id === o1.orderId)?.delivery?.pickupCode;
await K("POST", `/courier/jobs/${job.id}/pickup`, { code: pickupCode });
await K("POST", "/courier/location", { lat: 24.6948, lng: 46.6866 });

// Cart for the checkout screenshot
const cartState = { restaurantId: rest.restaurant.id, restaurantSlug: "najd-burger-demo", restaurantNameAr: rest.restaurant.name_ar, videoId: null, lines: [
  { key: "a", itemId: smash.id, nameAr: smash.name_ar, nameEn: smash.name_en, qty: 1, optionIds: [smash.modifierGroups[0].options[0].id], optionsLabel: "جبن إضافي", unitPrice: smash.price + 400 },
  { key: "b", itemId: fries.id, nameAr: fries.name_ar, nameEn: fries.name_en, qty: 1, optionIds: [fries.modifierGroups[0].options[0].id], optionsLabel: "عادي", unitPrice: fries.price },
] };

await shot("01-customer-feed", "/customer#/feed", cust, { mobile: true, wait: 1800 });
await shot("02-customer-restaurant", "/customer#/r/najd-burger-demo", cust, { mobile: true });
await shot("03-customer-item-sheet", "/customer#/r/najd-burger-demo", cust, { mobile: true, before: async (p) => { await p.locator(".item").first().click(); await p.waitForTimeout(500); } });
await shot("04-customer-checkout", "/customer#/cart", cust, { mobile: true, wait: 1500, before: async (p) => { await p.evaluate((c) => { localStorage.setItem("abu9.cart", JSON.stringify(c)); }, cartState); await p.reload(); await p.waitForTimeout(1500); await p.evaluate(() => window.scrollTo(0, 99999)); await p.waitForTimeout(300); } });
await shot("05-customer-tracking", `/customer#/o/${o1.orderId}`, cust, { mobile: true, wait: 1200 });
await shot("06-customer-plus", "/customer#/plus", cust, { mobile: true });
await shot("07-customer-login", "/customer#/account", null, { mobile: true });
await shot("08-courier-job", "/courier#/jobs", courier, { mobile: true, wait: 1200 });
await shot("09-restaurant-orders", "/restaurant#/orders", owner, { wait: 1200 });
await shot("10-restaurant-billing", "/restaurant#/billing", owner);
await shot("11-admin-overview", "/admin#/overview", ops, { wait: 1200 });
await shot("12-admin-order-detail", `/admin#/orders/${o1.orderId}`, ops, { wait: 1200 });
await shot("13-admin-dispatch", "/admin#/dispatch", ops, { wait: 1200 });
await shot("14-admin-finance", "/admin#/finance", ops, { wait: 1200 });
await shot("15-logistics-overview", "/logistics#/overview", logi, { wait: 1200 });
await shot("16-creator-overview", "/creator#/overview", creator, { wait: 1200 });
await browser.close();
void o2;
