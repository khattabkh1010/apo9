/**
 * Restaurant onboarding rules (pure). Onboarding, menu setup and basic training are free;
 * the 30-day trial starts at ACTIVATION, which ops performs once the checklist is complete.
 */

export type OnboardingStepKey = "profile" | "branch" | "hours" | "menu" | "terms" | "coverage";

export interface OnboardingFacts {
  nameAr: string | null;
  cuisineTags: string[];
  crNumber: string | null;
  branches: number;
  branchesWithHours: number;
  pricedItems: number;
  categories: number;
  termsAcceptedAt: Date | null;
  /** Branch–zone coverage rules configured by ops (ABU9 controls coverage). */
  coverageRules: number;
}

export interface OnboardingStep {
  key: OnboardingStepKey;
  done: boolean;
  /** Who completes it: the restaurant itself, or ABU9 operations. */
  owner: "restaurant" | "ops";
  required: boolean;
}

export const MIN_MENU_ITEMS = 3;

export function onboardingChecklist(f: OnboardingFacts): { steps: OnboardingStep[]; readyForActivation: boolean; restaurantStepsDone: boolean } {
  const steps: OnboardingStep[] = [
    { key: "profile", owner: "restaurant", required: true, done: !!f.nameAr && f.cuisineTags.length > 0 && isValidCrNumber(f.crNumber ?? "") },
    { key: "branch", owner: "restaurant", required: true, done: f.branches > 0 },
    { key: "hours", owner: "restaurant", required: true, done: f.branches > 0 && f.branchesWithHours === f.branches },
    { key: "menu", owner: "restaurant", required: true, done: f.categories > 0 && f.pricedItems >= MIN_MENU_ITEMS },
    { key: "terms", owner: "restaurant", required: true, done: !!f.termsAcceptedAt },
    { key: "coverage", owner: "ops", required: true, done: f.coverageRules > 0 },
  ];
  const restaurantStepsDone = steps.filter((s) => s.owner === "restaurant" && s.required).every((s) => s.done);
  return { steps, restaurantStepsDone, readyForActivation: steps.filter((s) => s.required).every((s) => s.done) };
}

/** Saudi Commercial Registration: 10 digits (unified national numbers start with 7). */
export const isValidCrNumber = (s: string) => /^\d{10}$/.test(s);

/** Saudi VAT registration number: 15 digits, starting and ending with 3. */
export const isValidVatNumber = (s: string) => /^3\d{13}3$/.test(s);

export type WeeklyHours = Record<string, Array<[string, string]>>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/**
 * Validates opening hours: keys "0"…"6" (0 = Sunday, Riyadh local time), ranges "HH:MM"–"HH:MM".
 * A close earlier than open wraps past midnight (common in Riyadh: 16:00–02:00). Max 3 ranges/day,
 * ranges within a day must not overlap. Returns a list of problems (empty = valid).
 */
export function validateWeeklyHours(h: WeeklyHours): string[] {
  const problems: string[] = [];
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  for (const [day, ranges] of Object.entries(h)) {
    if (!/^[0-6]$/.test(day)) {
      problems.push(`invalid day ${day}`);
      continue;
    }
    if (ranges.length > 3) problems.push(`day ${day}: at most 3 ranges`);
    const spans: Array<[number, number]> = [];
    for (const [o, c] of ranges) {
      if (!HHMM.test(o) || !HHMM.test(c)) {
        problems.push(`day ${day}: invalid time ${o}-${c}`);
        continue;
      }
      if (o === c) {
        problems.push(`day ${day}: empty range ${o}-${c}`);
        continue;
      }
      const open = toMin(o);
      const close = toMin(c);
      // Overnight ranges occupy [open, 24:00) on this day for overlap purposes.
      spans.push([open, close > open ? close : 1440]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) if (spans[i]![0] < spans[i - 1]![1]) problems.push(`day ${day}: overlapping ranges`);
  }
  return problems;
}

export const hasAnyHours = (h: WeeklyHours) => Object.values(h).some((r) => r.length > 0);

/** URL-safe slug from an English name, with a short suffix to avoid collisions. */
export function restaurantSlug(nameEn: string, suffix: string): string {
  const base = nameEn
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "restaurant"}-${suffix}`;
}
