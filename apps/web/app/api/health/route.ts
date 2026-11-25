import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const startedAt = Date.now();
  try {
    const { getPool } = await import('@poc/core');
    const { rows } = await getPool().query<{ ok: number }>('SELECT 1 AS ok');
    return NextResponse.json({
      status: 'ok',
      db: rows[0]?.ok === 1 ? 'up' : 'unknown',
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'degraded',
        db: 'down',
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      },
      { status: 503 },
    );
  }
}
