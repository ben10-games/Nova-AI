import "server-only";

/**
 * Small in-memory rate limiter (fixed window + concurrency cap).
 * State lives in this server process only: with several instances or a
 * serverless host, each instance keeps its own counters. Use a shared store
 * (e.g. Redis) or your platform's rate limiting for multi-instance deployments.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const active = new Map<string, number>();
const MAX_TRACKED_CLIENTS = 10_000;

function sweep(now: number) {
  for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export function checkRateLimit(key: string, max: number, windowMs: number): RateLimitResult {
  if (max <= 0) return { ok: true };
  const now = Date.now();
  if (buckets.size > MAX_TRACKED_CLIENTS) sweep(now);
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  if (bucket.count >= max) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  bucket.count++;
  return { ok: true };
}

/** Reserves a concurrent-stream slot. Returns a release function, or null if the client is at its limit. */
export function acquireSlot(key: string, limit: number): (() => void) | null {
  if (limit <= 0) return () => {};
  const current = active.get(key) ?? 0;
  if (current >= limit) return null;
  active.set(key, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (active.get(key) ?? 1) - 1;
    if (n <= 0) active.delete(key);
    else active.set(key, n);
  };
}
