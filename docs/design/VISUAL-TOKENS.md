# Visual tokens (renderer)

Date: 2026-11-05. Extends the v1 visual rule in `DESIGN-v1-archive.md` §7.3 (warm paper theme, forest green,
10px radius, 1px borders, light shadows, CSS variables, no Tailwind).

Source of truth: the `:root` block (light) and the `@media (prefers-color-scheme: dark)` `:root` block at the top of
`src/renderer/src/styles/app.css`. Everything before the first `* {` rule is the token section.

## Rule

Component CSS and inline styles use **tokens only**. A literal hex / rgba / px radius / px font-size outside
the token section is a bug. Derived translucency uses `color-mix(in srgb, var(--token) N%, transparent)` so the
dark theme only redefines tokens.

Exceptions: `border-radius: 50%` for dots; `QrSvg.tsx` / `main/identity/qr.ts` stay black-on-white in both themes
(scanners need it); the Weekly Review export (`main/het/weekly.ts`) is a standalone light HTML file.

Check:

```bash
python3 - <<'EOF'
import re, glob
for f in glob.glob('src/renderer/src/**/*.css', recursive=True):
    t = open(f).read()
    if f.endswith('styles/app.css'):
        t = t[t.index('\n* {'):].replace('a[href] {\n  cursor: pointer;\n}', '')
    bad = re.findall(r'#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|border-radius:\s*\d[^;]*|font-size:\s*\d[^;]*|cursor:\s*pointer', t)
    bad = [b for b in bad if b != 'border-radius: 50%']
    if bad:
        print(f, bad)
EOF
```

## Scales

| Group | Tokens | Use |
|---|---|---|
| Radius | `--radius-xs` 4 · `--radius-sm` 6 · `--radius-md` 10 · `--radius-lg` 14 · `--radius-pill` | xs: code, bars, heat cells · sm: buttons, inputs, nav rows, images · md: cards, banners, inner tiles · lg: modals, sheets, the Personal Card object · pill: chips |
| Type | `--fs-2xs` 10 · `xs` 11 · `sm` 12 · `base` 13 · `md` 14 · `lg` 16 · `xl` 20 · `2xl` 22 | Body is 13 (macOS). No half-pixel sizes. Page title 22 / 650. |
| Elevation | `--shadow-xs` · `--shadow-md` · `--shadow-lg` · `--focus-ring` | xs: resting cards / buttons · md: popovers, the card object · lg: drawers, modals |
| Scrims | `--scrim` · `--scrim-strong` | drawer/modal backdrop · onboarding overlay |
| Motion | `--ease-out` · `--dur-fast` (120ms) | hover/press transitions |

Colors: surfaces (`--bg --sidebar --card --card-2 --fill --fill-subtle`), ink (`--ink --muted --faint
--on-accent`), lines (`--line --line-strong`), accent and status (`--accent --accent-strong --accent-soft
--accent-line --ok --warn* --bad* --bad-dot --heat-1..3`).

## Native macOS conventions

- Controls use the arrow cursor (`cursor: default`); `pointer` only on `a[href]`.
- App chrome (sidebar, topbar, buttons, chips, table headers) is not text-selectable.
- Sidebar is a source list: single-line 28px rows, active = 9% ink tint; the nav hint is the row tooltip.
- Focus is `:focus-visible` + `--focus-ring`, never a mouse-click outline.
- Tables, stats, chips and code use `tabular-nums`.

## Buttons

`.btn` = push button (border, `--shadow-xs`, 28px). `.btn.primary` = filled accent, one per view.
`.btn.ghost` = borderless accent-colored action, hover `--accent-soft`; use for card-header "go to" actions.
`.btn.small` = 24px. Avoid an arrow on every action label; it is kept for now because the copy lives in TSX.

## Dark theme

Follows the macOS appearance (`prefers-color-scheme`); no in-app toggle. Only tokens are redefined, so component
CSS never needs a dark override. Rules when adding UI:

- Tint with `color-mix(in srgb, var(--ink) N%, transparent)` for hover / selected fills: it lightens in dark and
  darkens in light automatically.
- `--on-accent` is dark text in the dark theme (on a lighter green), white in light. Never hardcode `#fff` on accent.
- Charts take `--series-1..6`; the Mini Map takes `--map-volume` / `--map-face`. Set SVG colors through
  `style={{ fill }}`, not the `fill` attribute, so `var()` always resolves.
- Window background (pre-paint) comes from `src/main/shell/theme.ts` (`WINDOW_BG` must match `--bg` in both themes)
  and follows live appearance changes via `nativeTheme.on('updated')`.

Contrast (WCAG ratio, text on its usual surface): ink/card 12.5, muted/card 5.7, accent/card 6.2,
on-accent/accent 6.7, warn/warn-soft 6.1, bad/bad-soft 5.6. `--faint` (3.3) is decorative only.

## Structure (2026-11-05 "UI pass")

- Sidebar is grouped: `NAV_GROUPS` in `src/renderer/src/lib/navigation.tsx` is the only nav source. Five groups
  (Today / Memory / Capture / Identity & connections / System), 28px rows, 15px Lucide icons. Group labels are 11px `--muted`
  (10px `--faint` failed contrast at 3.4:1 and the 11px text floor), no uppercase tracking; they encode grouping,
  not decoration. `.nav-item[data-page]` survives for e2e.
- ⌘K palette (`components/CommandPalette.tsx`, cmdk + Base UI Dialog) is the escape hatch for the 19 pages;
  the sidebar footer carries a visible Quick jump button. Keep the palette data derived from `NAV_GROUPS`.
- Overlays: `components/Modal.tsx` and `EvidenceDrawer` both wrap Base UI Dialog. Do not hand-roll a backdrop,
  `role="dialog"`, Escape handling or a focus trap again — Base UI owns focus trap, dismissal, scroll lock and
  focus restoration. Enter/exit uses `data-starting-style` / `data-ending-style` + transitions, not keyframes.
- Loading: `components/Skeleton.tsx` for card bodies (same height as the text it replaces). Do not use
  "Loading…" as the only loading state.
- Toasts: `components/Toaster.tsx` (Sonner, tokenised). Copy confirmations and completed writes use
  `copiedToast()` / `doneToast()`; errors stay as inline `.banner` because they need reading time.
- Type scale: page title 24/650, card title 14/600, body 13, eyebrow 11. A stat value is `--ink`; tone classes
  only mark a condition, never decorate a healthy number.
- Motion tokens: `--dur-fast` 120ms (hover), `--dur-base` 180ms (state), `--dur-slow` 240ms (overlay entrance).
  `prefers-reduced-motion` collapses all animation/transition durations globally.
- Anti-pattern removed: the 3px `border-left` accent on `.schema-item.volume` (Impeccable `detect` flagged it).

Screens from this pass: `docs/design/v3-shots/` (home light/dark, Today, settings, ⌘K).

Page-level audit (catches contrast / text-size problems the regex scan cannot):

```bash
npm run build
python3 -m http.server 4900 --directory out/renderer &          # serve the built renderer
# copy to /tmp, drop the CSP meta, inject a stub for window.lens before the bundle, then:
npx impeccable detect http://127.0.0.1:4900/index.html --json
```

The stub is required because the renderer expects the Electron preload bridge; the CSP must go because it
blocks the stub. Keep the audit copy out of the repo.

## Not done (next steps)

- An in-app Light / Dark / System override (would set `nativeTheme.themeSource` from Settings).
- Sidebar vibrancy was considered and skipped: macOS sidebar material is cool gray and clashes with the warm
  paper palette.
- A persistent `DESIGN.md` from `/impeccable document` (the tokens above are still the source of truth).
