---
name: Automation schedule per-list
description: How automated crawling works with list selection
---
- `scheduleEnabled` (bool), `scheduleDays`, `scheduleTime`, `scheduleTimezone`, `scheduleUrlListId` (nullable int) all stored in adminSettingsTable.
- Scheduler reads scheduleEnabled first — returns early if false.
- If scheduleUrlListId is set, only crawls that specific list; otherwise crawls all lists.
- Automation page (/automation) is standalone; NOT in Admin Panel tabs.
**Why:** User may have many URL lists and wants to control which one gets auto-crawled.
