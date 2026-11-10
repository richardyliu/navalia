# Decisions — Round 3 (2026-11-05, S1 wrap-up)

Decided by the user on 2026-11-05. This file is the Round 3 Approval Ledger: code in this round is implemented only within the "Boundary" column of the tables below. Any requirement beyond a boundary stops work and is logged in "Out-of-bounds log" at the end of this file; it is never implemented silently.

Earlier decisions: `DECISIONS.md`, `DECISIONS-ROUND2.md` (original questions X1–X10), `DECISIONS-OG.md` (OG-D1..D5).

## 1. Approved

| # | Decision | Boundary |
|---|---|---|
| X4 | **Approved B: this week's AI work counts** | Visible to the owner only; not called a "score"; not exposed through the Broker; every number links back to the HET task list; the page states "These are counts, not a rating of your work, and do not represent time saved". A (HET minutes) and C (long-running project completion) were **not chosen**. |
| X9 | **Approved local notifications** | User must turn them on, off by default; build T3/T4/T5 first, then T1/T2; at most 3 per day; quiet hours (default 22:00–09:00); notifications contain no body text; no network; no further prompting after the user denies permission. |
| X2 | **Approved background scanning of local subscriptions** | Scans only the local folder the user picked; off by default; non-recursive, no network; periodic scanning must be turned on by the user; manual refresh stays. |
| X5 | **Approved build after import** | Off by default; second confirmation before turning on; warns that it will call the Runtime's LLM; costs nothing by default; on failure shows the exit code and stderr. |
| X8 | **Approved optional Access log in backups** | Excluded by default; the user must explicitly tick it; the manifest records whether it is included; still never includes the private key (`identity/ed25519.key.enc`) or `grants.json`. |

## 2. Not approved / still BLOCKED

| # | Decision | Meaning |
|---|---|---|
| X7 | **Built-in LLM in Lens not approved** | Workflow extraction keeps going through an external Agent (copy the prompt, paste the JSON back). R8 structured Workflows and data rebuilds use **the Runtime's own LLM** (`[agent_funding]`); Lens sends no LLM requests. |
| X1 | **Cloud / accounts not approved** | Chat, Meetings, Check-ins delivery and cloud sync stay BLOCKED, with no fake versions either. |
| X3 | **HET transport not approved** | HET keeps showing "Not measured"; this is not core to S1. |
| OG-D3 / OG-D4 | **Still BLOCKED** | No Developer ID and no release source; no pretending to sign, notarize or auto-update. |

## 3. Constraints that apply to every item

- Local first: no cloud, accounts, telemetry or public-network requests.
- No new npm dependencies.
- Lens does not write the Runtime's `index.db`; it goes only through the Runtime's CLI, REST API or MCP.
- `~/.persome` must be backed up before rebuilding the model or deploying R8; roll back per DEPLOY-06 / R7 in `UPSTREAM-DEPLOY.md`.
- No faked lineage, Workflow structure, minutes, notifications or Performance.
- LLM budget: the Runtime's `[agent_funding] daily_call_limit = 200`, counted per **local date** (`personal-model-og/src/persome/writer/agent_cli.py:318` `_usage_date` uses `datetime.now().astimezone().date()`). Lens and this round's agents do **not** change the limit and do **not** reset the usage file; doing so would be spending money without authorization.

## 4. Out-of-bounds log

(Log here any requirement found to need X1/X3/X7 or to exceed the boundaries above.)

| Date | Task | What it needs | Handling |
|---|---|---|---|
| 2026-11-05 | S1-R4-02 R8 real run | Runtime LLM quota (200/200 used up for the day, resets at local midnight) | **BLOCKED (budget)**; the limit was not changed and usage was not reset. R8 is deployed; the real pattern_detector run waits for quota to recover. |
| 2026-11-05 | S1-R4-01 lineage | The plan was to rebuild with `model build`, but both the code and a test on a copy show that `model build` does not backfill links for existing Points | Switched to the upstream deterministic backfill R9 (the Runtime's own CLI, no LLM, Lens does not write the database). This is local Runtime integration and within the original approval. Rehearsed on a copy, then applied to real data after a backup. |
| 2026-11-05 | X8 | The original text said "copy audit.db (consistent snapshot)" | It is actually exported as JSON (`lens/access-log.json`) so it passes the backup's secret scan; still off by default and requires an explicit tick. DEVIATIONS D68. |
