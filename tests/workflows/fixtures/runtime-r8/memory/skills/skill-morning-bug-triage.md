---
created: '2026-11-05'
description: Morning Linear bug triage with a Slack summary
entry_count: 1
needs_compact: false
status: active
tags:
- pattern
- observed
updated: '2026-11-05'
---

## [2026-11-05T15:55] {id: 20261105-1555-628bfd} #pattern #observed
stage: observed

**Pattern**: On weekday mornings the user triages the Linear bug queue, updates triage notes, and posts a summary in Slack.
**Context**: start of the work day, around 09:00
**Steps**:
1. Open the Linear triage view — evidence: `cap-triage-d2`, `cap-triage-d1`, `cap-triage-d0`
2. Merge duplicate issues before assigning owners — evidence: `⟨20261105-1555-b18767:event-triage-d1.md⟩`
3. Update triage-notes.md with the queue size — evidence: `⟨20261105-1555-b2902e:event-triage-d0.md⟩`, `cap-notes-d0`
4. Post the summary in #eng-triage — evidence: `⟨20261105-1555-76a016:event-triage-d2.md⟩`
**Artifacts**:
- url: https://linear.app/acme/view/triage — evidence: `cap-triage-d0`
- path: triage-notes.md — evidence: `cap-notes-d1`
- name: #eng-triage summary post — evidence: `⟨20261105-1555-76a016:event-triage-d2.md⟩`
**Rules**:
- P0 issues are assigned the same morning — evidence: `⟨20261105-1555-76a016:event-triage-d2.md⟩`
**Problems**:
- Duplicate issues clutter the queue → merge them before assigning owners — evidence: `⟨20261105-1555-b18767:event-triage-d1.md⟩`
**Evidence**: 3 sessions on 3 distinct dates; receipts ⟨20261105-1555-76a016:event-triage-d2.md⟩ ⟨20261105-1555-b18767:event-triage-d1.md⟩ ⟨20261105-1555-b2902e:event-triage-d0.md⟩
**Confidence**: medium
