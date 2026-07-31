---
name: URL ingress normalization
description: Every route that accepts user-supplied URLs must normalize before the SSRF check, never after.
---

# Rule

Any API route that accepts user-pasted URLs runs each raw entry through the shared
normalization helper **before** the SSRF safety check, then persists/queues only the
normalized form. Never call the SSRF check directly on raw input at ingress.

**Why:** Users paste org website lists out of spreadsheets and email — entries arrive
scheme-less (`www.haps.org`), wrapped in `<>` or quotes, with trailing commas, or with a
mixed-case host. Validating raw input rejected whole lists over cosmetic problems and
forced hand-editing of dozens of lines. Normalizing first also makes case/trailing-slash
variants of the same site collapse into one stored entry instead of duplicating crawls.

**How to apply:** When adding a new endpoint that takes URLs (import, bulk add, retry,
scheduling), reuse the helper rather than re-validating. Rejections must name the
offending original entries in the 400 message — anonymous "one or more URLs are invalid"
errors are what made this painful in the first place.

# Deliberate non-goals

- Normalization only fixes *shape* (scheme, host case, wrapping junk, fragment, bare root
  slash). It never rewrites path or query case, and never checks reachability.
- A bare label with no dot (`localhost`, `intranet`) is treated as unusable, not as a host
  to be DNS-checked. Private/loopback/metadata addresses are still rejected by the SSRF
  guard applied to the normalized URL.
- Already-stored URLs are not backfilled; only new writes are normalized.
