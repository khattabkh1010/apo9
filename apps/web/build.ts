/**
 * Builds the six web apps with esbuild (React 19, automatic JSX runtime).
 * Output: apps/web/dist/{customer,courier,restaurant,logistics,creator,admin}.html + assets/.
 *   node apps/web/build.ts           production build
 *   node apps/web/build.ts --watch   rebuild on change
 */
import { build, context, type BuildOptions } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tokensToCss } from "../../packages/design-tokens/src/tokens.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const APPS = [
  { name: "customer", titleAr: "أبو9", theme: "#1C1633" },
  { name: "courier", titleAr: "أبو9 — المندوب", theme: "#1C1633" },
  { name: "restaurant", titleAr: "أبو9 للمطاعم", theme: "#FFFFFF" },
  { name: "logistics", titleAr: "أبو9 لشركاء التوصيل", theme: "#FFFFFF" },
  { name: "creator", titleAr: "أبو9 لصنّاع المحتوى", theme: "#FFFFFF" },
  { name: "admin", titleAr: "أبو9 — مركز العمليات", theme: "#FFFFFF" },
];

const watch = process.argv.includes("--watch");
rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, "assets"), { recursive: true });

// Self-hosted fonts (no third-party requests; required by the strict CSP). Arabic + Latin subsets only.
const FONTS: Array<[pkg: string, weights: number[]]> = [
  ["ibm-plex-sans-arabic", [400, 500, 600, 700]],
  ["readex-pro", [400, 600, 700]],
];
mkdirSync(path.join(dist, "assets/fonts"), { recursive: true });
let fontCss = "";
for (const [pkg, weights] of FONTS) {
  const dir = path.join(root, "../../node_modules/@fontsource", pkg);
  for (const w of weights) {
    for (const block of readFileSync(path.join(dir, `${w}.css`), "utf8").split("/* ").slice(1)) {
      const name = block.slice(0, block.indexOf(" */"));
      if (!/-(arabic|latin)-\d+-normal$/.test(name)) continue;
      copyFileSync(path.join(dir, "files", `${name}.woff2`), path.join(dist, "assets/fonts", `${name}.woff2`));
      fontCss += block
        .slice(block.indexOf("@font-face"))
        .replace(/src: [^;]+;/, `src: url(/assets/fonts/${name}.woff2) format('woff2');`);
    }
  }
}

const css = fontCss + "\n" + tokensToCss() + "\n" + readFileSync(path.join(root, "src/shared/base.css"), "utf8");
writeFileSync(path.join(dist, "assets/abu9.css"), css);
writeFileSync(path.join(dist, "favicon.svg"), readFileSync(path.join(root, "src/shared/favicon.svg")));

const opts: BuildOptions = {
  entryPoints: Object.fromEntries(APPS.map((a) => [a.name, path.join(root, `src/${a.name}/main.tsx`)])),
  bundle: true,
  outdir: path.join(dist, "assets"),
  format: "esm",
  splitting: true,
  jsx: "automatic",
  target: ["es2022", "safari16"],
  minify: !watch,
  sourcemap: watch ? "inline" : "linked",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  logLevel: "info",
  nodePaths: [path.join(root, "../../node_modules")],
};

for (const a of APPS) {
  writeFileSync(
    path.join(dist, `${a.name}.html`),
    `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${a.theme}">
<title>${a.titleAr}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/abu9.css">
</head>
<body class="app-${a.name}">
<div id="root"></div>
<script type="module" src="/assets/${a.name}.js"></script>
</body>
</html>`,
  );
}

if (watch) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("watching web apps…");
} else {
  await build(opts);
  console.log(`built ${APPS.length} web apps → ${path.relative(process.cwd(), dist)}`);
}
