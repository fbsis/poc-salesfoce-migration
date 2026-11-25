/**
 * `@poc/salesforce` — the Salesforce integration used by `apps/worker`.
 *
 *   auth.ts       OAuth (mock + real), token cache, 401 refresh
 *   http.ts       REST client (bearer token, 401 retry once)
 *   bulk.ts       Bulk API 2.0 query jobs → `applySalesforceBatch`
 *   cdc.ts        Pub/Sub gRPC + Avro CDC consumer (checkpoints, dedupe, replay)
 *   reconcile.ts  count/newest-timestamp comparison per object
 *   csv.ts        Bulk result CSV parsing
 *   objects.ts    SOQL field lists + extraction order
 */
export * from './config';
export * from './auth';
export * from './http';
export * from './objects';
export * from './csv';
export * from './bulk';
export * from './cdc';
export * from './reconcile';
