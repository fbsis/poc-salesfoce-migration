/**
 * Shared helpers for the MCP tool handlers: result envelopes, error mapping,
 * money/date formatting and the tiny ASCII table renderer used in the
 * human-readable `content` text.
 */

import { CrmApiError } from '../crm-client';

/** The shape every tool handler returns to the MCP SDK. */
export interface ToolResult {
  // The index signature mirrors the SDK's `CallToolResult` (an open record).
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** What a handler body produces: compact text + the raw API payload. */
export interface ToolPayload {
  text: string;
  structured: Record<string, unknown>;
}

export interface ListMeta {
  total: number;
  limit: number;
  offset: number;
}

/** Errors become `"<code>: <message>"` — never a stack trace. */
export function describeError(error: unknown): string {
  if (error instanceof CrmApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) {
    // Zod / programming errors: message only, no stack.
    return `internal_error: ${error.message}`;
  }
  return 'internal_error: unexpected failure';
}

/** Runs a handler body, converting thrown errors into `isError` tool results. */
export async function runTool(body: () => Promise<ToolPayload>): Promise<ToolResult> {
  try {
    const { text, structured } = await body();
    return { content: [{ type: 'text', text }], structuredContent: structured };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: describeError(error) }] };
  }
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** `amount` arrives as a numeric string from Postgres. Text summaries only. */
export function formatMoney(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'n/a';
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(amount) ? USD.format(amount) : 'n/a';
}

/** ISO timestamp -> `YYYY-MM-DD` (dates only, terminal friendly). */
export function formatDate(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'n/a';
  return value.slice(0, 10);
}

function cell(value: unknown, max = 34): string {
  const text = value === null || value === undefined ? '' : String(value);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface TableOptions {
  /** Rows printed before the "…and N more" line. Default 10. */
  maxRows?: number;
  /** Total row count across all pages, used for the trailer. */
  total?: number;
}

/**
 * Small aligned table: `header | header` plus a dashed rule.
 * Capped at 10 rows; the remainder is summarised as "…and N more".
 */
export function renderTable(headers: string[], rows: unknown[][], options: TableOptions = {}): string {
  const maxRows = options.maxRows ?? 10;
  const shown = rows.slice(0, maxRows);
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...shown.map((row) => cell(row[column]).length)),
  );
  const line = (cells: unknown[]) =>
    cells
      .map((value, column) => cell(value).padEnd(widths[column] ?? 0))
      .join(' | ')
      .trimEnd();

  const out = [line(headers), widths.map((width) => '-'.repeat(width)).join('-+-'), ...shown.map(line)];
  const hidden = (options.total ?? rows.length) - shown.length;
  if (hidden > 0) out.push(`…and ${hidden} more`);
  return out.join('\n');
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

/**
 * Normalises a list response. The CRM API is authoritative for `meta`, but the
 * MCP server must never render `undefined` while the upstream is incomplete.
 */
export function normalizeList<T>(
  payload: unknown,
  fallback: { limit: number; offset: number },
): { rows: T[]; meta: ListMeta } {
  const envelope = (payload ?? {}) as { data?: unknown; meta?: unknown };
  const rows = Array.isArray(envelope.data) ? (envelope.data as T[]) : [];
  const meta = (envelope.meta ?? {}) as Record<string, unknown>;
  return {
    rows,
    meta: {
      total: positiveInt(meta.total, rows.length),
      limit: positiveInt(meta.limit, fallback.limit),
      offset: positiveInt(meta.offset, fallback.offset),
    },
  };
}

/** Single-entity response: `{ data }` per CONTRACTS §4, tolerating a bare body. */
export function unwrapEntity<T>(payload: unknown): T {
  const envelope = (payload ?? {}) as { data?: unknown };
  if (envelope.data !== undefined) return envelope.data as T;
  return payload as T;
}

/** Header line above a list table, e.g. `4 of 6 opportunities (stage=Negotiation)`. */
export function listHeading(label: string, meta: ListMeta, filters: Record<string, unknown>): string {
  const active = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  const suffix = active ? ` (${active})` : '';
  return `${meta.total} ${label}${suffix}`;
}

/** `{ account }` style record -> `{ id, ... }` field lines for detail views. */
export function fieldLines(entries: Array<[string, unknown]>): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries
    .map(([label, value]) => `${label.padEnd(width)}: ${value === null || value === undefined || value === '' ? 'n/a' : String(value)}`)
    .join('\n');
}
