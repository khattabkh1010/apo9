import type { Queryable } from "../../../../packages/db/src/pg.ts";
import { accountType, finalizeEntry, type JournalEntryDraft } from "../../../../packages/domain/src/ledger.ts";
import type { DeliveryPricingConfig } from "../../../../packages/domain/src/pricing.ts";
import type { AppContext } from "../context.ts";

/**
 * Post a journal entry. Idempotent on event_key: re-posting the same business event returns the
 * existing entry id and writes nothing. Party accounts are created on first use.
 * Balance is enforced twice: in `finalizeEntry` and by a deferred DB constraint trigger.
 */
export async function postEntry(q: Queryable, draft: JournalEntryDraft): Promise<{ id: string; created: boolean }> {
  const e = finalizeEntry(draft);
  const existing = await q.query<{ id: string }>("select id from journal_entries where event_key = $1", [e.eventKey]);
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  for (const l of e.lines) {
    const parts = l.account.split(":");
    const partyId = parts.length >= 3 && /^[0-9a-f-]{36}$/.test(parts[2]!) ? parts[2] : null;
    await q.query(
      "insert into ledger_accounts(code, type, party_type, party_id, name) values ($1,$2,$3,$4,$5) on conflict (code) do nothing",
      [l.account, accountType(l.account), partyId ? parts[1] : null, partyId, l.account],
    );
  }
  const ins = await q.query<{ id: string }>(
    `insert into journal_entries(event_key, event_type, occurred_at, description, ref_type, ref_id, reverses_entry_id)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (event_key) do nothing returning id`,
    [e.eventKey, e.eventType, e.occurredAt, e.description, e.refType, e.refId, e.reversesEntryId ?? null],
  );
  if (!ins.rows[0]) {
    const again = await q.query<{ id: string }>("select id from journal_entries where event_key = $1", [e.eventKey]);
    return { id: again.rows[0]!.id, created: false };
  }
  const id = ins.rows[0].id;
  for (const l of e.lines)
    await q.query("insert into journal_lines(entry_id, account_code, debit, credit, memo) values ($1,$2,$3,$4,$5)", [id, l.account, l.debit, l.credit, l.memo ?? null]);
  return { id, created: true };
}

export async function getSetting<T>(q: Queryable, key: string, fallback: T): Promise<T> {
  const r = await q.query<{ value: T }>("select value from platform_settings where key = $1", [key]);
  return r.rows[0]?.value ?? fallback;
}

export async function getPricingConfig(q: Queryable, zoneId: string | null): Promise<DeliveryPricingConfig & { id: string }> {
  const r = await q.query<Record<string, unknown>>(
    `select * from delivery_pricing_configs
     where (zone_id = $1 or zone_id is null) and effective_from <= now()
     order by (zone_id is not null) desc, effective_from desc limit 1`,
    [zoneId],
  );
  const c = r.rows[0];
  if (!c) throw new Error("no delivery pricing configured");
  return {
    id: c.id as string,
    basicFee: c.basic_fee as number,
    baseDistanceKm: Number(c.base_distance_km),
    additionalFeePerIncrement: c.additional_fee_per_increment as number,
    additionalIncrementKm: Number(c.additional_increment_km),
    additionalFeeCap: (c.additional_fee_cap as number | null) ?? undefined,
    serviceFee: c.service_fee as number,
    smallOrderFee: c.small_order_fee as number,
    smallOrderThreshold: c.small_order_threshold as number,
    vatRateBps: c.vat_rate_bps as number,
  };
}

export async function notify(
  app: AppContext,
  q: Queryable,
  userId: string,
  n: { kind: string; titleAr: string; bodyAr?: string; titleEn?: string; bodyEn?: string; data?: Record<string, unknown> },
): Promise<void> {
  await q.query("insert into notifications(user_id, kind, title_ar, body_ar, title_en, body_en, data) values ($1,$2,$3,$4,$5,$6,$7)", [
    userId, n.kind, n.titleAr, n.bodyAr ?? null, n.titleEn ?? null, n.bodyEn ?? null, n.data ?? {},
  ]);
  app.bus.publish(`user:${userId}`, { type: "notification", kind: n.kind, titleAr: n.titleAr });
  // Push delivery (APNs/FCM) is NOT implemented — see docs/LAUNCH_BLOCKERS.md.
}
