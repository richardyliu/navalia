# HET-X3 — real assessor transport (Runtime agent_funding)

For the approval boundary see `DECISIONS-ROUND4.md` R4-1. This document records the implementation, budget, outbound data and real runs.

## 1. Transport

`src/main/het/agentFundingTransport.ts`, name `agent_funding`.

- Interpreter: `<locate().root>/venv/bin/python`. Missing or not executable → every call returns `budget_unavailable`, **no process is spawned**, and there is no fallback to `claude`.
- Call: `execFile(python, ['-I','-B','-c', AGENT_FUNDING_SCRIPT])`, `shell:false`, cwd = OS tmpdir, stdout capped at 1 MB. `-B` prevents writing `.pyc` files into `~/.persome/venv`.
- The fixed script (a string constant, with no input concatenated into it) reads `{messages:[{role:'user',content:<prompt>}], max_tokens:800}` from stdin, runs `persome.config.load().agent_funding` → `agent_cli.complete(cfg, messages=…, tools=None, max_tokens=…)`, and prints exactly one JSON object to stdout: `{content, client, model}` or `{error, message, client, model}`.
  - `config.load()` reads `paths.root()/config.toml`; when `PERSOME_ROOT` is set, root = that value. The main process always sets `PERSOME_ROOT=locate().root`, so it reads the same config and usage ledger as `readBudget()`.
- Exception mapping: `AgentFundingBudgetExceeded`→`quota`; `AgentFundingTimeout`→`offline`; `AgentFundingUnavailable` (not enabled / executable missing / CLI non-zero exit) and import/config failures →`budget_unavailable`; anything else →`error` (only the exception class name is passed back).
- Child process env: the allowlist is the same as the Runtime's own `agent_cli._PASSTHROUGH_ENV_NAMES` (HOME/USER/PATH/TMPDIR/LANG/LC_*/proxy/CA etc.), plus `PERSOME_ROOT`. No API keys, `NODE_*` or `ELECTRON_*` are passed. PATH gets `~/.local/bin:/opt/homebrew/bin:/usr/local/bin` appended (an app launched from Finder has a very short PATH).
- Timeout: the Runtime's `timeout_seconds` (180 s) fires first and cleans up the CLI child process; the Node side kills python at 180 s + 15 s (if python were killed first, `claude` would become an orphan process).
- Logging: the prompt is never logged. stderr is only taken on error, last 2 KB, passed through `redactForDisplay`, then written to the main process log.

## 2. Gate and budget

The HET section of `src/main/index.ts` injects `transport` + `budget` + `assessorMeta`. Minutes are only produced when all of the following hold:

1. `het-settings.json` `assessorEnabled === true` (default false; the main process never turns it on automatically);
2. the transport exists;
3. budget probe: python exists, and `readBudget()` is `enabled && !exhausted` (otherwise the reason is `runtime_python_missing` / `not_enabled` / `exhausted`);
4. HET's own `perTickCap=5`, `perDayCap=20`. After `quota`/`offline`/`error` it enters a 15-minute backoff and does not retry repeatedly.

Shared budget: each call uses one unit of `$PERSOME_ROOT/.agent-funding-usage.json` inside the Runtime (fcntl lock), sharing the same `daily_call_limit` with the daemon. **Deviation**: the limit on this machine is currently 20000, not the 200 written in the brief (see R4-1a). So what actually limits HET usage is `perDayCap=20`.

## 3. Outbound data

By default (`sendSummariesToAssessor=false`) the prompt contains only: task id, agent, duration_min, stats counts, tool names, signals, file **types**, evidence event ids. No titles, project paths, file paths, summaries or original text are sent. Real prompts measured 1045–3190 characters.

Optional "Send summaries to the assessor": off by default. Turning it on requires a main-process native confirmation dialog (`SEND_SUMMARIES_CONFIRM`), which states what will be sent, to whom (the CLI provider configured in the Persome Runtime), and that it cannot be recalled once sent. Turning it off needs no confirmation.

What Lens stores: verdict, evidence ids, counts, and `agent_calls.{client, model, anchor_version, input_chars, output_chars}` (schema migration v2). It **does not store** the prompt or the raw model output (tests dump the whole table to check).

## 4. UI

`components/het/AssessorPanel.tsx`: an "Allow assessment" toggle (off by default), plus client/model, today's budget (used/limit), a description of what is sent, and a "Send summaries to the assessor" toggle. Copy for each state:

| State | Copy |
|---|---|
| disabled | Assessor off, 0 minutes |
| no_transport | This build has no assessor transport |
| budget_unavailable | Budget unavailable (with reason) |
| has minutes | "Estimate" + anchors v<n> + "not performance, not time saved" |

## 5. Tests

- `tests/het/agentFundingTransport.test.ts` (27): success path (fake exec → verdict → anchors → minutes); a verdict with `minutes` or unknown keys → invalid, 0 minutes; quota/budget_unavailable/offline/error/killed/garbled stdout/maxBuffer exceeded → spawns only once, enters backoff, 0 minutes; off by default, budget exhausted, not enabled, python missing → 0 spawns; neither logs nor het.db contain the prompt; IPC confirmation flow. There are also 2 integration tests that run the fixed script with the **real** `~/.persome/venv/bin/python` against a temp root (`enabled=false`, and executable missing) → `budget_unavailable`, 0 LLM calls, and the stat of the usage file under `~/.persome` is unchanged.
- `tests/het/c23-transport.test.ts` rewritten: off by default; index.ts has the readBudget probe; a call happens only when all gates are open; HET does not import cloud modules, and `/v1/chat/completions` does not appear.
- `tests/e2e/smoke.e2e.mjs`: asserts `transport === 'agent_funding' && assessor.state === 'disabled'`.

## 6. Real runs (2026-11-06, PST)

Method: copied the real het.db (728 `needs_assessment`) into the scratchpad with sqlite `.backup`, wired up the **real** transport + the real `~/.persome` Runtime, with `perTickCap` set to 1 and then 2; the runner is at `docs/test-evidence/PHASE4/x3/runner.ts`. This was not done directly on the running packaged app, for two reasons: that bundle was built before X3, and repackaging would overwrite the running app and reset its TCC grants (see §7).

| # | task | agent | kind | size | complexity | agent_share | adoption | minutes (estimate) | client / model | anchor |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | het_42fc…f4b4d3d1 | claude-code | coding | s | low | 1.0 | unknown | **5.1** | claude-code / (subscription default) | v1 |
| 2 | het_f6d6…094696a | claude-code | research | s | medium | 1.0 | unknown | **3.0** | claude-code / (subscription default) | v1 |
| 3 | het_0bcc…2948ace | claude-code | coding | l | medium | 0.95 | unknown | **27.0** | claude-code / (subscription default) | v1 |

- The minutes for task 1 can be checked by hand: 45 (coding anchor v1) × 0.5 (s) × 0.3 (adoption unknown) × 0.75 (low) = 5.06 → 5.1. All 3 verdicts passed strict schema validation; no `invalid` occurred.
- Calls: 3 (X3 self-limit 20). The usage count went 9→10→12, recorded by the Runtime itself. Each call took about 8–12 s.
- After turning the toggle off: the tick result is `gated: assessor_disabled`, 0 calls, usage unchanged.
- Finding: in the default privacy mode, adoption is `unknown` for all 3 verdicts (the tasks have no `git_commit` or similar signal, and the prompt carries no content), so all minutes were multiplied by 0.3. These are **deliberately low estimates**, not measurements.
- Evidence: `docs/test-evidence/PHASE4/x3/{agent_calls.csv, assessed_tasks.csv, runner.ts}` (no titles or paths).

Conclusion: **X3 PASS (transport + gate + UI + tests + real estimated minutes)**. One item remains: clicking the UI toggle in a freshly packaged app and checking the HET page display, which requires repackaging first (§7).

## 7. Not done

- The packaged build has been rebuilt (2026-11-06 13:49, `e2e:packaged` 30/0/1); the new app is running with the assessor off by default. Remaining: the user clicks "Allow assessment" on the HET page as a UI test.
- `AgentFundingUnavailable` also covers "CLI non-zero exit" (expired login, no network); in that case the UI shows "Budget unavailable", and the reason is not precise enough.
- Anchors calibration (E3.7) still needs user review.
