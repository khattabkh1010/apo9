/**
 * Seed data — ALL RESTAURANTS, PEOPLE, COMPANIES AND CONTENT HERE ARE FICTIONAL DEMO DATA.
 * Zones use real Riyadh district names with approximate polygons for realism only.
 * Rows are flagged `is_demo = true` where the table supports it.
 *
 *   node packages/db/src/seed.ts            (expects migrated, empty DB)
 *   npm run db:reset                         (reset + migrate + seed)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type Db, type Queryable } from "./pg.ts";
import { generateClip, ffmpegAvailable } from "./demo-media.ts";

const MEDIA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/api/storage/media");

export const DEMO_PHONES = {
  customer: "+966500000001",
  customer2: "+966500000002",
  restaurantOwner: "+966500000101", // Najd Burger
  restaurantOwner2: "+966500000102", // Al Deera Grills
  courier1: "+966500000201",
  logisticsAdmin: "+966500000301",
  creator: "+966500000401",
  opsAdmin: "+966500000901",
  finance: "+966500000902",
} as const;

type Box = [number, number, number, number]; // latMin, latMax, lngMin, lngMax
const box = ([a, b, c, d]: Box) => [
  { lat: a, lng: c },
  { lat: a, lng: d },
  { lat: b, lng: d },
  { lat: b, lng: c },
];

const ZONES: Array<{ code: string; ar: string; en: string; box: Box; sla: number; status?: string }> = [
  { code: "RUH-OLAYA", ar: "العليا", en: "Olaya", box: [24.675, 24.725, 46.665, 46.705], sla: 40 },
  { code: "RUH-MALQA", ar: "الملقا", en: "Al Malqa", box: [24.79, 24.835, 46.59, 46.65], sla: 45 },
  { code: "RUH-HITTIN", ar: "حطين", en: "Hittin", box: [24.745, 24.79, 46.57, 46.63], sla: 45 },
  { code: "RUH-YASMIN", ar: "الياسمين", en: "Al Yasmin", box: [24.815, 24.855, 46.65, 46.69], sla: 45, status: "restricted" },
];

interface ItemSeed {
  ar: string;
  en: string;
  dAr: string;
  price: number; // SAR
  cal?: number;
  tags?: string[];
  mods?: Array<{ ar: string; en: string; min: number; max: number; opts: Array<[string, string, number]> }>;
}
interface RestaurantSeed {
  slug: string;
  ar: string;
  en: string;
  dAr: string;
  tags: string[];
  color: string;
  colorB: string;
  branches: Array<{ ar: string; en: string; lat: number; lng: number; district: string; prep: number; zones: Array<[string, number, number]> }>;
  menu: Array<{ ar: string; en: string; items: ItemSeed[] }>;
  clips: Array<{ key: string; label: string; captionAr: string; itemIdx: Array<[number, number]>; byCreator?: boolean }>;
}

const SIZE_MOD = { ar: "الحجم", en: "Size", min: 1, max: 1, opts: [["عادي", "Regular", 0], ["كبير", "Large", 6]] as Array<[string, string, number]> };

const RESTAURANTS: RestaurantSeed[] = [
  {
    slug: "najd-burger-demo", ar: "برجر نجد", en: "Najd Burger Co.", dAr: "سماش برجر على الطريقة النجدية، خبز بريوش يومي.",
    tags: ["burger", "american"], color: "0xE4572E", colorB: "0x1E120C",
    branches: [
      { ar: "فرع العليا", en: "Olaya", lat: 24.6962, lng: 46.6849, district: "العليا", prep: 12, zones: [["RUH-OLAYA", 6, 22]] },
      { ar: "فرع الملقا", en: "Al Malqa", lat: 24.8095, lng: 46.6185, district: "الملقا", prep: 14, zones: [["RUH-MALQA", 6, 22], ["RUH-HITTIN", 7, 24]] },
    ],
    menu: [
      { ar: "البرجر", en: "Burgers", items: [
        { ar: "سماش كلاسيك", en: "Classic Smash", dAr: "قطعتين لحم، جبن شيدر، صوص نجد", price: 32, cal: 780, tags: ["bestseller"], mods: [{ ar: "إضافات", en: "Extras", min: 0, max: 3, opts: [["جبن إضافي", "Extra cheese", 4], ["هالبينو", "Jalapeño", 3], ["لحم إضافي", "Extra patty", 9]] }] },
        { ar: "برجر الكمأة", en: "Truffle Burger", dAr: "مايونيز الكمأة، فطر مشوي", price: 42, cal: 860 },
        { ar: "دجاج مقرمش", en: "Crispy Chicken", dAr: "صدر دجاج متبل بالبهارات النجدية", price: 29, cal: 690 },
      ] },
      { ar: "الجانبيات", en: "Sides", items: [
        { ar: "بطاطس بالدقة", en: "Duqqa Fries", dAr: "بطاطس مقرمشة مع دقة سعودية", price: 14, cal: 420, mods: [SIZE_MOD] },
        { ar: "حلقات البصل", en: "Onion Rings", dAr: "", price: 13, cal: 390 },
      ] },
      { ar: "المشروبات", en: "Drinks", items: [
        { ar: "ليمون بالنعناع", en: "Mint Lemonade", dAr: "", price: 12 },
        { ar: "مياه", en: "Water", dAr: "", price: 3 },
      ] },
    ],
    clips: [
      { key: "najd-smash", label: "Classic Smash", captionAr: "السماش اللي الكل يسأل عنه 🔥", itemIdx: [[0, 0], [1, 0]] },
      { key: "najd-truffle", label: "Truffle Burger", captionAr: "برجر الكمأة… جرّبه وقول رأيك", itemIdx: [[0, 1]], byCreator: true },
    ],
  },
  {
    slug: "al-deera-grills-demo", ar: "مشاوي الديرة", en: "Al Deera Grills", dAr: "مشاوي على الفحم وأطباق شعبية.",
    tags: ["grills", "saudi"], color: "0xB5651D", colorB: "0x24160D",
    branches: [{ ar: "فرع العليا", en: "Olaya", lat: 24.7005, lng: 46.6772, district: "العليا", prep: 20, zones: [["RUH-OLAYA", 7, 25]] }],
    menu: [
      { ar: "المشاوي", en: "Grills", items: [
        { ar: "مشكل مشاوي", en: "Mixed Grill", dAr: "كباب، شيش طاووق، أوصال", price: 68, cal: 1200, tags: ["sharing"], mods: [{ ar: "الخبز", en: "Bread", min: 1, max: 1, opts: [["تنور", "Tannour", 0], ["صاج", "Saj", 0]] }] },
        { ar: "شيش طاووق", en: "Shish Tawook", dAr: "", price: 38, cal: 640 },
        { ar: "كباب لحم", en: "Lamb Kebab", dAr: "", price: 44, cal: 720 },
      ] },
      { ar: "المقبلات", en: "Starters", items: [
        { ar: "حمص", en: "Hummus", dAr: "", price: 15 },
        { ar: "متبل", en: "Mutabbal", dAr: "", price: 15 },
      ] },
    ],
    clips: [{ key: "deera-grill", label: "Mixed Grill", captionAr: "صحن المشاوي للعزايم", itemIdx: [[0, 0]] }],
  },
  {
    slug: "jaddah-kitchen-demo", ar: "مطبخ الجدّة", en: "Grandma's Kitchen", dAr: "كبسة ومندي وأكلات البيت كل يوم.",
    tags: ["saudi", "rice"], color: "0xD99A2B", colorB: "0x2A1B08",
    branches: [{ ar: "فرع حطين", en: "Hittin", lat: 24.7652, lng: 46.6021, district: "حطين", prep: 18, zones: [["RUH-HITTIN", 6, 22], ["RUH-MALQA", 8, 25]] }],
    menu: [
      { ar: "الأرز", en: "Rice", items: [
        { ar: "كبسة دجاج", en: "Chicken Kabsa", dAr: "نص دجاج مع رز بشاور وحشوة", price: 36, cal: 950, tags: ["bestseller"], mods: [SIZE_MOD] },
        { ar: "مندي لحم", en: "Lamb Mandi", dAr: "ربع لحم حاشي على رز مندي", price: 58, cal: 1150 },
        { ar: "مرقوق", en: "Margoog", dAr: "طبق يومي", price: 32 },
      ] },
      { ar: "حلا", en: "Dessert", items: [{ ar: "قرصان بالعسل", en: "Qursan with honey", dAr: "", price: 18 }] },
    ],
    clips: [{ key: "jaddah-kabsa", label: "Chicken Kabsa", captionAr: "كبسة الجمعة بس كل يوم 😄", itemIdx: [[0, 0]], byCreator: true }],
  },
  {
    slug: "sadu-pies-demo", ar: "فطائر السدو", en: "Sadu Pies", dAr: "فطائر ومعجنات طازجة وفطور سعودي.",
    tags: ["breakfast", "bakery"], color: "0xC23B22", colorB: "0x2B0F0A",
    branches: [{ ar: "فرع الياسمين", en: "Al Yasmin", lat: 24.8302, lng: 46.6655, district: "الياسمين", prep: 10, zones: [["RUH-YASMIN", 5, 20], ["RUH-MALQA", 6, 22]] }],
    menu: [
      { ar: "الفطائر", en: "Pies", items: [
        { ar: "فطيرة جبن وعسل", en: "Cheese & Honey Pie", dAr: "", price: 16, tags: ["bestseller"] },
        { ar: "فطيرة زعتر", en: "Zaatar Pie", dAr: "", price: 9 },
        { ar: "فطيرة لحم", en: "Meat Pie", dAr: "", price: 18 },
      ] },
      { ar: "فطور", en: "Breakfast", items: [
        { ar: "شكشوكة", en: "Shakshuka", dAr: "", price: 19 },
        { ar: "فول بالسمن", en: "Foul with ghee", dAr: "", price: 14 },
      ] },
    ],
    clips: [{ key: "sadu-pie", label: "Cheese & Honey", captionAr: "فطيرة الجبن والعسل وقت الفطور", itemIdx: [[0, 0], [1, 0]] }],
  },
  {
    slug: "hara-shawarma-demo", ar: "شاورما الحارة", en: "Al Hara Shawarma", dAr: "شاورما على الفحم، صوص ثوم بيتي.",
    tags: ["shawarma", "fast"], color: "0xF2A541", colorB: "0x2D1A05",
    branches: [{ ar: "فرع الملقا", en: "Al Malqa", lat: 24.8155, lng: 46.6302, district: "الملقا", prep: 8, zones: [["RUH-MALQA", 5, 18], ["RUH-YASMIN", 6, 20]] }],
    menu: [
      { ar: "الشاورما", en: "Shawarma", items: [
        { ar: "شاورما دجاج صاروخ", en: "Chicken Saroukh", dAr: "", price: 15, tags: ["bestseller"], mods: [{ ar: "إضافات", en: "Extras", min: 0, max: 2, opts: [["جبن", "Cheese", 3], ["حار", "Spicy", 0]] }] },
        { ar: "شاورما لحم عربي", en: "Beef Arabi", dAr: "", price: 26 },
        { ar: "وجبة شاورما عائلية", en: "Family Meal", dAr: "٤ صاروخ + بطاطس + مشروبات", price: 69, tags: ["sharing"] },
      ] },
    ],
    clips: [{ key: "hara-shawarma", label: "Saroukh", captionAr: "صاروخ الحارة 🚀", itemIdx: [[0, 0]], byCreator: true }],
  },
  {
    slug: "liwan-sweets-demo", ar: "حلويات الليوان", en: "Liwan Sweets", dAr: "كنافة ولقيمات وقهوة سعودية.",
    tags: ["dessert", "coffee"], color: "0x8E5572", colorB: "0x1C0F16",
    branches: [{ ar: "فرع حطين", en: "Hittin", lat: 24.7598, lng: 46.6104, district: "حطين", prep: 9, zones: [["RUH-HITTIN", 6, 20], ["RUH-OLAYA", 12, 30]] }],
    menu: [
      { ar: "الحلا", en: "Sweets", items: [
        { ar: "كنافة نابلسية", en: "Nabulsi Kunafa", dAr: "", price: 28, tags: ["bestseller"] },
        { ar: "لقيمات بالدبس", en: "Luqaimat with date syrup", dAr: "", price: 17 },
      ] },
      { ar: "القهوة", en: "Coffee", items: [
        { ar: "دلة قهوة سعودية", en: "Saudi Coffee Dallah", dAr: "مع تمر سكري", price: 35 },
        { ar: "سبانش لاتيه", en: "Spanish Latte", dAr: "", price: 18 },
      ] },
    ],
    clips: [{ key: "liwan-kunafa", label: "Kunafa", captionAr: "الكنافة وهي تتمدد… 🤤", itemIdx: [[0, 0]] }],
  },
];

async function seed(db: Db): Promise<void> {
  const existing = await db.query<{ n: number }>("select count(*)::int n from restaurants");
  if (existing.rows[0]!.n > 0) {
    console.log("database already seeded — run `npm run db:reset` to start fresh");
    return;
  }
  const canMakeMedia = ffmpegAvailable();
  if (!canMakeMedia) console.warn("ffmpeg not found — demo videos will be skipped (feed shows posters only)");
  else {
    // Render placeholder clips before opening the transaction (cached on disk after the first run).
    for (const r of RESTAURANTS) for (const c of r.clips) generateClip(MEDIA_DIR, { key: c.key, label: c.label, colorA: r.color, colorB: r.colorB });
  }

  await db.tx(async (q) => {
    const id = async (sql: string, params: unknown[]) => ((await q.query<{ id: string }>(sql + " returning id", params)).rows[0]!.id);

    // ── settings ──
    const settings: Record<string, unknown> = {
      batching: { enabled: true, maxOrdersPerCourier: 2, maxDetourKm: 2, maxAddedDelayMin: 7 },
      abu9_plus_rules: { minEligibleBasket: 3500, waiveServiceFee: false },
      abu9_plus_experiment: { key: "plus-2026q4", status: "running" },
      loyalty: { basePointsPerSar: 1, pointValueHalalas: 1, minRedeemPoints: 500, maxRedeemShareBps: 3000, expiryDays: 365, dailyEarnCap: 2000 },
      coverage: { maxDeliveryCost: 2200, costPerOrder: 1000, costPerKm: 150, restrictedLoadFactor: 1.2, restrictedMaxKm: 4 },
      restaurant_acceptance_timeout_s: 240,
    };
    for (const [k, v] of Object.entries(settings)) await q.query("insert into platform_settings(key, value) values ($1, $2)", [k, v]);

    // ── users ──
    const user = async (phone: string, name: string, roles: Array<[string, string?, string?]>) => {
      const uid = await id("insert into users(phone, name) values ($1, $2)", [phone, name]);
      for (const [role, scopeType, scopeId] of roles)
        await q.query("insert into user_roles(user_id, role, scope_type, scope_id) values ($1,$2,$3,coalesce($4::uuid,'00000000-0000-0000-0000-000000000000'))", [uid, role, scopeType ?? "global", scopeId ?? null]);
      return uid;
    };
    const ops = await user(DEMO_PHONES.opsAdmin, "مشرف العمليات (تجريبي)", [["admin"], ["ops_manager"]]);
    await user(DEMO_PHONES.finance, "المالية (تجريبي)", [["finance"]]);
    const sara = await user(DEMO_PHONES.customer, "سارة (تجريبي)", [["customer"]]);
    const fahad = await user(DEMO_PHONES.customer2, "فهد (تجريبي)", [["customer"]]);

    // ── zones & pricing ──
    const zoneIds: Record<string, string> = {};
    for (const z of ZONES)
      zoneIds[z.code] = await id("insert into zones(code, name_ar, name_en, status, polygon, sla_minutes) values ($1,$2,$3,$4,$5,$6)", [z.code, z.ar, z.en, z.status ?? "active", box(z.box), z.sla]);
    await q.query(
      `insert into delivery_pricing_configs(zone_id, basic_fee, base_distance_km, additional_fee_per_increment, additional_increment_km, additional_fee_cap, service_fee, vat_rate_bps, created_by)
       values (null, 900, 2, 100, 0.5, 1500, 0, 1500, $1)`,
      [ops],
    );

    // ── logistics (fictional) ──
    const sahm = await id("insert into logistics_companies(name_ar, name_en, cr_number, is_demo) values ($1,$2,$3,true)", ["سهم للتوصيل (تجريبي)", "Sahm Delivery (demo)", "DEMO-1010000001"]);
    const rawahel = await id("insert into logistics_companies(name_ar, name_en, cr_number, is_demo) values ($1,$2,$3,true)", ["رواحل للخدمات (تجريبي)", "Rawahel Services (demo)", "DEMO-1010000002"]);
    await q.query(
      `insert into logistics_contracts(company_id, per_order, per_batched_order, per_km_beyond, included_km, committed_hourly_minimum, auto_deduct_reason_codes, dispute_window_hours, effective_from)
       values ($1, 1300, 800, 120, 3, 3500, '{spilled_damaged}', 72, now() - interval '30 days'),
              ($2, 1450, 900, 130, 3, 0, '{}', 72, now() - interval '30 days')`,
      [sahm, rawahel],
    );
    const logiAdmin = await user(DEMO_PHONES.logisticsAdmin, "مدير سهم (تجريبي)", [["logistics_admin", "logistics_company", sahm]]);
    void logiAdmin;
    for (let wd = 0; wd < 7; wd++)
      for (const z of ["RUH-OLAYA", "RUH-MALQA"])
        await q.query("insert into zone_capacity_commitments(company_id, zone_id, weekday, start_hour, end_hour, committed_couriers) values ($1,$2,$3,12,24,4)", [sahm, zoneIds[z], wd]);

    const couriers: Array<[string, string, string, number, number, string]> = [
      [DEMO_PHONES.courier1, "عبدالله (تجريبي)", sahm, 24.698, 46.683, "committed"],
      ["+966500000202", "ماجد (تجريبي)", sahm, 24.705, 46.69, "committed"],
      ["+966500000203", "سلمان (تجريبي)", sahm, 24.808, 46.622, "committed"],
      ["+966500000204", "ناصر (تجريبي)", rawahel, 24.768, 46.605, "on_demand"],
      ["+966500000205", "يوسف (تجريبي)", rawahel, 24.826, 46.664, "on_demand"],
      ["+966500000206", "تركي (تجريبي)", sahm, 24.812, 46.61, "committed"],
    ];
    for (const [phone, name, company, lat, lng, cap] of couriers) {
      const uid = await user(phone, name, [["courier", "logistics_company", company]]);
      await q.query(
        "insert into couriers(user_id, company_id, display_name, vehicle_type, capacity_type, status, last_lat, last_lng, last_seen_at) values ($1,$2,$3,'car',$4,'online',$5,$6,now())",
        [uid, company, name, cap, lat, lng],
      );
    }

    // ── creator ──
    const creatorUser = await user(DEMO_PHONES.creator, "نورة — صانعة محتوى (تجريبي)", [["creator"], ["customer"]]);
    const creatorId = await id("insert into creators(user_id, handle, display_name, bio, status, approved_by) values ($1,$2,$3,$4,'approved',$5)", [creatorUser, "noura_eats_demo", "نورة تاكل (تجريبي)", "أجرّب مطاعم الرياض عنكم", ops]);
    await q.query("insert into referral_codes(code, creator_id) values ('NOURA10', $1)", [creatorId]);

    // ── restaurants ──
    const ownerPhones = [DEMO_PHONES.restaurantOwner, DEMO_PHONES.restaurantOwner2];
    let ri = 0;
    for (const r of RESTAURANTS) {
      const rid = await id(
        `insert into restaurants(slug, name_ar, name_en, description_ar, cuisine_tags, brand_color, status, activated_at, is_demo, rating_sum, rating_count, cr_number)
         values ($1,$2,$3,$4,$5,$6,'active', now() - ($7 || ' days')::interval, true, $8, $9, $10)`,
        // Fictional CR numbers (format only: 10 digits) — not real registrations.
        [r.slug, r.ar, r.en, r.dAr, r.tags, "#" + r.color.slice(2), String(10 + ri * 9), 46 * (20 + ri), 10 * (2 + ri) * 1, `00000000${String(ri + 10).padStart(2, "0")}`],
      );
      // fix rating: avg ≈ 4.6
      await q.query("update restaurants set rating_sum = rating_count * 46 / 10 where id = $1", [rid]);
      const ownerPhone = ownerPhones[ri] ?? `+9665000001${String(10 + ri).padStart(2, "0")}`;
      const owner = await user(ownerPhone, `مالك ${r.ar} (تجريبي)`, [["restaurant_owner", "restaurant", rid]]);
      await q.query("insert into restaurant_members(restaurant_id, user_id, role) values ($1,$2,'owner')", [rid, owner]);
      await q.query("insert into restaurant_contract_terms(restaurant_id, auto_deduct_reason_codes, dispute_window_hours, signed_at) values ($1, '{missing_item,wrong_item}', 72, now())", [rid]);
      const trialStart = new Date(Date.now() - (10 + ri * 9) * 86_400_000);
      const trialEnd = new Date(trialStart.getTime() + 30 * 86_400_000);
      await q.query(
        "insert into restaurant_subscriptions(restaurant_id, plan_code, status, trial_ends_at, current_period_start, current_period_end) values ($1,'starter',$2,$3,$4,$5)",
        [rid, trialEnd > new Date() ? "trialing" : "active", trialEnd, trialStart, trialEnd],
      );

      const branchIds: string[] = [];
      for (const b of r.branches) {
        const bid = await id(
          `insert into branches(restaurant_id, name_ar, name_en, lat, lng, district, prep_minutes_default, opening_hours) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [rid, b.ar, b.en, b.lat, b.lng, b.district, b.prep, Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [["00:00", "24:00"]]]))],
        );
        branchIds.push(bid);
        for (const [zc, km, mins] of b.zones)
          await q.query("insert into branch_zone_rules(branch_id, zone_id, max_road_km, max_travel_minutes) values ($1,$2,$3,$4)", [bid, zoneIds[zc], km, mins]);
      }

      const itemIds: string[][] = [];
      let cs = 0;
      for (const c of r.menu) {
        const cid = await id("insert into menu_categories(restaurant_id, name_ar, name_en, sort) values ($1,$2,$3,$4)", [rid, c.ar, c.en, cs++]);
        const ids: string[] = [];
        let is = 0;
        for (const it of c.items) {
          const iid = await id(
            "insert into menu_items(restaurant_id, category_id, name_ar, name_en, description_ar, price, calories, tags, sort) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [rid, cid, it.ar, it.en, it.dAr || null, Math.round(it.price * 100), it.cal ?? null, it.tags ?? [], is++],
          );
          ids.push(iid);
          let gs = 0;
          for (const m of it.mods ?? []) {
            const gid = await id("insert into modifier_groups(item_id, name_ar, name_en, min_select, max_select, sort) values ($1,$2,$3,$4,$5,$6)", [iid, m.ar, m.en, m.min, m.max, gs++]);
            let os = 0;
            for (const [oar, oen, delta] of m.opts)
              await q.query("insert into modifier_options(group_id, name_ar, name_en, price_delta, sort) values ($1,$2,$3,$4,$5)", [gid, oar, oen, Math.round(delta * 100), os++]);
          }
        }
        itemIds.push(ids);
      }

      for (const clip of r.clips) {
        const media = canMakeMedia ? generateClip(MEDIA_DIR, { key: clip.key, label: clip.label, colorA: r.color, colorB: r.colorB }) : null;
        const vid = await id(
          `insert into videos(restaurant_id, creator_id, uploaded_by, caption_ar, video_url, poster_url, duration_s, status, moderated_by, moderated_at, view_count, like_count)
           values ($1,$2,$3,$4,$5,$6,6,'approved',$7,now(),$8,$9)`,
          [rid, clip.byCreator ? creatorId : null, clip.byCreator ? creatorUser : owner, clip.captionAr, media ? `/media/${clip.key}.mp4` : `/media/missing.mp4`, media ? `/media/${clip.key}.jpg` : null, ops, 1200 + ri * 431, 140 + ri * 37],
        );
        for (const [ci, ii] of clip.itemIdx) await q.query("insert into video_items(video_id, item_id) values ($1,$2)", [vid, itemIds[ci]![ii]]);
      }
      ri++;
    }

    // ── one video awaiting moderation (shows the approval workflow) ──
    const firstR = (await q.query<{ id: string }>("select id from restaurants where slug = 'najd-burger-demo'")).rows[0]!.id;
    await q.query("insert into videos(restaurant_id, creator_id, uploaded_by, caption_ar, video_url, status) values ($1,$2,$3,'فيديو جديد بانتظار المراجعة','/media/najd-smash.mp4','pending_review')", [firstR, creatorId, creatorUser]);

    // ── ABU9+ test prices ──
    for (const [vid, label, price] of [["plus_m_1999", "SAR 19.99 / month (test)", 1999], ["plus_m_2499", "SAR 24.99 / month (test)", 2499], ["plus_m_2999", "SAR 29.99 / month (test)", 2999]] as const)
      await q.query("insert into plus_price_variants(id, experiment_key, label, interval, price, weight, active, is_test_price) values ($1,'plus-2026q4',$2,'month',$3,1,true,true)", [vid, label, price]);

    // ── promotions & loyalty campaigns ──
    const now = new Date();
    const in60 = new Date(now.getTime() + 60 * 86_400_000);
    await q.query(
      `insert into promotions(code, title_ar, kind, value, max_discount, min_food_subtotal, abu9_share_bps, restaurant_share_bps, budget, per_customer_limit, first_order_only, starts_at, ends_at, approved_by)
       values ('AHLAN', 'خصم ٢٠٪ لأول طلب', 'percent', 2000, 1500, 3000, 10000, 0, 500000, 1, true, $1, $2, $3),
              ('NAJD10', 'خصم ١٠ ريال من برجر نجد', 'fixed', 1000, null, 4000, 5000, 5000, 200000, 3, false, $1, $2, $3)`,
      [now, in60, ops],
    );
    await q.query("update promotions set restaurant_id = $1 where code = 'NAJD10'", [firstR]);
    await q.query(
      `insert into loyalty_campaigns(restaurant_id, name, multiplier, budget, abu9_share_bps, restaurant_share_bps, status, starts_at, ends_at, approved_by)
       values ($1, 'نقاط مضاعفة ×٢ — برجر نجد', 2, 50000, 3000, 7000, 'active', $2, $3, $4)`,
      [firstR, now, in60, ops],
    );

    // ── customer addresses ──
    await q.query("insert into addresses(user_id, label, lat, lng, district, details, is_default) values ($1,'البيت',24.6930,46.6880,'العليا','شارع الأمير محمد بن عبدالعزيز (عنوان تجريبي)',true)", [sara]);
    await q.query("insert into addresses(user_id, label, lat, lng, district, details) values ($1,'العمل',24.7120,46.6740,'العليا','برج تجريبي، الدور ١٢')", [sara]);
    await q.query("insert into addresses(user_id, label, lat, lng, district, details, is_default) values ($1,'البيت',24.8120,46.6230,'الملقا','فيلا تجريبية',true)", [fahad]);

    // ── ledger chart of accounts (platform-level; party accounts are created on demand) ──
    for (const [code, type, name] of [
      ["asset:psp_clearing", "asset", "PSP clearing"],
      ["asset:bank", "asset", "Bank"],
      ["liability:vat_payable", "liability", "VAT payable"],
      ["liability:deferred_revenue:abu9_plus", "liability", "Deferred ABU9+ revenue"],
      ["revenue:delivery_fees", "revenue", "Delivery fee revenue"],
      ["revenue:service_fees", "revenue", "Service fee revenue"],
      ["revenue:abu9_plus", "revenue", "ABU9+ subscription revenue"],
      ["revenue:restaurant_subscriptions", "revenue", "Restaurant subscription revenue"],
      ["expense:delivery_cost", "expense", "Delivery cost"],
      ["expense:promotions", "expense", "Promotions"],
      ["expense:loyalty", "expense", "Loyalty"],
      ["expense:customer_compensation", "expense", "Customer compensation"],
      ["expense:compensation_recovery", "expense", "Compensation recovered (contra)"],
      ["expense:psp_fees", "expense", "PSP fees"],
    ])
      await q.query("insert into ledger_accounts(code, type, name) values ($1,$2,$3)", [code, type, name]);
  });
  console.log("seeded fictional demo data ✓");
}

export { seed };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = createDb();
  seed(db)
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}

export type { Queryable };
