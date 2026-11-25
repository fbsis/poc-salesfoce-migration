import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SUBMISSIONS,
  WINDOW_MS,
  check,
  clientIpFromHeaders,
  reset,
} from '../../lib/leads/rate-limit';

function headers(pairs: Record<string, string>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(pairs)) result.set(key, value);
  return result;
}

describe('lead rate limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    reset();
  });

  afterEach(() => {
    reset();
    vi.useRealTimers();
  });

  it('allows five submissions per window and blocks the sixth', () => {
    for (let i = 0; i < MAX_SUBMISSIONS; i += 1) {
      const result = check('203.0.113.5');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(MAX_SUBMISSIONS - i - 1);
    }

    const blocked = check('203.0.113.5');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_MS / 1000);
  });

  it('keeps buckets per IP', () => {
    for (let i = 0; i < MAX_SUBMISSIONS; i += 1) check('203.0.113.5');
    expect(check('203.0.113.5').allowed).toBe(false);
    expect(check('198.51.100.9').allowed).toBe(true);
  });

  it('slides: an old hit expires and the IP is allowed again', () => {
    for (let i = 0; i < MAX_SUBMISSIONS; i += 1) check('203.0.113.7');
    expect(check('203.0.113.7').allowed).toBe(false);

    vi.advanceTimersByTime(WINDOW_MS + 1000);
    expect(check('203.0.113.7').allowed).toBe(true);
  });

  it('pairs a sliding window rather than a fixed reset', () => {
    check('203.0.113.8'); // t=0, expires at t=WINDOW
    for (let i = 0; i < MAX_SUBMISSIONS - 1; i += 1) {
      vi.advanceTimersByTime(1000);
      check('203.0.113.8');
    }
    // 5 hits recorded; still blocked.
    expect(check('203.0.113.8').allowed).toBe(false);

    // At t=601s the hits at t=0s and t=1s have expired, so exactly two slots
    // free up — a fixed window that resets on a boundary would behave differently.
    vi.advanceTimersByTime(WINDOW_MS - 3000);
    expect(check('203.0.113.8').allowed).toBe(true); // 4 hits in window
    expect(check('203.0.113.8').allowed).toBe(true); // 5 hits in window
    expect(check('203.0.113.8').allowed).toBe(false); // full again
  });

  it('reset() clears every bucket', () => {
    for (let i = 0; i < MAX_SUBMISSIONS; i += 1) check('203.0.113.5');
    expect(check('203.0.113.5').allowed).toBe(false);

    reset();
    expect(check('203.0.113.5').allowed).toBe(true);
  });

  it('treats an empty IP as "unknown" instead of a shared empty bucket', () => {
    for (let i = 0; i < MAX_SUBMISSIONS; i += 1) check('   ');
    expect(check('   ').allowed).toBe(false);
    expect(check('203.0.113.5').allowed).toBe(true);
  });

  it('reads the first x-forwarded-for hop, else x-real-ip, else unknown', () => {
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '203.0.113.1, 70.41.3.18, 150.172.238.178' }))).toBe(
      '203.0.113.1',
    );
    expect(clientIpFromHeaders(headers({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '', 'x-real-ip': '198.51.100.5' }))).toBe(
      '198.51.100.5',
    );
    expect(clientIpFromHeaders(headers({}))).toBe('unknown');
  });
});
