/**
 * limit/offset normalisation shared by every list endpoint.
 * Default 50, maximum 200 (docs/CONTRACTS.md §4).
 */
import type { Paged } from './types';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const DEFAULT_SEARCH_LIMIT = 20;

function toInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

export function normalizeLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
  const parsed = toInteger(value);
  if (parsed === null) return fallback;
  if (parsed < 1) return 1;
  if (parsed > MAX_LIMIT) return MAX_LIMIT;
  return parsed;
}

export function normalizeOffset(value: unknown): number {
  const parsed = toInteger(value);
  if (parsed === null || parsed < 0) return 0;
  return parsed;
}

export interface Page {
  limit: number;
  offset: number;
}

export function normalizePagination(params?: { limit?: unknown; offset?: unknown } | null): Page {
  return {
    limit: normalizeLimit(params?.limit),
    offset: normalizeOffset(params?.offset),
  };
}

export function toPaged<T>(data: T[], total: number, page: Page): Paged<T> {
  return { data, total, limit: page.limit, offset: page.offset };
}
