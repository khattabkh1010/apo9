/**
 * Saudi mobile numbers: 05XXXXXXXX locally, +9665XXXXXXXX in E.164.
 * Accepts Arabic-Indic digits, spaces, dashes and common prefixes (00966, 966, +966, 05, 5).
 */
export function normalizeSaudiMobile(input: string): string | null {
  const ascii = input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s\-()]/g, "");
  let n = ascii;
  if (n.startsWith("+966")) n = n.slice(4);
  else if (n.startsWith("00966")) n = n.slice(5);
  else if (n.startsWith("966")) n = n.slice(3);
  if (n.startsWith("0")) n = n.slice(1);
  if (!/^5\d{8}$/.test(n)) return null;
  return `+966${n}`;
}

export function formatSaudiMobile(e164: string): string {
  const local = e164.replace(/^\+966/, "0");
  return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}
