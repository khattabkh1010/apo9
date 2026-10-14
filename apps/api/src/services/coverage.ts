import type { Queryable } from "../../../../packages/db/src/pg.ts";
import { evaluateCoverage, findZone, type BranchZoneRule, type CapacitySnapshot, type CoverageConfig, type CoverageResult, type Zone, DEFAULT_COVERAGE_CONFIG } from "../../../../packages/domain/src/coverage.ts";
import { haversineKm, type LatLng, type RouteEstimate } from "../../../../packages/domain/src/geo.ts";
import type { AppContext } from "../context.ts";
import { getSetting } from "./common.ts";

export async function loadZones(q: Queryable): Promise<Zone[]> {
  const r = await q.query<{ id: string; code: string; name_ar: string; name_en: string; status: Zone["status"]; polygon: Zone["polygon"]; sla_minutes: number }>("select * from zones");
  return r.rows.map((z) => ({ id: z.id, code: z.code, nameAr: z.name_ar, nameEn: z.name_en, status: z.status, polygon: z.polygon, slaMinutes: z.sla_minutes }));
}

/** Live capacity per zone: online couriers currently located in the zone vs open deliveries. */
export async function capacitySnapshot(q: Queryable, zones: Zone[]): Promise<CapacitySnapshot[]> {
  const couriers = (await q.query<{ last_lat: number; last_lng: number }>("select last_lat, last_lng from couriers where status = 'online' and last_lat is not null and last_seen_at > now() - interval '10 minutes'")).rows;
  const open = (await q.query<{ zone_id: string; n: number }>(
    "select o.zone_id, count(*)::int n from delivery_jobs j join orders o on o.id = j.order_id where j.status not in ('delivered','failed','cancelled') group by o.zone_id",
  )).rows;
  return zones.map((z) => ({
    zoneId: z.id,
    availableCouriers: couriers.filter((c) => findZone({ lat: c.last_lat, lng: c.last_lng }, [z])).length,
    openDeliveries: open.find((o) => o.zone_id === z.id)?.n ?? 0,
    maxLoadFactor: 1.6,
  }));
}

export interface BranchRow {
  id: string;
  restaurant_id: string;
  name_ar: string;
  lat: number;
  lng: number;
  accepting_orders: boolean;
  prep_minutes_default: number;
  opening_hours: Record<string, Array<[string, string]>>;
}

/** Opening hours are stored in Riyadh local time; "24:00" closes at midnight, ranges past midnight wrap. */
export function isBranchOpen(b: BranchRow, at: Date): boolean {
  if (!b.accepting_orders) return false;
  const local = new Date(at.getTime() + 3 * 3_600_000);
  const day = local.getUTCDay();
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const ranges = b.opening_hours[String(day)] ?? [];
  return ranges.some(([o, c]) => {
    const open = toMin(o);
    const close = toMin(c);
    return close > open ? minutes >= open && minutes < close : minutes >= open || minutes < close;
  });
}

export async function evaluateBranchCoverage(app: AppContext, q: Queryable, branch: BranchRow, dropoff: LatLng): Promise<CoverageResult & { route: RouteEstimate }> {
  const zones = await loadZones(q);
  const rules = (await q.query<{ branch_id: string; zone_id: string; enabled: boolean; max_road_km: string; max_travel_minutes: number }>("select * from branch_zone_rules where branch_id = $1", [branch.id])).rows.map(
    (r): BranchZoneRule => ({ branchId: r.branch_id, zoneId: r.zone_id, enabled: r.enabled, maxRoadKm: Number(r.max_road_km), maxTravelMinutes: r.max_travel_minutes }),
  );
  const capacity = await capacitySnapshot(q, zones);
  const now = app.now();
  const route = await app.routing.route({ lat: branch.lat, lng: branch.lng }, dropoff, now);
  // Expected courier arrival: nearest online courier to the branch, else a conservative default.
  const nearest = (await q.query<{ last_lat: number; last_lng: number }>("select last_lat, last_lng from couriers where status = 'online' and last_lat is not null")).rows
    .map((c) => haversineKm({ lat: c.last_lat, lng: c.last_lng }, { lat: branch.lat, lng: branch.lng }))
    .sort((a, b) => a - b)[0];
  const expectedCourierToPickupMin = nearest === undefined ? 15 : Math.max(4, (nearest * 1.35 * 60) / 24);
  const cfg = await getSetting<CoverageConfig>(q, "coverage", DEFAULT_COVERAGE_CONFIG);
  const result = evaluateCoverage({
    dropoff,
    branch: { id: branch.id, isOpen: isBranchOpen(branch, now), prepMinutes: branch.prep_minutes_default },
    zones,
    rules,
    capacity,
    route,
    expectedCourierToPickupMin,
    config: cfg,
  });
  return { ...result, route };
}
