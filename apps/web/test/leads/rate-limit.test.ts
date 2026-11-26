import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMAIL_MAX_SUBMISSIONS,
  GLOBAL_MAX_SUBMISSIONS,
  MAX_SUBMISSIONS,
  UNKNOWN_IP,
  WINDOW_MS,
  check,
  checkEmail,
  clientIpFromHeaders,
  isAttributableIp,
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

  describe('per-IP bucket (a real IP is present)', () => {
    it('allows five submissions per window and blocks the sixth', () => {
      for (let i = 0; i < MAX_SUBMISSIONS; i += 1) {
        const result = check('203.0.113.5');
        expect(result.allowed).toBe(true);
        expect(result.bucket).toBe('ip');
        expect(result.remaining).toBe(MAX_SUBMISSIONS - i - 1);
      }

      const blocked = check('203.0.113.5');
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.bucket).toBe('ip');
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
  });

  describe('global bucket (unknown IP — no proxy header)', () => {
    it('does NOT 429 at the sixth unknown-IP request (AUDIT P0-3)', () => {
      for (let i = 1; i <= 6; i += 1) {
        const result = check(UNKNOWN_IP);
        expect(result.allowed).toBe(true);
        expect(result.bucket).toBe('global');
      }
      // An empty/garbage IP lands in the same bucket.
      expect(check('   ').bucket).toBe('global');
      expect(check('   ').allowed).toBe(true);
    });

    it('is generous but not unlimited: caps unknown-IP traffic at GLOBAL_MAX_SUBMISSIONS', () => {
      expect(GLOBAL_MAX_SUBMISSIONS).toBeGreaterThan(MAX_SUBMISSIONS * 10);

      for (let i = 0; i < GLOBAL_MAX_SUBMISSIONS; i += 1) {
        expect(check(UNKNOWN_IP).allowed).toBe(true);
      }

      const blocked = check(UNKNOWN_IP);
      expect(blocked.allowed).toBe(false);
      expect(blocked.bucket).toBe('global');
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('does not consume the per-IP buckets (and vice versa)', () => {

      for (let i = 0; i < GLOBAL_MAX_SUBMISSIONS; i += 1) check(UNKNOWN_IP);
      expect(check(UNKNOWN_IP).allowed).toBe(false);

      // A real IP still has its own 5 slots.
      for (let i = 0; i < MAX_SUBMISSIONS; i += 1) {
        expect(check('203.0.113.6').allowed).toBe(true);
      }
      expect(check('203.0.113.6').allowed).toBe(false);

      // …and exhausting an IP never eats into the global bucket.
      vi.advanceTimersByTime(WINDOW_MS + 1000);
      expect(check(UNKNOWN_IP).allowed).toBe(true);
    });
  });

  describe('per-email guard', () => {
    it('allows two submissions for one address and rejects the third', () => {
      expect(EMAIL_MAX_SUBMISSIONS).toBe(2);

      const first = checkEmail('person@example.com');
      expect(first.allowed).toBe(true);
      expect(first.bucket).toBe('email');
      expect(first.remaining).toBe(EMAIL_MAX_SUBMISSIONS - 1);

      const second = checkEmail('person@example.com');
      expect(second.allowed).toBe(true);
      expect(second.remaining).toBe(0);

      const third = checkEmail('person@example.com');
      expect(third.allowed).toBe(false);
      expect(third.bucket).toBe('email');
      expect(third.remaining).toBe(0);
    });

    it('rejects a third submission for the same address within 10 minutes', () => {
      expect(checkEmail('third@example.com').allowed).toBe(true);
      expect(checkEmail('third@example.com').allowed).toBe(true);

      const blocked = checkEmail('third@example.com');
      expect(blocked.allowed).toBe(false);
      expect(blocked.bucket).toBe('email');
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_MS / 1000);
    });

    it('matches case-insensitively and per address', () => {
      expect(checkEmail('Mixed.Case@Example.com').allowed).toBe(true);
      expect(checkEmail('mixed.case@example.com').allowed).toBe(true);
      expect(checkEmail('MIXED.CASE@EXAMPLE.COM').allowed).toBe(false);

      // A different address is unaffected.
      expect(checkEmail('other@example.com').allowed).toBe(true);
    });

    it('expires with the sliding window', () => {
      expect(checkEmail('window@example.com').allowed).toBe(true);
      expect(checkEmail('window@example.com').allowed).toBe(true);
      expect(checkEmail('window@example.com').allowed).toBe(false);

      vi.advanceTimersByTime(WINDOW_MS + 1000);
      expect(checkEmail('window@example.com').allowed).toBe(true);
    });

    it('is independent of the IP and global buckets', () => {
      for (let i = 0; i < MAX_SUBMISSIONS; i += 1) check('203.0.113.30');
      expect(check('203.0.113.30').allowed).toBe(false);
      expect(checkEmail('unrelated@example.com').allowed).toBe(true);
    });
  });

  describe('reset()', () => {
    it('clears the IP, global and email buckets', () => {
      for (let i = 0; i < MAX_SUBMISSIONS; i += 1) check('203.0.113.5');
      expect(check('203.0.113.5').allowed).toBe(false);

      for (let i = 0; i < GLOBAL_MAX_SUBMISSIONS; i += 1) check(UNKNOWN_IP);
      expect(check(UNKNOWN_IP).allowed).toBe(false);

      expect(checkEmail('reset@example.com').allowed).toBe(true);
      expect(checkEmail('reset@example.com').allowed).toBe(true);
      expect(checkEmail('reset@example.com').allowed).toBe(false);

      reset();

      const afterIp = check('203.0.113.5');
      expect(afterIp.allowed).toBe(true);
      expect(afterIp.remaining).toBe(MAX_SUBMISSIONS - 1);

      const afterGlobal = check(UNKNOWN_IP);
      expect(afterGlobal.allowed).toBe(true);
      expect(afterGlobal.remaining).toBe(GLOBAL_MAX_SUBMISSIONS - 1);

      const afterEmail = checkEmail('reset@example.com');
      expect(afterEmail.allowed).toBe(true);
      expect(afterEmail.remaining).toBe(EMAIL_MAX_SUBMISSIONS - 1);
    });
  });

  describe('clientIpFromHeaders', () => {
    it('reads the first x-forwarded-for hop, else x-real-ip, else unknown', () => {
      expect(
        clientIpFromHeaders(headers({ 'x-forwarded-for': '203.0.113.1, 70.41.3.18, 150.172.238.178' })),
      ).toBe('203.0.113.1');
      expect(clientIpFromHeaders(headers({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
      expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '', 'x-real-ip': '198.51.100.5' }))).toBe(
        '198.51.100.5',
      );
      expect(clientIpFromHeaders(headers({}))).toBe(UNKNOWN_IP);
      expect(UNKNOWN_IP).toBe('unknown');
    });
  });

  describe('isAttributableIp', () => {
    it('accepts public client addresses (including the documentation ranges used by these tests)', () => {
      for (const ip of ['203.0.113.9', '198.51.100.5', '8.8.8.8', '2001:4860:4860::8888']) {
        expect(isAttributableIp(ip)).toBe(true);
      }
    });

    it('rejects loopback, private, link-local and CGNAT addresses', () => {
      for (const ip of [
        '',
        'unknown',
        '127.0.0.1',
        '10.1.2.3',
        '172.16.0.1',
        '172.31.255.254',
        '192.168.228.1',
        '169.254.1.1',
        '100.64.0.1',
        '0.0.0.0',
        '::1',
        'fe80::1',
        'fd00::1',
        'not-an-ip',
      ]) {
        expect(isAttributableIp(ip)).toBe(false);
      }
    });

    it('unwraps IPv4-mapped IPv6 addresses (what Next dev reports for a Docker bridge)', () => {
      expect(isAttributableIp('::ffff:192.168.228.1')).toBe(false);
      expect(isAttributableIp('::FFFF:203.0.113.9')).toBe(true);
      expect(isAttributableIp('::ffff:127.0.0.1')).toBe(false);
    });

    it('routes a private source address to the global bucket instead of one shared IP bucket', () => {
      // This is the live compose case: every visitor arrives as the bridge address.
      const bridge = '::ffff:192.168.228.1';
      for (let i = 0; i < 7; i += 1) {
        const result = check(bridge);
        expect(result.allowed).toBe(true);
        expect(result.bucket).toBe('global');
      }
      // …and it shares the bucket with the literal `unknown` key.
      const shared = check(UNKNOWN_IP);
      expect(shared.bucket).toBe('global');
      expect(shared.remaining).toBe(GLOBAL_MAX_SUBMISSIONS - 8);
    });
  });
});
