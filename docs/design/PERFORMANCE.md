# Performance — what it could mean (S2-11)

Status (updated 2026-11-06, Round 4): **B and C are implemented; A exists only as an opt-in estimate (X3), not as Performance.**

| Option | State | Where |
|---|---|---|
| **A** — HET minutes | **Estimate only, opt-in (Round 4, X3 approved).** Default off → 0 minutes. When the user turns on 「允许评估」, the Runtime `[agent_funding]` transport produces LLM verdicts and anchors turn them into minutes shown as 「估计」 + anchor version. This is **not** Performance, not a grade and not time saved; 「表现」 does not use HET minutes. First real run: 3 tasks → 5.1 / 3.0 / 27.0 min (`HET-X3.md` §6). | `src/main/het/agentFundingTransport.ts`, `tests/het/{agentFundingTransport,c23-transport}.test.ts` |
| **B** — count view, owner-only | **Done**, twice. (1) S1-R3-04 / S1-R4-04: the Home card 「本周 AI 工作计数」 (details below). (2) S1-FULL C16: the 「表现」 page counts per day / per ISO week: HET corrections (`accepted` / `rejected` / `not_agent`), `git commit` *calls* seen in Claude Code / Codex transcripts (with the hash only when git's own output shows it), and commits by the user's email in local repos the user adds (read-only `git log`). Every number opens the rows behind it. A source that is not configured or cannot be read shows 「未知 / 未接入」, never 0. | `src/main/performance/{het,git,transcriptHash,service}.ts`, `pages/Performance.tsx`, log `docs/design/s1full-log/C16-C17.md` |
| **C** — long-horizon projects | **Done as an activity view only** (S1-FULL C16, D-C16b). The user writes the goal and milestones in `<LensStore>/performance/projects.json` (0600). Lens lists dated activity that matches the user's keywords / paths / repos. There is no % complete and no ETA. Only the user's tick marks a milestone done. | `src/main/performance/store.ts`, `components/performance/ProjectsPanel.tsx` |

This supersedes the 2026-11-05 line "A and C were not chosen". The S1-FULL brief asked for C, built as above. The user-facing word is 「表现」, and the English word "Performance" still does not appear in the renderer. Owner-only still holds: no Broker tool or route, Card, `.lensskill` or weekly letter carries 「表现」 data (`tests/performance/static.test.ts`, `tests/home/x4-owner-only.test.ts`).

Known limits (from C16): a transcript `git commit` is a command call, not a confirmed commit. HET keeps a bounded set of evidence per task, so heavy-commit tasks can undercount. Project activity from memory uses Runtime `search` (top 20 per keyword, then a literal filter).

Previous status (2026-11-05): **X4 decided = B (count view, owner-only)** — user decision 2026-11-05, `DECISIONS-ROUND3.md` §1. Implemented in S1-R3-04 and formalized in S1-R4-04 (`docs/design/s1-log/S1-R4-04-05.md`).

What B is, exactly (the boundary from the ledger):

- Home card 「本周 AI 工作计数」: for HET tasks that ended in the current ISO week, the number marked `accepted`, `rejected`, `not_agent` by the user, and the number with a `git_commit` signal (`src/main/het/weekCounts.ts`). No minutes, rate, trend or score.
- Every number opens the HET page filtered to exactly those tasks (`countFilter.ts`, `FilteredTaskList.tsx`).
- The card says literally 「这是计数，不是绩效分，不代表节省时间」 (`aiCountsView.ts` `AI_COUNTS_DISCLAIMER`). It is never called a score or Performance.
- Owner-only: no Broker MCP tool and no Broker REST route serves the counts; the Card, `.lensskill` and the weekly letter do not contain them (`tests/home/x4-owner-only.test.ts`). Caveat [INFERRED]: the pre-existing OG-08 HET REST routes on the Broker (`GET /het/tasks`, `/het/period`) return task rows that include `correction` and `signals`, so a connected agent with HET access could recount them itself. The count view adds nothing to that surface.
- The HET page eyebrow is now `HET · 等效人工时间（未测量）`; the word Performance no longer appears in the renderer.

Everything below is the **historical** S2-11 analysis that led to the decision. It is kept for the reasoning; its "BLOCKED" wording and recommendations are superseded by the status above.

---

*Historical (S2-11, before the decision):*

- **No Performance metric is implemented in Lens.** No code computes, stores or shows a "Performance" number, score, rate or trend.
- **The UI must not promise Performance.** No page, chip, empty state or export may say or imply that Lens measures how well the user (or their agents) perform.
- **Today's 「下一步」 / 「明天建议」 is not Performance.** It restates explicit todo markers (`- [ ]`, `TODO:`, `待办：`, `下一步：` …; regex at `src/main/library/brief.ts:113`) and verbatim learned patterns, and each line is labelled 「未核实」 (`brief.ts:13`, `:187-188`). It measures nothing (GAP-vs-S1-R2 §2, S2-08).
- **HET minutes are not Performance either.** HET is off by default and produces 0 minutes (see option A).

Where the word comes from: the S1 article title is 《…Personal Agent 要从 Context 走向 Performance》. DECISIONS X4 records that the article does not define Performance (`docs/design/DECISIONS.md:10`). The "长程项目" reading in option C is taken from DECISIONS-ROUND2 X4. I did not re-read the article for this doc, and I have no quote from it that defines Performance.

## Existing UI wording that conflicted with this doc (resolved)

- *Resolved S1-R4-04:* `src/renderer/src/pages/Het.tsx` used to render the eyebrow **`Performance · HET`** (later `HET · Human Equivalent Time`). It now reads `HET · 等效人工时间（未测量）`.
- `docs/design/DESIGN.md:64,79,260,418` calls HET the "Performance Plane". That is v2.1 architecture naming and not user-facing text. Since option A was not chosen, the plane name is historical.

## Option A — Performance = HET time (human-equivalent minutes) (X3 approved as an opt-in *estimate*; still not Performance)

**What it would mean.** For each agent task: the minutes a human would have needed, computed deterministically from an LLM verdict (kind / size / complexity / adoption) and versioned anchors.

**Data that exists today**

| Source | What it holds | Ref |
|---|---|---|
| Claude Code / Codex transcript adapters (read-only) | Agent events, tool calls, files written, coarse signals | `src/main/het/adapters/{claudeCode,codex,common}.ts` |
| Segmenter → `het_tasks` | One row per agent task: agent, project, start/end, stats, `files_written`, `signals` (`git_commit`, `git_push`, `pr_create`, `pr_link`, `tool_error`), `attended_ms` | `src/main/het/schema.ts:42-75`, `src/main/het/types.ts:21,80-104` |
| Anchors | Versioned and immutable; `minutes = anchor(kind) × size_units × adoption_weight × complexity_factor` | `src/main/het/anchors.ts:1-58`, `schema.ts:27-40` |
| User corrections | `accepted` / `rejected` / `not_agent`, each appended to `het_events` | `schema.ts:14,60`, `src/main/het/ledger.ts:250-262,341-351` |
| Weekly Review export | Local Markdown/HTML that states the assessor is off | `src/main/het/weekly.ts` |

**What is missing**

- **(Round 4 update: the transport now exists — see `HET-X3.md`. The text below describes the pre-X3 state and is kept for history.)** **The assessor.** `assessorEnabled` defaults to `false` (`src/main/het/settings.ts:42`). The production transport is `disabledTransport` (`src/main/het/assessor.ts`, header comment; `service.ts:1-26`). Minutes need all three of switch on, real transport, and budget available (`service.ts:40-53` `assessorGate`). As a result every task stays `needs_assessment` and counts 0 minutes (DEVIATIONS D22; README Limitations "HET does not measure anything yet").
- **A decision on LLM transport, budget and what data leaves the machine** (DECISIONS X3). `assessor.ts` documents option C (spawn the Runtime's own interpreter and reuse `[agent_funding]`). It is not implemented.
- **Calibration.** Default anchors (`anchors.ts:22-29`, e.g. coding 45 min per 200 lines/PR) are design defaults. No dataset checks them against real human time.
- **REST `/het/*`.** HET is IPC only (DEVIATIONS D17, HET-05 FAIL in `docs/test-evidence/REPORT.md`).

**Risks**

- **Goodhart.** Minutes rise with size buckets and with how many tasks get segmented. More, longer agent runs read as "more performance". Adoption weights (`anchors.ts:33-40`, `unknown` = 0.3) still pay something for unadopted output.
- **Fabrication.** An LLM guesses size and complexity, so the minutes are an estimate presented with integer precision. The code prevents the LLM from emitting minutes directly (`assessor.ts` rejects a `minutes` key). It cannot make the estimate true.
- **Privacy.** The assessor needs redacted task summaries to leave Lens for an LLM provider (`redact.ts`, `persistSummaries`). Today nothing leaves.
- **LLM cost.** One call per settled task. It is bounded by per-tick and per-day caps and the shared `daily_call_limit` (assessor.ts option C), but it is never free.

**Status (Round 4):** transport implemented and verified with 3 real calls; minutes are an estimate, deliberately not promoted to a Performance metric. Anchors are uncalibrated (E3.7).

## Option B — Performance = task effectiveness / outcomes (chosen, as a count view only)

**What it would mean.** Did agent work get used? Rates such as accepted vs rejected corrections, tasks that ended in a commit/PR, or Workflow versions the user kept.

**Data that exists today (all local, none of it aggregated into a metric)**

| Source | Signal | Ref | Caveat |
|---|---|---|---|
| HET corrections | `accepted` / `rejected` / `not_agent` per task | `het/ledger.ts:341`, `het/ipc.ts:30` | These correct the *attribution and adoption* of a HET task (`effectiveAdoption`, `ledger.ts:252-256`; `not_agent` ⇒ 0 min, `:260`). They do not grade quality. Users correct only a few tasks, so the sample is self-selected |
| HET signals | `git_commit`, `git_push`, `pr_create`, `pr_link`, `tool_error` | `het/types.ts:21` | Presence only. A commit can be reverted, and Lens has no merge, CI or revert signal |
| Workflow versions | `provenance` ∈ `observed / imported / user_edited / shared`, `based_on_version` | `src/main/workflows/schema.ts:14-20,75-76` | An edit means the user changed the method. It does not mean the agent did badly |
| Runtime model corrections | `correct_memory` supersedes an entry and keeps the old one with a reason (MOD-10 PASS) | `docs/test-evidence/REPORT.md` (MOD-10) | These correct the *model of the user*, not task outcomes |
| Broker Access log | Per call: client, capability, item_count, response_chars, outcome | `src/main/broker/audit.ts:66-80` | Shows that an agent *read* context. It says nothing about whether that helped |
| Today brief checkboxes | `- [ ]` lines in a generated Markdown | `library/brief.ts:212` | When I read `pages/Today.tsx` (2026-11-05, S2-08 in progress) checkbox state was not persisted. There is no "done" history |

**What is missing**

- A definition of "outcome" per task kind (merged PR? accepted doc? question answered?) and a source of truth for it. Lens has no CI, VCS-host or review integration, and it must not go online (BRIEF; DECISIONS X1).
- Any linkage between a Broker read (`audit.db`) and a later HET task. They share no key today.
- Durable user feedback. The existing corrections serve another purpose (attribution).

**Risks**

- **Goodhart.** Users or agents learn to accept by default, or to commit early. `tool_error` counts penalize exploratory work.
- **Fabrication.** Turning sparse signals into a rate invents precision. With a handful of corrections per week, the rate is noise.
- **Privacy.** Outcome data about colleagues' reviews or PRs would need network access or more capture. Even a local "effectiveness score" invites managerial use (X4 also asks *who can see it*).
- **LLM cost.** Low if purely deterministic. Grading quality with an LLM brings back X3/X7.

## Option C — Performance = long-horizon project completion (长程项目) (historical analysis; implemented as an activity view in C16, see Status)

**What it would mean.** For a multi-week project: is it progressing toward done? Milestones reached, open items shrinking, time spent per project over weeks.

**Data that exists today**

| Source | Ref | Caveat |
|---|---|---|
| Project entities (Runtime `project-*` Points, relation `*_entity_kind`) | `src/main/library/aggregate.ts:14-18,189-226`; DEVIATIONS D28 | Only names and relations. No goal, milestone or "done" state |
| HET `project` per task + time range | `het/schema.ts:44` (`project TEXT`) | Taken from the agent's working dir/session. 0 minutes while the assessor is off; start/end are wall-clock, not effort |
| Attention / timeline | MCP `attention_trajectory` (`src/main/broker/catalog.ts:50`; `het/types.ts:62-66`) | Attention is not progress |
| Explicit todos in activity | `brief.ts:113` regex | Only the latest 100 activity entries (D29). No project link, no closure detection |

**What is missing**

- A project goal and completion definition. Neither the Runtime nor Lens stores one. Inferring it would be fabrication.
- Cross-week identity of "the same project" across HET `project` strings and Runtime `project-*` Points. Nothing maps them.
- A history of todo open → closed. The brief is regenerated and keeps no history.

**Risks**

- **Fabrication (highest of the three).** "% complete" without a user-declared goal is invented.
- **Goodhart.** Users split projects or declare trivial milestones.
- **Privacy.** Project-level summaries are the most shareable artefact, and the most sensitive to an employer.
- **LLM cost.** Summarizing weeks of activity per project is the most expensive option if done with an LLM.

## Recommendation (historical; the user chose recommendation 2)

1. **Keep X4 BLOCKED until the user decides.** Ship nothing called Performance. Fix the `Het.tsx:67` eyebrow as above.
2. If the user wants a first step, **prefer a narrow, honest version of B**: a local, owner-only *count* view with no rate or score, e.g. "this week: N tasks you marked 采纳, M marked 不采纳, K with a commit signal". Every number must trace to rows in `het_tasks` / `het_events`, and the page must say what the numbers are not. It needs no LLM and no network. It still depends on the user actually correcting tasks, so it will often show 0 and must say so.
3. **A only after X3 is decided.** HET minutes are an LLM-backed estimate. If X3 is approved they can be shown as 「估计」 with the anchor version, never as a performance grade.
4. **C only with user-declared goals.** The user writes the project goal and milestones themselves (e.g. as a Workflow or a Lens-local note). Lens then shows activity *against* them without computing "% complete".

Whichever option is chosen, X4's second question ("谁能看") must be answered before any number leaves the owner's machine (Card, `.lensskill`, weekly letter, Broker tool).

## Open questions for the user (X4) — answered 2026-11-05: B, owner only, a count view is acceptable

- Which definition (A / B / C), or none?
- Who may see it: owner only, connected agents via Broker, friends via card/letter?
- Is a deterministic count view (recommendation 2) acceptable as "not Performance", or should it wait too?
