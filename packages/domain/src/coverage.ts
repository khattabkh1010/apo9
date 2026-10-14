import { type LatLng, pointInPolygon, type RouteEstimate } from "./geo.ts";

/**
 * Dynamic coverage.
 *
 * There is deliberately NO global delivery radius. Whether a customer can order from a branch
 * is decided per (branch, dropoff zone) using road distance, travel time, preparation time,
 * live courier capacity, SLA targets and an operational cost ceiling.
 */

export type ZoneStatus = "active" | "paused" | "restricted";

export interface Zone {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  status: ZoneStatus;
  polygon: LatLng[];
  /** Promised delivery SLA (minutes from order acceptance to delivery). */
  slaMinutes: number;
}

/** Per branch × dropoff-zone rule. Absent rule = branch does not serve that zone. */
export interface BranchZoneRule {
  branchId: string;
  zoneId: string;
  enabled: boolean;
  maxRoadKm: number;
  /** Max allowed courier travel time pickup→dropoff. */
  maxTravelMinutes: number;
}

export interface CapacitySnapshot {
  zoneId: string;
  availableCouriers: number;
  /** Orders waiting for a courier or in progress in the zone. */
  openDeliveries: number;
  /**
   * Max open deliveries per available courier before the zone is considered saturated.
   * With batching up to 2, ~1.6 is a reasonable conservative starting point.
   */
  maxLoadFactor: number;
}

export interface CoverageConfig {
  /** Max estimated delivery-only cost we accept for one order (halalas). */
  maxDeliveryCost: number;
  /** Cost model used to estimate delivery cost: fixed per order + per km. */
  costPerOrder: number;
  costPerKm: number;
  /** When load factor is above this but below max, restrict to shorter trips. */
  restrictedLoadFactor: number;
  /** In restricted mode, maximum road km allowed. */
  restrictedMaxKm: number;
}

export const DEFAULT_COVERAGE_CONFIG: CoverageConfig = {
  maxDeliveryCost: 2200,
  costPerOrder: 1000,
  costPerKm: 150,
  restrictedLoadFactor: 1.2,
  restrictedMaxKm: 4,
};

export type CoverageReason =
  | "no_zone"
  | "zone_paused"
  | "branch_closed"
  | "branch_not_serving_zone"
  | "distance_exceeds_branch_limit"
  | "travel_time_exceeds_limit"
  | "sla_cannot_be_met"
  | "no_courier_capacity"
  | "restricted_capacity_short_trips_only"
  | "delivery_cost_exceeds_ceiling";

export interface CoverageInput {
  dropoff: LatLng;
  branch: { id: string; isOpen: boolean; prepMinutes: number };
  zones: Zone[];
  rules: BranchZoneRule[];
  capacity: CapacitySnapshot[];
  route: RouteEstimate;
  /** Expected minutes for a courier to reach the branch (from dispatch stats). */
  expectedCourierToPickupMin: number;
  config?: CoverageConfig;
}

export interface CoverageResult {
  eligible: boolean;
  zoneId: string | null;
  reasons: CoverageReason[];
  /** Estimated minutes from acceptance to delivery. */
  etaMinutes: number;
  etaRange: [number, number];
  estimatedDeliveryCost: number;
  routeSource: RouteEstimate["source"];
}

export function findZone(p: LatLng, zones: Zone[]): Zone | undefined {
  return zones.find((z) => pointInPolygon(p, z.polygon));
}

export function evaluateCoverage(input: CoverageInput): CoverageResult {
  const cfg = input.config ?? DEFAULT_COVERAGE_CONFIG;
  const reasons: CoverageReason[] = [];
  const zone = findZone(input.dropoff, input.zones);
  const route = input.route;

  // Food is ready at prepMinutes; courier must be at branch by then (or after). Delivery leg follows.
  const pickupAt = Math.max(input.branch.prepMinutes, input.expectedCourierToPickupMin);
  const etaMinutes = Math.ceil(pickupAt + 2 /* handover */ + route.durationMin + 3 /* parking/handoff */);
  const estimatedDeliveryCost = Math.round(cfg.costPerOrder + cfg.costPerKm * route.distanceKm);

  if (!zone) {
    reasons.push("no_zone");
  } else {
    if (zone.status === "paused") reasons.push("zone_paused");
    if (!input.branch.isOpen) reasons.push("branch_closed");
    const rule = input.rules.find((r) => r.branchId === input.branch.id && r.zoneId === zone.id);
    if (!rule || !rule.enabled) {
      reasons.push("branch_not_serving_zone");
    } else {
      if (route.distanceKm > rule.maxRoadKm) reasons.push("distance_exceeds_branch_limit");
      if (route.durationMin > rule.maxTravelMinutes) reasons.push("travel_time_exceeds_limit");
    }
    if (etaMinutes > zone.slaMinutes) reasons.push("sla_cannot_be_met");

    const cap = input.capacity.find((c) => c.zoneId === zone.id);
    if (!cap || cap.availableCouriers <= 0) {
      reasons.push("no_courier_capacity");
    } else {
      const load = cap.openDeliveries / cap.availableCouriers;
      if (load >= cap.maxLoadFactor) reasons.push("no_courier_capacity");
      else if ((zone.status === "restricted" || load >= cfg.restrictedLoadFactor) && route.distanceKm > cfg.restrictedMaxKm)
        reasons.push("restricted_capacity_short_trips_only");
    }
    if (estimatedDeliveryCost > cfg.maxDeliveryCost) reasons.push("delivery_cost_exceeds_ceiling");
  }

  return {
    eligible: reasons.length === 0,
    zoneId: zone?.id ?? null,
    reasons,
    etaMinutes,
    etaRange: [Math.max(10, etaMinutes - 5), etaMinutes + 7],
    estimatedDeliveryCost,
    routeSource: route.source,
  };
}

export const COVERAGE_REASON_TEXT: Record<CoverageReason, { ar: string; en: string }> = {
  no_zone: { ar: "عنوانك خارج مناطق خدمة أبو9 حالياً", en: "Your address is outside ABU9 service areas" },
  zone_paused: { ar: "الخدمة متوقفة مؤقتاً في منطقتك", en: "Service is temporarily paused in your area" },
  branch_closed: { ar: "المطعم مغلق الآن", en: "The restaurant is closed now" },
  branch_not_serving_zone: { ar: "هذا الفرع لا يوصّل لمنطقتك", en: "This branch does not deliver to your area" },
  distance_exceeds_branch_limit: { ar: "المسافة أبعد من نطاق توصيل الفرع", en: "Too far from this branch" },
  travel_time_exceeds_limit: { ar: "وقت الوصول طويل جداً للحفاظ على جودة الطعام", en: "Travel time too long to keep food quality" },
  sla_cannot_be_met: { ar: "لا يمكننا ضمان وقت التوصيل الآن", en: "We cannot guarantee the delivery time right now" },
  no_courier_capacity: { ar: "المناديب مشغولون حالياً، جرّب بعد قليل", en: "Couriers are busy right now, try again shortly" },
  restricted_capacity_short_trips_only: { ar: "ضغط عالٍ: التوصيل متاح للمسافات القريبة فقط", en: "High demand: only nearby deliveries available" },
  delivery_cost_exceeds_ceiling: { ar: "التوصيل لهذا العنوان غير متاح حالياً", en: "Delivery to this address is not available right now" },
};
