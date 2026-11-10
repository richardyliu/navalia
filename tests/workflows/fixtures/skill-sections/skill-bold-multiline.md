---
description: Release checklist for the desktop app
tags: [pattern, observed]
status: active
created: '2026-10-01'
updated: '2026-10-20'
---

## [2026-10-20T10:00] {id: rel-0002} #pattern #observed
stage: observed

**Pattern**: Ships a desktop release after the test suite is green.
**Steps**:
- Run the full test suite
- Bump the version
- Build the DMG
**Artifacts**:
- signed DMG
- release notes
**Rules**:
- never release on Friday
- typecheck must be clean
**Problems**:
- notarization times out → retry with the stapler
- DMG too large
**Evidence**: 2 sessions across 2 days; receipts `⟨ev-0201:event-2026-10-20.md⟩`
