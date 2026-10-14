import { z } from "zod";
import { findZone } from "../../../../packages/domain/src/coverage.ts";
import type { AppContext } from "../context.ts";
import { notFound, withStatus, type Router } from "../http/router.ts";
import { requireUser } from "../auth/rbac.ts";
import { loadZones } from "../services/coverage.ts";

/**
 * Public catalog and the discovery feed.
 * Feed ranking v1 (explainable, no ML): deliverable-to-you first, then an engagement score
 * (likes×3 + views/100) decayed by age. Personalisation is a documented future step.
 */
export function catalogRoutes(r: Router, app: AppContext) {
  r.get("/api/v1/restaurants", async (ctx) => {
    const search = ctx.query.get("q")?.trim();
    const tag = ctx.query.get("tag");
    const lat = Number(ctx.query.get("lat"));
    const lng = Number(ctx.query.get("lng"));
    const rows = (
      await app.db.query<Record<string, unknown>>(
        `select r.id, r.slug, r.name_ar, r.name_en, r.description_ar, r.cuisine_tags, r.brand_color, r.is_demo,
                round(r.rating_sum::numeric / nullif(r.rating_count,0), 1)::text rating, r.rating_count,
                (select json_agg(json_build_object('id', b.id, 'nameAr', b.name_ar, 'lat', b.lat, 'lng', b.lng, 'prep', b.prep_minutes_default, 'accepting', b.accepting_orders,
                    'zones', (select json_agg(z.zone_id) from branch_zone_rules z where z.branch_id = b.id and z.enabled))) from branches b where b.restaurant_id = r.id) branches,
                (select v.poster_url from videos v where v.restaurant_id = r.id and v.status = 'approved' order by v.like_count desc limit 1) cover
         from restaurants r
         where r.status = 'active'
           and ($1::text is null or r.name_ar ilike '%' || $1 || '%' or r.name_en ilike '%' || $1 || '%'
                or exists (select 1 from menu_items m where m.restaurant_id = r.id and (m.name_ar ilike '%' || $1 || '%' or m.name_en ilike '%' || $1 || '%')))
           and ($2::text is null or $2 = any(r.cuisine_tags))
         order by r.rating_count desc`,
        [search || null, tag || null],
      )
    ).rows;
    let zoneId: string | null = null;
    if (Number.isFinite(lat) && Number.isFinite(lng) && ctx.query.has("lat")) zoneId = findZone({ lat, lng }, await loadZones(app.db))?.id ?? null;
    const withDeliverable = rows.map((x) => ({
      ...x,
      servesYourArea: zoneId ? (x.branches as Array<{ zones: string[] | null }>).some((b) => b.zones?.includes(zoneId!)) : null,
    }));
    withDeliverable.sort((a, b) => Number(b.servesYourArea ?? 0) - Number(a.servesYourArea ?? 0));
    return { restaurants: withDeliverable, zoneId };
  });

  r.get("/api/v1/restaurants/:slug", async (ctx) => {
    const rest = (await app.db.query<Record<string, unknown>>(
      `select r.id, r.slug, r.name_ar, r.name_en, r.description_ar, r.cuisine_tags, r.brand_color, r.is_demo,
              round(r.rating_sum::numeric / nullif(r.rating_count,0), 1)::text rating, r.rating_count
       from restaurants r where (r.slug = $1 or r.id::text = $1) and r.status = 'active'`,
      [ctx.params.slug],
    )).rows[0];
    if (!rest) throw notFound("restaurant");
    const [branches, categories, items, groups, options, videos] = await Promise.all([
      app.db.query("select id, name_ar, name_en, lat, lng, district, accepting_orders, prep_minutes_default, opening_hours from branches where restaurant_id = $1", [rest.id]),
      app.db.query("select id, name_ar, name_en, sort from menu_categories where restaurant_id = $1 order by sort", [rest.id]),
      app.db.query("select id, category_id, name_ar, name_en, description_ar, description_en, price, image_url, calories, tags, is_available from menu_items where restaurant_id = $1 order by sort", [rest.id]),
      app.db.query("select g.* from modifier_groups g join menu_items m on m.id = g.item_id where m.restaurant_id = $1 order by g.sort", [rest.id]),
      app.db.query("select o.* from modifier_options o join modifier_groups g on g.id = o.group_id join menu_items m on m.id = g.item_id where m.restaurant_id = $1 order by o.sort", [rest.id]),
      app.db.query("select id, poster_url, video_url, caption_ar from videos where restaurant_id = $1 and status = 'approved' order by created_at desc", [rest.id]),
    ]);
    const menu = categories.rows.map((c) => ({
      ...c,
      items: items.rows
        .filter((i) => i.category_id === c.id)
        .map((i) => ({
          ...i,
          modifierGroups: groups.rows.filter((g) => g.item_id === i.id).map((g) => ({ ...g, options: options.rows.filter((o) => o.group_id === g.id) })),
        })),
    }));
    let favorite = false;
    if (ctx.principal) favorite = !!(await app.db.query("select 1 from favorites where user_id = $1 and restaurant_id = $2", [ctx.principal.userId, rest.id])).rowCount;
    return { restaurant: rest, branches: branches.rows, menu, videos: videos.rows, favorite };
  });

  r.get("/api/v1/feed", async (ctx) => {
    const lat = Number(ctx.query.get("lat"));
    const lng = Number(ctx.query.get("lng"));
    const limit = Math.min(Number(ctx.query.get("limit") ?? 20), 50);
    const zoneId = ctx.query.has("lat") && Number.isFinite(lat) ? (findZone({ lat, lng }, await loadZones(app.db))?.id ?? null) : null;
    const rows = (
      await app.db.query<Record<string, unknown>>(
        `select v.id, v.caption_ar, v.video_url, v.poster_url, v.duration_s, v.view_count, v.like_count, v.created_at,
                json_build_object('id', r.id, 'slug', r.slug, 'nameAr', r.name_ar, 'nameEn', r.name_en, 'brandColor', r.brand_color,
                  'rating', round(r.rating_sum::numeric / nullif(r.rating_count,0), 1)::text) restaurant,
                case when c.id is null then null else json_build_object('id', c.id, 'handle', c.handle, 'displayName', c.display_name) end creator,
                (select json_agg(json_build_object('id', m.id, 'nameAr', m.name_ar, 'nameEn', m.name_en, 'price', m.price, 'available', m.is_available,
                    'hasRequiredOptions', exists(select 1 from modifier_groups g where g.item_id = m.id and g.min_select > 0)))
                   from video_items vi join menu_items m on m.id = vi.item_id where vi.video_id = v.id) items,
                ($1::uuid is not null and exists (select 1 from branches b join branch_zone_rules z on z.branch_id = b.id and z.enabled
                   where b.restaurant_id = r.id and z.zone_id = $1)) deliverable,
                ($2::uuid is not null and exists (select 1 from video_events e where e.video_id = v.id and e.user_id = $2 and e.kind = 'like'
                   and not exists (select 1 from video_events u where u.video_id = v.id and u.user_id = $2 and u.kind = 'unlike' and u.id > e.id))) liked,
                ((v.like_count * 3 + v.view_count / 100.0) / power(extract(epoch from now() - v.created_at) / 3600 + 2, 0.8)) score
         from videos v join restaurants r on r.id = v.restaurant_id and r.status = 'active'
         left join creators c on c.id = v.creator_id
         where v.status = 'approved'
         order by deliverable desc, score desc limit $3`,
        [zoneId, ctx.principal?.userId ?? null, limit],
      )
    ).rows;
    return { videos: rows, zoneId };
  });

  r.post("/api/v1/videos/:id/events", async (ctx) => {
    const { kind } = await ctx.body(z.object({ kind: z.enum(["view", "like", "unlike", "share", "add_to_cart", "open_restaurant"]) }));
    const v = await app.db.query("select 1 from videos where id = $1 and status = 'approved'", [ctx.params.id]);
    if (!v.rowCount) throw notFound("video");
    await app.db.query("insert into video_events(video_id, user_id, kind) values ($1,$2,$3)", [ctx.params.id, ctx.principal?.userId ?? null, kind]);
    if (kind === "view") await app.db.query("update videos set view_count = view_count + 1 where id = $1", [ctx.params.id]);
    if (kind === "like") await app.db.query("update videos set like_count = like_count + 1 where id = $1", [ctx.params.id]);
    if (kind === "unlike") await app.db.query("update videos set like_count = greatest(like_count - 1, 0) where id = $1", [ctx.params.id]);
    return withStatus(202, { ok: true });
  });

  r.get("/api/v1/me/favorites", async (ctx) => {
    const p = requireUser(ctx);
    return { favorites: (await app.db.query("select r.id, r.slug, r.name_ar, r.name_en, r.brand_color from favorites f join restaurants r on r.id = f.restaurant_id where f.user_id = $1 order by f.created_at desc", [p.userId])).rows };
  });
  r.put("/api/v1/me/favorites/:restaurantId", async (ctx) => {
    const p = requireUser(ctx);
    await app.db.query("insert into favorites(user_id, restaurant_id) values ($1,$2) on conflict do nothing", [p.userId, ctx.params.restaurantId]);
    return { ok: true };
  });
  r.delete("/api/v1/me/favorites/:restaurantId", async (ctx) => {
    const p = requireUser(ctx);
    await app.db.query("delete from favorites where user_id = $1 and restaurant_id = $2", [p.userId, ctx.params.restaurantId]);
    return undefined;
  });

  r.get("/api/v1/zones", async () => ({ zones: (await loadZones(app.db)).map((z) => ({ id: z.id, code: z.code, nameAr: z.nameAr, nameEn: z.nameEn, status: z.status, polygon: z.polygon })) }));
}
