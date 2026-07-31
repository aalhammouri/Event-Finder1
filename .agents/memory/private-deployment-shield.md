---
name: Deployment visibility shield & URL change
description: Private-visibility "Network error" signature, and that toggling visibility changes the .replit.app hostname
---
- With **visibility: private**, Replit fronts ALL requests with an auth shield: unauthenticated requests get **307 → replit.com/__replshield** and never reach the app.
- **Symptom signature:** the SPA still renders (cached/authed page load), but any `fetch` to `/api/...` follows the 307 cross-origin and the browser blocks it → frontend catch shows "Network error — please try again". Simultaneously `fetch_deployment_logs` shows zero request logs because requests never hit the app instance.
- **Toggling private → public changes the production hostname** (this app: `event-finder--aalhammouri2.replit.app` with double dash → `event-finder-aalhammouri2.replit.app` single dash). The old URL then returns 404 "This app isn't live yet", so users on stale pages/bookmarks keep seeing "Network error" even after the fix. Always re-run `getDeploymentInfo()` after any visibility change and give the user the fresh primaryUrl.
- **How to apply:** when the published app reports network errors, curl the current primaryUrl — a 307 to `__replshield` means private-visibility wall; a 404 "isn't live yet" means stale hostname. Neither is an app bug.
- Use `getDeploymentInfo()` for the production URL — never `$REPLIT_DOMAINS` in dev (that's the dev domain).
