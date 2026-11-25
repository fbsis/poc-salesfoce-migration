/**
 * Response envelope + route wrapper for the internal CRM API
 * (docs/CONTRACTS.md §4).
 *
 *   list   -> { data: [...], meta: { total, limit, offset } }
 *   single -> { data: {...} }
 *   error  -> { error: { code, message, details? } }
 *
 * `withRoute` catches everything: `AppError` becomes its mapped status, any
 * other throw becomes a 500 with a generic body (the stack is logged
 * server-side only, never returned to the caller).
 */
import { NextResponse } from 'next/server';
import {
  AppError,
  isAppError,
  toErrorResponse,
  type ErrorResponse,
  type Paged,
} from '@poc/core';

/** `200 { data }` — single resource or a non-paged collection. */
export function ok<T>(data: T, status = 200): NextResponse<{ data: T }> {
  return NextResponse.json({ data }, { status });
}

/** `201 { data }` — resource created. */
export function created<T>(data: T): NextResponse<{ data: T }> {
  return NextResponse.json({ data }, { status: 201 });
}

/** `200 { data, meta: { total, limit, offset } }` — paged collection. */
export function list<T>(paged: Paged<T>): NextResponse<{
  data: T[];
  meta: { total: number; limit: number; offset: number };
}> {
  return NextResponse.json({
    data: paged.data,
    meta: { total: paged.total, limit: paged.limit, offset: paged.offset },
  });
}

/** Map any thrown value onto the §4 error envelope + status. */
export function errorResponse(error: unknown): NextResponse<ErrorResponse> {
  const body = toErrorResponse(error);
  const status = isAppError(error) ? error.status : 500;

  if (!isAppError(error)) {
    // toErrorResponse already logged the raw error; log a route-level breadcrumb.
    console.error('[crm-api] unhandled route error', error);
  } else if (status >= 500) {
    console.error(`[crm-api] ${body.error.code}: ${body.error.message}`);
  }

  return NextResponse.json(body, { status });
}

/** Context shape Next 15 passes to dynamic routes (`params` is a Promise). */
export interface RouteContext<P = Record<string, string>> {
  params: Promise<P>;
}

type RouteHandler<C> = (request: Request, context: C) => Promise<Response> | Response;

/**
 * Wrap a handler so every thrown value is converted into the error envelope.
 *
 * The returned function declares its context parameter (Next 15 passes
 * `{ params: Promise<...> }` and type-checks that second argument), so static
 * routes pass `RouteContext` explicitly and dynamic routes pass their own
 * `{ params: Promise<{ id: string }> }`.
 */
export function withRoute<C = RouteContext>(handler: RouteHandler<C>): RouteHandler<C> {
  return async (request: Request, context: C): Promise<Response> => {
    try {
      return await handler(request, context);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/**
 * Read and parse a JSON request body. An empty body is `{}` (so PATCH bodies
 * can legitimately be empty and be rejected by the schema, not by the parser).
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError('validation_error', 'Request body must be valid JSON', {
      _: 'could not parse the JSON body',
    });
  }
}
