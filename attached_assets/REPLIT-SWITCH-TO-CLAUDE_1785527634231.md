# Task: Replace OpenAI with Claude (Anthropic) across the app

Do **not** set the OpenAI variables. We are switching the AI provider to Claude.
This is a real migration — the client, the structured-output mechanism, the vision
format, and the response-parsing shape all differ. Follow this exactly.

## 1. Dependency and client

```bash
pnpm --filter @workspace/api-server add @anthropic-ai/sdk
pnpm --filter @workspace/api-server remove openai
```

Replace `getOpenAIClient()` in `artifacts/api-server/src/services/extractor.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";

let anthropicClient: Anthropic | null = null;

/** Returns null when no API key is configured — callers fall back to regex extraction. */
export function getAnthropicClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ maxRetries: 3 });
  }
  return anthropicClient;
}
```

Keep the old export name as an alias if that avoids churn, but update the three
importers: `extractor.ts`, `services/enrichment.ts`, and the `analyze-errors`
route in `routes/crawlRuns.ts`.

**Environment variable: `ANTHROPIC_API_KEY`.** Set it in **both** the workspace
Secrets and the Deployment Secrets, then republish — deployments do not inherit
workspace secrets retroactively.

## 2. Model

Use **`claude-opus-5`** for every call, text and vision alike. It is one model
with native vision, so the current gpt-4o-mini / gpt-4o split collapses into a
single model string.

Do not substitute a cheaper model on your own initiative. If cost turns out to be
a problem at 2,000+ pages per run, tell me the measured numbers and I will decide
whether to move some calls to `claude-sonnet-5` or `claude-haiku-4-5`.

## 3. Request shape — four differences from OpenAI

**a. The system prompt is a top-level parameter, not a message.**

```ts
// OpenAI
messages: [ { role: "system", content: SYSTEM }, { role: "user", content: USER } ]

// Anthropic
system: SYSTEM,
messages: [ { role: "user", content: USER } ]
```

**b. `max_tokens` is required** on every request.

**c. Structured output uses `output_config.format`, not `response_format`.**
The existing JSON Schemas (`EVENT_EXTRACTION_SCHEMA`, `EVENT_CLASSIFY_SCHEMA`,
and enrichment's `ENRICH_SCHEMA`) carry over as-is — `anyOf`, `enum`,
`required`, and `additionalProperties: false` are all supported. Drop the OpenAI
wrapper keys `name` and `strict`; pass only the schema:

```ts
// OpenAI
response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }

// Anthropic
output_config: { format: { type: "json_schema", schema } }
```

**d. Responses are a content-block array, not `choices[0].message.content`.**

```ts
const response = await client.messages.create({ ... });

// Guard refusals BEFORE reading content — a refused request returns HTTP 200
// with an empty or partial content array.
if (response.stop_reason === "refusal") return null;

const text = response.content.find((b) => b.type === "text")?.text;
if (!text) return null;
const parsed = JSON.parse(text);
```

## 4. Vision (the image path in `extractFromImages`)

The block shape is different and there is **no `detail` parameter** — delete the
`detail: idx < 2 ? "high" : "low"` logic entirely.

```ts
// OpenAI
{ type: "image_url", image_url: { url: `data:${mime};base64,${b64}`, detail: "low" } }

// Anthropic — media type and raw base64 are separate fields, no data: URI
{ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.base64 } }
```

`media_type` must be a real MIME type (`image/jpeg`, `image/png`, `image/webp`,
`image/gif`) — `fetchImageAsBase64` already returns one in `img.mimeType`.

## 5. Enable prompt caching — do not skip this

The system prompts are large and byte-identical across every page in a run, so
caching them cuts input cost on the repeated portion by roughly 90%. Pass `system`
as a block array with a cache breakpoint:

```ts
system: [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
],
```

**This only works if the prompt text is byte-identical between requests.** The
prompts currently interpolate `todayForPrompt()`, which changes daily — that is
fine (the cache re-forms each day) but it must not become finer-grained than
that. Do **not** interpolate a timestamp, per-page value, or run ID into the
system prompt.

Verify it is working: log `response.usage.cache_read_input_tokens` on a run. If
it stays 0 across many pages, something is varying the prompt and caching is off.

## 6. Cost and latency control

Claude Opus 5 thinks by default, and `max_tokens` caps thinking **plus** the
response together — so an existing tight `max_tokens` can now truncate output.
For this extraction workload, set effort explicitly on the two text passes:

```ts
output_config: { format: { ... }, effort: "low" },   // Pass 1: classification
output_config: { format: { ... }, effort: "medium" }, // Pass 2: field extraction
```

Raise `max_tokens` on the extraction pass from 1200 to at least 4000 to leave
room. Report back what a full run costs so we can tune from there.

## 7. Error handling

Replace any OpenAI error handling with the Anthropic classes, most specific
first:

```ts
import Anthropic from "@anthropic-ai/sdk";

try { /* ... */ }
catch (err) {
  if (err instanceof Anthropic.RateLimitError) { /* backoff */ }
  else if (err instanceof Anthropic.AuthenticationError) { /* bad key */ }
  else if (err instanceof Anthropic.APIError) { /* other API failure */ }
  else throw err;
}
```

The SDK already retries 429 and 5xx with backoff via `maxRetries: 3` — do not add
a second retry layer on top.

## 8. Keep unchanged

- The concurrency limiter (`createLimiter` / `AI_MAX_CONCURRENCY`) — still needed.
- The prompt *text* itself. Do not rewrite the extraction prompts during this
  migration; changing the provider and the prompts at once makes a quality
  regression impossible to attribute.
- The keyword gate, dedupe, scoring, and enrichment logic.

## 9. Add a status endpoint — required

There is currently no way to tell from the app whether AI is configured, which is
how a 117-minute run completed with the extraction layer silently disabled. Mirror
the existing `GET /admin/email-status` pattern:

Add **`GET /api/admin/ai-status`** returning `{ configured, reachable, model, error }`.
`configured` checks the env var; `reachable` makes one cheap `max_tokens: 1` call
and reports whether it succeeded. Surface it as a badge in the Admin panel.

Also add a **pre-run guard**: if AI is not configured, a crawl run must either
refuse to start or be flagged prominently in the UI — never silently fall back to
regex-only extraction and report "COMPLETED".

## 10. Verify before reporting back

1. `pnpm run typecheck` passes.
2. `GET /api/admin/ai-status` returns `configured: true, reachable: true`.
3. Run a **single-site crawl against `https://inspirationranch.org`**. Expected
   result: event name "18th Annual Denim and Diamonds Gala", date September 19,
   venue The Woodlands Waterway Marriott, silent auction **and** live auction
   true, contacts MG Tindall / Melissa Jurik. Report the actual extracted row.
4. Confirm `response.usage.cache_read_input_tokens` is non-zero after the first
   few pages.
5. Report token usage and estimated cost for that single-site run.

If the extracted row still comes back with a name but no date or venue, the AI is
working and the issue is elsewhere — tell me rather than guessing.
