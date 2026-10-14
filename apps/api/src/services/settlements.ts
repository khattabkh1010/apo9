import { buildStatement, monthlyPeriodContaining, weeklyPeriodContaining, type Period, type SettlementLineInput } from "../../../../packages/domain/src/settlements.ts";
import { postPayout } from "../../../../packages/domain/src/ledger.ts";
import type { AppContext } from "../context.ts";
import { ApiError, conflict, notFound } from "../http/router.ts";
import { postEntry } from "./common.ts";
import { postClaimRecovery } from "./support.ts";

/**
 * Settlement statements are derived from the ledger (source of truth), not from order totals.
 *  - Restaurants: weekly (Sun–Sat, Riyadh). Lines = credits/debits on the merchant payable account.
 *  - Logistics: monthly. Lines = delivery cost accruals on the logistics payable account.
 * Deductions for compensation claims are applied only when contractually deductible and undisputed;
 * disputed claims are shown as withheld-from-deduction (not deducted) and undisputed balances are paid in full.
 */
export async function generateSettlement(app: AppContext, partyType: "restaurant" | "logistics", partyId: string, period: Period): Promise<{ id: string }> {
  const account = partyType === "restaurant" ? `liability:merchant_payable:${partyId}` : `liability:logistics_payable:${partyId}`;
  const ledgerLines = (
    await app.db.query<{ entry_id: string; event_type: string; ref_id: string; debit: number; credit: number }>(
      `select e.id entry_id, e.event_type, e.ref_id, l.debit, l.credit from journal_lines l join journal_entries e on e.id = l.entry_id
       where l.account_code = $1 and e.occurred_at >= $2 and e.occurred_at < $3 and e.event_type not in ('settlement.paid','compensation.recovered')`,
      [account, period.start, period.end],
    )
  ).rows;
  const lines: SettlementLineInput[] = ledgerLines.map((l) => ({
    kind: l.event_type === "refund.issued" ? "refund_authorized" : l.event_type.endsWith(".reversal") ? "adjustment" : "order_payable",
    amount: l.credit - l.debit,
    refId: l.ref_id,
    disputed: false,
  }));
  // Claims: deductible (window passed, undisputed, contract-authorised) → deduction; disputed → withheld from deduction.
  const claims = (await app.db.query<{ id: string; amount: number; status: string; deductible_after: Date | null }>(
    "select id, amount, status, deductible_after from compensation_claims where party_type = $1 and party_id = $2 and status in ('open','disputed','accepted')",
    [partyType, partyId],
  )).rows;
  const now = app.now();
  for (const c of claims) {
    const deductible = c.status === "accepted" || (c.status === "open" && c.deductible_after !== null && c.deductible_after <= now);
    if (deductible) lines.push({ kind: "compensation_recovery", amount: -c.amount, refId: `claim:${c.id}`, disputed: false });
    else if (c.status === "disputed") lines.push({ kind: "compensation_recovery", amount: -c.amount, refId: `claim:${c.id}`, disputed: true });
  }
  let allowNetting = false;
  if (partyType === "restaurant") {
    allowNetting = (await app.db.query<{ allow_subscription_netting: boolean }>("select allow_subscription_netting from restaurant_contract_terms where restaurant_id = $1", [partyId])).rows[0]?.allow_subscription_netting ?? false;
    const openInv = (await app.db.query<{ id: string; amount: number }>("select id, amount from restaurant_invoices where restaurant_id = $1 and status = 'open'", [partyId])).rows;
    for (const i of openInv) lines.push({ kind: "subscription_invoice_netting", amount: -i.amount, refId: `invoice:${i.id}`, disputed: false });
  }
  const st = buildStatement(lines, { allowSubscriptionNetting: allowNetting });
  const orderCount = new Set(ledgerLines.filter((l) => l.event_type === "order.captured" || l.event_type === "delivery.cost_accrued").map((l) => l.ref_id)).size;
  const row = (await app.db.query<{ id: string; status: string }>(
    `insert into settlements(party_type, party_id, period_start, period_end, gross, deductions, withheld_disputed, net_payable, order_count, statement)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (party_type, party_id, period_start) do update set gross = $5, deductions = $6, withheld_disputed = $7, net_payable = $8, order_count = $9, statement = $10
       where settlements.status = 'draft'
     returning id, status`,
    [partyType, partyId, period.start, period.end, st.gross, st.deductions, st.withheldDisputed, st.netPayable, orderCount, { lines: st.lines, withheld: lines.filter((l) => l.disputed) }],
  )).rows[0];
  if (!row) throw conflict("settlement_locked", "settlement already approved");
  return { id: row.id };
}

export function periodFor(partyType: "restaurant" | "logistics", at: Date): Period {
  return partyType === "restaurant" ? weeklyPeriodContaining(at) : monthlyPeriodContaining(at);
}

export async function approveSettlement(app: AppContext, id: string, actorId: string): Promise<void> {
  await app.db.tx(async (q) => {
    const s = (await q.query<{ status: string; statement: { lines: SettlementLineInput[] } }>("select status, statement from settlements where id = $1 for update", [id])).rows[0];
    if (!s) throw notFound("settlement");
    if (s.status !== "draft") throw conflict("not_draft");
    const party = (await q.query<{ party_id: string }>("select party_id from settlements where id = $1", [id])).rows[0]!.party_id;
    for (const l of s.statement.lines) {
      if (l.kind === "compensation_recovery") await postClaimRecovery(app, q, l.refId.replace("claim:", ""));
      if (l.kind === "subscription_invoice_netting") {
        // Contract allows netting: clear the invoice receivable against the payable.
        const invId = l.refId.replace("invoice:", "");
        await postEntry(q, {
          eventKey: `invoice.netted:${invId}`, eventType: "restaurant_subscription.netted", occurredAt: app.now(), description: `Invoice ${invId} netted in settlement ${id}`,
          refType: "restaurant_invoice", refId: invId,
          lines: [{ account: `liability:merchant_payable:${party}`, debit: -l.amount, credit: 0 }, { account: `asset:merchant_receivable:${party}`, debit: 0, credit: -l.amount }],
        });
        await q.query("update restaurant_invoices set status = 'paid' where id = $1", [invId]);
      }
    }
    await q.query("update settlements set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [id, actorId]);
  });
}

/**
 * Mark paid after the bank transfer is executed. Bank payout integration (e.g. SARIE via the
 * company bank's API) is NOT implemented — finance executes the transfer and records the reference.
 */
export async function markSettlementPaid(app: AppContext, id: string, payoutRef: string, actorId: string): Promise<void> {
  await app.db.tx(async (q) => {
    const s = (await q.query<{ status: string; party_type: "restaurant" | "logistics"; party_id: string; net_payable: number; approved_by: string | null }>("select * from settlements where id = $1 for update", [id])).rows[0];
    if (!s) throw notFound("settlement");
    if (s.status !== "approved") throw conflict("not_approved");
    // Four-eyes: approving a statement and releasing the money are done by different people.
    if (s.approved_by === actorId) throw new ApiError(403, "four_eyes_required", "من اعتمد الكشف لا يسجّل الدفع");
    if (s.net_payable > 0) await postEntry(q, postPayout({ payoutId: id, party: { kind: s.party_type, id: s.party_id }, amount: s.net_payable, occurredAt: app.now() }));
    await q.query("update settlements set status = 'paid', paid_at = now(), payout_ref = $2, paid_by = $3 where id = $1", [id, payoutRef, actorId]);
  });
}

/**
 * Reconciliation checks. Each returns rows that need a human look; an empty result means reconciled.
 */
export async function reconcile(app: AppContext) {
  const q = app.db;
  const [captureMismatch, missingCapture, missingDeliveryCost, trial, pspVsLedger] = await Promise.all([
    q.query(
      `select p.order_id, p.captured_amount, coalesce(sum(l.debit),0)::bigint ledger_debit from payments p
       left join journal_entries e on e.event_key = 'order.captured:' || p.order_id
       left join journal_lines l on l.entry_id = e.id and l.account_code = 'asset:psp_clearing'
       where p.purpose = 'order' and p.status in ('captured','refunded','partially_refunded')
       group by p.order_id, p.captured_amount having p.captured_amount <> coalesce(sum(l.debit),0)`,
    ),
    q.query(
      `select o.id, o.number, o.status from orders o where o.status in ('accepted','preparing','ready_for_pickup','picked_up','delivered')
       and not exists (select 1 from journal_entries e where e.event_key = 'order.captured:' || o.id)`,
    ),
    q.query(
      `select j.id job_id, o.number from delivery_jobs j join orders o on o.id = j.order_id where j.status = 'delivered'
       and not exists (select 1 from journal_entries e where e.event_key = 'delivery.cost:' || j.id)`,
    ),
    q.query<{ debit: number; credit: number }>("select coalesce(sum(debit),0)::bigint debit, coalesce(sum(credit),0)::bigint credit from journal_lines"),
    q.query<{ psp_net: number; ledger_psp: number }>(
      `select (select coalesce(sum(captured_amount - refunded_amount),0) from payments)::bigint psp_net,
              (select coalesce(sum(debit - credit),0) from journal_lines where account_code = 'asset:psp_clearing')::bigint ledger_psp`,
    ),
  ]);
  const t = trial.rows[0]!;
  const p = pspVsLedger.rows[0]!;
  return {
    trialBalanced: t.debit === t.credit,
    trial: t,
    pspClearing: { pspNetCaptured: p.psp_net, ledgerBalance: p.ledger_psp, matches: p.psp_net === p.ledger_psp, note: "PSP settlement files (to bank) are not yet ingested — see launch blockers" },
    captureMismatches: captureMismatch.rows,
    ordersMissingCaptureEntry: missingCapture.rows,
    deliveriesMissingCostEntry: missingDeliveryCost.rows,
  };
}
