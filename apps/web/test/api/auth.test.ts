import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@poc/core';
import { getConfiguredToken, isCrmRequestAuthorized, requireCrmToken } from '../../lib/api/auth';

const TOKEN = 'test-token-abc123';
let previousToken: string | undefined;

beforeAll(() => {
  previousToken = process.env.CRM_API_TOKEN;
  process.env.CRM_API_TOKEN = TOKEN;
});

afterAll(() => {
  if (previousToken === undefined) delete process.env.CRM_API_TOKEN;
  else process.env.CRM_API_TOKEN = previousToken;
});

function request(authorization?: string): Request {
  return new Request('http://localhost/api/crm/accounts', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

function catchAppError(fn: () => void): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the call to throw');
}

describe('requireCrmToken', () => {
  it('accepts the configured token', () => {
    expect(() => requireCrmToken(request(`Bearer ${TOKEN}`))).not.toThrow();
    expect(isCrmRequestAuthorized(request(`Bearer ${TOKEN}`))).toBe(true);
  });

  it('accepts a case-insensitive scheme and surrounding whitespace', () => {
    expect(() => requireCrmToken(request(`  bearer   ${TOKEN}  `))).not.toThrow();
  });

  it('rejects a missing Authorization header', () => {
    const error = catchAppError(() => requireCrmToken(request()));
    expect(error.code).toBe('unauthorized');
    expect(error.status).toBe(401);
  });

  it('rejects a wrong token', () => {
    const error = catchAppError(() => requireCrmToken(request('Bearer not-the-token')));
    expect(error.code).toBe('unauthorized');
    expect(error.status).toBe(401);
  });

  it('rejects a token that is a prefix of the real one', () => {
    expect(() => requireCrmToken(request('Bearer test-token'))).toThrow(AppError);
  });

  it('rejects a non-bearer scheme', () => {
    const error = catchAppError(() => requireCrmToken(request(`Basic ${TOKEN}`)));
    expect(error.code).toBe('unauthorized');
  });

  it('rejects an empty bearer token', () => {
    expect(() => requireCrmToken(request('Bearer    '))).toThrow(AppError);
  });

  it('fails closed with an internal error when CRM_API_TOKEN is unset', () => {
    delete process.env.CRM_API_TOKEN;
    try {
      const error = catchAppError(() => requireCrmToken(request(`Bearer ${TOKEN}`)));
      expect(error.code).toBe('internal');
      expect(error.status).toBe(500);
      expect(getConfiguredToken()).toBeNull();
    } finally {
      process.env.CRM_API_TOKEN = TOKEN;
    }
  });
});
