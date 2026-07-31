---
name: Scheduler design
description: Dynamic cron scheduler that reads from DB settings and can be reloaded
---

Key exports from services/scheduler.ts:
- initScheduler(): called once at server startup; calls reloadScheduler()
- reloadScheduler(): stops current task, reads fresh settings from DB, creates new cron task

admin.ts calls reloadScheduler() (non-blocking) after PATCH /admin/settings if any schedule field changed.

scheduleFrequency values: "daily", "weekly" (default), "monthly"
- daily: "M H * * *"
- weekly: "M H * * {dayNums}" (comma-separated, Mon=1...Sun=0)
- monthly: "M H {monthDay} * *"

**Why:** Previous hardcoded "0 6 * * 1" ignored all DB settings. Now cron is rebuilt from scheduleDays, scheduleTime, scheduleTimezone, scheduleFrequency, scheduleMonthDay.
**How to apply:** Always use reloadScheduler() to update the schedule; never call cron.schedule() directly.
