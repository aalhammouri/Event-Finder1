---
name: OpenAI structured outputs nullable fields
description: JSON-schema rules required by OpenAI strict structured outputs, especially for nullable fields
---
- With `strict: true` structured outputs, OpenAI enforces rigid JSON-schema rules:
  - Nullable fields must use `anyOf: [{type: "string"}, {type: "null"}]` (or the appropriate base type) — plain `nullable: true` or omitting the field is rejected.
  - Every property must be listed in `required[]` (optionality is expressed via the null variant, not by omission).
  - `additionalProperties: false` is mandatory on every object.
- **Why:** violating any of these causes the API to reject the request with a schema validation error rather than degrading gracefully.
- **How to apply:** when adding fields to the event-extraction schema (extractor service), follow all three rules for each new field; test with a live extraction call.
