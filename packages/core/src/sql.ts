/**
 * Small SQL helpers shared by the service modules: a condition builder that
 * keeps placeholder numbering in sync, a dynamic UPDATE builder and pg error
 * inspection.
 */
import { queryOne } from './db';
import { validationError } from './errors';
import { classifyId } from './ids';

export interface SqlStatement {
  text: string;
  values: unknown[];
}

export interface Conditions {
  /** Register a value and get its `$n` placeholder back. */
  param(value: unknown): string;
  add(clause: string): void;
  /** `WHERE a AND b`, or an empty string. */
  where(): string;
  values: unknown[];
}

export function createConditions(): Conditions {
  const clauses: string[] = [];
  const values: unknown[] = [];
  return {
    values,
    param(value: unknown): string {
      values.push(value);
      return `$${values.length}`;
    },
    add(clause: string): void {
      clauses.push(clause);
    },
    where(): string {
      return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    },
  };
}

/**
 * Build `UPDATE <table> SET col = $1, ... WHERE <key> = $n RETURNING ...`.
 * Returns null when the patch has no defined values (nothing to update).
 */
export function buildUpdate(args: {
  table: string;
  patch: Record<string, unknown>;
  key: { column: string; value: string };
  returning: string;
}): SqlStatement | null {
  const entries = Object.entries(args.patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;

  const assignments = entries.map(([column], index) => `${column} = $${index + 1}`);
  const values: unknown[] = entries.map(([, value]) => value);
  values.push(args.key.value);

  return {
    text: `UPDATE ${args.table} SET ${assignments.join(', ')} WHERE ${args.key.column} = $${values.length} RETURNING ${args.returning}`,
    values,
  };
}

export function pgErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/**
 * Resolve an `account_id` supplied by a caller. Accepts a local uuid or a
 * Salesforce account id; an unknown Salesforce id is a validation error (the
 * CRM API surfaces it as 400).
 */
export async function resolveAccountId(value: string | null | undefined): Promise<string | null> {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const kind = classifyId(trimmed);
  if (kind === 'uuid') return trimmed;
  if (kind === 'salesforce') {
    const row = await queryOne<{ id: string }>('SELECT id FROM accounts WHERE salesforce_id = $1', [
      trimmed,
    ]);
    if (!row) {
      throw validationError('account_id does not exist', { account_id: 'unknown salesforce account' });
    }
    return row.id;
  }
  throw validationError('account_id must be a uuid or a salesforce id', {
    account_id: 'invalid id',
  });
}

/** Trim, collapse an empty string to null and lowercase (emails). */
export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function cleanEmail(value: unknown): string | null {
  const cleaned = cleanText(value);
  return cleaned === null ? null : cleaned.toLowerCase();
}

/** Defensive trim for query-string parameters (they arrive as `unknown`). */
export function searchTerm(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
