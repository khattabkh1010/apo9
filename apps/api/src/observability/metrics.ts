/**
 * Minimal Prometheus exposition (text format 0.0.4) — no dependency. HTTP metrics are recorded per
 * route PATTERN (not raw path) to keep label cardinality bounded. Business gauges are computed at
 * scrape time from the database so they are always consistent with OLTP state.
 */
import type { Queryable } from "../../../../packages/db/src/pg.ts";

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

interface Hist {
  buckets: number[];
  sum: number;
  count: number;
}

export class Metrics {
  private requests = new Map<string, number>();
  private durations = new Map<string, Hist>();
  private counters = new Map<string, number>();
  readonly startedAt = Date.now();

  observeRequest(method: string, route: string, status: number, seconds: number) {
    const k = `${method}|${route}|${status}`;
    this.requests.set(k, (this.requests.get(k) ?? 0) + 1);
    const hk = `${method}|${route}`;
    let h = this.durations.get(hk);
    if (!h) this.durations.set(hk, (h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }));
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h!.buckets[i]!++;
    });
    h.sum += seconds;
    h.count++;
  }

  /** Free-form counters for domain events (e.g. dispatch outcomes). Name must be a valid metric name. */
  inc(name: string, labels: Record<string, string> = {}, by = 1) {
    const k = `${name}|${JSON.stringify(labels)}`;
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  async render(db: Queryable): Promise<string> {
    const out: string[] = [];
    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const lbl = (o: Record<string, string | number>) => `{${Object.entries(o).map(([k, v]) => `${k}="${esc(String(v))}"`).join(",")}}`;

    out.push("# HELP abu9_http_requests_total HTTP requests by route pattern and status.", "# TYPE abu9_http_requests_total counter");
    for (const [k, v] of this.requests) {
      const [method, route, status] = k.split("|");
      out.push(`abu9_http_requests_total${lbl({ method: method!, route: route!, status: status! })} ${v}`);
    }
    out.push("# HELP abu9_http_request_duration_seconds Request latency.", "# TYPE abu9_http_request_duration_seconds histogram");
    for (const [k, h] of this.durations) {
      const [method, route] = k.split("|");
      BUCKETS.forEach((b, i) => out.push(`abu9_http_request_duration_seconds_bucket${lbl({ method: method!, route: route!, le: b })} ${h.buckets[i]}`));
      out.push(`abu9_http_request_duration_seconds_bucket${lbl({ method: method!, route: route!, le: "+Inf" })} ${h.count}`);
      out.push(`abu9_http_request_duration_seconds_sum${lbl({ method: method!, route: route! })} ${h.sum.toFixed(6)}`);
      out.push(`abu9_http_request_duration_seconds_count${lbl({ method: method!, route: route! })} ${h.count}`);
    }
    const names = new Set([...this.counters.keys()].map((k) => k.split("|")[0]!));
    for (const n of names) {
      out.push(`# TYPE ${n} counter`);
      for (const [k, v] of this.counters) {
        const [name, labels] = k.split("|");
        if (name === n) out.push(`${n}${Object.keys(JSON.parse(labels!)).length ? lbl(JSON.parse(labels!)) : ""} ${v}`);
      }
    }

    // ── business / operational gauges (scrape-time queries; all cheap, indexed) ──
    const g = (await db.query<Record<string, number | null>>(
      `select
         (select count(*) from orders where status in ('placed','accepted','preparing','ready_for_pickup','picked_up'))::int active_orders,
         (select count(*) from orders where status = 'placed')::int awaiting_restaurant,
         (select count(*) from orders where placed_at > now() - interval '5 minutes')::int placed_5m,
         (select count(*) from delivery_jobs where status = 'unassigned')::int unassigned_jobs,
         (select extract(epoch from now() - min(created_at)) from delivery_jobs where status = 'unassigned')::float8 oldest_unassigned_sec,
         (select count(*) from couriers where status = 'online' and last_seen_at > now() - interval '10 minutes')::int couriers_online,
         (select count(*) from order_events where to_status = 'rejected' and created_at > now() - interval '1 hour')::int rejected_1h,
         (select count(*) from support_tickets where status in ('open','awaiting_evidence'))::int open_tickets,
         (select count(*) from videos where status = 'pending_review')::int videos_pending_review`,
    )).rows[0]!;
    const gauge = (name: string, help: string, v: number | null | undefined) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${v ?? 0}`);
    gauge("abu9_orders_active", "Orders between placement and delivery.", g.active_orders);
    gauge("abu9_orders_awaiting_restaurant", "Placed orders not yet accepted (240 s acceptance window).", g.awaiting_restaurant);
    gauge("abu9_orders_placed_5m", "Orders placed in the last 5 minutes.", g.placed_5m);
    gauge("abu9_dispatch_unassigned_jobs", "Delivery jobs without a courier.", g.unassigned_jobs);
    gauge("abu9_dispatch_oldest_unassigned_seconds", "Age of the oldest unassigned delivery job (alert on this).", g.oldest_unassigned_sec);
    gauge("abu9_couriers_online", "Couriers online and seen in the last 10 minutes.", g.couriers_online);
    gauge("abu9_orders_rejected_1h", "Orders rejected (restaurant or timeout) in the last hour.", g.rejected_1h);
    gauge("abu9_support_tickets_open", "Open support tickets.", g.open_tickets);
    gauge("abu9_videos_pending_review", "Videos waiting for moderation.", g.videos_pending_review);
    gauge("abu9_process_uptime_seconds", "Process uptime.", Math.round((Date.now() - this.startedAt) / 1000));
    gauge("abu9_process_resident_memory_bytes", "Resident set size.", process.memoryUsage().rss);
    return out.join("\n") + "\n";
  }
}
