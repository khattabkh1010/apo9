import type { Queryable } from "../../../../packages/db/src/pg.ts";
import { reasonByCode, recoveryPath, suggestedRefund, type FaultParty } from "../../../../packages/domain/src/refunds.ts";
import { postCustomerRefund, postCompensationRecovery } from "../../../../packages/domain/src/ledger.ts";
import { refundAdjustments, DEFAULT_LOYALTY } from "../../../../packages/domain/src/loyalty.ts";
import type { AppContext } from "../context.ts";
import { ApiError, conflict, notFound } from "../http/router.ts";
import { notify, postEntry } from "./common.ts";

const AUTO_REFUND_MAX = 5000; // SAR 50
const AUTO_REFUND_MAX_30D = 2; // customer refunds in 30 days before manual review

/**
 * Fast resolution for low-value, low-risk tickets: instant-eligible reason, small amount,
 * delivered order, no recent refund history. Everything else goes to an agent.
 */
export async function autoResolveTicketIfEligible(app: AppContext, ticketId: string): Promise<boolean> {
  const t = (await app.db.query<{ id: string; order_id: string; user_id: string; reason_code: string; affected_amount: number; fault_party: FaultParty }>("select * from support_tickets where id = $1", [ticketId])).rows[0]!;
  const reason = reasonByCode(t.reason_code);
  if (!reason.instantEligible) return false;
  const amount = suggestedRefund({ reasonCode: t.reason_code, affectedAmount: t.affected_amount });
  if (amount <= 0 || amount > AUTO_REFUND_MAX) return false;
  const recent = (await app.db.query<{ n: number }>("select count(*)::int n from refunds r join payments p on p.id = r.payment_id where p.user_id = $1 and r.created_at > now() - interval '30 days'", [t.user_id])).rows[0]!.n;
  if (recent >= AUTO_REFUND_MAX_30D) {
    await app.db.query("insert into fraud_flags(entity_type, entity_id, rule, score, details) values ('user',$1,'refund_velocity',60,$2)", [t.user_id, { ticketId, recent }]);
    return false;
  }
  await resolveTicket(app, ticketId, { faultParty: t.fault_party, refundAmount: amount, actorId: null, note: "auto-resolved (instant-eligible, under SAR 50)" });
  return true;
}

/**
 * Resolve a ticket with an evidence-based fault decision.
 * The customer is refunded by ABU9 immediately. Recovery from a partner is NEVER an immediate
 * deduction: a compensation claim is opened that becomes deductible only per contract terms and
 * after the dispute window, or is absorbed by ABU9.
 */
export async function resolveTicket(app: AppContext, ticketId: string, d: { faultParty: FaultParty; refundAmount: number; actorId: string | null; note?: string }): Promise<{ refundId: string | null; claimId: string | null }> {
  const t = (await app.db.query<{ id: string; order_id: string; status: string; reason_code: string; user_id: string }>("select * from support_tickets where id = $1", [ticketId])).rows[0];
  if (!t) throw notFound("ticket");
  if (t.status === "resolved" || t.status === "rejected") throw conflict("ticket_closed");
  const order = (await app.db.query<{ id: string; restaurant_id: string; total: number; pricing: { basicDeliveryFee: number; additionalDistanceFee: number; plusDiscount: number; vatOnPlatformFees: number; serviceFee: number; smallOrderFee: number }; customer_id: string }>("select * from orders where id = $1", [t.order_id])).rows[0]!;
  const payment = (await app.db.query<{ id: string; provider_ref: string; captured_amount: number; refunded_amount: number }>("select * from payments where order_id = $1 and purpose = 'order' and status in ('captured','partially_refunded')", [t.order_id])).rows[0];

  let refundId: string | null = null;
  let claimId: string | null = null;
  if (d.refundAmount > 0) {
    if (!payment) throw new ApiError(409, "no_captured_payment");
    const refundable = payment.captured_amount - payment.refunded_amount;
    if (d.refundAmount > refundable) throw new ApiError(422, "refund_exceeds_captured", `max ${refundable}`);
    const pr = order.pricing;
    const fees = pr.basicDeliveryFee + pr.additionalDistanceFee - pr.plusDiscount + pr.serviceFee + pr.smallOrderFee;
    // Fee portion refunded proportionally (fees are ABU9 revenue; food portion is compensation expense).
    const feePortion = Math.round((fees * d.refundAmount) / order.total);
    const feeVat = Math.round((pr.vatOnPlatformFees * d.refundAmount) / order.total);
    const ins = (await app.db.query<{ id: string }>(
      "insert into refunds(payment_id, order_id, ticket_id, amount, reason_code, fault_party, funding, created_by) values ($1,$2,$3,$4,$5,$6,'abu9',$7) returning id",
      [payment.id, order.id, t.id, d.refundAmount, t.reason_code, d.faultParty, d.actorId],
    )).rows[0]!;
    refundId = ins.id;
    const psp = await app.payments.refund(payment.provider_ref, d.refundAmount, `refund:${refundId}`);
    if (psp.status !== "refunded") {
      await app.db.query("update refunds set status = 'failed' where id = $1", [refundId]);
      throw new ApiError(502, "refund_failed");
    }
    await app.db.tx(async (q) => {
      await q.query("update refunds set status = 'succeeded', provider_ref = $2 where id = $1", [refundId, psp.providerRef]);
      await q.query(
        "update payments set refunded_amount = refunded_amount + $2, status = case when refunded_amount + $2 >= captured_amount then 'refunded' else 'partially_refunded' end, updated_at = now() where id = $1",
        [payment.id, d.refundAmount],
      );
      await postEntry(q, postCustomerRefund({ refundId: refundId!, orderId: order.id, occurredAt: app.now(), amount: d.refundAmount, funding: "abu9", restaurantId: order.restaurant_id, platformFeePortion: feePortion, platformFeeVatPortion: feeVat }));
      await reverseLoyaltyForRefund(q, order.id, order.customer_id, Math.round((d.refundAmount * 10_000) / order.total));

      // Recovery path
      if (d.faultParty === "restaurant" || d.faultParty === "logistics") {
        const partyId = d.faultParty === "restaurant" ? order.restaurant_id : (await q.query<{ company_id: string }>("select company_id from delivery_jobs where order_id = $1 and company_id is not null order by created_at desc limit 1", [order.id])).rows[0]?.company_id;
        if (partyId) {
          const terms =
            d.faultParty === "restaurant"
              ? (await q.query<{ auto_deduct_reason_codes: string[]; dispute_window_hours: number }>("select * from restaurant_contract_terms where restaurant_id = $1 and signed_at is not null", [partyId])).rows[0]
              : (await q.query<{ auto_deduct_reason_codes: string[]; dispute_window_hours: number }>("select * from logistics_contracts where company_id = $1 order by effective_from desc limit 1", [partyId])).rows[0];
          const path = recoveryPath({ fault: d.faultParty, reasonCode: t.reason_code, openedAt: app.now(), terms: terms ? { autoDeductReasonCodes: terms.auto_deduct_reason_codes, disputeWindowHours: terms.dispute_window_hours } : null });
          const foodPortion = d.refundAmount - feePortion;
          claimId = (await q.query<{ id: string }>(
            "insert into compensation_claims(order_id, refund_id, party_type, party_id, amount, reason_code, status, deductible_after) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
            [order.id, refundId, d.faultParty, partyId, Math.max(1, d.faultParty === "restaurant" ? foodPortion : d.refundAmount), t.reason_code, path.kind === "claim_pending" ? "open" : "absorbed", path.kind === "claim_pending" ? path.deductibleAfter : null],
          )).rows[0]!.id;
        }
      }
    });
  }
  await app.db.tx(async (q) => {
    await q.query("update support_tickets set status = 'resolved', fault_party = $2, resolution = $3, resolved_by = $4, resolved_at = now() where id = $1", [ticketId, d.faultParty, { refundAmount: d.refundAmount, refundId, claimId, note: d.note ?? null }, d.actorId]);
    await notify(app, q, t.user_id, { kind: "ticket_resolved", titleAr: d.refundAmount > 0 ? `تم استرداد ${(d.refundAmount / 100).toFixed(2)} ر.س` : "تم إغلاق طلب الدعم", data: { ticketId } });
  });
  return { refundId, claimId };
}

async function reverseLoyaltyForRefund(q: Queryable, orderId: string, userId: string, shareBps: number) {
  const earned = (await q.query<{ n: number }>("select coalesce(sum(delta),0)::int n from points_transactions where order_id = $1 and kind in ('earn','campaign_earn')", [orderId])).rows[0]!.n;
  const reversed = (await q.query<{ n: number }>("select coalesce(-sum(delta),0)::int n from points_transactions where order_id = $1 and kind = 'reverse'", [orderId])).rows[0]!.n;
  const adj = refundAdjustments({ earnedOnOrder: earned, redeemedOnOrder: 0, refundShareBps: Math.min(10_000, shareBps) });
  const toReverse = Math.min(adj.reverseEarned, earned - reversed);
  if (toReverse <= 0) return;
  let left = toReverse;
  for (const lot of (await q.query<{ id: string; remaining: number }>("select id, remaining from points_lots where order_id = $1 and remaining > 0", [orderId])).rows) {
    const take = Math.min(left, lot.remaining);
    await q.query("update points_lots set remaining = remaining - $2 where id = $1", [lot.id, take]);
    left -= take;
  }
  // If points were already spent, the balance goes negative and future earnings net it off.
  await q.query("insert into points_transactions(user_id, delta, kind, order_id, note) values ($1,$2,'reverse',$3,'refund')", [userId, -toReverse, orderId]);
  void DEFAULT_LOYALTY;
}

/** Partner disputes a claim inside the window → it can no longer be auto-deducted. */
export async function disputeClaim(app: AppContext, claimId: string, partyId: string, note: string): Promise<void> {
  const r = await app.db.query("update compensation_claims set status = 'disputed', dispute_note = $3 where id = $1 and party_id = $2 and status = 'open'", [claimId, partyId, note]);
  if (!r.rowCount) throw conflict("claim_not_disputable");
}

/** Ops resolves a disputed claim: accepted (partner pays) or rejected (ABU9 absorbs). */
export async function decideClaim(app: AppContext, claimId: string, accept: boolean, actorId: string): Promise<void> {
  const r = await app.db.query("update compensation_claims set status = $2, resolved_by = $3, resolved_at = now() where id = $1 and status in ('open','disputed')", [claimId, accept ? "accepted" : "absorbed", actorId]);
  if (!r.rowCount) throw conflict("claim_not_open");
}

/** Called when a settlement that includes the claim is approved: posts the recovery entry. */
export async function postClaimRecovery(app: AppContext, q: Queryable, claimId: string): Promise<void> {
  const c = (await q.query<{ id: string; order_id: string; amount: number; party_type: "restaurant" | "logistics"; party_id: string }>("select * from compensation_claims where id = $1", [claimId])).rows[0]!;
  await postEntry(q, postCompensationRecovery({ claimId: c.id, orderId: c.order_id, occurredAt: app.now(), amount: c.amount, party: { kind: c.party_type, id: c.party_id } }));
  await q.query("update compensation_claims set status = 'deducted', resolved_at = now() where id = $1", [claimId]);
}
