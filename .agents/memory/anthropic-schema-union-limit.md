---
name: Anthropic output_config json_schema union limit
description: Anthropic API rejects json_schema with more than 16 nullable/union fields — use effort-only output_config for large schemas
---

# Anthropic output_config json_schema union limit

## The rule
Anthropic's `output_config.format.json_schema` rejects schemas with more than **16 parameters that use `anyOf`, `type` arrays, or other union constructs**. Sending a schema over the limit returns HTTP 400 "Schemas contains too many parameters with union types".

**Why:** Exponential compilation cost on the server side.

**How to apply:**
- For small schemas (≤ 16 nullable fields): use `output_config: { format: { type: "json_schema", schema: ... }, effort: "..." }` normally.
- For large schemas (> 16 nullable fields): drop `format` from `output_config` and rely on a well-written system prompt to enforce JSON structure. Keep `effort` alone: `output_config: { effort: "medium" }`.
- Count every `anyOf`, `type` array, and enum+null union toward the limit — they all compile as union types on Anthropic's side.
