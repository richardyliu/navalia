---
description: Friday afternoon weekly status report for the demo project
tags:
- pattern
- observed
status: active
created: '2026-10-02'
updated: '2026-10-16'
entry_count: 4
needs_compact: false
---

## [2026-10-02T15:10] {id: wr-0001} #pattern #observed
stage: observed

**Pattern**: Writes a weekly status report from the issue tracker.
**Evidence**: 1 session; receipts `⟨ev-0001:event-2026-10-02.md⟩`
**Confidence**: low

## [2026-10-09T15:05] {id: wr-0002} #pattern #observed #superseded-by:wr-0003
stage: observed

**Pattern**: old wording that was superseded
**Evidence**: receipts `⟨ev-0099:event-2026-10-09.md⟩`

## [2026-10-09T15:20] {id: wr-0003} #pattern #observed
stage: observed

**Pattern**: Writes the weekly status report from closed tracker issues.
**Evidence**: 2 sessions across 2 days; receipts `⟨ev-0002:event-2026-10-09.md⟩`

## [2026-10-16T15:12] {id: wr-0004} #pattern #observed #confidence:high
stage: observed

**Pattern**: Every Friday afternoon, compiles the weekly status report for the demo project from closed tracker issues.
**Context**: Friday 15:00, after the team sync
**Inputs**: closed issues of the week, sync notes
**Tools**: Tracker, Notes, Mail
**Steps**: 1. Filter closed issues in Tracker. 2. Group them by milestone in Notes. 3. Draft the summary. 4. Mail it to the team list.
**Outputs**: weekly-report draft, sent mail
**Boundaries**: only closed issues; no customer names
**Problems**: tracker filter misses reopened issues → re-run the filter with the reopened label
**Evidence**: 3 sessions across 3 days; receipts `⟨ev-0003:event-2026-10-16.md⟩`, `⟨ev-0002:event-2026-10-09.md⟩`
**Confidence**: high
**Frequency**: weekly
