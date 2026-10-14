/**
 * Money is always represented as an integer number of halalas (1 SAR = 100 halalas).
 * Never use floating point for stored or summed monetary values.
 */
export type Halalas = number;

export const HALALAS_PER_SAR = 100;

export function sar(amount: number): Halalas {
  return Math.round(amount * HALALAS_PER_SAR);
}

export function toSar(h: Halalas): number {
  return h / HALALAS_PER_SAR;
}

export function assertHalalas(value: number, label = "amount"): Halalas {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer number of halalas, got ${value}`);
  }
  return value;
}

/** Round a fractional halala value using banker's rounding (round half to even) to avoid systematic bias. */
export function roundHalalas(value: number): Halalas {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

/**
 * Extract the VAT component from a VAT-inclusive amount.
 * KSA consumer prices are displayed VAT-inclusive; rate is configurable (currently 15%).
 */
export function vatIncluded(grossInclusive: Halalas, rateBps: number): Halalas {
  if (rateBps <= 0) return 0;
  return roundHalalas((grossInclusive * rateBps) / (10_000 + rateBps));
}

/**
 * Split an amount into parts proportional to weights, guaranteeing the parts sum exactly
 * to the total (largest-remainder method). Used for e.g. splitting a promotion's cost
 * between ABU9 and a restaurant.
 */
export function allocate(total: Halalas, weights: number[]): Halalas[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error("allocate: weights must sum to a positive number");
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map((r) => Math.floor(r));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) {
    parts[order[k]!.i]! += 1;
  }
  return parts;
}

/** Format halalas as a localized SAR string, Arabic by default. */
export function formatSar(h: Halalas, locale: "ar" | "en" = "ar"): string {
  const value = toSar(h);
  if (locale === "ar") {
    const n = new Intl.NumberFormat("ar-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    return `${n} ر.س`;
  }
  const n = new Intl.NumberFormat("en-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  return `SAR ${n}`;
}
