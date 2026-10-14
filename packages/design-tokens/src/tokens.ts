/**
 * ABU9 design tokens — the single source of truth for brand identity.
 * Change the brand here; every app (web now, React Native later) reads these values.
 */
export const tokens = {
  color: {
    ink: "#1C1633", // Najd night — feed & dark surfaces
    ink2: "#2A2347",
    inkSoft: "#4A4560", // body text on light
    mute: "#7C7791",
    line: "#E2E0EA",
    mist: "#F3F2F7", // working surface
    paper: "#FFFFFF",
    saffron: "#F2B230", // the action colour
    saffronDeep: "#C98C0E",
    saffronInk: "#2B1D00", // text on saffron
    sadu: "#C23B2E", // brand mark, alerts
    palm: "#1E7A58", // success / delivered
    palmSoft: "#E3F2EB",
    warnSoft: "#FDF1D6",
    dangerSoft: "#F9E3E0",
  },
  font: {
    display: `"Readex Pro", "IBM Plex Sans Arabic", system-ui, sans-serif`,
    body: `"IBM Plex Sans Arabic", "Readex Pro", system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif`,
  },
  // Modular scale 1.25, base 16
  size: { xs: "12px", sm: "14px", md: "16px", lg: "20px", xl: "25px", xxl: "31px", hero: "48px" },
  space: { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "24px", 6: "32px", 7: "48px" },
  radius: { sm: "6px", md: "10px", lg: "18px", pill: "999px" },
  motion: { fast: "120ms", base: "220ms", ease: "cubic-bezier(.2,.8,.2,1)" },
} as const;

export function tokensToCss(): string {
  const v: string[] = [];
  for (const [k, val] of Object.entries(tokens.color)) v.push(`--c-${k}:${val}`);
  for (const [k, val] of Object.entries(tokens.font)) v.push(`--f-${k}:${val}`);
  for (const [k, val] of Object.entries(tokens.size)) v.push(`--s-${k}:${val}`);
  for (const [k, val] of Object.entries(tokens.space)) v.push(`--sp-${k}:${val}`);
  for (const [k, val] of Object.entries(tokens.radius)) v.push(`--r-${k}:${val}`);
  for (const [k, val] of Object.entries(tokens.motion)) v.push(`--m-${k}:${val}`);
  return `:root{${v.join(";")}}`;
}
