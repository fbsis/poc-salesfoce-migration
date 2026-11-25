/**
 * OAuth for Salesforce (mock or real).
 *
 * Mock (SF_USE_MOCK=true): form-encoded client_credentials against
 *   POST ${SF_LOGIN_URL}/services/oauth2/token  → { access_token, instance_url }
 *   (apps/salesforce-mock/src/rest.ts accepts client_credentials and password).
 *
 * Real: the same endpoint on ${SF_LOGIN_URL}; grant_type=password when
 *   SF_USERNAME/SF_PASSWORD are set, otherwise client_credentials.
 *
 * The token is cached in memory and refreshed exactly once on a 401 (see
 * `http.ts`), so a long-running consumer survives token expiry.
 */
import { sfConfiguredInstanceUrl, sfLoginUrl, sfUseMock } from './config';

export interface SalesforceToken {
  accessToken: string;
  instanceUrl: string;
  tokenType: string;
  issuedAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 20 * 60 * 1000;

let cached: SalesforceToken | null = null;
let inflight: Promise<SalesforceToken> | null = null;

function tokenTtlMs(): number {
  const raw = Number(process.env.SF_TOKEN_TTL_MS ?? NaN);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

export class SalesforceAuthError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'SalesforceAuthError';
    this.status = status;
    this.body = body;
  }
}

function readErrorBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestToken(): Promise<SalesforceToken> {
  const mock = sfUseMock();
  const params = new URLSearchParams();

  const username = process.env.SF_USERNAME?.trim() ?? '';
  const password = process.env.SF_PASSWORD ?? '';
  const usePassword = !mock && username !== '' && password !== '';

  if (usePassword) {
    params.set('grant_type', 'password');
    params.set('username', username);
    params.set('password', `${password}${process.env.SF_SECURITY_TOKEN ?? ''}`);
  } else {
    params.set('grant_type', 'client_credentials');
  }
  params.set('client_id', process.env.SF_CLIENT_ID ?? (mock ? 'mock-client-id' : ''));
  const secret = process.env.SF_CLIENT_SECRET;
  if (secret) params.set('client_secret', secret);

  const url = `${sfLoginUrl()}/services/oauth2/token`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: params.toString(),
    signal: AbortSignal.timeout(Number(process.env.SF_HTTP_TIMEOUT_MS ?? 20_000)),
  });

  const text = await response.text();
  if (!response.ok) {
    const body = readErrorBody(text);
    throw new SalesforceAuthError(
      `Salesforce OAuth failed (${response.status} ${url}): ${text.slice(0, 300)}`,
      response.status,
      body,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new SalesforceAuthError(`Salesforce OAuth returned non-JSON: ${text.slice(0, 200)}`, 502, text);
  }

  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  if (!accessToken) {
    throw new SalesforceAuthError('Salesforce OAuth response has no access_token', 502, parsed);
  }

  const instanceUrl =
    sfConfiguredInstanceUrl() ||
    (typeof parsed.instance_url === 'string' && parsed.instance_url
      ? parsed.instance_url.replace(/\/+$/, '')
      : sfLoginUrl());

  const issuedAt = Date.now();
  return {
    accessToken,
    instanceUrl,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : 'Bearer',
    issuedAt,
    expiresAt: issuedAt + tokenTtlMs(),
  };
}

/** Cached token; fetches once and de-duplicates concurrent callers. */
export async function getToken(forceRefresh = false): Promise<SalesforceToken> {
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached;
  if (!inflight) {
    inflight = requestToken()
      .then((token) => {
        cached = token;
        return token;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function getAccessToken(): Promise<string> {
  return (await getToken()).accessToken;
}

export async function getInstanceUrl(): Promise<string> {
  return (await getToken()).instanceUrl;
}

/** Drop the cached token and obtain a fresh one (used on a 401). */
export async function refreshAccessToken(): Promise<string> {
  cached = null;
  return (await getToken(true)).accessToken;
}

/** Test/CLI helper: forget the cached token. */
export function resetTokenCache(): void {
  cached = null;
  inflight = null;
}
