/**
 * Builds the six web apps with esbuild (React 19, automatic JSX runtime).
 * Output: apps/web/dist/{customer,courier,restaurant,logistics,creator,admin}.html + assets/.
 *   node apps/web/build.ts           production build
 *   node apps/web/build.ts --watch   rebuild on change
 */
import { build, context, type BuildOptions } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

const css = tokensToCss() + "\n" + readFileSync(path.join(root, "src/shared/base.css"), "utf8");
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
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Readex+Pro:wght@400;600;700&display=swap">
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
