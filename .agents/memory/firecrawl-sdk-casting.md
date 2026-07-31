---
name: Firecrawl SDK v4 casting
description: Why Firecrawl crawl methods are cast as `any` and what their actual return shapes are
---
- The Firecrawl SDK v4 type definitions don't match runtime return shapes for the async crawl methods, so `asyncCrawlUrl`, `checkCrawlStatus`, and `getCrawlErrors` are cast as `any` in the crawler service.
- Actual runtime shapes:
  - `asyncCrawlUrl(url, opts)` → `{ id, url }`
  - `checkCrawlStatus(id)` → `{ status, data: [], total, completed }`
- **Why:** trusting the published types caused compile errors / wrong property access; runtime shapes were verified against live responses.
- **How to apply:** keep the casts when upgrading the SDK until the published types are confirmed to match runtime; re-verify shapes against a live crawl before removing `any`.
