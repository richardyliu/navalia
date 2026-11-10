# Navalia — Local Visual Shell Design Document

> Version: v1.0 Draft
> Date: 2026-11-04
> Goal: a local Electron app that **needs no sign-in and does not depend on the official cloud**, reads the open-source Runtime's (`personal-model`) local data directly, and provides a model overview, evidence tracing, and people/project views.
> Status: in design review, implementation not started.

---

## 1. Background

The open-source Runtime (`~/Documents/GitHub/personal-model`, v0.3.2) already has the full capability set:

```
AX/OCR capture → 1-minute timeline → 5-minute session reduction → evidence-gated memory
      → Point/Line/Face/Volume/Root → SQLite + HUMAN.md
      → local REST /model viewer + MCP 21 tools
```

But it has only two "interfaces":

1. **Command line** (the 40+ subcommands of `persome`);
2. **Official web viewer** (the `/model` page opened by `persome model open`).

The official viewer is complete, but it is part of the runtime: it depends on the daemon to start, uses a short-lived browser capability, and cannot be customized. The Electron shell of the product DMG, meanwhile, requires signing in to the official cloud.

So what is missing here is **a standalone, read-only, local-first desktop viewer** that presents the Runtime's data more clearly and leaves room for later features (search, correction, export).

---

## 2. Goals and non-goals

### 2.1 Goals (v1)

| # | Goal | Acceptance |
|---|---|---|
| G1 | No account/sign-in/cloud key required | Starts and shows data offline and without an official cloud account |
| G2 | Automatically discover the local Runtime | Read `~/.persome`, probe `127.0.0.1:8742`, show health status |
| G3 | Model overview | Root narrative, Face/Volume lists, Point counts, build status |
| G4 | Evidence tracing | Click any Root/Face/Point to see the quote, source app/window/URL, receipt status |
| G5 | Relation browsing | Click a Point to see its relation tree and raw receipts |
| G6 | Empty states and degradation | Not installed/not started/not modeled/insufficient permissions each have a clear explanation and next step |
| G7 | Packageable | `npm run dist` produces a DMG that runs on double-click |
| G8 | Security | The token never reaches the renderer, no remote content, no telemetry |

### 2.2 Non-goals (v1)

- ❌ No sign-in, accounts, cloud sync, friend cards, weekly reports, or meeting transcription.
- ❌ No writes (correct/delete/import); v1 is read-only; writes move to v1.2.
- ❌ **No HET**: `het/` exists only in the product's private branch; the open-source Runtime has no such module. Doing it later would mean recomputing it ourselves from Points/the timeline, which is a separate project.
- ❌ Do not embed the official `/model` viewer (see §4.2), but provide an "Open official viewer" button.
- ❌ No mobile, Windows, or Linux (the Runtime itself is macOS-only).

---

## 3. Users and scenarios

| User | Scenario | Key action |
|---|---|---|
| Developer (Runtime installed) | "I want to see what it actually remembers" | Open the app → Overview → click Root → view evidence |
| Privacy-sensitive user | "I don't want to sign in, and I don't want my data in the cloud" | Fully local, no network requests |
| Researcher/evaluator | "I need to check whether a conclusion is reliable" | Search/locate → evidence chain → original text and receipt |
| Future self | "What was my judgment on this project last month?" | (v1.2) as-of time travel |

---

## 4. Solution overview

### 4.1 Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Persome Lens (Electron)                                     │
│                                                              │
│  ┌────────────────────┐        ┌───────────────────────────┐ │
│  │ Renderer (React)   │◄─IPC──►│ Main process              │ │
│  │  Overview          │        │  - RuntimeClient (HTTP)   │ │
│  │  Model             │        │  - token reader           │ │
│  │  Evidence          │        │  - supervisor (start)     │ │
│  │  Settings          │        │  - IPC whitelist          │ │
│  └────────────────────┘        └────────────┬──────────────┘ │
└─────────────────────────────────────────────┼────────────────┘
                                              │ HTTP 127.0.0.1:8742
                                              │ Bearer PERSOME_LOCAL_API_TOKEN
                                   ┌──────────▼──────────┐
                                   │ Persome Runtime     │
                                   │ FastAPI + SQLite    │
                                   │ 21 MCP tools        │
                                   └─────────────────────┘
```

- **The main process is the only place that can read the token and send HTTP.**
- The renderer gets data only through the narrow interface exposed by preload and never sees the token.
- By default the Runtime is **not started** (to avoid silently starting screen recording); `persome start` runs only when the user clicks "Start Runtime".

### 4.2 Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Data channel | **HTTP REST** | `/model/graph`, `/model/evidence`, `/status` are already stable JSON; no MCP protocol stack needed |
| Embed the official `/model`? | **No; own UI + an "Open official viewer" button** | The official page depends on a capability cookie and the daemon and is hard to embed; our own UI is controllable and extensible |
| Starting the Runtime | **Connect only by default, no auto-start** | Starting means screen capture begins; it must be an explicit action |
| v1 read/write | **Read-only** | Get "viewing" right first; build/correct/delete move to v1.1+, v1 only shows the commands |
| Search | **v1.1 via MCP stdio** | The public REST has no search route; MCP `search` is the only stable entry point |
| Port | Prefer `8742`, then read `config.toml [mcp].port` | The Runtime default port; the product uses 8823, so no conflict |
| Data root | `PERSOME_ROOT` > `~/.persome` | Consistent with the Runtime, supports dev isolation |
| Rendering | React + TypeScript + CSS Modules | Small footprint, no heavy UI library; charts in SVG |

---

## 5. Runtime integration

### 5.1 Discovery order

```
1. process.env.PERSOME_ROOT
2. ~/.persome
```

Checks:

- The directory exists and is owned by the current user;
- `<root>/env` exists, has permissions 0600, and is not a symlink;
- `PERSOME_LOCAL_API_TOKEN` can be parsed from it;
- Port available: first read `[mcp].port` from `<root>/config.toml`; if that fails, use 8742.

### 5.2 Token

```ts
// electron/runtime/token.ts
export function readLocalToken(root: string): string {
  const envPath = path.join(root, 'env');
  const st = fs.lstatSync(envPath);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('env file is not a regular file');
  if ((st.mode & 0o077) !== 0) throw new Error('env file permissions are too open');
  const text = fs.readFileSync(envPath, 'utf8');
  const m = text.match(/^PERSOME_LOCAL_API_TOKEN=(.+)$/m);
  if (!m) throw new Error('PERSOME_LOCAL_API_TOKEN missing');
  return m[1].trim();
}
```

Rules:

- Kept only in main-process memory;
- Never logged, never in IPC return values, never in crash reports;
- Re-read only at startup or when the token becomes invalid (401).

### 5.3 Lifecycle

| State | Detection | UI |
|---|---|---|
| `not_installed` | `<root>` or the `persome` executable not found | Show installation guide |
| `stopped` | `/health` connection refused | "Start Runtime" button |
| `running` | `/health` 200 + `/status` 200 | Normal |
| `unauthorized` | `/status` 401 | "Token invalid, regenerate it" |
| `version_mismatch` | `/status.version` outside the supported range | Prompt to upgrade |
| `degraded` | `/health` returns degraded | Yellow bar at the top + specific items |

Start action (explicit):

```bash
persome start        # start in background; non-blocking
```

Implementation: `spawn(persomeBin, ['start'], { detached: true, stdio: 'ignore' })`, then poll `/health` for up to 30 seconds.

A stop action is not in v1 (to avoid accidentally stopping a daemon the user is relying on).

### 5.4 API contract

Except for `/health`, every request carries `Authorization: Bearer <token>`; timeout 5s (`/model/graph` 15s).

| Method | Path | Purpose | Returns |
|---|---|---|---|
| GET | `/health` | Liveness/degradation (no auth) | `{status, ocr, index, capture}` |
| GET | `/status` | Version, root, daemon, capture, last_capture, memory/sessions/timeline, LLM profile | `ApiResponse<StatusData>` |
| GET | `/permissions` | accessibility / screen_recording | `ApiResponse<{...}>` |
| GET | `/model/graph` | Full model snapshot (not redacted) | `{generated_at, model, index_health?}` |
| GET | `/model/evidence?ref=&as_of=` | Resolve a single piece of evidence | `EvidenceResponse` |
| GET | `/model/node?id=` | Node raw receipts + relation tree | `{id, source, raw[], tree}` |
| GET | `/model/share-card` | Redacted share projection | `{generated_at, model}` |
| POST | `/model/edit` | Correction (v1.2) | `ApiResponse` |

`/model/graph` returns the **owner's unredacted view** (the source comments are explicit: MCP/export redact by default, the loopback viewer does not). Therefore:

- v1 offers no "share/export" entry point;
- If export is added in the future, it must go through the redacted path of `/model/share-card` or `model export`.

### 5.5 Error mapping

| Transport | UI |
|---|---|
| `ECONNREFUSED` | runtime stopped, show the start button |
| 401 | token invalid, show the guide to regenerate via `persome start` |
| 404 | Route does not exist, treat as version mismatch |
| 5xx | Show error details + "Open logs" |
| JSON schema mismatch | "Runtime version incompatible"; keep the old cache and notify |

---

## 6. Data model

```ts
// src/lib/types.ts
export type SchemaVersion = 1;

export interface ModelSnapshot {
  schema_version: SchemaVersion;
  generated_at: string;
  build: BuildRecord;
  points: Point[];
  lines: Line[];
  faces: Face[];
  volumes: Volume[];
  root: Root | null;
  receipts: Receipt[];
  stats: ModelStats;
}

export interface Point {
  id: string;
  content: string;
  layer: string;
  status: 'active' | 'retired' | string;
  is_latest: boolean;
  supersedes?: string | null;
  superseded_by?: string | null;
  occurred_at?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  created_at?: string | null;
  file_name: string;
  tags: string[];
  confidence: number;
  conflicted: boolean;
  receipt: string;
  edit_refusal: string; // "" = correctable
}

export interface Line {
  kind: 'evolution' | 'relation';
  // relation: src, dst, predicate, label, polarity, confidence, status
  // evolution: from, to, reason...
  [key: string]: unknown;
}

export interface Face {
  signature: string;
  observations: number;
  confidence: number;
  provenance: 'mined' | 'emergent' | 'both' | 'synth' | 'authored';
  members?: string[];
  source_receipts: string[];
  edit_refusal: string;
  // anchors / status ...
}

export interface Volume extends Face {
  // cross-domain schema, same fields as Face
}

export interface Root {
  signature: string;
  observations: number;
  confidence: number;
  provenance: 'synth' | 'authored' | string;
  source_receipts: string[];
  edit_refusal: string;
}

export interface BuildRecord {
  build_id: string | null;
  core_commit: string | null;
  models: Record<string, string>;
  prompt_hashes: Record<string, string>;
  config_hash: string | null;
  input_window: { start: string; end: string } | null;
  mode: string | null;
  trigger: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  degraded_stages: string[];
  status: 'complete' | 'degraded' | 'building' | 'not_built';
}

export interface ModelStats {
  points: number;
  evolution_lines: number;
  relation_lines: number;
  faces: number;
  volumes: number;
  roots: number;
  receipts: number;
}
```

Evidence response (from `_base` in `evidence.py`):

```ts
export interface EvidenceResponse {
  reference: string;
  canonical_reference: string;
  kind: string;
  id: string;
  status: 'ok' | 'missing' | string;
  label: string;
  summary: string;
  timestamp: string | null;
  path: string | null;
  metadata: Record<string, unknown>;
  sources: EvidenceItem[];   // explicit sources, usable as proof
  context: EvidenceItem[];   // temporally nearby context, not proof
  history: EvidenceItem[];   // the Point's version chain
}
```

> UI copy must distinguish `sources` (direct sources) from `context` (nearby context, not evidence). This is the Runtime's own contract; do not mix them.

---

## 7. UI design

### 7.1 Information architecture

```
┌ Sidebar ─────────┬ Main ─────────────────────────────────────┐
│ ● Overview       │  Overview / Model / Evidence / Settings    │
│ ● Model          │                                            │
│ ● Search (v1.1)  │                                            │
│ ● Settings       │                                            │
└──────────────────┴────────────────────────────────────────────┘
```

### 7.2 Pages

#### Overview

```
┌────────────────────────────────────────────────────────────┐
│ Persome Lens                           [Runtime: running]  │
├────────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│ │ Capture  │ │ Last     │ │ Model    │ │ Sessions │        │
│ │ active   │ │ 2m ago   │ │ 1 Root   │ │ 42       │        │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘        │
│                                                            │
│ Build: complete · 2026-11-04T… · 1,204 points              │
│ Degraded stages: (none)                                    │
│                                                            │
│ [Copy build cmd] [Open official viewer] [Open data folder] │
└────────────────────────────────────────────────────────────┘
```

- Data source: `/status` (polled every 5s, 30s when the window is unfocused).
- Shows: daemon, capture, last_capture, sessions, memory, timeline, build status, counts.
- If `build.status = not_built`: show "No model yet, run a build first" + a copyable command (v1 does not run the build on the user's behalf; v1.1 adds a button).

#### Model

Three columns:

```
┌ Root ────────────────┬ Faces / Volumes ──────┬ Points ─────────┐
│ Narrative (scrolls)  │ Face list (confidence)│ Filterable table│
│ Conf · evidence · time│ Volume list          │ Click → evidence│
└──────────────────────┴───────────────────────┴─────────────────┘
```

- Root card: signature, confidence, observations, build time, receipt count.
- Faces/Volumes: sorted by confidence, showing the first two lines of the signature; click → filter related Points.
- Points: virtualized list; columns: time, file, summary, confidence, conflicted, tags.
- Filters: `is_latest`, `conflicted`, `file_name`, tag.
- Selecting a Point → opens the Evidence drawer (no page change).

#### Evidence (drawer/standalone page)

```
┌ Evidence ─────────────────────────────────────────────┐
│ Claim: the user prefers Rust for CLI tools             │
│ status: ok · point:event:entry:… · 2026-10-12          │
├────────────────────────────────────────────────────────┤
│ Direct sources (sources)                               │
│  • 2026-10-12 14:03 · Terminal · iTerm                 │
│    “I’ll use Rust for this one.”                       │
│    receipt ⟨…⟩  [Copy]                                  │
├────────────────────────────────────────────────────────┤
│ Nearby context (context, not proof)                    │
│  • 14:01 · VS Code · Cargo.toml                        │
├────────────────────────────────────────────────────────┤
│ Version history (history)                              │
│  • supersedes ← 2026-09-30 …                           │
└────────────────────────────────────────────────────────┘
```

- Clicking a receipt: call `/model/evidence?ref=<receipt>` to drill down further; when `status=missing`, show "The raw data is past its retention period".
- `as_of` picker (v1.1): time travel.

#### Node (relations)

- Triggered from a Point's "Relations" tab via `/model/node?id=<point.id>`.
- Shows `raw[]` (raw receipts) and `tree` (BFS relation tree, depth≤2, fanout≤8).
- Tree nodes can be clicked further → evidence.

#### Settings

| Item | Content |
|---|---|
| Runtime path | `<root>`, can open in Finder |
| Port / version | Read-only |
| Token | `loaded / missing` (value not shown) |
| Config | Open `config.toml` (read-only notice) |
| Diagnostics | Copy the `doctor` summary (without the token) |
| Official viewer | Button: `persome model open` |
| About | Version, license, unofficial notice |

### 7.3 Visuals

- Light "paper" theme, following the Runtime viewer's warm white/forest green;
- Fonts: system `-apple-system` / `PingFang SC`;
- 10px corner radius, 1px borders, soft shadows;
- Dark mode in v1.1 (CSS variables already reserved).

### 7.4 Empty states and degradation

| State | Copy | Action |
|---|---|---|
| Runtime not installed | "~/.persome not found" | Link to installation guide |
| Runtime not started | "The Runtime is not running" | Start button |
| No permission | "Accessibility / Screen Recording not granted" | Open System Settings |
| Model empty | "The model is still forming (not built)" | Show `persome model build` |
| Build degraded | "The following stages failed: …" | Show the stage list |
| index_health abnormal | Yellow bar at the top | Link to diagnostics |

---

## 8. Security design

| Surface | Measure |
|---|---|
| Process | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| preload | Exposes only fixed methods on `window.lens`; arguments validated with zod |
| token | Main only; IPC return values never contain the token; logs redacted |
| CSP | `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'` |
| Remote content | Loading any http(s) page is forbidden; external links go through `shell.openExternal` + a domain allowlist |
| File access | Read only specified files under `<root>`; paths normalized, `..` rejected |
| Telemetry | **None** (no Sentry/analytics) |
| Export | Not offered in v1; v1.2 only via `/model/share-card` or `persome model export` |

---

## 9. Performance

| Point | Approach |
|---|---|
| `/model/graph` can be large | Fetch once at startup, cache for 60s; virtualized lists; render only the current view |
| Evidence clicks | Lazy loading, one request each |
| Status polling | 5s focused / 30s unfocused; paused when the window is hidden |
| Memory | Don't copy the whole graph into React state multiple times; use a normalized store |
| First screen | Show status first, then fetch the graph asynchronously; show a skeleton meanwhile |

---

## 10. Tech stack and project structure

### 10.1 Stack

| Layer | Choice |
|---|---|
| Shell | Electron 43 (current stable), electron-vite |
| Rendering | React 19 + TypeScript |
| State | TanStack Query + a little Zustand (selection) |
| Styling | CSS Modules + CSS variables (no Tailwind) |
| Validation | zod |
| Packaging | electron-builder (DMG, arm64) |
| Testing | Vitest (unit) + Playwright `_electron` (e2e) |

### 10.2 Directory layout

```
persome-lens/
  package.json
  electron.vite.config.ts
  electron/
    main.ts                 # app lifecycle, window, IPC registration
    preload.ts              # window.lens API
    ipc.ts                  # channel whitelist + zod validation
    runtime/
      paths.ts              # root/port discovery
      token.ts              # env reader
      client.ts             # RuntimeClient (fetch + error mapping)
      supervisor.ts         # start runtime, health polling
    log.ts                  # redacted logger
  src/
    main.tsx
    App.tsx
    pages/Overview.tsx
    pages/Model.tsx
    pages/Settings.tsx
    components/EvidenceDrawer.tsx
    components/PointTable.tsx
    components/RootCard.tsx
    components/StateBanner.tsx
    lib/types.ts
    lib/api.ts              # window.lens typed wrapper
    lib/format.ts
    styles/tokens.css
  tests/
    fixtures/               # trimmed from runtime tests/fixtures/runtime_model
    unit/*.test.ts
    e2e/*.spec.ts
  build/
    icon.png
  README.md
```

---

## 11. Testing

### 11.1 Unit

- Token parsing: missing field, overly broad permissions, symlink;
- Port discovery: with/without config, port in use;
- Error mapping: 401/404/5xx/ECONNREFUSED;
- Data normalization: `/model/graph` → view model; `status` → cards.

### 11.2 Contract tests

Use the JSON in the Runtime repo's `tests/fixtures/runtime_model/` as golden fixtures:

- Empty model (no root);
- Full model (root + faces + volumes + points);
- evidence `status=missing`;
- degraded build.

### 11.3 E2E

Launch the app with Playwright `_electron` and inject a **fake runtime** (local Express or msw) that returns fixtures:

1. runtime down → start button visible;
2. after starting → Overview shows running;
3. Model page shows Root;
4. Click a Point → the Evidence drawer shows `sources`;
5. No token → shows the unauthorized copy.

### 11.4 Manual

- Run against the real Runtime for 10 minutes and confirm status polling doesn't flicker;
- Start offline and confirm there are no network requests at all (DevTools Network is empty);
- Check that logs contain no token.

---

## 12. Packaging and distribution

```bash
npm run dist
# produces dist/Persome Lens-1.0.0-arm64.dmg
```

- appId: `dev.persomelens.app`
- productName: `Persome Lens`
- Minimum macOS 14, arm64
- v1 has no auto-update and no notarization (local personal use); add Developer ID + notarize before distributing externally
- Icon: a self-drawn placeholder, not the original trademark

---

## 13. Milestones

| Milestone | Content | Done when |
|---|---|---|
| M0 | Scaffolding, window, preload, token/port discovery, `/status` | The app starts and reads the Runtime |
| M1 | Model page: graph, Root, Faces, Points list | Real data renders |
| M2 | Evidence drawer, Node tree, Settings, empty/degraded states | Evidence can be traced; empty states don't crash |
| M3 | Package DMG, README, fixture tests | DMG installs; fixture tests pass |

Dependencies: Runtime installed (done), Node 24, Xcode CLT (available).

---

## 14. Risks and open questions

| Risk | Impact | Mitigation |
|---|---|---|
| `/model/graph` contract changes in v0.4 | Parsing fails | Branch on `schema_version`; zod validation; when incompatible, read only the old cache |
| Large model payload (thousands of Points) | Lag | Virtualization + paging (v1.1 switches to the MCP bounded projection) |
| Token file permission differences | Cannot connect | Clear error + guide to regenerate via `persome start` |
| Runtime version too old | Routes missing | Version check + upgrade prompt |
| User also runs the product at the same time | Port/capture conflicts | Use only 8742; detect 8823 and show "The product version is running" |
| Read-only v1 isn't enough | User wants to correct | v1.2 wires up `POST /model/edit` + `correct_memory` |

Open questions:

1. Should search be in v1? Suggest v1.1, using `persome mcp` stdio + `@modelcontextprotocol/sdk`.
2. Build a "constellation" star map? Suggest v1.1; lists + relation tree first.
3. Is i18n needed? v1 is Chinese-first, English in v1.1.
4. Support switching between multiple roots (dev/prod)? v1 uses a single root + `PERSOME_ROOT` override.

---

## 15. Acceptance criteria (Definition of Done)

- [ ] `npm install && npm run dev` opens the window directly on a machine with the Runtime installed;
- [ ] Offline and without an account, Overview/Model/Evidence all work;
- [ ] When the Runtime is not started, a clear empty state is shown, and it refreshes automatically after one-click start;
- [ ] Clicking Root/Face/Point shows the sources' original text and receipt;
- [ ] Old receipts with `status=missing` have the correct copy;
- [ ] The token cannot be found by searching in the renderer's DevTools;
- [ ] No external network requests at all (except 127.0.0.1);
- [ ] `npm run dist` produces a DMG that runs on double-click;
- [ ] The README states: unofficial, read-only, data never leaves the machine.

---

## 16. Later versions

| Version | Content |
|---|---|
| v1.1 | MCP stdio search (`search` / `search_captures` / `recent_activity`); star map; dark mode |
| v1.2 | Writes: `POST /model/edit`, `correct_memory`; `as_of` time travel |
| v1.3 | Import wizard (Obsidian/folder/Notion); `HUMAN.md` preview |
| v2 | Optionally connect to the product Cloud (meetings/cards/weekly reports enabled after sign-in), but "local mode" must keep running standalone |
| Not for now | HET (the open-source Runtime has no such module); meetings; social; cloud sync |

---

## 17. References

- Runtime repo: `~/Documents/GitHub/personal-model`
- Model format: `MODEL_FORMAT.md`
- MCP contract: `MCP.md`
- Evidence contract: `src/persome/evidence.py`
- Routes: `src/persome/api/routes.py`
- Official viewer: `src/persome/api/model_view.py`

---

## 18. Unofficial notice

This project is a third-party local viewer; it does not use the original trademark or cloud services, and reads only data generated by the open-source Runtime in the user's local `~/.persome`. The Runtime code is under Apache-2.0, and this viewer will keep the corresponding NOTICE.

---

## 19. Implementation status (2026-11-04)

- Code location: `~/Documents/GitHub/persome-lens`
- Implemented: Overview (status/build/permissions), Model (Root/Faces/Volumes/Points filters), Evidence drawer (sources/context/history/receipt drill-down), Node relations and raw receipts, Settings, one-click Runtime start, empty states for not connected/empty model/no permission.
- Not implemented (as planned): search (MCP, v1.1), writes/correction (v1.2), star map, i18n, DMG notarization.
- Verification: typecheck ✅, build ✅, DMG packaging ✅, both mock fixtures and the real runtime (ingest mode) pass.
- Running:
  ```bash
  cd ~/Documents/GitHub/persome-lens
  env -u ELECTRON_RUN_AS_NODE npm run dev
  ```

### 19.1 Real-data verification (2026-11-04 evening)

- Works end to end on the real `~/.persome`: Overview / Model / Evidence all read runtime data.
- Found and fixed a real-data bug: `Point.tags` in `/model/graph` is a space-separated string, not an array; the first version of the Model page crashed on it (blank screen). `tagList()` now handles string / array / null.
- First build (114 imported sessions + 4 agent `remember` facts) result: **14 Points / 10 Lines / 0 Faces / 0 Volumes / 0 Root**, `model_contract` degraded.
- Conclusion: in public v0.3.2, `import-data` only produces event logs, and evomem skips `event-*`; Points come mainly from durable memories written by `remember` and from entity edges. Face/Volume/Root need repeated evidence across sessions.
- The Claude subscription quota hit 200/200 that night (reducing the imported sessions is expensive); until the next-day reset, the LLM stages fail closed.

### 19.2 P0 / P1 implemented (2026-11-04 night)

- **P0**: the top bar gains an `LLM used/limit` badge; when the quota is exhausted, a red notice bar appears (with the next reset time); a global refresh button was added.
- **P1**: a new "Search" page, using `persome mcp` stdio:
  - Memory search: MCP `search`
  - Screen search: MCP `search_captures`
  - Recent activity: MCP `recent_activity`
  - Memory/recent results can open the Evidence drawer.
- The main process gains a minimal MCP JSON-RPC client (`src/main/mcp/client.ts`) that starts `persome mcp` on demand and closes it on exit.
- Verified: typecheck, build, dist; memory search returns results on the real `~/.persome`; the quota bar shows 200/200 and the reset time.

### 19.3 P2 / P3 implemented (2026-11-04 night)

- **P2 writes**:
  - "Remember something" dialog: calls MCP `remember`, writes directly to `topic-agent-findings.md`, zero LLM.
  - Evidence drawer "Correct": calls MCP `correct_memory`, natural-language correction, keeps the receipt; may call the LLM.
  - "Build model" button: the main process spawns `persome model build`, shows the tail of the output and the exit code live, and can be cancelled; disabled when the quota is exhausted.
- **P3 Playbook**: a new page reads MCP `behavior_patterns` and shows Root / Faces / Skills and the Runtime-rendered blocks; the empty state explains that cross-session evidence is needed.
- Real-data verification: search, the remember dialog, the correct dialog, and the empty Playbook all render correctly; typecheck/build/dist pass.
- Not verified: a full build via the build button (currently disabled at 200/200 quota); actually applying correct_memory (it calls the LLM and is subject to the same quota).
