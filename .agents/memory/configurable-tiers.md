---
name: Configurable tiers system
description: How scoring tiers are stored, evaluated, and displayed after the A/B/C hardcoded enum was replaced with a flexible JSONB-based system.
---

# Configurable Tiers System

## The rule
Tiers are stored as `ScoringTier[]` (JSONB) in `adminSettings.tiers`. Each tier has `{ id, name, minScore, description? }`. Events are assigned the highest-ranked tier whose `minScore` they meet (sort descending by minScore, first match wins).

**Why:** The old hardcoded A/B/C enum prevented admins from renaming tiers, adding/removing tiers, or adjusting thresholds without code changes.

**How to apply:**
- Never reintroduce a hardcoded `"A" | "B" | "C"` tier enum anywhere — tier is a plain string derived from the configurable list; UI colors are rank-based (position in the descending-sorted list), not name-based.
- Keep the backend default tiers and the admin-UI default tiers in sync if either changes (both define the same id/minScore defaults).
- A legacy-string fallback exists in the badge components for old "A"/"B"/"C" values — keep it until stored events are known to be re-tiered.

## Legacy object shape can blank the whole app
`adminSettings.tiers` may be persisted in an OLD shape — a plain object `{ "tierA": 70, "tierB": 45 }` (Tier C implied at 0) — instead of the canonical `ScoringTier[]`. Dev was migrated to the array; production was NOT, and the two drifted.

**Why it matters:** Any code that spreads/iterates tiers (`[...tiers].sort(...)`, `tiers.map(...)`) throws "tiers is not iterable" on the object. This happened during first render of the dashboard, and with no React error boundary the throw unmounted the entire tree → blank white page after login in production.

**How to apply:**
- Production is a READ-ONLY replica and the Publish flow only syncs *schema*, not row data — you cannot hand-migrate a bad tiers value. The durable fix is **normalize-on-read**: `normalizeTiers(raw)` in `scorer.ts` converts a legacy object → array (preserving its thresholds), passes arrays through (incl. empty `[]`), and falls back to `DEFAULT_TIERS` otherwise. It's applied in `serializeSettings` so the API contract always returns an array; the DB self-heals the next time an admin saves scoring settings.
- Treat any `tiers` value from the DB as untrusted shape: guard leaf render consumers with `Array.isArray(tiers)` before `.length`/`.map`/spread (a truthy object passes a `!tiers` check but still crashes).
- The web app now has a top-level `ErrorBoundary` (wraps the tree in `App.tsx`) — keep it; a single render throw must never blank the whole app again.
