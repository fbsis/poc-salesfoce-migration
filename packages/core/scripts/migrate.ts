/**
 * Applies every file in db/migrations (sorted) to the application database and
 * to the isolated test database. Migrations must be idempotent.
 *
 *   docker compose run --rm tools pnpm migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../db/migrations');

async function applyTo(connectionString: string, label: string) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
      console.log(`[migrate] ${label}: applied ${file}`);
    }
  } finally {
    await client.end();
  }
}

const targets: Array<[string, string]> = [];
const primary = process.env.DATABASE_URL;
const test = process.env.TEST_DATABASE_URL;

if (primary) targets.push([primary, 'app']);
if (test && test !== primary) targets.push([test, 'test']);

if (targets.length === 0) {
  console.error('[migrate] DATABASE_URL is not set');
  process.exit(1);
}

for (const [connectionString, label] of targets) {
  await applyTo(connectionString, label);
}
console.log('[migrate] done');
