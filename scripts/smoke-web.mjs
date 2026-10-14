// Browser smoke test of all six web apps against a running, seeded API (dev mode: OTP/TOTP echo on).
// Logs in through the real UI (cookie sessions), passes the staff MFA screen, opens main screens,
// exercises an in-app dialog, and fails on page errors or CSP violations.
// Usage: node scripts/smoke-web.mjs   (BASE=http://127.0.0.1:8080, PLAYWRIGHT_PATH, CHROME overridable)
// The run logs in ~15 times: start the API with RATE_LIMIT=0 OTP_MAX_PER_HOUR=1000 for repeated local runs.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? (existsSync("/opt/node-tools/node_modules/playwright") ? "/opt/node-tools/node_modules/playwright" : "playwright"));

const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
const chrome = process.env.CHROME ?? "/opt/pw-browsers/chromium";
const browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome } : {});
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
      // Each TOTP step can be used once; with several staff logins in one run, wait for the next 30 s window.
      for (let attempt = 0; ; attempt++) {
        try {
          await page.waitForFunction(() => document.querySelector("#totp")?.value?.length === 6, null, { timeout: 4000 });
          break;
        } catch (e) {
          if (attempt >= 2) throw e;
          await page.waitForTimeout(31_000);
          await page.reload();
          await page.waitForSelector("text=المصادقة الثنائية");
        }
      }
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

// Full restaurant onboarding journey through the UI: apply → menu, modifiers, hours, terms → ops activates.
const phone = `0559${String(Date.now()).slice(-6)}`;
const dialog = async (p, value) => {
  await p.waitForSelector("[role=dialog] form");
  if (value !== undefined) {
    const input = p.locator("[role=dialog] form input:not([type=radio]), [role=dialog] form textarea").first();
    if (await input.count()) await input.fill(value);
  }
  await p.locator("[role=dialog] form button:not([type=button])").first().click();
  await p.waitForTimeout(150);
};
await check("restaurant onboarding via UI", {
  path: "/restaurant", phone, expect: "text=انضم إلى أبو9",
  extra: async (p) => {
    await p.fill("#ap-nameAr", "مطبخ الاختبار (وهمي)");
    await p.fill("#ap-nameEn", "UI Test Kitchen");
    await p.fill("#ap-cuisine", "سعودي، مندي");
    await p.fill("#ap-crNumber", "1010777666");
    await p.fill("#ap-branchAr", "فرع العليا");
    await p.click("button:has-text('إرسال طلب الانضمام')");
    await p.waitForSelector("text=تهيئة المطعم");
    await p.goto(`${BASE}/restaurant#/menu`);
    await p.click("button:has-text('+ قسم')");
    await dialog(p, "الأطباق الرئيسية");
    await dialog(p, "Mains");
    await p.waitForSelector("h3:has-text('الأطباق الرئيسية')");
    for (const [ar, en, price] of [["كبسة", "Kabsa", "45"], ["مندي", "Mandi", "38"], ["سلطة", "Salad", "15"]]) {
      await p.click("button:has-text('+ صنف')");
      await p.fill("#ni-a", ar); await p.fill("#ni-e", en); await p.fill("#ni-p", price);
      await p.click("[role=dialog] button:has-text('إضافة')");
      await p.waitForSelector(`td:has-text('${ar}')`);
    }
    await p.locator("button:has-text('الخيارات')").first().click();
    await p.click("button:has-text('+ مجموعة')");
    await dialog(p); // variant (first choice)
    await dialog(p, "الحجم");
    await p.waitForSelector("text=إلزامي");
    await p.keyboard.press("Escape");
    await p.click("button:has-text('أوقات العمل')");
    await p.locator("[role=dialog] button:has-text('+ فترة')").first().click();
    await p.click("button:has-text('نسخ أوقات الأحد لكل الأيام')");
    await p.click("[role=dialog] button:has-text('حفظ')");
    await p.waitForSelector("[role=dialog]", { state: "detached" });
    await p.goto(`${BASE}/restaurant#/onboarding`);
    await p.click("button:has-text('مراجعة والموافقة')");
    await dialog(p);
    await p.waitForSelector("text=أكملت خطواتك");
  },
});
await check("ops activates the new restaurant via UI", {
  path: "/admin#/partners", phone: "0500000901", staff: true, expect: "button:has-text('مراجعة')",
  extra: async (p) => {
    await p.click("button:has-text('مراجعة')");
    await p.click("button:has-text('+ تغطية')");
    await dialog(p); // first zone
    await dialog(p, "6");
    await dialog(p, "22");
    await dialog(p, "تغطية فرع جديد");
    await p.waitForSelector("button:has-text('تفعيل المطعم'):not([disabled])");
    await p.click("button:has-text('تفعيل المطعم')");
    await dialog(p, "اكتملت المراجعة والتدريب");
    await p.waitForSelector("text=تم التفعيل");
  },
});

const campaignName = `حملة اختبار ${String(Date.now()).slice(-5)}`;
await check("restaurant proposes a creator campaign via UI", {
  path: "/restaurant#/promotions", phone: "0500000102", expect: "text=حملة مع صنّاع المحتوى",
  extra: async (p) => {
    await p.fill("#cc-n", campaignName);
    await p.click("button:has-text('إرسال للموافقة')");
    await p.waitForSelector(`td:has-text('${campaignName}')`);
  },
});
await check("ops approves the campaign via UI", {
  path: "/admin#/content", phone: "0500000901", staff: true, expect: "text=حملات الصنّاع",
  extra: async (p) => {
    await p.locator(`tr:has-text('${campaignName}') button:has-text('اعتماد')`).click();
    await p.waitForSelector("text=اعتُمدت");
  },
});

// Group order across two browsers: host starts, guest joins by link, host locks and pays.
{
  const problems = [];
  const mk = async () => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await c.newPage();
    p.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    return [c, p];
  };
  const loginCustomer = async (p, phone) => {
    await p.fill("#phone", phone);
    await p.click("button:has-text('أرسل الرمز')");
    await p.waitForFunction(() => document.querySelector("#code")?.value?.length === 6);
    await p.click("button:has-text('دخول')");
  };
  const addFirstItem = async (p, name) => {
    await p.locator(`.item:has-text('${name}')`).first().click();
    await p.locator("[role=dialog] button.btn.primary").click();
    await p.waitForSelector("text=أُضيف للطلب الجماعي");
  };
  const [hc, host] = await mk();
  const [gc, guest] = await mk();
  try {
    await host.goto(`${BASE}/customer#/account`);
    await loginCustomer(host, "0500000001");
    await host.waitForSelector("text=تسجيل الخروج");
    // address via the account screen
    await host.click("button:has-text('+ إضافة')");
    await host.fill("#ad-s", "شارع التحلية");
    await host.click("[role=dialog] button:has-text('حفظ العنوان')");
    await host.waitForSelector("text=شارع التحلية");
    await host.goto(`${BASE}/customer#/r/najd-burger-demo`);
    await host.click("button:has-text('طلب جماعي مع الأصدقاء')");
    await host.waitForURL(/#\/g\//);
    const code = host.url().split("#/g/")[1];
    await host.click("button:has-text('أضف المزيد من المنيو')");
    await addFirstItem(host, "سماش");
    await guest.goto(`${BASE}/customer#/g/${code}`);
    await loginCustomer(guest, "0500000002");
    await guest.click("button:has-text('انضم وأضف طلبك')");
    await addFirstItem(guest, "بطاطس");
    await host.goto(`${BASE}/customer#/g/${code}`);
    await host.waitForSelector("text=فهد", { timeout: 8000 }).catch(() => host.waitForSelector("text=بطاطس"));
    await host.click("button:has-text('إقفال والدفع')");
    await host.locator("[role=dialog] form button:not([type=button])").click();
    await host.waitForSelector("text=طلب جماعي");
    await host.waitForSelector("button:has-text('تأكيد الطلب'):not([disabled])", { timeout: 10000 });
    await host.click("button:has-text('تأكيد الطلب')");
    await host.waitForURL(/#\/o\//, { timeout: 10000 });
  } catch (e) {
    problems.push(`flow: ${e.message.split("\n")[0]}`);
  }
  if (problems.length) { failed++; console.log(`✖ group order across two customers\n   ${problems.join("\n   ")}`); } else console.log("✔ group order across two customers (+ new address)");
  await hc.close();
  await gc.close();
}

await browser.close();
if (failed) {
  console.log(`${failed} smoke check(s) failed`);
  process.exit(1);
}
console.log("all web smoke checks passed");
