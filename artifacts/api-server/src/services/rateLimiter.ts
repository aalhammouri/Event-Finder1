import { logger } from "../lib/logger";

/**
 * Small dependency-free concurrency helpers used by the crawl engine:
 *
 * - createLimiter(n)  — classic p-limit style semaphore for capping parallelism
 * - politeDelay(domain, ms) — per-domain politeness: serializes requests to the
 *   same hostname and enforces a minimum gap between them, so crawling many
 *   sites in parallel never hammers any single site
 * - reportDomainBackoff(domain, ms) — imposes a cooldown on a domain after a
 *   429/403 so subsequent requests to it wait out the penalty
 * - withRetry(fn, opts) — exponential backoff + jitter retry for transient
 *   failures (network errors, timeouts, 429s, 5xx), honoring Retry-After
 */

// ── Semaphore / p-limit ────────────────────────────────────────────────────────

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    const resume = queue.shift();
    if (resume) resume();
  };

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

// ── Per-domain politeness ──────────────────────────────────────────────────────

// Tail of the per-domain promise chain; awaiting it serializes access.
const domainChains = new Map<string, Promise<void>>();
// Earliest timestamp the next request to a domain may fire.
const domainNextAllowedAt = new Map<string, number>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Waits until it is polite to hit `domain` again, then reserves the next slot
 * `minDelayMs` in the future. Requests to different domains never wait on each
 * other; requests to the same domain are spaced at least `minDelayMs` apart.
 */
export async function politeDelay(domain: string, minDelayMs: number): Promise<void> {
  if (!domain) return;
  const prev = domainChains.get(domain) ?? Promise.resolve();
  const turn = prev.then(async () => {
    const waitMs = (domainNextAllowedAt.get(domain) ?? 0) - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    domainNextAllowedAt.set(domain, Date.now() + minDelayMs);
  });
  // Keep the chain alive even if a link rejects (it never should).
  domainChains.set(domain, turn.catch(() => {}));
  await turn;
}

/** Push a domain's next-allowed time out after a 429/403/5xx response. */
export function reportDomainBackoff(domain: string, cooldownMs: number): void {
  if (!domain) return;
  const current = domainNextAllowedAt.get(domain) ?? 0;
  const proposed = Date.now() + cooldownMs;
  if (proposed > current) domainNextAllowedAt.set(domain, proposed);
}

// ── Retry with exponential backoff ─────────────────────────────────────────────

export interface RetryOptions {
  retries: number;        // number of retries after the first attempt
  baseDelayMs?: number;   // first backoff delay (default 1000)
  maxDelayMs?: number;    // cap for a single backoff (default 30000)
  domain?: string;        // if set, 429/403 responses also cool this domain down
  label?: string;         // for log messages
}

function getStatusCode(err: unknown): number | undefined {
  const e = err as { response?: { statusCode?: number; status?: number }; statusCode?: number; status?: number };
  return e?.response?.statusCode ?? e?.response?.status ?? e?.statusCode ?? (typeof e?.status === "number" ? e.status : undefined);
}

function getRetryAfterMs(err: unknown): number | undefined {
  const headers = (err as { response?: { headers?: Record<string, string | string[] | undefined> } })?.response?.headers;
  const raw = headers?.["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Transient failures worth retrying; 4xx (except 408/429) are permanent. */
function isRetriable(err: unknown): boolean {
  const status = getStatusCode(err);
  if (status !== undefined) {
    return status === 408 || status === 429 || status >= 500;
  }
  // No HTTP status — network error, DNS failure, timeout, reset, etc.
  return true;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { retries, baseDelayMs = 1000, maxDelayMs = 30_000, domain, label } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetriable(err)) break;

      const status = getStatusCode(err);
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = Math.random() * 0.3 * exponential;
      const delayMs = Math.min(maxDelayMs, Math.max(getRetryAfterMs(err) ?? 0, exponential + jitter));

      // Rate-limited or blocked: also cool down the whole domain so parallel
      // workers don't keep hitting it while we wait.
      if (domain && (status === 429 || status === 403 || (status !== undefined && status >= 500))) {
        reportDomainBackoff(domain, delayMs);
      }

      logger.warn(
        { label, domain, status, attempt: attempt + 1, retries, delayMs: Math.round(delayMs) },
        "Retriable fetch failure — backing off"
      );
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
