// Browser smoke test of all six web apps against a running, seeded API (dev mode: OTP/TOTP echo on).
// Logs in through the real UI (cookie sessions), passes the staff MFA screen, opens main screens,
// exercises an in-app dialog, and fails on page errors or CSP violations.
// Usage: node scripts/smoke-web.mjs   (BASE=http://127.0.0.1:8080, PLAYWRIGHT_PATH, CHROME overridable)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "/opt/node-tools/node_modules/playwright");

const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium" });
let failed = 0;

async function check(name, { path, phone, mobile = false, staff = false, expect, extra }) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) problems.push(`csp: ${m.text()}`);
  });
  page.on("requestfailed", (r) => {
    if (!r.url().startsWith(BASE)) problems.push(`third-party request: ${r.url()}`);
  });
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    if (phone) {
      await page.fill("#phone", phone);
      await page.click("button:has-text('أرسل الرمز')");
      await page.waitForSelector("#code");
      await page.waitForFunction(() => document.querySelector("#code")?.value?.length === 6);
      await page.click("button:has-text('دخول')");
    }
    if (staff) {
      await page.waitForSelector("text=المصادقة الثنائية");
      if (await page.isVisible("button:has-text('إعداد تطبيق المصادقة')")) await page.click("button:has-text('إعداد تطبيق المصادقة')");
      await page.waitForFunction(() => document.querySelector("#totp")?.value?.length === 6);
      await page.click("button:has-text('تحقق')");
    }
    await page.waitForSelector(expect, { timeout: 8000 });
    if (extra) await extra(page);
    const cookies = await ctx.cookies();
    const sess = cookies.find((c) => c.name === "abu9_session");
    if (phone && (!sess || !sess.httpOnly)) problems.push("session cookie missing or not httpOnly");
    const leaked = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes("token")));
    if (leaked.length) problems.push(`token in localStorage: ${leaked}`);
  } catch (e) {
    problems.push(`flow: ${e.message.split("\n")[0]}`);
  }
  if (problems.length) {
    failed++;
    console.log(`✖ ${name}\n   ${problems.join("\n   ")}`);
  } else console.log(`✔ ${name}`);
  await ctx.close();
}

await check("customer feed (anonymous)", { path: "/customer", mobile: true, expect: ".tabbar" });
await check("customer login + orders", {
  path: "/customer#/account", phone: "0500000001", mobile: true, expect: "text=تسجيل الخروج",
  extra: async (p) => { await p.goto(`${BASE}/customer#/orders`); await p.waitForTimeout(600); },
});
await check("courier login", { path: "/courier", phone: "0500000201", mobile: true, expect: "text=إبلاغ عن مشكلة" });
await check("restaurant login", { path: "/restaurant", phone: "0500000101", expect: ".dash" });
await check("logistics login", { path: "/logistics", phone: "0500000301", expect: ".dash" });
await check("creator login", { path: "/creator", phone: "0500000401", expect: ".dash" });
await check("admin login + MFA + dialog", {
  path: "/admin#/config", phone: "0500000901", staff: true, expect: ".dash",
  extra: async (p) => {
    await p.waitForSelector("button:has-text('تعديل')");
    await p.click("button:has-text('تعديل')");
    await p.waitForSelector("[role=dialog]");
    await p.keyboard.press("Escape");
    await p.waitForSelector("[role=dialog]", { state: "detached" });
  },
});

await browser.close();
if (failed) {
  console.log(`${failed} smoke check(s) failed`);
  process.exit(1);
}
console.log("all web smoke checks passed");
