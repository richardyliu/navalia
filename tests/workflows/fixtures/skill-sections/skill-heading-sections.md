---
description: Monthly invoice run
tags:
- pattern
- observed
status: active
---

## [2026-10-31T09:00] {id: inv-0001} #pattern #observed
stage: observed

**Pattern**: Sends client invoices on the last working day of the month.

### Steps
1. Export hours from the tracker
2. Fill the invoice template
3. Email the PDF

### Artifacts
- invoice PDF

### Rules
- one invoice per client

### Problems
- template totals wrong → recalc the sheet before export

### Notes
free text that is not a Workflow field

**Evidence**: receipts `⟨ev-0301:event-2026-10-31.md⟩`
