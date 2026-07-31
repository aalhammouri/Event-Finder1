---
name: jsdom must be esbuild-external in api-server
description: Why jsdom is in the build.mjs external list and what breaks if it isn't
---

The api-server bundles to a single ESM file via esbuild (`build.mjs`). `jsdom`
must stay in the esbuild `external` array.

**Why:** jsdom loads data files (e.g. `living/css/.../default-stylesheet.css`)
with `readFileSync` resolved relative to its own module location. When bundled,
that path resolves against `dist/` and the file isn't there, so the server
crashes at startup with `ENOENT ... browser/default-stylesheet.css`. Marking it
external makes Node load jsdom from `node_modules` at runtime, where its data
files exist.

**How to apply:** Any new dependency that reads sibling data files by path
(jsdom, and historically things like @google-cloud protos) must be added to the
`external` list in `artifacts/api-server/build.mjs`. Readability is pure JS and
bundles fine — only jsdom needs externalizing.

**Corollary — externalized deps make their runtime version overrides load-bearing:**
because jsdom is loaded from `node_modules` at startup (not bundled), a bad
transitive-version override crashes the server before it binds its port. A broad
`undici` security override (`>=7.28.0`, no upper bound) resolved to undici 8.x,
which removed `undici/lib/handler/wrap-handler.js` that jsdom@29 / cheerio@1
require → startup crash, `/api/healthz` 500, autoscale promote failure. Keep
`undici` capped `<8` (`>=7.28.0 <8`).
**Why:** broad `>=` overrides greedily pick the highest major; an externalized,
startup-imported package can't tolerate an incompatible major.
**How to apply:** scope transitive security overrides to a compatible major
range, and after any override change run the prod-bundle smoke test
(build → `node dist/index.mjs` → probe `/api/healthz`) before publishing.
