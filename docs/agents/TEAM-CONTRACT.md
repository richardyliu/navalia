# Persome Lens v2.1 — Agent Team Contract

Every agent in `.claude/agents/lens-*.md` MUST read this file plus
`docs/reference/AGENT_PROMPT_V2.1.md` (the master brief) before doing anything.
The master brief wins on scope.

## 1. Roles

| Agent | Owns | Phase / PLAN items |
|---|---|---|
| `lens-lead` (main thread, `claude --agent lens-lead`) | Plan, todo, sequencing, shared wiring files, user communication (Chinese), final report | Phase 0, 4, 5 |
| `lens-capture` | Native addon, coordinator, exclusions/pause, ingest client, Capture page | E1.1–E1.9 |
| `lens-identity` | Lens Store, keys, Card, grants, Broker, Connections, Access log, Swipe | E2.1–E2.9 |
| `lens-het` | Agent log adapters, segmenter, assessor, anchors, ledger, HET UI, Weekly Review | E3.1–E3.7 |
| `lens-release` | E2E harness, electron-builder/DMG (incl. addon packaging), README, demo fixtures | E5.1–E5.4, Phase 4 |
| `lens-fidelity-auditor` (read-mostly) | Runs reference §15 tests, writes test records + score | Phase 5, and after each plane |
| `lens-security-reviewer` (read-only) | Trust-boundary review: tokens, keys, IPC, CSP, egress, PII | After E1, E2, E3, before dist |

## 2. File ownership (no two agents edit the same file concurrently)

| Path | Owner |
|---|---|
| `native/**`, `src/main/capture/**`, `src/renderer/src/pages/Capture*.tsx`, `tests/capture/**` | lens-capture |
| `src/main/store/**`, `src/main/identity/**`, `src/main/broker/**`, `src/renderer/src/pages/{Card,Connections,AccessLog}*.tsx`, `tests/identity/**` | lens-identity |
| `src/main/het/**`, `src/renderer/src/pages/Het*.tsx`, `tests/het/**` | lens-het |
| `tests/e2e/**`, `tests/fixtures/demo/**`, `build/**` (electron-builder resources/hooks), `README.md`, electron-builder config in `package.json` | lens-release |
| `docs/test-evidence/**`, `docs/test-evidence/REPORT.md` | lens-fidelity-auditor |
| **Shared wiring**: `src/main/index.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/api.ts`, `src/shared/types.ts`, `src/renderer/src/App.tsx`, `package.json` deps/scripts, `tsconfig*`, `electron.vite.config.ts`, `docs/design/DEVIATIONS.md` | **lens-lead only** |

Wiring rule: each plane exports from its own directory

- `register<Plane>Ipc(ipcMain, deps)` with zod schemas for every channel,
- a typed API fragment (`src/main/<plane>/api.ts`) the lead merges into `src/shared/api.ts`,
- a page component the lead adds to the router.

Specialists who need a shared-file change (new dependency, new IPC channel, new route) put it in the
handoff under **Wiring requests** as an exact diff. They do not edit shared files themselves.

The repo is **not a git repo**: no worktree isolation. The lead therefore runs specialists in
parallel only when their write sets are disjoint (true by the table above), and runs
`npm run typecheck` after merging each wiring request.

## 2b. Shared decisions (made by lead, 2026-11-04)

- Test runner: **vitest 5** (`npm test` = `vitest run`, files `tests/**/*.test.ts`). Rationale: no runner
  existed; vitest reuses the existing vite toolchain and handles TS path imports.
- SQLite: **`node:sqlite`** (`DatabaseSync`), verified working inside Electron 43.3.0 / Node 24.18.1.
  No better-sqlite3 (avoids a second native rebuild).
- Runtime OSS source lives at `~/Documents/GitHub/personal-model` (read-only reference). It natively
  supports `capture.source = "ingest"` and `POST /captures/ingest` (`src/persome/capture/scheduler.py`,
  `src/persome/config.py`); helper source `resources/mac-ax-helper.swift`.
- Toolchain: Command Line Tools only (no full Xcode), SDK MacOSX26, clang 17, swiftc present.
- `~/.codex` does not exist on this machine: the Codex adapter is fixture-tested only (mark real-run UNKNOWN).
  `~/.claude/projects` exists (11 projects) — read-only.
- Real `~/.persome/config.toml` currently has `source = "daemon"`. Switching the real config is a lead
  decision; agents switch only temp `PERSOME_ROOT` copies.

- **The user's packaged Lens v1 (`dist/mac-arm64/Persome Lens.app`) may be running** and holds the
  single-instance lock: a plain `electron .` exits silently. Never kill it. Launch test instances with
  `--user-data-dir=<scratch dir>` plus `LENS_STORE_ROOT=<scratch dir>`; use `perl -e 'alarm N; exec @ARGV'`
  as a timeout (no `timeout` binary on macOS). `LENS_SCREENSHOT=<png>` auto-quits after rendering.
- Identity wiring is merged (2026-11-04): `window.lens.identity.*`, `window.lens.card.*`;
  `RuntimeClient.shareCard()` → `GET /model/share-card` exists for the scrubbed card source.

## 3. Non-negotiables (summary of master brief §4, §5, §10)

- Mechanism before UI. No fake data, fake screenshots, or weakened assertions.
- Declare a fidelity level (L0–L3) for every feature; never call L0 "L2".
- Original-product facts: Lens owns TCC and Runtime runs `capture.source="ingest"`; Connections are
  per-agent **full access** + **Access log** (scopes are a Lens extension and must be labelled so);
  HET counts only *completed, assessed* AI work; HET corrections are `accepted` / `rejected` / `not_agent`.
- Main process owns tokens, private keys, API calls. Renderer never sees them. `contextIsolation`,
  `sandbox`, CSP, zod-validated IPC allowlist.
- Never write Runtime `index.db`. Destructive tests use a temp `PERSOME_ROOT` under the scratchpad or
  `/tmp/persome-test`, never `~/.persome`.
- Any LLM call fails closed: bounded, queued, no retry loops. Budget exhausted → `needs_assessment`.
- No `git init` / commit / push. No AI attribution in code, docs, or messages.
- Launch Electron with `env -u ELECTRON_RUN_AS_NODE`.
- New dependency → justify in the handoff (why existing stack is insufficient).
- Code/comments English; anything addressed to the user Chinese.

## 4. Definition of "done" for one PLAN item

1. Code written in owned paths.
2. `npm run typecheck` passes (after lead merges wiring).
3. Unit/contract tests for the item exist and pass — paste the command and its tail output.
4. Real-run check when the item is runtime-observable (launch app, hit endpoint, inspect file).
5. Deviations, if any, sent to lead for `docs/design/DEVIATIONS.md`.

## 5. Handoff format (every specialist ends with this, nothing else)

```markdown
## Handoff: <agent> — <PLAN ids>
### Done
- <item>: <files>; level reached: L?
### Verification (commands actually run)
- `<cmd>` → <exit code, key output lines>
### Wiring requests (lead applies)
- <file>: <exact diff or snippet>
### Deviations
- <what / why / impact / test / reversible?>
### BLOCKED / UNKNOWN
- <item>: <reason, what would unblock>
### Next
- <next PLAN id and its first step>
```

A claim without a command in **Verification** is treated as not done.

## 6. Test records

Use the reference §15.3 template verbatim (`test / target / level / source / method / expected /
actual / evidence / result / notes`). Results are `PASS | FAIL | BLOCKED | UNKNOWN`; a test that
was not executed is never PASS. Evidence files go to `docs/test-evidence/<TEST-ID>/`.
