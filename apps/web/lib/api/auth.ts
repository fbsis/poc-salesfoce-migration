/**
 * Bearer-token auth for the internal CRM API (docs/CONTRACTS.md §4).
 *
 * Every request must carry `Authorization: Bearer ${CRM_API_TOKEN}`.
 * The comparison is constant-time: both sides are SHA-256 hashed first so the
 * buffers handed to `crypto.timingSafeEqual` always have the same length
 * (timingSafeEqual throws on length mismatch, which would itself leak length).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '@poc/core';

const BEARER_RE = /^bearer\s+(\S.*)$/i;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** The token configured for this process, or null when it is unset/blank. */
export function getConfiguredToken(): string | null {
  const token = process.env.CRM_API_TOKEN;
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Enforce `Authorization: Bearer <CRM_API_TOKEN>`.
 *
 * @throws AppError('internal')   when CRM_API_TOKEN is not configured
 * @throws AppError('unauthorized') when the header is missing or wrong
 */
export function requireCrmToken(request: Request): void {
  const expected = getConfiguredToken();
  if (expected === null) {
    console.error('[crm-api] CRM_API_TOKEN is not configured; rejecting every request');
    throw new AppError('internal', 'CRM API token is not configured');
  }

  const header = request.headers.get('authorization');
  if (!header) {
    throw new AppError('unauthorized', 'Missing Authorization header');
  }

  const match = BEARER_RE.exec(header.trim());
  if (!match) {
    throw new AppError('unauthorized', 'Expected an Authorization: Bearer <token> header');
  }

  const provided = match[1].trim();
  if (provided === '' || !timingSafeEqual(digest(provided), digest(expected))) {
    throw new AppError('unauthorized', 'Invalid bearer token');
  }
}

/** Non-throwing variant, handy for tests and diagnostics. */
export function isCrmRequestAuthorized(request: Request): boolean {
  try {
    requireCrmToken(request);
    return true;
  } catch {
    return false;
  }
}
