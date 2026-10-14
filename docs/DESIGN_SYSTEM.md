# ABU9 design system

Source of truth: `packages/design-tokens/src/tokens.ts` → emitted as CSS variables; components in `apps/web/src/shared/ui.tsx` and `base.css`. Change the brand there and every app follows.

## Identity
- **Najd Ink `#1C1633`** — deep aubergine night; feed and dark surfaces.
- **Saffron `#F2B230`** — the only action colour (add, order, accept). If it is saffron, you can press it.
- **Sadu Red `#C23B2E`** — brand mark and alerts only.
- **Mist `#F3F2F7`** — cool working surface for dashboards (deliberately not cream).
- **Palm `#1E7A58`** — delivered / success.
- The **Sadu weave band** (alternating red/saffron triangles) is the single cultural motif: it is the order tracker's progress bar and appears on the ABU9+ card. It is not used decoratively elsewhere.

## Type
- Display: **Readex Pro** (geometric Arabic + Latin) for headings, prices, codes, KPIs.
- Body/UI: **IBM Plex Sans Arabic**.
- Scale 1.25 from 16 px: 12 · 14 · 16 · 20 · 25 · 31 · 48. Western digits for prices, codes and times (`.num`, isolated LTR).
- Fonts load from Google Fonts with system fallbacks (self-host before launch — CSP).

## Layout rules
- Arabic-first: `dir="rtl"` by default, **logical CSS properties only** (`margin-inline-start`, `inset-inline-end`), so English (LTR) works without overrides.
- Phone apps: single column ≤ 480 px, bottom tab bar (44 px+ targets), sheets for decisions.
- Dashboards: right-side nav rail (RTL), hairline-separated tables, white panels; no shadows, no gradient decoration. KPI strips are a single joined band.
- Every list has loading (skeleton), empty (what to do next) and error (what happened + retry) states via `Loadable`.

## Components
Button (`primary` saffron, `dark`, `danger`, `ghost`; `lg`, `sm`, `block`), Field/Input (+ `code` variant for OTP and handover codes), Badge (`ok`/`warn`/`bad`/`live` pulse), StatusBadge (one vocabulary for all order/job/settlement states), Sheet (bottom sheet; centred dialog on desktop), Toast, Sadu, Kpis, PageHead, DashShell, OtpLogin, Empty, ErrorBox, Skeleton, inline stroke icons.

## Motion
One orchestrated moment per surface: sheet rise, new-order ticket rise on the kitchen board, the live pulse on in-progress states. `prefers-reduced-motion` disables all animation.

## Accessibility baseline
Visible saffron focus ring, labelled controls, `aria-live` order status, radio/checkbox semantics for modifiers, 44 px touch targets, contrast-checked pairs (ink on mist, saffron-ink on saffron).

Screenshots of every app: `docs/screenshots/` (regenerate with `npm run screenshots`).
