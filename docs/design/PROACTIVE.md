# Proactive layer and long-running projects (S1-R3-08)

Status: **X9 approved 2026-11-05 (`DECISIONS-ROUND3.md` §1); implemented: T3/T4/T5/T1/T2** in S1-R4-05 (`src/main/proactive/**`, Settings "Local notifications", log `docs/design/s1-log/S1-R4-04-05.md`). X4 is decided as B (count view, `PERFORMANCE.md`); nothing here measures project progress.

**S1-FULL C17 update (2026-11-06, C23 doc pass):** the layer was extended and wired at the Phase 4 gate (`docs/design/s1full-log/C16-C17.md`, `PHASE4-GATE.md`). Defaults are unchanged in spirit: **everything is off**.

- **Triggers.** The fixed evaluation order (the daily cap is spent in this order) is T3, T4, T5, then the event triggers T8 `meeting_ready` and T9 `friend_moment`, then the time triggers T1, T2 and T10 `weekly_counts` (last week's "Performance" counts) (`src/main/proactive/api.ts`). T6 and T7 are still not implemented.
- **Event bus** (`src/main/proactive/events.ts`). It is typed and carries two events: `meeting.transcript_ready` (published by Meetings `onTranscriptReady`) and `peers.moment_accepted` (published by moments `sync()` the first time it sees one of *my* proposals accepted; this differs from the agent's proposal, see PHASE4-GATE). Payloads are zod-validated, and an invalid payload returns false. A listener error never reaches the publisher. An event that arrives while the master switch is off is ignored and not recorded. An event held by quiet hours or the cap stays pending for at most 24 h (`EVENT_TTL_MS`). Pending events keep hashed ids only.
- **Context-sufficiency gate.** The gated triggers stay silent below `minItems` items that carry a non-empty evidence pointer. Defaults: T8 3, T9 1, T10 3, T1/T2 1 (`DEFAULT_MIN_ITEMS`). Every send / no-send decision for an enabled trigger is recorded with its reason in `<LensStore>/proactive-decisions.json` (0600; identical decisions are folded; no text). The log can be cleared.
- **Defaults** (`defaultProactiveSettings()`, settings v2): master `enabled: false`; every trigger false; quiet hours 22:00–09:00; `briefTime` 09:00; `briefDays: 'weekdays'`; `dailyCap` 3 (max 10); `detail: false` (a one-line label of ≤ 30 chars that can show a meeting title or friend label on the lock screen); `tray: false`; `shortcut: { enabled: false, accelerator: 'CommandOrControl+Alt+L' }`. A v1 file migrates with every new field off and `briefDays: 'all'`, which preserves v1 behaviour. A corrupt file means all off.
- **Master switch off** clears the timer, unregisters the proactive shortcut, empties the tray items, and drops pending events and their in-memory labels at once.
- **Shortcut / tray.** The proactive shortcut is separate from the Quick Box and conflict-checked against it (`reservedAccelerators`) and against `isRegistered`. An OS refusal is reported. The tray adds "N/cap sent today", "View proactive log…" and "Turn off all proactive notifications" (which sets the master switch off) to the existing shell tray, with no second icon.
- **Not verified:** real Notification Center, real Tray and real globalShortcut interaction (fakes only). See `docs/test-evidence/CAP-L2L3-CHECKLIST.md` B2.

Original S1-R4-05 status (still accurate for T1–T5):
What is implemented, in the order the cap is spent: T3 owner aliases pending, T4 capture / OCR degraded (≥10 min, plus one "recovered"), T5 Runtime down ≥5 min or revision changed, T1 daily brief ready, T2 yesterday's open todos. Master switch + per-trigger switches, all default off; 3 per local day; per-trigger cooldown (T3 4 h, T4 30 min, T5 1 h, T1/T2 once per local day); dedupe = trigger + hash of source ids; quiet hours default 22:00–09:00 (configurable, crosses midnight); one timer at ≤1 tick / 15 min that exists only while the master switch is on and permission was shown, stopped on switch-off and on quit; content-free fixed-template text; click opens a Lens page only; `<LensStore>/proactive-settings.json` (0600, zod strict, corrupt ⇒ all off), `proactive-state.json` and `proactive-log.json` (0600, trigger / time / hashed or categorical source ids, no text). Tests: `tests/proactive/*`; `tests/ask/no-proactive.test.ts` now allows Notification only inside `src/main/proactive/`.

**Not implemented / deviations:**
- T6 (model work waiting) and T7 (new agent access): not in the approved first batch.
- Back-off after 3 dismissals without open (§2.2): not implemented. Electron gives no reliable "dismissed" event on macOS [INFERRED], so it could not be counted honestly.
- Permission: Electron has no API that reports macOS notification denial. Lens records whether the test notification emitted `show`; the user can press "I didn't see a notification" to mark it denied. After that nothing is sent and Lens never asks again on its own.
- Timing: the thresholds (T4 ≥10 min, T5 ≥5 min, T1 brief time) are checked on the 15-min tick, so a notification can arrive up to ~15 min after the threshold.
- T5 "schema revision": Lens uses `schema_revision` from `/health` when present, otherwise `/status` `version`, as the upgrade marker. Whether the live Runtime puts `schema_revision` in `/health` is unverified [INFERRED]; Lens does not read `index.db` for it. The first value seen is the baseline (no notification).
- Overflow items are not folded into the next T1 brief (§2.2); a capped or quiet-hours-suppressed item is simply retried on later ticks until its dedupe key was sent or its source changed.
- *(S1-R4-05 state; C17 later added the one-line `detail` option and tray menu items, but still no badge count on the icon.)* No menu-bar badge, no one-line preview option, no scheduled brief *generation* (T1 builds the deterministic brief in memory only to count items; nothing is written).
- Not run against a real Runtime or real Notification Center in this round (rules forbid running the app on real data).

The sections below are the original design (S1-R3-08) and still describe the intent.

## 1. What already exists (so nobody re-builds or over-claims it)

| Surface | State | Where | Proactive? |
|---|---|---|---|
| Menu-bar icon, global shortcut, Quick Box | Built in OG-04 under OG-D5. **Every toggle defaults to off** (`trayEnabled`, `shortcutEnabled`, `keepResidentOnClose`). | `src/main/shell/{main,settings,controller}.ts`, `<LensStore>/shell-settings.json` | No. These are pull surfaces: the user opens them. Nothing is pushed. |
| Today brief / Next steps | Deterministic, no LLM, regenerated when the user opens or refreshes Today (D29, D35) | `src/main/library/brief.ts` | No. It is never scheduled. |
| HET tick | `setInterval` every 5 min, which updates the local ledger | `src/main/het/service.ts:244` | No user-facing output. It never notifies. |
| Capture page polling | React Query refetch every 2 s / 10 s, only while the page is mounted | `src/renderer/src/pages/Capture.tsx` | No. It is a UI refresh. |
| Notifications | Since S1-R4-05: only `src/main/proactive/main.ts` (opt-in, default off). Before that: none. | `src/main/proactive/**` | Yes, opt-in (X9). |

So the missing part of X9 is the **push half**: deciding on Lens's own initiative to tell the user something, and the schedule that drives that decision.

## 2. Design (X9 approved 2026-11-05; see Status for what was built)

### 2.1 Candidate triggers (T1–T5 implemented, T6/T7 not)

Each trigger must be computable without an LLM (X7) and without network (X1), from data Lens already reads. Each must state the exact rows that fired it. If no source exists, nothing fires.

| # | Trigger | Source (existing) | Fires when | Notification text (content-free by default) |
|---|---|---|---|---|
| T1 | Daily brief ready | `library/brief.ts` over `recent_activity` | At a user-chosen time, if the brief has ≥1 item | "Today's brief: N next steps" |
| T2 | Carried-over todo | D35 markers (`- [ ]`, `TODO:`, the Chinese "to-do:" marker) still open the next local day | Once per item per day | "N of yesterday's to-dos still not ticked off" |
| T3 | Owner alias waiting for review | Runtime `GET /owner-aliases?status=pending` count | Pending count rises above the last-seen count | "N names that might be yours to confirm" |
| T4 | Capture / OCR stopped working | Capture status (permissions lost, ingest rejected) and Runtime `/health` (`ocr_enabled`, `ocr`, `ocr_worker`) | State goes from good to bad and stays bad for ≥10 min | "Screen capture degraded: missing Screen Recording permission" |
| T5 | Runtime down or upgraded | Recovery health; schema revision change | Down ≥5 min, or schema changed since last launch (other agent sessions must be restarted, D54) | "Runtime was upgraded. Please restart other Agent sessions" |
| T6 | Model work waiting | MCP `get_pending_model_work` count | Count > 0 for ≥1 day | "Model updates waiting to be built" (building is still a confirmed user action, X5) |
| T7 | New agent access | Broker `audit.db`, first call from a new client or grant | First call per new client | "A new Agent read your data: <client name>" |

Explicitly **not** triggers:
- Anything inferred about mood, focus or productivity.
- "You seem stuck."
- Anything that scores the user, and any project "% complete" (X4).
- Peers / subscription changes. X2 forbids background folder scans.
- Anything that needs the content of a capture.

### 2.2 Frequency limits

- **Global cap:** at most 3 notifications per local day across all triggers. Extra items are folded into the next T1 brief and never queued as a burst.
- **Per-trigger cooldown:** T1 once a day. T2 once a day. T3/T6/T7 once per state change. T4/T5 once per incident, plus one "recovered" message.
- **Dedupe:** the key is trigger + the hash of its source row ids. A dismissed notification does not come back until the source state changes.
- **Quiet hours:** user-set, default 22:00–09:00 local. macOS Focus also suppresses notifications at the system level.
- **Back-off:** if the user dismisses the same trigger 3 times without opening it, that trigger turns itself off and Settings says so.
- **One scheduler:** a single main-process timer at no more than 1 tick / 15 min, plus T1's fixed time. It does not run while the Runtime is down, except for T5. Every tick reads local data only.

### 2.3 Privacy

- **Local only.** Electron `Notification` hands text to macOS Notification Center. Lens opens no socket for it, uses no push service and makes no network request. A zero-network test like `tests/peers/no-network.test.ts` would cover the module.
- **Content-free by default.** A notification carries counts and categories only. It never includes memory text, quotes, names of people, window titles, URLs or WeChat content. Banners can appear on the lock screen, in screen shares and in screenshots. They may also be picked up by screen capture, including Persome's own capture if Notification Center text is captured [INFERRED]. A separate option, default off, could show a one-line preview.
- **Click = open a Lens page.** No notification action writes anything: no remember, no confirm or reject, no build. Writes keep their existing confirmed paths.
- **Local log.** Each notification sent is recorded in `<LensStore>/proactive-log.json` (0600: trigger, time, source ids, no text), so the user can see why it fired. The file is excluded from backups unless X8 changes.

### 2.4 Opt-in model

- Off until X9 is approved. After approval it **stays off by default**.
- In Settings, a master switch plus one switch per trigger, each defaulting to off. T4/T5 could reasonably be suggested on during onboarding, but the user still clicks.
- Turning a trigger on triggers the macOS notification-permission prompt the first time. If the user denies it, Lens shows that state and does not fall back to in-app nagging.
- Settings live in `<LensStore>/proactive-settings.json` (0600, zod strict). A corrupt file means everything is off (fail closed, same as `shell/settings.ts`).
- Notifications do not require the menu-bar icon. If `keepResidentOnClose` is off, nothing fires after the window closes. Background residency stays a separate OG-D5 toggle.

### 2.5 What X9 approval would unlock (and what it would not)

Unlocks:
- `Notification` in main, the single scheduler above, and an optional menu-bar badge count when the tray is on.
- Scheduled brief generation (T1).

Does **not** unlock:
- Network (X1).
- An LLM (X7).
- Any Performance metric or project completion number (X4).
- Writes without a confirm.
- Background scans of shared folders (X2).

### 2.6 Tests to write when it is implemented

- Each trigger fires only from fixture rows and stays silent when its source is empty.
- The cap, cooldowns, dedupe, quiet hours and back-off, checked with an injected clock.
- Notification text contains no memory content (fixture with secrets, names and URLs).
- Zero-network test, both static and runtime.
- The default settings file sends nothing.
- A corrupt settings file sends nothing.

## 3. Long-running projects (X4 option C)

**No "% complete", no progress bar, no ETA, no health score.** Neither the Runtime nor Lens stores a project goal or a definition of done (`PERFORMANCE.md` option C), so any percentage would be invented.

If the user picks option C later:

1. **The user writes the goal and milestones.** Lens stores them as a Lens-local project note (proposed `<LensStore>/projects/<id>.json`, 0600). It could also be a Workflow with `provenance: user_edited`. Fields: title, goal (free text), milestones (text + optional target date), and the aliases the user says belong to this project.
2. **The user links names.** A project is linked to Runtime `project-*` Points and HET `project` strings only through aliases the user typed or confirmed. Lens may suggest literal matches, labelled "Unverified", and never links them silently.
3. **Lens shows activity, never progress.** Per week it shows:
   - counts of memory entries, HET tasks and explicit todo markers that match the linked aliases;
   - a list of those items with their sources (entry id, path, time).
   Every number traces to rows. With no rows it shows 0 and says that this means "no recorded activity", not "no progress".
4. **Only the user marks a milestone done.** A done milestone shows who marked it and when. Lens never infers completion from commits, PRs or todo checkboxes; at most it shows them next to the milestone as activity.
5. **Owner only.** Nothing about projects goes into the Card, `.lensskill`, a weekly letter or a Broker tool until X4's "who can see it" is answered.

## 4. Open questions for the user

- **X9:** may Lens send local notifications at all? If yes, which of T1–T7, and is a content-free default acceptable?
- **X9:** may the brief be generated on a schedule (T1) rather than when Today opens?
- **X4:** is option C wanted? If yes, should projects be a Lens-local note or a Workflow?
