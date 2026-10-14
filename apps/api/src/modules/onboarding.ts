import { randomBytes } from "node:crypto";
import { z } from "zod";
import { hasAnyHours, isValidCrNumber, isValidVatNumber, onboardingChecklist, restaurantSlug, validateWeeklyHours, type WeeklyHours } from "../../../../packages/domain/src/onboarding.ts";
import { trialEndsAt } from "../../../../packages/domain/src/subscriptions.ts";
import type { Queryable } from "../../../../packages/db/src/pg.ts";
import type { AppContext } from "../context.ts";
import { badRequest, conflict, notFound, withStatus, type Ctx, type Router } from "../http/router.ts";
import { requirePermission, requireRestaurantAccess, requireUser } from "../auth/rbac.ts";
import { audit } from "../audit.ts";
import { notify } from "../services/common.ts";

/**
 * Restaurant self-onboarding (application → profile, branch hours, menu, modifiers, terms) and
 * ops activation. Onboarding is free; the 30-day trial starts at activation.
 */

/** Version of the restaurant subscription terms shown in-app. DRAFT until legal sign-off (LAUNCH_BLOCKERS §B5). */
export const RESTAURANT_TERMS_VERSION = "restaurant-subscription-v0-draft";

const MAX_OPEN_APPLICATIONS_PER_USER = 3;

const LatLng = { lat: z.number().min(15).max(33), lng: z.number().min(34).max(56) };
const BranchBody = z.object({
  nameAr: z.string().min(1).max(80),
  nameEn: z.string().min(1).max(80),
  ...LatLng,
  district: z.string().max(80).optional(),
  phone: z.string().max(20).optional(),
  prepMinutesDefault: z.number().int().min(3).max(90).optional(),
});
const HoursBody = z.record(z.string(), z.array(z.tuple([z.string(), z.string()])).max(3));

async function onboardingFacts(q: Queryable, rid: string) {
  const r = (
    await q.query<{
      name_ar: string; cuisine_tags: string[]; cr_number: string | null; status: string; signed_at: Date | null;
      branches: number; branches_with_hours: number; priced_items: number; categories: number; coverage_rules: number;
    }>(
      `select r.name_ar, r.cuisine_tags, r.cr_number, r.status, t.signed_at,
              (select count(*) from branches b where b.restaurant_id = r.id)::int branches,
              (select count(*) from branches b where b.restaurant_id = r.id and b.opening_hours::text not in ('{}', 'null')
                 and exists (select 1 from jsonb_each(b.opening_hours) e where jsonb_array_length(e.value) > 0))::int branches_with_hours,
              (select count(*) from menu_items m where m.restaurant_id = r.id and m.price > 0)::int priced_items,
              (select count(*) from menu_categories c where c.restaurant_id = r.id)::int categories,
              (select count(*) from branch_zone_rules z join branches b on b.id = z.branch_id where b.restaurant_id = r.id and z.enabled)::int coverage_rules
       from restaurants r left join restaurant_contract_terms t on t.restaurant_id = r.id where r.id = $1`,
      [rid],
    )
  ).rows[0];
  if (!r) throw notFound("restaurant");
  const checklist = onboardingChecklist({
    nameAr: r.name_ar, cuisineTags: r.cuisine_tags, crNumber: r.cr_number, branches: r.branches, branchesWithHours: r.branches_with_hours,
    pricedItems: r.priced_items, categories: r.categories, termsAcceptedAt: r.signed_at, coverageRules: r.coverage_rules,
  });
  return { status: r.status, ...checklist };
}

export function onboardingRoutes(r: Router, app: AppContext) {
  const scope = (ctx: Ctx) => {
    const id = ctx.params.rid!;
    requireRestaurantAccess(ctx, id);
    return id;
  };
  /** Owner-only actions (profile, terms, branches). Staff can operate the kitchen but not sign terms. */
  const ownerScope = async (ctx: Ctx) => {
    const rid = scope(ctx);
    const p = ctx.principal!;
    const isOwner = p.roles.some((x) => x.role === "restaurant_owner" && x.scopeType === "restaurant" && x.scopeId === rid);
    if (!isOwner) requirePermission(ctx, "restaurants.manage_all");
    return rid;
  };

  // ── application ──
  r.post("/api/v1/restaurant-applications", async (ctx) => {
    const p = requireUser(ctx);
    const b = await ctx.body(
      z.object({
        nameAr: z.string().min(2).max(80),
        nameEn: z.string().min(2).max(80),
        descriptionAr: z.string().max(300).optional(),
        cuisineTags: z.array(z.string().min(1).max(20)).min(1).max(6),
        crNumber: z.string().refine(isValidCrNumber, "السجل التجاري 10 أرقام"),
        vatNumber: z.string().refine(isValidVatNumber, "الرقم الضريبي 15 رقماً يبدأ وينتهي بـ 3").optional(),
        branch: BranchBody,
      }),
    );
    return app.db.tx(async (q) => {
      const open = (await q.query<{ n: number }>(
        "select count(*)::int n from restaurants r join restaurant_members m on m.restaurant_id = r.id where m.user_id = $1 and m.role = 'owner' and r.status = 'onboarding'",
        [p.userId],
      )).rows[0]!.n;
      if (open >= MAX_OPEN_APPLICATIONS_PER_USER) throw conflict("too_many_applications", "لديك طلبات انضمام قيد الإكمال");
      const slug = restaurantSlug(b.nameEn, randomBytes(3).toString("hex"));
      const rest = (await q.query<{ id: string }>(
        `insert into restaurants(slug, name_ar, name_en, description_ar, cuisine_tags, status, cr_number, vat_number)
         values ($1,$2,$3,$4,$5,'onboarding',$6,$7) returning id`,
        [slug, b.nameAr, b.nameEn, b.descriptionAr ?? null, b.cuisineTags, b.crNumber, b.vatNumber ?? null],
      )).rows[0]!;
      await q.query("insert into restaurant_members(restaurant_id, user_id, role) values ($1,$2,'owner')", [rest.id, p.userId]);
      await q.query("insert into user_roles(user_id, role, scope_type, scope_id) values ($1,'restaurant_owner','restaurant',$2) on conflict do nothing", [p.userId, rest.id]);
      // Contract terms start EMPTY: no automatic deductions until the restaurant signs terms that allow them.
      await q.query("insert into restaurant_contract_terms(restaurant_id, auto_deduct_reason_codes, dispute_window_hours) values ($1, '{}', 72)", [rest.id]);
      const br = (await q.query<{ id: string }>(
        "insert into branches(restaurant_id, name_ar, name_en, lat, lng, district, phone, prep_minutes_default, accepting_orders) values ($1,$2,$3,$4,$5,$6,$7,$8,true) returning id",
        [rest.id, b.branch.nameAr, b.branch.nameEn, b.branch.lat, b.branch.lng, b.branch.district ?? null, b.branch.phone ?? null, b.branch.prepMinutesDefault ?? 15],
      )).rows[0]!;
      await audit(q, ctx, { action: "restaurant.application", entityType: "restaurant", entityId: rest.id, after: { slug, nameAr: b.nameAr, crNumber: b.crNumber, branchId: br.id } });
      return withStatus(201, { restaurantId: rest.id, slug, branchId: br.id, status: "onboarding" });
    });
  });

  r.get("/api/v1/restaurant/:rid/onboarding", async (ctx) => {
    const rid = scope(ctx);
    const facts = await onboardingFacts(app.db, rid);
    const terms = (await app.db.query("select auto_deduct_reason_codes, dispute_window_hours, signed_at, document_url from restaurant_contract_terms where restaurant_id = $1", [rid])).rows[0] ?? null;
    return { ...facts, terms, termsVersion: RESTAURANT_TERMS_VERSION, trialDays: 30 };
  });

  r.patch("/api/v1/restaurant/:rid/profile", async (ctx) => {
    const rid = await ownerScope(ctx);
    const b = await ctx.body(
      z.object({
        nameAr: z.string().min(2).max(80).optional(),
        nameEn: z.string().min(2).max(80).optional(),
        descriptionAr: z.string().max(300).optional(),
        cuisineTags: z.array(z.string().min(1).max(20)).min(1).max(6).optional(),
        brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        crNumber: z.string().refine(isValidCrNumber).optional(),
        vatNumber: z.string().refine(isValidVatNumber).optional(),
      }),
    );
    return app.db.tx(async (q) => {
      const before = (await q.query("select name_ar, name_en, description_ar, cuisine_tags, brand_color, cr_number, vat_number, status from restaurants where id = $1 for update", [rid])).rows[0]!;
      // Legal identity of an ACTIVE restaurant changes only through ops (settlement payee must stay verified).
      if (before.status !== "onboarding" && (b.crNumber || b.vatNumber)) requirePermission(ctx, "restaurants.manage_all");
      const after = (await q.query(
        `update restaurants set name_ar = coalesce($2, name_ar), name_en = coalesce($3, name_en), description_ar = coalesce($4, description_ar),
           cuisine_tags = coalesce($5, cuisine_tags), brand_color = coalesce($6, brand_color), cr_number = coalesce($7, cr_number), vat_number = coalesce($8, vat_number)
         where id = $1 returning name_ar, name_en, description_ar, cuisine_tags, brand_color, cr_number, vat_number`,
        [rid, b.nameAr ?? null, b.nameEn ?? null, b.descriptionAr ?? null, b.cuisineTags ?? null, b.brandColor ?? null, b.crNumber ?? null, b.vatNumber ?? null],
      )).rows[0];
      await audit(q, ctx, { action: "restaurant.profile_update", entityType: "restaurant", entityId: rid, before, after });
      return { restaurant: after };
    });
  });

  r.post("/api/v1/restaurant/:rid/terms/accept", async (ctx) => {
    const rid = await ownerScope(ctx);
    const { version } = await ctx.body(z.object({ version: z.literal(RESTAURANT_TERMS_VERSION) }));
    return app.db.tx(async (q) => {
      const t = (await q.query<{ signed_at: Date | null }>("select signed_at from restaurant_contract_terms where restaurant_id = $1 for update", [rid])).rows[0];
      if (!t) throw notFound("terms");
      if (t.signed_at) return { ok: true, signedAt: t.signed_at };
      const row = (await q.query<{ signed_at: Date }>("update restaurant_contract_terms set signed_at = now(), document_url = $2 where restaurant_id = $1 returning signed_at", [rid, `terms/${version}`])).rows[0]!;
      await audit(q, ctx, { action: "restaurant.terms_accepted", entityType: "restaurant", entityId: rid, after: { version, signedAt: row.signed_at } });
      return { ok: true, signedAt: row.signed_at };
    });
  });

  // ── branches & hours ──
  r.post("/api/v1/restaurant/:rid/branches", async (ctx) => {
    const rid = await ownerScope(ctx);
    const b = await ctx.body(BranchBody);
    return app.db.tx(async (q) => {
      const row = (await q.query<{ id: string }>(
        "insert into branches(restaurant_id, name_ar, name_en, lat, lng, district, phone, prep_minutes_default) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *",
        [rid, b.nameAr, b.nameEn, b.lat, b.lng, b.district ?? null, b.phone ?? null, b.prepMinutesDefault ?? 15],
      )).rows[0]!;
      // A new branch is not deliverable until ops configures its coverage rules.
      await audit(q, ctx, { action: "branch.create", entityType: "branch", entityId: row.id, after: row });
      return withStatus(201, { branch: row });
    });
  });

  r.put("/api/v1/restaurant/:rid/branches/:bid/hours", async (ctx) => {
    const rid = scope(ctx);
    const hours = (await ctx.body(z.object({ hours: HoursBody }))).hours as WeeklyHours;
    const problems = validateWeeklyHours(hours);
    if (problems.length) throw badRequest("invalid_hours", "أوقات العمل غير صحيحة", problems);
    return app.db.tx(async (q) => {
      const before = (await q.query("select opening_hours from branches where id = $1 and restaurant_id = $2 for update", [ctx.params.bid, rid])).rows[0];
      if (!before) throw notFound("branch");
      await q.query("update branches set opening_hours = $2 where id = $1", [ctx.params.bid, hours]);
      await audit(q, ctx, { action: "branch.hours_update", entityType: "branch", entityId: ctx.params.bid!, before, after: { opening_hours: hours } });
      return { ok: true, open: hasAnyHours(hours) };
    });
  });

  r.get("/api/v1/restaurant/:rid/branches", async (ctx) => {
    const rid = scope(ctx);
    return {
      branches: (await app.db.query(
        `select b.*, (select count(*) from branch_zone_rules z where z.branch_id = b.id and z.enabled)::int coverage_zones
         from branches b where b.restaurant_id = $1 order by b.created_at`,
        [rid],
      )).rows,
    };
  });

  // ── menu categories ──
  const CategoryBody = z.object({ nameAr: z.string().min(1).max(60), nameEn: z.string().min(1).max(60), sort: z.number().int().min(0).max(1000).optional() });
  r.post("/api/v1/restaurant/:rid/menu/categories", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(CategoryBody);
    const row = (await app.db.query("insert into menu_categories(restaurant_id, name_ar, name_en, sort) values ($1,$2,$3,coalesce($4,(select coalesce(max(sort),0)+1 from menu_categories where restaurant_id = $1))) returning *", [rid, b.nameAr, b.nameEn, b.sort ?? null])).rows[0];
    return withStatus(201, { category: row });
  });
  r.patch("/api/v1/restaurant/:rid/menu/categories/:cid", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(CategoryBody.partial());
    const row = (await app.db.query("update menu_categories set name_ar = coalesce($3, name_ar), name_en = coalesce($4, name_en), sort = coalesce($5, sort) where id = $1 and restaurant_id = $2 returning *", [ctx.params.cid, rid, b.nameAr ?? null, b.nameEn ?? null, b.sort ?? null])).rows[0];
    if (!row) throw notFound("category");
    return { category: row };
  });
  r.delete("/api/v1/restaurant/:rid/menu/categories/:cid", async (ctx) => {
    const rid = scope(ctx);
    // Items keep existing (category_id → null) so nothing customers can order silently disappears.
    const res = await app.db.query("delete from menu_categories where id = $1 and restaurant_id = $2", [ctx.params.cid, rid]);
    if (!res.rowCount) throw notFound("category");
    return undefined;
  });

  // ── modifiers (variants & add-ons) ──
  const OptionBody = z.object({ nameAr: z.string().min(1).max(60), nameEn: z.string().min(1).max(60), priceDelta: z.number().int().min(0).max(100_000).default(0), isAvailable: z.boolean().optional() });
  const GroupBody = z
    .object({
      nameAr: z.string().min(1).max(60),
      nameEn: z.string().min(1).max(60),
      minSelect: z.number().int().min(0).max(10),
      maxSelect: z.number().int().min(1).max(20),
      options: z.array(OptionBody).min(1).max(30).optional(),
    })
    .refine((g) => g.maxSelect >= g.minSelect, "maxSelect must be ≥ minSelect")
    .refine((g) => !g.options || g.options.length >= g.minSelect, "fewer options than minSelect");

  const itemInRestaurant = async (q: Queryable, rid: string, iid: string) => {
    if (!(await q.query("select 1 from menu_items where id = $1 and restaurant_id = $2", [iid, rid])).rowCount) throw notFound("item");
  };
  const groupInRestaurant = async (q: Queryable, rid: string, gid: string) => {
    const g = (await q.query<{ id: string; item_id: string; min_select: number; max_select: number }>(
      "select g.id, g.item_id, g.min_select, g.max_select from modifier_groups g join menu_items m on m.id = g.item_id where g.id = $1 and m.restaurant_id = $2",
      [gid, rid],
    )).rows[0];
    if (!g) throw notFound("modifier group");
    return g;
  };

  r.get("/api/v1/restaurant/:rid/menu/items/:iid/modifier-groups", async (ctx) => {
    const rid = scope(ctx);
    await itemInRestaurant(app.db, rid, ctx.params.iid!);
    return {
      groups: (await app.db.query(
        `select g.*, coalesce((select json_agg(o order by o.sort, o.name_ar) from modifier_options o where o.group_id = g.id), '[]') options
         from modifier_groups g where g.item_id = $1 order by g.sort, g.name_ar`,
        [ctx.params.iid],
      )).rows,
    };
  });

  r.post("/api/v1/restaurant/:rid/menu/items/:iid/modifier-groups", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(GroupBody);
    return app.db.tx(async (q) => {
      await itemInRestaurant(q, rid, ctx.params.iid!);
      const g = (await q.query<{ id: string }>(
        "insert into modifier_groups(item_id, name_ar, name_en, min_select, max_select, sort) values ($1,$2,$3,$4,$5,(select coalesce(max(sort),0)+1 from modifier_groups where item_id = $1)) returning *",
        [ctx.params.iid, b.nameAr, b.nameEn, b.minSelect, b.maxSelect],
      )).rows[0]!;
      for (const [i, o] of (b.options ?? []).entries()) {
        await q.query("insert into modifier_options(group_id, name_ar, name_en, price_delta, is_available, sort) values ($1,$2,$3,$4,$5,$6)", [g.id, o.nameAr, o.nameEn, o.priceDelta, o.isAvailable ?? true, i]);
      }
      await audit(q, ctx, { action: "modifier_group.create", entityType: "modifier_group", entityId: g.id, after: b });
      return withStatus(201, { group: g });
    });
  });

  r.patch("/api/v1/restaurant/:rid/modifier-groups/:gid", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(z.object({ nameAr: z.string().min(1).max(60).optional(), nameEn: z.string().min(1).max(60).optional(), minSelect: z.number().int().min(0).max(10).optional(), maxSelect: z.number().int().min(1).max(20).optional() }));
    return app.db.tx(async (q) => {
      const g = await groupInRestaurant(q, rid, ctx.params.gid!);
      const min = b.minSelect ?? g.min_select;
      const max = b.maxSelect ?? g.max_select;
      if (max < min) throw badRequest("invalid_selection_range", "الحد الأعلى أقل من الحد الأدنى");
      const available = (await q.query<{ n: number }>("select count(*)::int n from modifier_options where group_id = $1 and is_available", [g.id])).rows[0]!.n;
      if (min > available) throw badRequest("not_enough_options", "عدد الخيارات المتاحة أقل من الحد الأدنى المطلوب");
      const after = (await q.query("update modifier_groups set name_ar = coalesce($2, name_ar), name_en = coalesce($3, name_en), min_select = $4, max_select = $5 where id = $1 returning *", [g.id, b.nameAr ?? null, b.nameEn ?? null, min, max])).rows[0];
      await audit(q, ctx, { action: "modifier_group.update", entityType: "modifier_group", entityId: g.id, before: g, after });
      return { group: after };
    });
  });

  r.delete("/api/v1/restaurant/:rid/modifier-groups/:gid", async (ctx) => {
    const rid = scope(ctx);
    return app.db.tx(async (q) => {
      const g = await groupInRestaurant(q, rid, ctx.params.gid!);
      // Past orders keep their own snapshot of chosen options (order_items.options), so deletion is safe.
      await q.query("delete from modifier_groups where id = $1", [g.id]);
      await audit(q, ctx, { action: "modifier_group.delete", entityType: "modifier_group", entityId: g.id, before: g });
      return undefined;
    });
  });

  r.post("/api/v1/restaurant/:rid/modifier-groups/:gid/options", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(OptionBody);
    return app.db.tx(async (q) => {
      const g = await groupInRestaurant(q, rid, ctx.params.gid!);
      const row = (await q.query("insert into modifier_options(group_id, name_ar, name_en, price_delta, is_available, sort) values ($1,$2,$3,$4,$5,(select coalesce(max(sort),0)+1 from modifier_options where group_id = $1)) returning *", [g.id, b.nameAr, b.nameEn, b.priceDelta, b.isAvailable ?? true])).rows[0];
      await audit(q, ctx, { action: "modifier_option.create", entityType: "modifier_group", entityId: g.id, after: row });
      return withStatus(201, { option: row });
    });
  });

  const optionInRestaurant = async (q: Queryable, rid: string, oid: string) => {
    const o = (await q.query<{ id: string; group_id: string; price_delta: number; is_available: boolean; min_select: number }>(
      `select o.*, g.min_select from modifier_options o join modifier_groups g on g.id = o.group_id join menu_items m on m.id = g.item_id
       where o.id = $1 and m.restaurant_id = $2 for update of o`,
      [oid, rid],
    )).rows[0];
    if (!o) throw notFound("modifier option");
    return o;
  };
  const assertMinStillSatisfiable = async (q: Queryable, groupId: string, minSelect: number) => {
    const n = (await q.query<{ n: number }>("select count(*)::int n from modifier_options where group_id = $1 and is_available", [groupId])).rows[0]!.n;
    if (n < minSelect) throw badRequest("not_enough_options", "لا يمكن: سيصبح عدد الخيارات المتاحة أقل من الحد الأدنى المطلوب");
  };

  r.patch("/api/v1/restaurant/:rid/modifier-options/:oid", async (ctx) => {
    const rid = scope(ctx);
    const b = await ctx.body(OptionBody.partial());
    return app.db.tx(async (q) => {
      const before = await optionInRestaurant(q, rid, ctx.params.oid!);
      const after = (await q.query(
        "update modifier_options set name_ar = coalesce($2, name_ar), name_en = coalesce($3, name_en), price_delta = coalesce($4, price_delta), is_available = coalesce($5, is_available) where id = $1 returning *",
        [before.id, b.nameAr ?? null, b.nameEn ?? null, b.priceDelta ?? null, b.isAvailable ?? null],
      )).rows[0];
      if (b.isAvailable === false) await assertMinStillSatisfiable(q, before.group_id, before.min_select);
      // Price and availability changes are commercially sensitive → audited.
      if (b.priceDelta !== undefined || b.isAvailable !== undefined) await audit(q, ctx, { action: "modifier_option.update", entityType: "modifier_option", entityId: before.id, before, after });
      return { option: after };
    });
  });

  r.delete("/api/v1/restaurant/:rid/modifier-options/:oid", async (ctx) => {
    const rid = scope(ctx);
    return app.db.tx(async (q) => {
      const before = await optionInRestaurant(q, rid, ctx.params.oid!);
      await q.query("delete from modifier_options where id = $1", [before.id]);
      await assertMinStillSatisfiable(q, before.group_id, before.min_select);
      await audit(q, ctx, { action: "modifier_option.delete", entityType: "modifier_option", entityId: before.id, before });
      return undefined;
    });
  });

  // ── ops: review & activation ──
  r.get("/api/v1/admin/restaurants/:id/onboarding", async (ctx) => {
    requirePermission(ctx, "restaurants.manage_all");
    const facts = await onboardingFacts(app.db, ctx.params.id!);
    const branches = (await app.db.query("select id, name_ar, district, lat, lng from branches where restaurant_id = $1", [ctx.params.id])).rows;
    return { ...facts, branches };
  });

  r.post("/api/v1/admin/restaurants/:id/activate", async (ctx) => {
    requirePermission(ctx, "restaurants.manage_all");
    const { reason } = await ctx.body(z.object({ reason: z.string().min(3).max(300) }));
    return app.db.tx(async (q) => {
      const rest = (await q.query<{ id: string; status: string; name_ar: string }>("select id, status, name_ar from restaurants where id = $1 for update", [ctx.params.id])).rows[0];
      if (!rest) throw notFound("restaurant");
      if (rest.status !== "onboarding") throw conflict("not_onboarding", `restaurant is ${rest.status}`);
      const facts = await onboardingFacts(q, rest.id);
      if (!facts.readyForActivation) throw conflict("onboarding_incomplete", "قائمة التهيئة غير مكتملة", facts.steps.filter((s) => !s.done).map((s) => s.key));
      const now = app.now();
      const trialEnd = trialEndsAt(now);
      await q.query("update restaurants set status = 'active', activated_at = $2 where id = $1", [rest.id, now]);
      // Free trial starts at activation. Starter plan by default; plan changes only at renewal with consent.
      await q.query(
        "insert into restaurant_subscriptions(restaurant_id, plan_code, status, trial_ends_at, current_period_start, current_period_end) values ($1,'starter','trialing',$2,$3,$2)",
        [rest.id, trialEnd, now],
      );
      await audit(q, ctx, { action: "restaurant.activate", entityType: "restaurant", entityId: rest.id, before: { status: rest.status }, after: { status: "active", trialEndsAt: trialEnd }, reason });
      const owners = (await q.query<{ user_id: string }>("select user_id from restaurant_members where restaurant_id = $1 and role = 'owner'", [rest.id])).rows;
      for (const o of owners) {
        await notify(app, q, o.user_id, {
          kind: "restaurant_activated",
          titleAr: `تم تفعيل ${rest.name_ar} على أبو9`,
          bodyAr: `بدأت الفترة التجريبية المجانية (30 يوماً) وتنتهي ${trialEnd.toISOString().slice(0, 10)}.`,
          titleEn: "Your restaurant is live on ABU9",
          data: { restaurantId: rest.id },
        });
      }
      return { ok: true, status: "active", trialEndsAt: trialEnd };
    });
  });

  r.post("/api/v1/admin/restaurants/:id/status", async (ctx) => {
    requirePermission(ctx, "restaurants.manage_all");
    const b = await ctx.body(z.object({ status: z.enum(["active", "suspended"]), reason: z.string().min(3).max(300) }));
    return app.db.tx(async (q) => {
      const rest = (await q.query<{ status: string }>("select status from restaurants where id = $1 for update", [ctx.params.id])).rows[0];
      if (!rest) throw notFound("restaurant");
      if (rest.status === "onboarding" || rest.status === "churned") throw conflict("invalid_status_change", "use activation for onboarding restaurants");
      await q.query("update restaurants set status = $2 where id = $1", [ctx.params.id, b.status]);
      await audit(q, ctx, { action: "restaurant.status", entityType: "restaurant", entityId: ctx.params.id!, before: rest, after: { status: b.status }, reason: b.reason });
      return { ok: true };
    });
  });
}
