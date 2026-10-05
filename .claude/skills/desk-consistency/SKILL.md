---
name: desk-consistency
description: Use whenever a change to the GCP Package Desk (Dynamics web resource) touches a stage, label, rule, filter, action or wording. Forces the change to be applied across every page, template, dialog and test, and re-audits the app for leftovers of the old logic.
---

# Desk consistency audit

The Desk is one single-file app assembled by `build2.py` from these parts (scratchpad `handoff/` folder):

| Part | Owns |
|---|---|
| `live2.js` | state `S`, STAGES/VSTAGES, flags, Events/Contacts/Organizations/Home pages, record page, dialogs, click dispatch |
| `print.js` + `design.js` | package pages, checklist text, labels, Packages page, print caution, bulk stage |
| `calendar.js` | Home charts and mail-by calendar |
| `scan.js` + `qr.js` | phone scan page, Mailroom view, QR codes |
| `chatter.js` | discussion, mentions, attachments |
| `desk2.tpl.html` | shell markup, CSS, icons, Events toolbar |
| `mock10.js` / `mock11.js` | Playwright regression with mocked Dynamics API |

A rule written in one part is not applied until it shows up in every part that renders it.

## When a stage, label or rule changes

1. **Grep every part, not just the one you edited.** Search case-insensitively for the old word and every synonym (for example `merge`, `merged`, `Ready to merge`, `Merge gate` when the Merged stage was removed). Include CSS classes, dialog copy, KPI tile subtitles, checklist text in `print.js`, scan-page steps, chart labels, hint paragraphs, and test assertions.
2. **Check the value sites, not only the labels.** A stage number can be written by `stageBody`, `bulkStage`, `WRITES.mergeInto`, `WRITES.mergeNew`, `scanStage`, auto-generate after approve, and `printPreview`. A label rename that leaves a write to the old value behind is a bug.
3. **Keep Dynamics values untouched** (`lead_gcp_stage` option values are owned by Matt). Hide or relabel in `STAGES`; never renumber.
4. **One source of truth.** New vocabulary goes into a constant (`STAGES`, `AU_NAMES`, `VENUE_OPTS`, `PRINT_STAGES`) and every page reads it. Do not hand-write the same list twice.
5. **Filters and bulk actions travel together.** If the Events table gains a filter, column or bulk action, check whether Packages, Mailroom, Organizations sub-event lists and the Home charts need the same.

## Audit checklist before a build

- `grep -ni '<old word>' live2.js print.js calendar.js scan.js chatter.js desk2.tpl.html mock11.js` returns only internal identifiers you decided to keep.
- Every page renders without console errors in the mock: Home, Events (table + kanban + archive), record (all four tabs), Packages (+ Mailroom), Contacts, Organizations (+ one organization page), Reports, Scan page.
- Wording audit in the regression: `document.body.innerText` on each page contains no leftover of the removed term.
- Build label bumped (`python3 build2.py <version>`), gzip refreshed, `app.html.gz` copied for the mock, regression green, then a NEW web resource record `gcp_/packagedesk/build/<version>.html` (file column accepts the first upload only).

## Things that are easy to forget

- The record page has three places for the same action: hero quick actions, Overview `act-bar`, More menu.
- The print caution (`printCaution`) wraps `openPreview`; new print entry points must go through `openPreview`, not `renderPreview`.
- `isClosed`, `stageGate` and `VSTAGES` decide what a stage means; the path bar maps hidden stages with `vstageIdx`.
- Tests: any selector that matches a hidden menu item needs a container prefix (`#tabpanel [data-do=scanqr]`).
