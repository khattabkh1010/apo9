import { allocate, type Halalas } from "./money.ts";

/**
 * Hybrid loyalty: unified ABU9 points + restaurant-specific reward campaigns.
 * Points are a liability-like promise; their monetary cost is tracked against campaign budgets
 * with explicit funding split between ABU9 and participating restaurants.
 */

export interface LoyaltyProgramConfig {
  /** Points earned per whole SAR of eligible food net (base earn, ABU9-funded). */
  basePointsPerSar: number;
  /** Monetary value of one point, in halalas, when redeemed. 1 = 100 points per SAR. */
  pointValueHalalas: number;
  minRedeemPoints: number;
  /** Max share of food net that can be paid with points (basis points). */
  maxRedeemShareBps: number;
  expiryDays: number;
  /** Fraud guard: maximum points one customer can earn per rolling day. */
  dailyEarnCap: number;
}

export const DEFAULT_LOYALTY: LoyaltyProgramConfig = {
  basePointsPerSar: 1,
  pointValueHalalas: 1,
  minRedeemPoints: 500,
  maxRedeemShareBps: 3000,
  expiryDays: 365,
  dailyEarnCap: 2000,
};

export interface Campaign {
  id: string;
  restaurantId: string | null; // null = platform-wide
  status: "draft" | "active" | "paused" | "exhausted" | "ended";
  multiplier: number; // extra points = base × (multiplier − 1)
  /** Approved budget for the monetary value of extra points issued. */
  budget: Halalas;
  spent: Halalas;
  /** Funding split in basis points; must sum to 10000. */
  abu9ShareBps: number;
  restaurantShareBps: number;
  startsAt: Date;
  endsAt: Date;
}

export interface EarnQuote {
  basePoints: number;
  campaignPoints: number;
  campaignId: string | null;
  campaignCost: Halalas;
  campaignFunding: { abu9: Halalas; restaurant: Halalas };
  cappedByDailyLimit: boolean;
  cappedByBudget: boolean;
}

/**
 * Quote points earned for an order. Campaign extra points are only issued while the
 * campaign has budget remaining — a campaign can never spend beyond its approved budget.
 */
export function quoteEarn(args: {
  eligibleFoodNet: Halalas;
  restaurantId: string;
  campaigns: Campaign[];
  earnedToday: number;
  at: Date;
  cfg?: LoyaltyProgramConfig;
}): EarnQuote {
  const cfg = args.cfg ?? DEFAULT_LOYALTY;
  const wholeSar = Math.floor(args.eligibleFoodNet / 100);
  let basePoints = wholeSar * cfg.basePointsPerSar;
  const headroom = Math.max(0, cfg.dailyEarnCap - args.earnedToday);
  let cappedByDailyLimit = false;
  if (basePoints > headroom) {
    basePoints = headroom;
    cappedByDailyLimit = true;
  }

  const active = args.campaigns
    .filter((c) => c.status === "active" && c.startsAt <= args.at && args.at < c.endsAt)
    .filter((c) => c.restaurantId === null || c.restaurantId === args.restaurantId)
    .sort((a, b) => b.multiplier - a.multiplier || a.id.localeCompare(b.id));
  const campaign = active[0];

  let campaignPoints = 0;
  let cappedByBudget = false;
  if (campaign && campaign.multiplier > 1) {
    const wanted = Math.floor(basePoints * (campaign.multiplier - 1));
    const remainingBudget = Math.max(0, campaign.budget - campaign.spent);
    const affordable = Math.floor(remainingBudget / cfg.pointValueHalalas);
    const headroomLeft = Math.max(0, headroom - basePoints);
    campaignPoints = Math.min(wanted, affordable, headroomLeft);
    if (campaignPoints < wanted && affordable < wanted) cappedByBudget = true;
    if (campaignPoints < wanted && headroomLeft < wanted) cappedByDailyLimit = true;
  }
  const campaignCost = campaignPoints * cfg.pointValueHalalas;
  const [abu9, restaurant] = campaign && campaignCost > 0 ? allocate(campaignCost, [campaign.abu9ShareBps, campaign.restaurantShareBps]) : [0, 0];
  return {
    basePoints,
    campaignPoints,
    campaignId: campaignPoints > 0 && campaign ? campaign.id : null,
    campaignCost,
    campaignFunding: { abu9: abu9 ?? 0, restaurant: restaurant ?? 0 },
    cappedByDailyLimit,
    cappedByBudget,
  };
}

export interface PointsLot {
  id: string;
  remaining: number;
  expiresAt: Date;
}

export interface RedemptionPlan {
  points: number;
  discount: Halalas;
  consumed: Array<{ lotId: string; points: number }>;
}

/** Plan a redemption, consuming soonest-expiring lots first (FIFO by expiry). */
export function planRedemption(args: {
  requestedPoints: number;
  foodNet: Halalas;
  lots: PointsLot[];
  at: Date;
  cfg?: LoyaltyProgramConfig;
}): RedemptionPlan {
  const cfg = args.cfg ?? DEFAULT_LOYALTY;
  const live = args.lots.filter((l) => l.remaining > 0 && l.expiresAt > args.at).sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  const available = live.reduce((a, l) => a + l.remaining, 0);
  if (args.requestedPoints < cfg.minRedeemPoints) throw new LoyaltyError("below_minimum_redemption");
  const maxDiscount = Math.floor((args.foodNet * cfg.maxRedeemShareBps) / 10_000);
  const maxPoints = Math.floor(maxDiscount / cfg.pointValueHalalas);
  const points = Math.min(args.requestedPoints, available, maxPoints);
  if (points < cfg.minRedeemPoints) throw new LoyaltyError(available < cfg.minRedeemPoints ? "insufficient_points" : "exceeds_max_share");
  const consumed: RedemptionPlan["consumed"] = [];
  let left = points;
  for (const l of live) {
    if (left === 0) break;
    const take = Math.min(left, l.remaining);
    consumed.push({ lotId: l.id, points: take });
    left -= take;
  }
  return { points, discount: points * cfg.pointValueHalalas, consumed };
}

/**
 * On an eligible refund, points earned on that order are reversed. If the customer already spent
 * them, the balance may go negative; future earnings net it off. Redeemed points on a refunded order
 * are restored to the customer as a new lot.
 */
export function refundAdjustments(args: { earnedOnOrder: number; redeemedOnOrder: number; refundShareBps: number }): { reverseEarned: number; restoreRedeemed: number } {
  return {
    reverseEarned: Math.floor((args.earnedOnOrder * args.refundShareBps) / 10_000),
    restoreRedeemed: Math.floor((args.redeemedOnOrder * args.refundShareBps) / 10_000),
  };
}

export class LoyaltyError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
