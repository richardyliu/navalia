# DECISIONS — Round 4 (S1-FULL → X3 + real acceptance)

Date: 2026-11-06. This file is this round's Approval Ledger. Any extension not listed here is treated as not approved.

## R4-1 X3: real HET assessor transport — approved

| Item | Decision |
|---|---|
| Enabled? | **Approved**. Still `assessorEnabled=false` by default; the user turns it on explicitly on the HET page |
| Transport | Runtime `[agent_funding]` (option C): the Lens main process runs `execFile(<root>/venv/bin/python, ['-I','-c',<fixed script>])`, which calls `persome.writer.agent_cli.complete`. **Does not spawn `claude`/`codex` directly** (that would bypass the shared fcntl lock and daily_call_limit) |
| Provider / model | Uses `[agent_funding] client/model` from `~/.persome/config.toml`; het.db records client / model / anchor_version |
| Budget | Reuses `[agent_funding] daily_call_limit` (per local date); HET's `perTickCap` / `perDayCap` apply on top; exhausted → `budget_unavailable`, no retry |
| Data leaving the machine | `sendSummariesToAssessor` defaults to false: sends only task id, agent, duration, counts, tool names, signals, file types |
| User option | "Send summaries to the assessor" can be turned on explicitly, with a second confirmation; the UI states what is sent, to whom, and that it cannot be undone |
| Retention | Lens stores only verdict / evidence ids / counts; never the raw prompt |
| Source of minutes | The assessor outputs only kind/size/complexity/agent_share/adoption/evidence; minutes are computed deterministically from anchors; output with `minutes` or unknown keys → `invalid` |
| UI semantics | "Estimate" + anchor version; not Performance / a performance score / time saved |
| Cloud HET | **Not approved**: HET does not use cloud `/v1/chat/completions` |

### R4-1a Observed deviation (recorded, no action)

- The brief says `daily_call_limit = 200`; this machine's `~/.persome/config.toml` actually has **20000** (read 2026-11-06, used=7).
  Lens does not modify the Runtime config or usage file. So this round's effective limit is **the brief's self-imposed caps**
  (X3 ≤20, Workflow ≤40, cloud extraction ≤20, Faces/build ≤40) + HET `perDayCap=20`, not the Runtime's 20000.
  **User confirmed (2026-11-06): 20000 is an intentional change; the 200 in the brief is outdated.** The Runtime limit stays at 20000;
  HET is still bound by its own `perTickCap=5` / `perDayCap=20`.

## R4-2 Still not approved

- New third-party accounts / OAuth (Google / Notion / Outlook have no client id → BLOCKED).
- X7 built-in LLM in Lens. Workflow extraction goes only through the Runtime `pattern_detector` or the approved Cloud extraction path.
- HET using a cloud LLM.
- Signing / notarization / auto-update: this machine only has an `Apple Development` certificate, no Developer ID and no release source → BLOCKED.

## R4-3 Operating constraints for this round

- No changes to Runtime code, no direct writes to `index.db`; upstream gaps go in `docs/upstream/*.md`.
- No faked HET minutes, Workflow steps, Faces, cloud deliveries or CAP results.
- Real cloud tests rely only on environment variables; this machine's shell environment has no `CLOUD_LLM_*` / SMTP / `CLOUD_SONIOX_API_KEY` → those items are BLOCKED.
- No push / no PR / no release.
