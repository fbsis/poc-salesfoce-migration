/**
 * Minimal structured logger: one JSON object per line on stdout/stderr so
 * `docker compose logs mcp` is greppable. Never accepts arbitrary payloads —
 * callers pass counters, names and argument *keys* only (lead payloads contain
 * personal data that must not end up in logs).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  return ORDER[configured] ?? ORDER.info;
}

export type LogFields = Record<string, unknown>;

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: 'mcp',
    msg: message,
    ...fields,
  });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => log('debug', message, fields),
  info: (message: string, fields?: LogFields) => log('info', message, fields),
  warn: (message: string, fields?: LogFields) => log('warn', message, fields),
  error: (message: string, fields?: LogFields) => log('error', message, fields),
};
