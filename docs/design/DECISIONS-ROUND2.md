# Decisions — Round 2 (2026-11-05)

Until a decision is made, Round 2 follows the "default" column in the table below. Every default is local, account-free and cloud-free, and Lens does not call an LLM.
"Pending decision" lists the questions the user needs to answer; until they are answered, the code does not go beyond the default.

| # | Question | Round 2 default (implemented) | Pending decision |
|---|---|---|---|
| X1 | Cloud / accounts | No server, accounts, telemetry or public-network requests. Cards / skills / backups use local file exchange only (`.persomecard`, `.lensskill`, backup directory) | Whether to introduce any server (self-hosted / third-party); how identity is vouched for (currently self-signed, DEVIATIONS D3a) |
| X2 | Subscriptions | "Subscription folder": the user picks a local / iCloud folder; off by default; a manual "Refresh" scans for `.persomecard` / `.lensskill`, verifies signatures, imports, and dedupes by file hash; no background polling, no network (S2-09) | Whether a shared folder is accepted as the official subscription channel; whether background periodic scans are allowed |
| X3 | HET | Stays off by default, no real transport wired up; the page keeps showing "Not measured" | Whether to authorize a real LLM transport (budget, model, scope of data leaving the machine); whether HET keeps a top-level nav entry |
| X4 | Performance | No metric defined or implemented. `docs/design/PERFORMANCE.md` lists 3 options and a recommendation, marked BLOCKED. Today's "Next steps" is not called Performance (S2-08) | Which definition to choose (HET time / task outcomes / long-running project completion), and who can see it |
| X5 | Build after import | `import-data` defaults to `--no-build`; the Import page's "Build after import" toggle is off by default, and turning it on needs a second confirmation and warns that it will call the Runtime's LLM (S2-10) | Whether to allow it on by default |
| X6 | Habit threshold | Runtime unchanged; Lens keeps the label "Observing (fewer than 3 distinct dates)"; upstream proposal in `docs/upstream/HABIT-3-DATES.md` | Whether to submit that proposal upstream |
| X7 | Automatic Workflow extraction | **Lens does not call an LLM.** "Extract from session / text" = Lens provides a prompt + JSON schema → the user runs it in Claude Code / Codex → pastes the JSON back into Lens → saved after `WorkflowSchema` validation (S2-07) | Whether to allow a built-in LLM adapter in Lens (model, budget, scope of data leaving the machine) |

## Pending decisions added in Round 2

| # | Question | Default | Pending decision |
|---|---|---|---|
| X8 | Whether backups include the Access log (`audit.db`) and grants | **Excluded** by default: `audit.db`, `grants.json`, `identity/ed25519.key.enc` (S2-02) | Whether to offer an explicit "include Access log" option |
| X9 | Proactive layer (Tray / Notification / globalShortcut / scheduled brief) | Not built; "Today" is refreshed manually | Whether Lens may stay resident in the menu bar and post local notifications (still no network) |
| X10 | Publishing upstream notes (MOD-07, IMPORT-SOURCE-KEY, HABIT-3-DATES) | Written only in this repo's `docs/upstream/` | Whether to file issues / PRs against the personal-model upstream |
