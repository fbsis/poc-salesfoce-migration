/**
 * Redrive of dead-lettered CDC events — audit P0-2.
 *
 * When an apply fails after the consumer's bounded retry budget, `cdc.ts`
 * dead-letters the event (`cdc_events.status='failed'`, payload + error kept) and
 * **stops that topic's stream** instead of advancing the checkpoint. The topic
 * then re-subscribes from the last good checkpoint on every reconnect and keeps
 * retrying the same event — deliberately, because at-most-once silent loss is
 * worse than a lagging topic. Head-of-line blocking is recoverable, not
 * self-healing: an event whose *data* is unpalatable (an unmapped `StageName`, a
 * constraint violation, a bad amount) will never apply by itself.
 *
 * `redriveFailedEvents()` is that recovery hatch. It reads the `failed` rows and
 * re-applies them through the same `@poc/core` functions the consumer uses,
 * oldest first, **bypassing the duplicate check**: this is not ingesting a new
 * event, it is re-applying a known one, so `recordCdcEvent` is not called and
 * `event_id = <channel>:<replayId>` uniqueness is left alone. Each success moves
 * the row `failed → applied|skipped_stale|ignored` (and clears the error text).
 *
 * After a successful redrive the topic is still blocked *in the consumer's
 * memory* at that replay id until the next reconnect; the next replay delivers
 * the same event, `recordCdcEvent` answers `duplicate`, the stored row is now
 * `applied`, so it is skipped **and the checkpoint advances** — the topic drains
 * and everything behind the poison event is applied in order.
 *
 * There is intentionally no automatic redrive loop: a poison event is a data or
 * code defect, and retrying it forever from a background job hides the defect.
 * `POST /run/redrive` on the worker control plane is the operator interface
 * (`apps/worker/src/control.ts`).
 */
import {
  applySalesforceRecord,
  deleteSalesforceRecord,
  listCdcEvents,
  type ChangeType,
  type SalesforceRecord,
} from '@poc/core';

import { markEventResolved } from './cdc';

export interface RedriveOptions {
  /** Max failed events to attempt (default 50, core caps it at 200). */
  limit?: number;
  log?: (line: string) => void;
}

export interface RedriveSummary {
  /** Failed rows read from `cdc_events` and re-applied. */
  attempted: number;
  applied: number;
  skipped_stale: number;
  ignored: number;
  /** Still throwing after the redrive (the event is still blocking its topic). */
  still_failing: number;
}

/**
 * Re-apply every `cdc_events` row with `status='failed'`.
 *
 * Returns `{ attempted, applied, skipped_stale, ignored, still_failing }`;
 * `attempted === applied + skipped_stale + ignored + still_failing`.
 */
export async function redriveFailedEvents(options: RedriveOptions = {}): Promise<RedriveSummary> {
  const log = options.log ?? ((line: string) => console.log(line));
  const limit = options.limit ?? 50;

  const failed = await listCdcEvents({ status: 'failed', limit });
  // `listCdcEvents` returns newest first; re-apply oldest first so the local
  // rows converge in event order (a later UPDATE still wins the stale guard).
  const ordered = [...failed].reverse();

  const summary: RedriveSummary = {
    attempted: 0,
    applied: 0,
    skipped_stale: 0,
    ignored: 0,
    still_failing: 0,
  };

  log(`[redrive] ${ordered.length} failed cdc event(s) to re-apply (limit=${limit})`);

  for (const event of ordered) {
    summary.attempted += 1;
    const payload =
      typeof event.payload === 'object' && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};
    const salesforceId = String(payload.Id ?? event.record_id ?? '');
    // The stored payload is the decoded CDC datum with `Id` merged in; keep the
    // merge defensive so a row written by an older version still redrives.
    const record: SalesforceRecord = { ...payload, Id: salesforceId };

    try {
      const result =
        event.change_type === 'DELETE'
          ? await deleteSalesforceRecord(event.object_name, salesforceId)
          : await applySalesforceRecord(
              event.object_name,
              event.change_type as ChangeType,
              record,
            );
      await markEventResolved(event.event_id, result.outcome);
      summary[result.outcome] += 1;
      log(
        `[redrive] ${event.event_id} ${event.object_name} ${event.change_type} ` +
          `${salesforceId || '(no id)'} failed → ${result.outcome}` +
          (result.reason ? ` (${result.reason})` : ''),
      );
    } catch (error) {
      summary.still_failing += 1;
      const message = error instanceof Error ? error.message : String(error);
      log(
        `[redrive] ${event.event_id} ${event.object_name} ${event.change_type} ` +
          `${salesforceId || '(no id)'} still failing: ${message.slice(0, 300)}`,
      );
    }
  }

  log(
    `[redrive] done attempted=${summary.attempted} applied=${summary.applied} ` +
      `skipped_stale=${summary.skipped_stale} ignored=${summary.ignored} ` +
      `still_failing=${summary.still_failing}`,
  );

  return summary;
}
