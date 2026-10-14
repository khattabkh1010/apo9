export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371.0088;

export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

/** Ray-casting point-in-polygon. Polygon is an ordered ring of vertices (closing vertex optional). */
export function pointInPolygon(p: LatLng, polygon: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const intersects =
      a.lat > p.lat !== b.lat > p.lat &&
      p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng;
    if (intersects) inside = !inside;
  }
  return inside;
}

export interface RouteEstimate {
  /** Road distance in km. */
  distanceKm: number;
  /** Travel time in minutes including traffic. */
  durationMin: number;
  /** Where the estimate came from, so the UI and ops can tell estimates from real routing. */
  source: "routing-provider" | "heuristic";
}

/**
 * Routing provider abstraction. Production should use a real road-network provider
 * (e.g. Google Routes API, HERE, Mapbox, or a self-hosted OSRM/Valhalla with KSA OSM data).
 */
export interface RoutingProvider {
  route(from: LatLng, to: LatLng, departAt: Date): Promise<RouteEstimate> | RouteEstimate;
}

/**
 * HEURISTIC routing — NOT real road routing. Used for local development, tests and as a
 * degraded-mode fallback. Applies a circuity factor to straight-line distance and a
 * time-of-day speed profile approximating Riyadh traffic.
 */
export class HeuristicRiyadhRouting implements RoutingProvider {
  circuity: number;
  constructor(circuity = 1.35) {
    this.circuity = circuity;
  }
  route(from: LatLng, to: LatLng, departAt: Date): RouteEstimate {
    const distanceKm = haversineKm(from, to) * this.circuity;
    const speedKmh = riyadhSpeedKmh(departAt);
    return { distanceKm: round2(distanceKm), durationMin: round2((distanceKm / speedKmh) * 60), source: "heuristic" };
  }
}

/** Average courier urban speed by local Riyadh hour (UTC+3). Conservative assumptions, tune with real trip data. */
export function riyadhSpeedKmh(at: Date): number {
  const hour = (at.getUTCHours() + 3) % 24;
  if (hour >= 13 && hour < 15) return 20; // lunch + school pickup
  if (hour >= 19 && hour < 23) return 18; // evening peak
  if (hour >= 7 && hour < 9) return 22;
  if (hour >= 1 && hour < 6) return 32;
  return 26;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
