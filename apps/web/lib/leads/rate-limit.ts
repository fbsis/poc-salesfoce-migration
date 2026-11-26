/**
 * In-memory sliding-window rate limiting for the public lead endpoint
 * (docs/CONTRACTS.md §5).
 *
 * Three independent limits, all with a 10-minute sliding window:
 *
 *  1. **Per IP** — 5 submissions / 10 min (`MAX_SUBMISSIONS`), keyed on the
 *     client address taken from `X-Forwarded-For` / `X-Real-IP`.
 *  2. **Global (unknown IP)** — 60 submissions / 10 min per process
 *     (`GLOBAL_MAX_SUBMISSIONS`). When no proxy header is present we cannot
 *     tell visitors apart, so a per-IP bucket would silently become *one
 *     shared 5-per-10-min bucket for the whole internet* (AUDIT P0-3). Instead
 *     the unknown-IP traffic shares this deliberately generous cap: it stops a
 *     single runaway client from exhausting the process, without rejecting the
 *     sixth real customer of the day.
 *  3. **Per email** — 2 submissions / 10 min per email address
 *     (`EMAIL_MAX_SUBMISSIONS`): the 3rd landing-page submission for the same
 *     email inside the window is rejected. This is the abuse vector that
 *     actually matters for a lead form (one address, many rows / one inbox,
 *     many notifications) and it works even when every visitor is `unknown`.
 *
 * **Header requirement.** Behind a proxy, `X-Forwarded-For` (or `X-Real-IP`)
 * *must* be set to the real client address by that proxy; otherwise the per-IP
 * bucket is unavailable and the global bucket applies to everyone. A source
 * address that is itself private/loopback (RFC 1918, `::1`, link-local,
 * IPv4-mapped `::ffff:…`, CGNAT) is treated as *not attributable to a visitor*:
 * it means we are talking to a host bridge or an unconfigured proxy, and every
 * visitor would look identical. `docker-compose.yml` ships no proxy (Next's
 * dev server fills `x-forwarded-for` with the Docker bridge address), so in the
 * compose/demo environment the global + per-email limits are the ones in
 * force. Operators can tell which bucket ran from the `bucket=ip|global` field
 * in the `[leads]` log lines.
 *
 * LIMITATION — this is deliberately tiny, not production rate limiting:
 *  - the windows live in this process's memory, so they reset whenever the
 *    process restarts (every `next dev` hot reload / redeploy) and are NOT
 *    shared across instances (N replicas allow N × the numbers above);
 *  - IPs come from proxy headers and can be spoofed when the app is reachable
 *    without going through the trusted proxy that sets them.
 * A real deployment should use a shared store (Redis) or the edge platform's
 * limiter, plus a persistent record of submissions.
 */

export const WINDOW_MS = 10 * 60 * 1000;

/** Per-IP limit inside the window (the §5 "5 submissions / 10 min / IP"). */
export const MAX_SUBMISSIONS = 5;

/**
 * Shared bucket for traffic whose client IP is unknown (no proxy headers).
 * Generous on purpose: those visitors cannot be distinguished, so the only
 * defensible number is one that no realistic set of real customers reaches.
 */
export const GLOBAL_MAX_SUBMISSIONS = 60;

/**
 * Per-email limit inside the window: submission 1 and 2 are accepted, the 3rd
 * is rejected. Counts every landing-page attempt for that address, including
 * ones that turn out to be duplicates.
 */
export const EMAIL_MAX_SUBMISSIONS = 2;

/** Sentinel returned by `clientIpFromHeaders` when no IP header is present. */
export const UNKNOWN_IP = 'unknown';

/** Strip an IPv4-mapped IPv6 prefix so `::ffff:10.0.0.1` is judged as `10.0.0.1`. */
function bareAddress(ip: string): string {
  const lower = ip.trim().toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
}

/**
 * Is this address attributable to a single visitor?
 *
 * Private, loopback, link-local and CGNAT addresses are not: they are what you
 * see when the app is reached through an unconfigured proxy, a Docker bridge or
 * a local tunnel. A "real" bucket keyed on such an address would be a global
 * bucket in disguise, so those requests take the documented global path.
 * Anything unparseable is treated the same way (can't tell -> global).
 */
export function isAttributableIp(ip: string): boolean {
  const address = bareAddress(ip);
  if (address === '' || address === UNKNOWN_IP) return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((part) => part > 255)) return false;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true;
  }

  // IPv6: loopback, link-local (fe80::/10) and unique-local (fc00::/7) only.
  if (address === '::1' || address === '::') return false;
  if (address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb')) {
    return false;
  }
  if (address.startsWith('fc') || address.startsWith('fd')) return false;
  // An all-hex string with colons is an IPv6 address — assume a real client.
  return /^[0-9a-f:]+$/.test(address) && address.includes(':');
}

/** Which bucket produced a decision — log it, it says whether a proxy is in front. */
export type BucketKind = 'ip' | 'global' | 'email';

type Bucket = number[];

/** Per-IP buckets (real client addresses only). */
const ipBuckets = new Map<string, Bucket>();
/** One shared bucket for every visitor whose IP we cannot see. */
let globalHits: Bucket = [];
/** Per-email-address buckets, keyed on the lower-cased address. */
const emailBuckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the oldest hit in the window expires (0 when allowed). */
  retryAfterSeconds: number;
  /** Which limit decided this request. */
  bucket: BucketKind;
}

/** Drop expired hits from a bucket; returns the surviving hits. */
function prune(hits: Bucket, now: number): Bucket {
  return hits.filter((at) => now - at < WINDOW_MS);
}

/**
 * Decide against a pruned bucket. When allowed the caller records the hit;
 * `remaining` counts the slots left *after* that hit.
 */
function decide(
  hits: Bucket,
  now: number,
  max: number,
  bucket: BucketKind,
): RateLimitResult {
  if (hits.length >= max) {
    const oldest = hits[0] ?? now;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)),
      bucket,
    };
  }
  return {
    allowed: true,
    remaining: Math.max(0, max - hits.length - 1),
    retryAfterSeconds: 0,
    bucket,
  };
}

/** Record one submission attempt and report which limit (if any) applies. */
export function check(ip: string): RateLimitResult {
  const trimmed = ip.trim();
  const now = Date.now();

  // Unknown client: cannot be told apart from any other unknown client, so a
  // per-client bucket would be a global one. Use the generous shared cap.
  if (!isAttributableIp(trimmed)) {
    globalHits = prune(globalHits, now);
    const result = decide(globalHits, now, GLOBAL_MAX_SUBMISSIONS, 'global');
    if (result.allowed) globalHits.push(now);
    return result;
  }

  const hits = prune(ipBuckets.get(trimmed) ?? [], now);
  const result = decide(hits, now, MAX_SUBMISSIONS, 'ip');
  if (result.allowed) hits.push(now);
  if (hits.length === 0) ipBuckets.delete(trimmed);
  else ipBuckets.set(trimmed, hits);
  return result;
}

/**
 * Per-email guard: the 3rd submission for the same address inside the window
 * is rejected. Emails are lower-cased before bucketing (storage lower-cases
 * them too, so `A@B.com` and `a@b.com` are the same lead).
 */
export function checkEmail(email: string): RateLimitResult {
  const key = email.trim().toLowerCase();
  if (key === '') {
    // Nothing to bucket on; validation rejects this before the guard matters.
    return { allowed: true, remaining: EMAIL_MAX_SUBMISSIONS, retryAfterSeconds: 0, bucket: 'email' };
  }

  const now = Date.now();
  const hits = prune(emailBuckets.get(key) ?? [], now);
  const result = decide(hits, now, EMAIL_MAX_SUBMISSIONS, 'email');
  if (result.allowed) hits.push(now);
  if (hits.length === 0) emailBuckets.delete(key);
  else emailBuckets.set(key, hits);
  return result;
}

/** Clear every bucket (IP, global and email). Tests only (also handy after a manual demo run). */
export function reset(): void {
  ipBuckets.clear();
  emailBuckets.clear();
  globalHits = [];
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
  return UNKNOWN_IP;
}
