/**
 * Order lifecycle (customer/restaurant view) and delivery job lifecycle (logistics view) are
 * separate state machines. An order has at most one active delivery job; a job can be
 * reassigned between couriers without changing the order's state.
 */

export const ORDER_STATUSES = [
  "pending_payment",
  "placed",
  "accepted",
  "preparing",
  "ready_for_pickup",
  "picked_up",
  "delivered",
  "rejected",
  "cancelled",
  "delivery_failed",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type Actor = "customer" | "restaurant" | "courier" | "system" | "ops";

interface Transition {
  from: OrderStatus[];
  to: OrderStatus;
  actors: Actor[];
}

const ORDER_TRANSITIONS: Transition[] = [
  { from: ["pending_payment"], to: "placed", actors: ["system"] }, // payment authorized
  { from: ["placed"], to: "accepted", actors: ["restaurant", "ops"] },
  { from: ["placed"], to: "rejected", actors: ["restaurant", "system", "ops"] }, // system = acceptance timeout
  { from: ["accepted"], to: "preparing", actors: ["restaurant", "system"] },
  { from: ["accepted", "preparing"], to: "ready_for_pickup", actors: ["restaurant", "ops"] },
  { from: ["accepted", "preparing", "ready_for_pickup"], to: "picked_up", actors: ["courier", "ops"] },
  { from: ["picked_up"], to: "delivered", actors: ["courier", "ops"] },
  { from: ["picked_up"], to: "delivery_failed", actors: ["courier", "ops"] },
  { from: ["pending_payment", "placed"], to: "cancelled", actors: ["customer", "system", "ops"] },
  { from: ["accepted", "preparing", "ready_for_pickup"], to: "cancelled", actors: ["ops", "restaurant"] },
];

export class TransitionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus, actor: Actor): boolean {
  return ORDER_TRANSITIONS.some((t) => t.to === to && t.from.includes(from) && t.actors.includes(actor));
}

export function assertOrderTransition(from: OrderStatus, to: OrderStatus, actor: Actor): void {
  if (!canTransitionOrder(from, to, actor)) {
    throw new TransitionError("invalid_transition", `Order cannot move ${from} → ${to} by ${actor}`);
  }
}

export function isTerminalOrderStatus(s: OrderStatus): boolean {
  return s === "delivered" || s === "rejected" || s === "cancelled" || s === "delivery_failed";
}

export const DELIVERY_JOB_STATUSES = [
  "unassigned",
  "assigned",
  "at_pickup",
  "picked_up",
  "at_dropoff",
  "delivered",
  "failed",
  "cancelled",
] as const;
export type DeliveryJobStatus = (typeof DELIVERY_JOB_STATUSES)[number];

const JOB_TRANSITIONS: Record<DeliveryJobStatus, DeliveryJobStatus[]> = {
  unassigned: ["assigned", "cancelled"],
  // assigned → unassigned is a reassignment (courier rejected, timed out, or ops override).
  assigned: ["at_pickup", "picked_up", "unassigned", "cancelled"],
  at_pickup: ["picked_up", "unassigned", "cancelled"],
  picked_up: ["at_dropoff", "delivered", "failed"],
  at_dropoff: ["delivered", "failed"],
  delivered: [],
  failed: [],
  cancelled: [],
};

export function assertJobTransition(from: DeliveryJobStatus, to: DeliveryJobStatus): void {
  if (!JOB_TRANSITIONS[from].includes(to)) {
    throw new TransitionError("invalid_job_transition", `Delivery job cannot move ${from} → ${to}`);
  }
}

export const ORDER_STATUS_TEXT: Record<OrderStatus, { ar: string; en: string }> = {
  pending_payment: { ar: "بانتظار الدفع", en: "Awaiting payment" },
  placed: { ar: "بانتظار قبول المطعم", en: "Waiting for restaurant" },
  accepted: { ar: "قبل المطعم طلبك", en: "Restaurant accepted" },
  preparing: { ar: "يتم تحضير طلبك", en: "Preparing your order" },
  ready_for_pickup: { ar: "الطلب جاهز للاستلام", en: "Ready for pickup" },
  picked_up: { ar: "المندوب في الطريق إليك", en: "On the way" },
  delivered: { ar: "تم التوصيل", en: "Delivered" },
  rejected: { ar: "اعتذر المطعم عن الطلب", en: "Restaurant declined" },
  cancelled: { ar: "تم الإلغاء", en: "Cancelled" },
  delivery_failed: { ar: "تعذّر التوصيل", en: "Delivery failed" },
};
