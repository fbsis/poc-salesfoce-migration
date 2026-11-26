/**
 * Bearer auth for `/mcp` (CONTRACTS.md §8). Rejects before any CRM call is
 * made, with the MCP-flavoured error body the API contract uses:
 * `401 { "error": { "code": "unauthorized", "message": ... } }`.
 *
 * Comparison is constant-time on fixed-length digests, so an attacker cannot
 * learn the token length or content from timing.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from './logger';

export const UNAUTHORIZED_BODY = {
  error: { code: 'unauthorized', message: 'Missing or invalid Authorization bearer token.' },
} as const;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Extracts a bearer token from an `Authorization` header value. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

export function createAuthMiddleware(expectedToken: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = parseBearer(req.headers.authorization);
    const ok = expectedToken.length > 0 && presented !== null && safeEqual(presented, expectedToken);
    if (!ok) {
      logger.warn('mcp.auth.rejected', {
        path: req.originalUrl,
        method: req.method,
        reason: presented === null ? 'missing_token' : 'invalid_token',
      });
      res
        .status(401)
        .set('WWW-Authenticate', 'Bearer realm="poc-crm-mcp"')
        .json(UNAUTHORIZED_BODY);
      return;
    }
    next();
  };
}
