# UI upgrade research: skills and UI/UX kits

Date: 2026-11-05. Used to push Lens from a clean "warm paper + forest green" interface to one that feels more premium and is clearer.
This doc only includes sources **tested/checked on 2026-11-05**; install commands were verified in this machine's environment (DeepSeek Harness + Claude Code).

## TL;DR

- **Skill already installed**: Impeccable (in this project at `.dsh/skills/impeccable`, 19MB including the local engine).
  It ships a deterministic detector that caught a real issue on the first run: the `border-left: 3px` side accent bar in `app.css`.
- **Skills most worth installing next**: `frontend-design` from `anthropics/skills` (design direction, guards against a "template look"),
  `ibelick/ui-skills` (design-engineering baseline), `emil-design-eng` (motion/component feel); use Impeccable's `critique` / `audit` for audits.
- **Kits: install headless primitives only**: Base UI (dialogs/focus/keyboard), Motion (animation), cmdk (⌘K), Sonner (toast).
  **Do not install shadcn/ui itself**: it comes with Tailwind by default, which conflicts with the "tokens only, no Tailwind" rule in this project's `VISUAL-TOKENS.md`.
- **The biggest clarity problem is structure, not color**: 19 flat nav items, 4 kinds of hand-written overlays in `App.tsx`, pages that each re-implement
  loading/empty/error, and stat cards that cram a sentence into large green text. These are the real source of "premium feel".

## 1. Skills (installed into the agent, not into dependencies)

| Skill | Source | What it solves | How to install |
|---|---|---|---|
| **Impeccable** | [impeccable.style](https://impeccable.style) · [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | 24 commands: `critique` (UX scoring), `audit` (a11y/performance/theming), `polish`, `typeset`, `layout`, `distill`, `onboard`, `animate`; 62 deterministic rules that catch an AI-generated feel | Installed (see below). Global: `npx impeccable install --providers=deepseek --scope=global -y` |
| **frontend-design** | [anthropics/skills](https://github.com/anthropics/skills) | Set the visual direction before writing code: palette, fonts, layout, principles; explicitly lists the traits of an "AI-generated look" | Claude Code: `/plugin marketplace add anthropics/skills` → install `example-skills` |
| **ui-skills** (baseline-ui etc.) | [ibelick/ui-skills](https://github.com/ibelick/ui-skills) · [ui-skills.com](https://www.ui-skills.com) | Design-engineering baseline: accessible primitives, motion rules, Tailwind constraints (this project skips the Tailwind part) | `npx ui-skills list --category motion` → `npx ui-skills get baseline-ui` |
| **emil-design-eng** | [master5d/claude-design-skills](https://github.com/master5d/claude-design-skills) | Component feel: pressed states, springs, `ease-out`, avoiding `transition: all`; outputs a Before/After table | Copy the repo's skills directory directly, or install the plugin per its README |
| **fixing-accessibility** | Same as above | ARIA, focus traps, keyboard navigation, WCAG audits | Same as above |
| **webapp-testing** | [anthropics/skills](https://github.com/anthropics/skills) | Playwright screenshots/console, as the acceptance loop for "screenshot and compare after changes" | Installed with `example-skills` |
| Superdesign (optional) | [superdesign.dev](https://superdesign.dev/docs/cli-skill-tutorial) | Design canvas + multi-option generation; needs sign-in and the CLI | `npm i -g @superdesign/cli` → `superdesign login` → `npx skills add superdesigndev/superdesign-skill` |

**Install already run on this machine** (project level, picked up automatically by DeepSeek Harness):

```bash
npm_config_cache=/tmp/npm-cache npx --yes impeccable install \
  --providers=deepseek --scope=project -y
```

Output: `.dsh/skills/impeccable/` (including the `scripts/bin/darwin-arm64/impeccable` engine). `.dsh/` has been added to `.gitignore`.
Next step: run `/impeccable init` in a conversation to generate `PRODUCT.md`, then `/impeccable document` to capture the existing tokens in `DESIGN.md`.

> Note: this machine's global npm cache has root-owned files, so a plain `npx` fails with `EPERM`.
> Temporary workaround: prefix the command with `npm_config_cache=/tmp/npm-cache`; permanent fix: `sudo chown -R 501:20 ~/.npm`.

## 2. UI/UX kits (three tiers by "can it go into this project")

### A. OK to install: headless, unstyled, doesn't take over design

| Package | Version (2026-11-05 npm) | Use | Relation to existing constraints |
|---|---|---|---|
| `@base-ui/react` | 1.9.0 | Dialog / Popover / Select / Menu / Tooltip / Switch, with built-in focus trap, Esc, keyboard, ARIA | Unstyled, classes keep using tokens; replaces the hand-written `Modal.tsx` + 4 overlays |
| `motion` | 14.9.1 | Enter/exit, layout animation, `useReducedMotion` | Only 150–200ms motion that "responds to an action"; no decorative animation |
| `cmdk` | 1.1.1 | ⌘K command palette (jump to page + search memory) | Fully headless, styles written by us |
| `sonner` | 2.0.8 | Toasts (copied, background scan, import finished) | Can be fully overridden with CSS variables, brings in no visual language |
| `vaul` | 1.1.2 | Mobile-style drawer/bottom sheet | This project is closer to macOS drawers; low priority |
| `lucide-react` | 1.69.0 | Icons (nav groups, buttons, empty states) | 1px stroke line icons, compatible with the paper-like interface |

### B. Take inspiration / copy structure only, don't install

| Source | What to take | Why it can't be installed directly |
|---|---|---|
| [shadcn/ui](https://ui.shadcn.com) blocks / charts | The **information hierarchy** of form layout, empty states, settings-page grouping, chart cards | Tailwind by default + its own tokens; conflicts with the token-only rule in `VISUAL-TOKENS.md` |
| [ui-skills Playbook](https://www.ui-skills.com/playbook) | A rule list distilled from top design-engineering skills | It's reading material, not a dependency |
| [Mobbin](https://mobbin.com) / [Cosmos](https://cosmos.so) | Mature patterns from similar "local-first tools / knowledge bases" | Reference only; mind copyright, don't copy directly |
| [Refactoring UI](https://www.refactoringui.com) | How to judge hierarchy, whitespace, contrast, color | A book/method |

### C. Not recommended

- **Full UI kits** (Mantine, MUI, Ant Design, Chakra, Vuero, etc.): they bring a whole visual language and tokens,
  would turn the current warm paper/forest green into a generic admin panel, and noticeably grow the Electron bundle.
- **Tremor**: nice chart components, but tied to Tailwind and with its own grayscale design language; this project has only 2 charts, so hand-written SVG is easier to control.
- **Framer/Webflow templates**: static marketing-page assets; moving them into React state flow costs more than it gains.

## 3. Priorities for this repo

### P0 — low cost, visible right away (pure CSS/TSX, no dependency changes)

1. **Remove the side accent bar**: `app.css:762` `.schema-item.volume { border-left: 3px solid var(--accent) }`
   → change to a 1px `--accent-line` border + a small `VOLUME` label, or a full-card `--accent-soft` background.
   This is the detector's hit for "the most typical AI-generated look".
2. **Quiet the stat cards**: `.tone-ok .stat-value { color: var(--accent) }` makes all 4 numbers on the 4 cards green.
   Use `--ink` + `650` for numbers, and color only **states** (degraded / Not measured); split sentences into "main number + 1 line of detail".
3. **Loading state**: `Body` in `Home.tsx` currently renders the text "Loading…"; change it to a 2–3 line skeleton (`--fill` background + 120ms pulse,
   respecting `prefers-reduced-motion`) to avoid layout jumps.
4. **Visible focus**: give `Modal.tsx` / `drawer` Esc to close, initial focus and a focus trap; swap the hand-written `Modal` straight for Base UI Dialog.

### P1 — information architecture (the bulk of "clarity")

1. **Nav groups**: the `NAV` in `App.tsx` has 19 flat items; change it to 5 groups:
   `Today` (Home/Today/Ask), `Memory` (Overview/Library/Model/Search/Playbook), `Capture` (Capture/Rewind),
   `Identity & connections` (Personal Card/Peers/Swipe/Connections), `System` (HET/Import/Connectors/Settings/Recovery).
   Group headings use 10–11px weight 600 in `--muted`; no all-caps with letter spacing (`VISUAL-TOKENS.md` has already reined in eyebrows).
2. **⌘K**: the cmdk palette covers both "jump to page" and "search memory"; `Search.tsx` stays as the results page, and the palette is only an entry point.
   One shortcut reduces both nav pressure and the anxiety of "I can't find it".
3. **Unify overlays**: the drawer in `App.tsx`, `Modal.tsx`, `ResetIdentityDialog`, `RememberDialog` and the Evidence drawer
   each implement their own backdrop/animation/focus. Converge on one set of Dialog + Drawer primitives; consistent interaction is what makes it feel "finished".

### P2 — polish (only after P0/P1)

1. **Fonts**: currently `-apple-system + PingFang SC`. SF Pro renders well on macOS; the problem is **hierarchy**:
   page title 22/650, card title 14, body 13, so the steps are too small. First widen the hierarchy (title 24–26, line height 1.2,
   card title 13/600 + description 12/400), then consider changing fonts.
   If changing: Latin `Geist` / `Inter` (Fontsource, offline variable fonts), keep PingFang for Chinese;
   or self-host `MiSans` / `Noto Sans SC` (mind the +5–10MB bundle; the Electron installer gets bigger).
2. **Motion tokens**: the existing `--dur-fast: 120ms` is only enough for hover. Add `--dur-base: 180ms`, `--dur-slow: 240ms`
   and a set of `--ease-out` curves, used only for drawer/popover enter and exit, list insertion and state changes.
3. **Data visualization**: the heatmap and AccessChart already share sizes/color scales; to go further, unify just two things:
   the same meaning gets the same color (success/warning/failure match between charts and chips), and axes and gridlines drop to 60% of `--line`.
4. **One memorable moment**: the frontend-design skill explicitly warns that "warm beige background + high-contrast serif headings + terracotta" is currently the most common
   AI-generated combination; this project is warm beige + forest green + sans-serif, so it already avoids half of it. Keep only **one** deliberately designed moment
   (for example, on the "Today" page make the brief a real paper daily: serif heading + thin rules + footer date), and keep everything else quiet.

## 4. How to verify

- After each round of changes: `npm run dev` → screenshot the four pages Today / Home / Model / Settings (light + dark) → compare.
- Accessibility: Impeccable `audit` produces a P0–P3 list; walk the keyboard through nav → page → drawer → Esc.
- Visual regression: use the `webapp-testing` skill to write a Playwright script that screenshot-diffs the four pages, so changes don't step on each other.

## 5. Shipped (2026-11-05)

Everything in P0–P2 except "change fonts" is implemented; details in `VISUAL-TOKENS.md` §Structure:

- The side-bar anti-pattern is gone (`schema-item.volume` now uses `--fill-raised` + an `--accent-line` border).
- The 19 pages are now 5 `NAV_GROUPS` groups with 15px Lucide icons; `App.tsx` no longer hand-writes a nav array.
- The ⌘K command palette (cmdk + Base UI Dialog) is wired up: filter as you type, groups, keyboard up/down + Enter; there is a visible entry at the bottom of the sidebar.
- `Modal.tsx` and `EvidenceDrawer` now let Base UI Dialog handle the focus trap / Esc / backdrop close / scroll lock / focus restore,
  and enter/exit use `data-starting-style` / `data-ending-style` transitions.
- `Skeleton` replaces "Loading…" on Home / Today / Library; `Toaster` (Sonner) handles copy and write success messages.
- Stat values are all `--ink`, tone only marks state; title 24/650, card title 14/600; added `--dur-base` / `--dur-slow` and
  a global `prefers-reduced-motion` fallback.
- Verification: `npm run typecheck`, 1578 unit tests and the 41-step Electron e2e all pass; Impeccable `detect` reports 0 findings on the renderer.
- Screenshots: `docs/design/v3-shots/`.

## 6. Reference links

- [Base UI](https://base-ui.com) · [Motion](https://motion.dev) · [cmdk](https://cmdk.paco.me) · [Sonner](https://sonner.emilkowal.ski)
- [Impeccable docs](https://impeccable.style/docs) · [ui-skills](https://www.ui-skills.com) · [skills.sh](https://www.skills.sh)
- [shadcn/ui Base UI default change (2026-07)](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default)
