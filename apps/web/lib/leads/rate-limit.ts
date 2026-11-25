/**
 * In-memory sliding-window rate limiter for the public lead endpoint
 * (docs/CONTRACTS.md §5): 5 submissions / 10 minutes / IP.
 *
 * LIMITATION — this is deliberately tiny, not production rate limiting:
 *  - the window lives in this process's memory, so it resets whenever the
 *    process restarts (every `next dev` hot reload / redeploy);
 *  - it is NOT shared across instances, so N replicas effectively allow
 *    5 × N submissions per IP per window;
 *  - IPs come from proxy headers and can be spoofed when the app is reachable
 *    without going through the trusted proxy that sets them.
 * A real deployment should use a shared store (Redis) or the edge platform's
 * limiter, plus a persistent record of submissions.
 */

export const WINDOW_MS = 10 * 60 * 1000;
export const MAX_SUBMISSIONS = 5;

type Bucket = number[];

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  /** Submissions left in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the oldest hit in the window expires (0 when allowed). */
  retryAfterSeconds: number;
}

/** Drop expired hits for one IP; returns the surviving bucket. */
function prune(ip: string, now: number): Bucket {
  const hits = buckets.get(ip);
  if (!hits || hits.length === 0) return [];
  const fresh = hits.filter((at) => now - at < WINDOW_MS);
  if (fresh.length === 0) {
    buckets.delete(ip);
    return [];
  }
  if (fresh.length !== hits.length) buckets.set(ip, fresh);
  return fresh;
}

/** Record one submission attempt for `ip` and report whether it is allowed. */
export function check(ip: string): RateLimitResult {
  const key = ip.trim() === '' ? 'unknown' : ip.trim();
  const now = Date.now();
  const hits = prune(key, now);

  if (hits.length >= MAX_SUBMISSIONS) {
    const oldest = hits[0] ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  hits.push(now);
  buckets.set(key, hits);
  return {
    allowed: true,
    remaining: Math.max(0, MAX_SUBMISSIONS - hits.length),
    retryAfterSeconds: 0,
  };
}

/** Clear every bucket. Tests only (also handy after a manual demo run). */
export function reset(): void {
  buckets.clear();
}

/** Best-effort client IP: first `x-forwarded-for` hop, else `x-real-ip`. */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  return 'unknown';
}
