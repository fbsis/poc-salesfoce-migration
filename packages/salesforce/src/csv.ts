/**
 * CSV helpers for Bulk API 2.0 query results.
 *
 * `successfulResults` is CSV whose first two columns are `sf__Id` and
 * `sf__Created`, followed by every queried field except `Id` (Salesforce omits
 * it because it duplicates `sf__Id`). `Owner.Name` arrives as a single flattened
 * column heading — `applySalesforceBatch` reads exactly that key.
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
 * Convert one Bulk result row into a Salesforce-shaped record.
 * `sf__Id` becomes `Id`; other `sf__*` bookkeeping columns are dropped.
 */
export function rowToRecord(row: Record<string, string>): SalesforceRecord {
  const record: SalesforceRecord = { Id: String(row.sf__Id ?? row.Id ?? '').trim() };
  for (const [column, value] of Object.entries(row)) {
    if (column === 'sf__Id' || column.startsWith('sf__')) continue;
    if (column === 'Id') continue;
    record[column] = value === '' ? null : value;
  }
  return record;
}

export function rowsToRecords(rows: Array<Record<string, string>>): SalesforceRecord[] {
  return rows.map(rowToRecord).filter((record) => record.Id !== '');
}
