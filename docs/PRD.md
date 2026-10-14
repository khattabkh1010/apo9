# ABU9 — Product Requirements (v0.1, MVP foundation)

## 1. Problem and positioning
Riyadh diners discover food on short-form video, then leave to order elsewhere. Restaurants pay 15–30% basket commissions to aggregators. ABU9 closes the loop — **order directly from the video** — and charges restaurants a **flat monthly subscription instead of a percentage of the basket**. Delivery is executed by partner logistics companies under ABU9's dispatch and service standards.

Launch: a few dense Riyadh districts (seeded: Olaya, Al Malqa, Hittin, Al Yasmin). Expansion only when on-time rate and unit economics hold.

## 2. Users and systems
| System | Primary users | Job |
|---|---|---|
| Customer app | Riyadh diners | Watch, discover, order, track, get help |
| Courier app | Partner couriers | Run assigned trips with verified pickup/handover |
| Restaurant dashboard | Owners, managers | Accept/prepare orders, manage menu, content, promotions, billing |
| Logistics portal | Partner companies | Manage couriers & capacity, see performance and monthly settlements |
| Creator portal | Food creators | Upload videos linked to dishes, referral codes, opt-in campaigns |
| Admin / operations | ABU9 ops, finance | Control tower: orders, dispatch, coverage, money, moderation, audit |

## 3. Core flow (implemented end-to-end)
1. Feed shows approved videos, ranked deliverable-to-you first; each carries linked dishes.
2. One tap adds a dish (or opens a customisation sheet if options are required). Cart is single-restaurant.
3. Checkout gets an **authoritative server quote**: coverage, ETA range, transparent price lines.
4. Order placement is idempotent; the payment is **authorised**; the restaurant sees it live.
5. Restaurant accepts with a prep time → payment **captured** → ledger entry → **dispatch starts immediately**, aligned to the food-ready time.
6. Courier: arrive → pickup (restaurant code) → arrive → deliver (customer code). Live location while on the way.
7. Delivery completion accrues logistics cost per order, awards loyalty points, records creator attribution.

## 4. Approved business rules encoded in the system
- **ABU9+**: unlimited eligible orders; full discount of the **basic delivery fee (first 2 km)**; customer pays additional distance; eligible basket ≥ **SAR 35 after food discounts, before delivery charges**; active coverage only; no hidden monthly cap. Not free delivery at any distance.
- ABU9+ prices **19.99 / 24.99 / 29.99 SAR** are **test variants** with sticky per-user assignment; weights are configurable and audited.
- Restaurant plans (proposals): Starter 699 (≤300), Growth 999 (301–1,000), Pro 1,899 (1,001–3,000), Enterprise custom. **30-day free trial from activation.** Plan changes are **proposed at cycle close and applied at renewal only with owner consent** — never mid-cycle charges.
- **No percentage commission on food.** Food money is recorded as a **liability to the restaurant**, never ABU9 revenue.
- Coverage is **per branch × zone** (road distance, travel time, prep, courier capacity, SLA, delivery cost ceiling). No global radius.
- Batching: max **2** orders per courier (hard cap), detour ≤ **2 km** and added delay ≤ **7 min** for the existing order (configurable), **never knowingly break a promised deadline**, accounting stays per order.
- Refunds: customer resolved fast and **funded by ABU9 first**. Partner recovery only via a **compensation claim** that is deductible solely when the contract authorises that reason code **and** the dispute window passes undisputed. Disputed claims are withheld from deduction; undisputed balances are paid in full.
- Settlements: restaurants **weekly** (Sun–Sat, Riyadh), logistics **monthly**.
- Every sensitive operational or financial change writes an append-only audit row.

## 5. Assumptions made (documented, reversible)
| Area | Assumption | Where to change |
|---|---|---|
| Delivery fee | SAR 9 basic (first 2 km) + SAR 1 per started 0.5 km, capped at SAR 15; no service fee | Admin › pricing (versioned) |
| VAT | Consumer prices VAT-inclusive at 15%; restaurant plan prices quoted excl. VAT | pricing config / jobs.ts — **needs tax advisor** |
| Acceptance timeout | 240 s, then auto-reject with no charge | `platform_settings.restaurant_acceptance_timeout_s` |
| Payment timing | Authorise at placement, capture at restaurant acceptance, void on rejection | services/orders.ts |
| Loyalty | 1 point per SAR food net; 100 points = SAR 1; redeem ≥500 pts up to 30% of food; 365-day expiry; 2,000 pts/day cap | `platform_settings.loyalty` |
| ABU9+ refund | Full refund if cancelled within 7 days with zero benefit use; otherwise benefits run to period end | domain/subscriptions.ts |
| ABU9+ grace | 3 days of benefits after a failed renewal | domain/subscriptions.ts |
| Auto-refunds | Instant for eligible reason codes ≤ SAR 50 and ≤ 2 refunds/30 days; above that, agent review | services/support.ts |
| Attribution | Referral code wins; else the video the order came from | services/orders.ts |
| Feed ranking | deliverable first, then (likes×3 + views/100) with age decay — no personalisation | modules/catalog.ts |
| Restaurant onboarding | Self-serve application (CR 10 digits; VAT optional, 15 digits starting and ending with 3). Activation needs a profile, ≥1 branch with hours, ≥1 category with ≥3 priced items, acceptance of the **draft** terms, and ops-configured coverage. The trial starts at activation on Starter. A new restaurant's contract has **no** auto-deduction reason codes | domain/onboarding.ts, modules/onboarding.ts |
| Creator campaigns | Incentive SAR 1–50 per attributed order or ≤30% of food value; a budget is required for paid incentives; ≤90 days. Restaurants fund only their own campaigns; ABU9 or shared funding is proposed by ops. Every campaign is approved by someone other than its proposer | domain/creators.ts |
| Separation of duties | Settlement approver ≠ payout recorder; campaign proposer ≠ approver | services/settlements.ts, modules/campaigns.ts |
| Staff security | TOTP required for ops, finance and admin roles | modules/identity.ts |

## 6. Open decisions for the founders (material — not decided in code)
1. Final ABU9+ price and annual plan; final restaurant plan prices and annual discount.
2. **What happens when a restaurant exceeds its plan volume and declines the upgrade** (stay, overage fee, or cap)? The system currently proposes and waits.
3. Whether subscription invoices may be netted against payouts (per-contract flag exists, default **off**).
4. Marketplace VAT model (agent vs principal for delivery and food) and ZATCA e-invoicing scope.
5. Courier-facing earnings display: today only company-level per-order amounts are shown (partners set courier pay).
6. Customer cancellation after acceptance (currently: via support only).
7. Restaurant subscription terms: the in-app acceptance records the version `restaurant-subscription-v0-draft`. Legal must approve final terms (including any auto-deduction reason codes) before real restaurants sign.
8. Creator incentive payout mechanics (who pays creators, when, and how it is invoiced and taxed). Incentives are accrued as `pending` only.

## 7. Out of scope for this MVP foundation
Native mobile builds, real maps/routing, push notifications, live PSP/SMS, bank payouts, ML ranking/ETAs, multi-city. See BACKLOG.md.
