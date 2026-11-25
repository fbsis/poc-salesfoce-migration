import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, type ErrorResponse } from '@poc/core';
import {
  created,
  errorResponse,
  list,
  ok,
  readJsonBody,
  withRoute,
} from '../../lib/api/respond';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('envelope helpers', () => {
  it('ok() returns 200 with { data }', async () => {
    const response = ok({ id: 'abc', name: 'Acme' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ data: { id: 'abc', name: 'Acme' } });
  });

  it('created() returns 201 with { data }', async () => {
    const response = created({ id: 'abc' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: { id: 'abc' } });
  });

  it('list() unwraps Paged<T> into { data, meta }', async () => {
    const response = list({ data: [{ id: 'a' }], total: 42, limit: 50, offset: 0 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [{ id: 'a' }],
      meta: { total: 42, limit: 50, offset: 0 },
    });
  });
});

describe('errorResponse', () => {
  it('maps AppError codes onto their HTTP status', async () => {
    const cases: Array<[ConstructorParameters<typeof AppError>[0], number]> = [
      ['validation_error', 400],
      ['unauthorized', 401],
      ['not_found', 404],
      ['conflict', 409],
      ['internal', 500],
    ];
    for (const [code, status] of cases) {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = errorResponse(new AppError(code, `${code} happened`));
      expect(response.status).toBe(status);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(`${code} happened`);
    }
  });

  it('keeps validation details', async () => {
    const response = errorResponse(
      new AppError('validation_error', 'name: name is required', { name: 'name is required' }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'validation_error',
        message: 'name: name is required',
        details: { name: 'name is required' },
      },
    });
  });

  it('never leaks a stack trace or the original message for unknown errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = errorResponse(new Error('connection string postgres://secret'));
    expect(response.status).toBe(500);
    const body = (await response.json()) as ErrorResponse;
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('postgres://secret');
    expect(JSON.stringify(body)).not.toContain('at ');
  });
});

describe('withRoute', () => {
  const STATIC = { params: Promise.resolve({}) };

  it('returns the handler response untouched', async () => {
    const handler = withRoute(async () => ok({ fine: true }));
    const response = await handler(new Request('http://localhost/x'), STATIC);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { fine: true } });
  });

  it('converts a thrown AppError into the error envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withRoute(async () => {
      throw new AppError('not_found', 'account nope not found');
    });
    const response = await handler(new Request('http://localhost/x'), STATIC);
    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorResponse).error.code).toBe('not_found');
  });

  it('converts an unexpected throw into a 500 with no internals', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withRoute(async () => {
      throw new Error('kaboom: internal detail');
    });
    const response = await handler(new Request('http://localhost/x'), STATIC);
    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).toContain('"code":"internal"');
    expect(text).not.toContain('kaboom');
  });

  it('passes the route context through', async () => {
    const handler = withRoute<{ params: Promise<{ id: string }> }>(async (_request, context) => {
      const { id } = await context.params;
      return ok({ id });
    });
    const response = await handler(new Request('http://localhost/x'), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(await response.json()).toEqual({ data: { id: 'abc' } });
  });
});

describe('readJsonBody', () => {
  it('parses a JSON object', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify({ name: 'Acme' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(await readJsonBody(request)).toEqual({ name: 'Acme' });
  });

  it('treats an empty body as {}', async () => {
    const request = new Request('http://localhost/x', { method: 'POST', body: '' });
    expect(await readJsonBody(request)).toEqual({});
  });

  it('rejects malformed JSON with a 400-shaped AppError', async () => {
    const request = new Request('http://localhost/x', { method: 'POST', body: '{name:' });
    const error: unknown = await readJsonBody(request).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'validation_error', status: 400 });
  });
});
