/**
 * Mock Salesforce service: Bulk API 2.0 + SOQL over REST (port 4000) and the
 * Pub/Sub API over gRPC (port 50051), in one process.
 *
 * Env (all optional):
 *   MOCK_HTTP_PORT / PORT        REST port, default 4000
 *   MOCK_GRPC_PORT               gRPC port, default 50051
 *   MOCK_HTTP_HOST / MOCK_GRPC_HOST  bind host, default 0.0.0.0
 *   SF_INSTANCE_URL              value returned as OAuth instance_url
 *   SF_API_VERSION               default v62.0
 *   SF_MASTER_TOKEN / SF_CLIENT_ID  accepted but ignored (mock auth is fixed)
 *   SF_MOCK_ACCESS_TOKEN         override the mock bearer token
 *   MOCK_SEED=false              boot with an empty dataset
 */

import 'dotenv/config';
import type { Server } from 'node:http';

import { SalesforceStore } from './store';
import { seedStore } from './seed';
import { createRestApp } from './rest';
import { PubSubMockServer } from './grpc';

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

async function main(): Promise<void> {
  const store = new SalesforceStore();
  if (flag(process.env.MOCK_SEED, true)) {
    const counts = seedStore(store);
    console.log(
      `[salesforce-mock] seeded ${counts.accounts} accounts, ${counts.contacts} contacts, ` +
        `${counts.opportunities} opportunities, ${counts.leads} leads`,
    );
  }

  const pubsub = new PubSubMockServer({ store });
  store.setPublisher((event) => pubsub.publish(event));

  const boundGrpcPort = await pubsub.start();
  console.log(`[salesforce-mock] gRPC Pub/Sub listening on 0.0.0.0:${boundGrpcPort}`);

  const app = createRestApp({ store, pubsub });
  const httpPort = Number(process.env.MOCK_HTTP_PORT ?? process.env.PORT ?? 4000);
  const httpHost = process.env.MOCK_HTTP_HOST ?? '0.0.0.0';

  const server: Server = await new Promise((resolve, reject) => {
    const created = app.listen(httpPort, httpHost, () => resolve(created));
    created.on('error', reject);
  });
  const instanceUrl =
    process.env.SF_INSTANCE_URL ?? `http://${httpHost === '0.0.0.0' ? 'localhost' : httpHost}:${httpPort}`;
  console.log(
    `[salesforce-mock] REST listening on ${httpHost}:${httpPort} ` +
      `(api=${process.env.SF_API_VERSION ?? 'v62.0'}, instance_url=${instanceUrl})`,
  );
  console.log('[salesforce-mock] ready — Bulk API 2.0, SOQL, Pub/Sub, /mock/* admin endpoints');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[salesforce-mock] ${signal} received, shutting down`);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 2000).unref();
    });
    await pubsub.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('[salesforce-mock] unhandled rejection', reason);
  });
}

main().catch((error) => {
  console.error('[salesforce-mock] failed to start', error);
  process.exit(1);
});
