import type { Queryable } from "../../../../packages/db/src/pg.ts";
import { addInterval, assignPriceVariant, applyPlusEvent, plusRefundOnCancel, type PlusPriceVariant } from "../../../../packages/domain/src/subscriptions.ts";
import { postPlusPayment, postRevenueRecognition, recognizedToDate } from "../../../../packages/domain/src/ledger.ts";
import { vatIncluded } from "../../../../packages/domain/src/money.ts";
import type { AppContext } from "../context.ts";
import { ApiError, conflict, notFound } from "../http/router.ts";
import { getSetting, notify, postEntry } from "./common.ts";
import { rowToPlus } from "./orders.ts";

const VAT_BPS = 1500;

export async function loadVariants(q: Queryable): Promise<PlusPriceVariant[]> {
  return (await q.query<{ id: string; label: string; interval: "month" | "year"; price: number; weight: number; active: boolean }>("select * from plus_price_variants")).rows.map((v) => ({ ...v }));
}

/** The price this user sees. Sticky per user for the running experiment. */
export async function offerFor(app: AppContext, userId: string): Promise<PlusPriceVariant> {
  const exp = await getSetting<{ key: string }>(app.db, "abu9_plus_experiment", { key: "plus-2026q4" });
  return assignPriceVariant(userId, exp.key, await loadVariants(app.db));
}

async function charge(app: AppContext, userId: string, amount: number, idemKey: string, token: string) {
  const pay = (await app.db.query<{ id: string }>(
    "insert into payments(purpose, user_id, provider, status, amount, idempotency_key, method) values ('abu9_plus',$1,$2,'requires_action',$3,$4,'card') on conflict (idempotency_key) do update set updated_at = now() returning id",
    [userId, app.payments.name, amount, idemKey],
  )).rows[0]!;
  const auth = await app.payments.authorize({ amount, currency: "SAR", idempotencyKey: idemKey, method: { type: "card_token", token }, description: "ABU9+ subscription" });
  if (auth.status !== "authorized") {
    await app.db.query("update payments set status = 'failed', failure_reason = $2, provider_ref = $3 where id = $1", [pay.id, auth.failureReason ?? auth.status, auth.providerRef]);
    return { ok: false as const, paymentId: pay.id, reason: auth.failureReason ?? auth.status };
  }
  const cap = await app.payments.capture(auth.providerRef, amount, `${idemKey}:capture`);
  await app.db.query("update payments set status = $2, provider_ref = $3, captured_amount = case when $2 = 'captured' then amount else 0 end where id = $1", [pay.id, cap.status === "captured" ? "captured" : "failed", auth.providerRef]);
  return cap.status === "captured" ? { ok: true as const, paymentId: pay.id } : { ok: false as const, paymentId: pay.id, reason: "capture_failed" };
}

export async function subscribe(app: AppContext, userId: string, paymentToken: string, idemKey: string): Promise<{ subscriptionId: string }> {
  const existing = (await app.db.query("select id from plus_subscriptions where user_id = $1 and status in ('active','past_due','cancelled')", [userId])).rows[0];
  if (existing) throw conflict("already_subscribed", "لديك اشتراك أبو9+ فعّال");
  const v = await offerFor(app, userId);
  const now = app.now();
  const end = addInterval(now, v.interval);
  const res = await charge(app, userId, v.price, `plus:${userId}:${idemKey}`, paymentToken);
  if (!res.ok) throw new ApiError(402, "payment_failed", "تعذّر الدفع");
  return app.db.tx(async (q) => {
    const sub = (await q.query<{ id: string }>(
      "insert into plus_subscriptions(user_id, price_variant_id, price, interval, status, current_period_start, current_period_end) values ($1,$2,$3,$4,'active',$5,$6) returning id",
      [userId, v.id, v.price, v.interval, now, end],
    )).rows[0]!;
    const vat = vatIncluded(v.price, VAT_BPS);
    const inv = (await q.query<{ id: string }>("insert into plus_invoices(subscription_id, period_start, period_end, amount, vat, status, payment_id) values ($1,$2,$3,$4,$5,'paid',$6) returning id", [sub.id, now, end, v.price, vat, res.paymentId])).rows[0]!;
    await postEntry(q, postPlusPayment({ invoiceId: inv.id, userId, gross: v.price, vat, occurredAt: now }));
    await notify(app, q, userId, { kind: "plus_activated", titleAr: "أهلاً بك في أبو9+ 🎉", bodyAr: "توصيل أساسي مجاني لأول ٢ كم على الطلبات المؤهلة (٣٥ ر.س فأكثر)." });
    return { subscriptionId: sub.id };
  });
}

export async function cancel(app: AppContext, userId: string): Promise<{ refund: number; benefitsUntil: Date }> {
  const s = (await app.db.query<Record<string, unknown>>("select * from plus_subscriptions where user_id = $1 and status in ('active','past_due')", [userId])).rows[0];
  if (!s) throw notFound("active subscription");
  const uses = (await app.db.query<{ n: number }>("select count(*)::int n from plus_benefit_uses where subscription_id = $1 and created_at >= $2", [s.id, s.current_period_start])).rows[0]!.n;
  const inv = (await app.db.query<{ id: string; amount: number; payment_id: string }>("select * from plus_invoices where subscription_id = $1 and period_start = $2 and status = 'paid'", [s.id, s.current_period_start])).rows[0];
  const refund = inv ? plusRefundOnCancel({ paid: inv.amount, periodStart: s.current_period_start as Date, at: app.now(), benefitUses: uses }) : 0;
  const next = applyPlusEvent(rowToPlus(s), { type: "cancel_requested", at: app.now() });
  await app.db.query("update plus_subscriptions set status = $2, cancel_at_period_end = true where id = $1", [s.id, next.status]);
  if (refund > 0 && inv) {
    // Cooling-off refund: reverse the payment; deferred revenue not yet recognised is reversed.
    const p = (await app.db.query<{ provider_ref: string }>("select provider_ref from payments where id = $1", [inv.payment_id])).rows[0]!;
    const r = await app.payments.refund(p.provider_ref, refund, `plus-refund:${inv.id}`);
    if (r.status === "refunded")
      await app.db.tx(async (q) => {
        await q.query("update payments set refunded_amount = $2, status = 'refunded' where id = $1", [inv.payment_id, refund]);
        await q.query("update plus_invoices set status = 'refunded' where id = $1", [inv.id]);
        await q.query("update plus_subscriptions set status = 'expired', current_period_end = now() where id = $1", [s.id]);
        const original = (await q.query<{ id: string; event_type: string; ref_type: string; ref_id: string; description: string; occurred_at: Date; event_key: string }>("select * from journal_entries where event_key = $1", [`abu9plus.paid:${inv.id}`])).rows[0];
        if (original) {
          const lines = (await q.query<{ account_code: string; debit: number; credit: number }>("select account_code, debit, credit from journal_lines where entry_id = $1", [original.id])).rows;
          const recognized = (await q.query<{ recognized_amount: number }>("select recognized_amount from plus_invoices where id = $1", [inv.id])).rows[0]!.recognized_amount;
          // Reverse the cash entry; if revenue was already recognised, reverse that portion from revenue.
          await postEntry(q, {
            eventKey: `abu9plus.refunded:${inv.id}`, eventType: "abu9plus.refunded", occurredAt: app.now(), description: `ABU9+ cooling-off refund ${inv.id}`, refType: "subscription_invoice", refId: inv.id,
            lines: [
              ...lines.map((l) => ({ account: l.account_code, debit: l.credit, credit: l.debit })).map((l) =>
                l.account === "liability:deferred_revenue:abu9_plus" ? { ...l, debit: l.debit - recognized } : l,
              ),
              ...(recognized > 0 ? [{ account: "revenue:abu9_plus", debit: recognized, credit: 0 }] : []),
            ],
          });
        }
      });
  }
  return { refund, benefitsUntil: refund > 0 ? app.now() : (s.current_period_end as Date) };
}

export async function resume(app: AppContext, userId: string): Promise<void> {
  const s = (await app.db.query<Record<string, unknown>>("select * from plus_subscriptions where user_id = $1 and status = 'cancelled'", [userId])).rows[0];
  if (!s) throw notFound("cancelled subscription");
  const next = applyPlusEvent(rowToPlus(s), { type: "resume_requested", at: app.now() });
  await app.db.query("update plus_subscriptions set status = $2, cancel_at_period_end = false where id = $1", [s.id, next.status]);
}

/** Background: renew due subscriptions, handle failures with a grace period, expire ended ones. */
export async function runRenewals(app: AppContext): Promise<{ renewed: number; failed: number; expired: number }> {
  let renewed = 0, failed = 0, expired = 0;
  const due = (await app.db.query<Record<string, unknown>>("select * from plus_subscriptions where status in ('active','past_due','cancelled') and current_period_end <= now()")).rows;
  for (const s of due) {
    const sub = rowToPlus(s);
    if (sub.cancelAtPeriodEnd) {
      await app.db.query("update plus_subscriptions set status = 'expired' where id = $1", [sub.id]);
      expired++;
      continue;
    }
    if (sub.status === "past_due" && sub.pastDueSince && app.now().getTime() - sub.pastDueSince.getTime() > 3 * 86_400_000) {
      await app.db.query("update plus_subscriptions set status = 'expired' where id = $1", [sub.id]);
      expired++;
      continue;
    }
    // Saved-card renewal: production uses the PSP's stored payment-method token. Mock uses a test token.
    const res = await charge(app, sub.userId, s.price as number, `plus-renew:${sub.id}:${sub.currentPeriodEnd.toISOString()}`, (s.payment_token_ref as string) ?? "tok_saved_mock");
    if (!res.ok) {
      const n = applyPlusEvent(sub, { type: "renewal_failed", at: app.now() });
      await app.db.query("update plus_subscriptions set status = 'past_due', past_due_since = $2 where id = $1", [sub.id, n.pastDueSince]);
      await app.db.tx((q) => notify(app, q, sub.userId, { kind: "plus_payment_failed", titleAr: "تعذّر تجديد أبو9+", bodyAr: "حدّث وسيلة الدفع خلال ٣ أيام للحفاظ على المزايا." }));
      failed++;
      continue;
    }
    const n = applyPlusEvent({ ...sub, status: "active" }, { type: "renewal_succeeded", at: app.now(), interval: s.interval as "month" | "year" });
    await app.db.tx(async (q) => {
      await q.query("update plus_subscriptions set status = 'active', past_due_since = null, current_period_start = $2, current_period_end = $3 where id = $1", [sub.id, n.currentPeriodStart, n.currentPeriodEnd]);
      const vat = vatIncluded(s.price as number, VAT_BPS);
      const inv = (await q.query<{ id: string }>("insert into plus_invoices(subscription_id, period_start, period_end, amount, vat, status, payment_id) values ($1,$2,$3,$4,$5,'paid',$6) on conflict do nothing returning id", [sub.id, n.currentPeriodStart, n.currentPeriodEnd, s.price, vat, res.paymentId])).rows[0];
      if (inv) await postEntry(q, postPlusPayment({ invoiceId: inv.id, userId: sub.userId, gross: s.price as number, vat, occurredAt: app.now() }));
    });
    renewed++;
  }
  return { renewed, failed, expired };
}

/** Background: straight-line revenue recognition for paid ABU9+ invoices (posts only the delta). */
export async function recognizePlusRevenue(app: AppContext): Promise<number> {
  let posted = 0;
  const invs = (await app.db.query<{ id: string; amount: number; vat: number; period_start: Date; period_end: Date; recognized_amount: number }>("select * from plus_invoices where status = 'paid' and recognized_amount < amount - vat")).rows;
  for (const inv of invs) {
    const target = recognizedToDate(inv.amount - inv.vat, inv.period_start, inv.period_end, app.now());
    const delta = target - inv.recognized_amount;
    if (delta <= 0) continue;
    await app.db.tx(async (q) => {
      const seq = (await q.query<{ n: number }>("select count(*)::int n from journal_entries where event_type = 'abu9plus.revenue_recognized' and ref_id = $1", [inv.id])).rows[0]!.n;
      await postEntry(q, postRevenueRecognition({ invoiceId: inv.id, seq, amount: delta, occurredAt: app.now() }));
      await q.query("update plus_invoices set recognized_amount = $2 where id = $1", [inv.id, target]);
    });
    posted++;
  }
  return posted;
}
