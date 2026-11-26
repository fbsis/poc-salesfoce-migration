/**
 * CSV helpers for Bulk API 2.0 **query** results.
 *
 * `jobs/query/:id/results` returns CSV whose header is exactly the SELECT list,
 * e.g. `Id,Name,Industry,Owner.Name,SystemModstamp` — there is no `sf__Id` or
 * `sf__Created` (those belong to ingest jobs). A relationship such as
 * `Owner.Name` arrives as one flattened column, which is the key
 * `applySalesforceBatch` reads. Empty cells become `null`; everything else is
 * passed through verbatim (dates stay the strings Salesforce sent).
 */
import { parse } from 'csv-parse/sync';
import type { SalesforceRecord } from '@poc/core';

export interface ParsedCsv {
  columns: string[];
  rows: Array<Record<string, string>>;
}

/** Parse a CSV document with a header row. Tolerant of CRLF and a BOM. */
export function parseCsv(text: string): ParsedCsv {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed === '') return { columns: [], rows: [] };

  const records = parse(trimmed, {
    columns: (header: string[]) => header.map((column) => column.trim()),
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
    trim: false,
  }) as Array<Record<string, string>>;

  const columns =
    records.length > 0 ? Object.keys(records[0]) : (parse(trimmed, { to_line: 1 })[0] as string[]);

  return { columns, rows: records };
}

/**
 * Convert one query-result row into a Salesforce-shaped record.
 *
 * The query-results header *is* the record shape (`Id`, `Owner.Name`, …), so the
 * columns are copied as-is. `sf__*` bookkeeping is not part of the query
 * contract; it is skipped defensively so an ingest CSV can never leak in.
 */
export function rowToRecord(row: Record<string, string>): SalesforceRecord {
  const record: SalesforceRecord = { Id: '' };
  for (const [column, value] of Object.entries(row)) {
    const key = column.trim();
    if (key === '' || key === 'attributes' || key.startsWith('sf__')) continue;
    record[key] = value === '' ? null : value;
  }
  record.Id = String(record.Id ?? '').trim();
  return record;
}

export function rowsToRecords(rows: Array<Record<string, string>>): SalesforceRecord[] {
  // Query jobs are always asked for `Id` (see `buildSoql`), so a row without one
  // cannot be upserted and is dropped — same contract as before the rewrite.
  return rows.map(rowToRecord).filter((record) => record.Id !== '');
}
