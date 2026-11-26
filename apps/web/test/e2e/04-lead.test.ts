/**
 * Capability 4 — "A visitor registers as a Lead through the public landing
 * page", and the lead is visible to staff in the CRM.
 *
 * The public endpoint is exercised exactly as a browser would call it: no
 * Authorization header, a real `x-forwarded-for` (one bucket per test run), the
 * real JSON body. Then the same lead is read back through the internal CRM API
 * *and* through the server-rendered HTML of `/crm/leads` and `/crm`.
 *
 * Covered: 201 create, 200 duplicate (no second row), 400 with per-field
 * details, 429 rate limit, and the website → CRM hop.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Lead } from '@poc/core';

import {
  WEB_URL,
  RUN,
  apiJson,
  cleanupE2EData,
  e2eEmail,
  e2eIp,
  page,
  plainText,
} from './helpers';

interface Paged<T> {
  data: T[];
  meta: { total: number; limit: number; offset: number };
}

const EMAIL = e2eEmail('lead');
const NAME = `E2E Lead ${RUN}`;
const IP = e2eIp('lead');

const PAYLOAD = {
  full_name: NAME,
  email: EMAIL,
  phone: '+1 415 555 0199',
  property_interest: 'Two-bedroom condo near the waterfront',
  message: `Submitted by the E2E suite (${RUN})`,
  consent: true,
};

/** `POST /api/leads` — the public, unauthenticated route. */
function submit(body: unknown, ip: string): Promise<Response> {
  return fetch(`${WEB_URL}/api/leads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

async function leadTotal(): Promise<number> {
  const page_ = await apiJson<Paged<Lead>>('/api/crm/leads?limit=1');
  return page_.meta.total;
}

describe(
  'Capability 4 — a visitor registers as a Lead through the public landing page',
  { timeout: 60_000 },
  () => {
    let leadId = '';

    beforeAll(async () => {
      // Warm every route the assertions touch, so the first timed request is not
      // paying for a Next.js dev-server compile. The POST also matters for
      // correctness: the rate limiter lives in the dev server's module memory,
      // and the first request to a cold route can re-evaluate that module — it
      // must happen on a throw-away IP bucket, not on the one under test.
      await page('/lead');
      await page('/crm/leads');
      await page('/crm');
      const warmup = await submit(
        { full_name: `E2E Warmup ${RUN}`, email: e2eEmail('warmup'), consent: true },
        e2eIp('warmup'),
      );
      expect(warmup.status).toBe(201);
    });

    afterAll(async () => {
      await cleanupE2EData();
    });

    it('creates a lead without any token (201, source=landing_page, status=new)', async () => {
      const response = await submit(PAYLOAD, IP);
      const body = (await response.json()) as {
        data: { id: string; status: string; source: string; created_at: string };
      };

      expect(response.status).toBe(201);
      expect(body.data.status).toBe('new');
      expect(body.data.source).toBe('landing_page');
      expect(body.data.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(Date.parse(body.data.created_at)).not.toBeNaN();
      // The public route must not leak anything beyond this shape.
      expect(Object.keys(body.data).sort()).toEqual(['created_at', 'id', 'source', 'status']);
      leadId = body.data.id;

      const listed = await apiJson<Paged<Lead>>(
        `/api/crm/leads?search=${encodeURIComponent(EMAIL)}&limit=10`,
      );
      expect(listed.meta.total).toBe(1);
      const lead = listed.data[0];
      expect(lead.id).toBe(leadId);
      expect(lead.full_name).toBe(NAME);
      expect(lead.email).toBe(EMAIL); // lower-cased before storage
      expect(lead.phone).toBe(PAYLOAD.phone);
      expect(lead.property_interest).toBe(PAYLOAD.property_interest);
      expect(lead.status).toBe('new');
      expect(lead.source).toBe('landing_page');
      expect(lead.salesforce_id).toBeNull();
      expect(lead.consent).toBe(true);
      expect(lead.consent_at).not.toBeNull();
    });

    it('treats a repeat submission as a duplicate (200, duplicate:true, no new row)', async () => {
      const before = await leadTotal();
      const response = await submit(PAYLOAD, IP);
      const body = (await response.json()) as { data: { id: string }; duplicate: boolean };

      expect(response.status).toBe(200);
      expect(body.duplicate).toBe(true);
      expect(body.data.id).toBe(leadId);
      expect(await leadTotal()).toBe(before);
    });

    it('rejects an invalid payload with per-field details (400)', async () => {
      const response = await submit(
        { full_name: 'A', email: 'not-an-email', consent: false },
        IP,
      );
      const body = (await response.json()) as {
        error: { code: string; message: string; details: Record<string, string> };
      };

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('validation_error');
      expect(typeof body.error.details.full_name).toBe('string');
      expect(typeof body.error.details.email).toBe('string');
      expect(typeof body.error.details.consent).toBe('string');

      // Nothing was stored for the invalid address.
      const stored = await apiJson<Paged<Lead>>(
        `/api/crm/leads?search=${encodeURIComponent('not-an-email')}&limit=10`,
      );
      expect(stored.meta.total).toBe(0);
    });

    it('is visible in the rendered CRM pages (website → CRM hop)', async () => {
      // /crm/leads?search=… renders the row server-side from @poc/core.
      const leadsText = plainText(
        await page(`/crm/leads?search=${encodeURIComponent(EMAIL)}`),
      );
      expect(leadsText).toContain(NAME);
      expect(leadsText).toContain(EMAIL);
      expect(leadsText).toContain('Website'); // source badge for landing_page
      expect(leadsText).toContain('New'); // status pill

      // The detail page renders every stored field of the lead.
      const detailText = plainText(await page(`/crm/leads/${leadId}`));
      expect(detailText).toContain(NAME);
      expect(detailText).toContain(PAYLOAD.message);
      expect(detailText).toContain(PAYLOAD.property_interest);
      expect(detailText).toContain('Website');

      // The dashboard lists the five most recent leads — this one is the most
      // recent local lead at this point.
      const dashboardText = plainText(await page('/crm'));
      expect(dashboardText).toContain(NAME);
      expect(dashboardText).toContain(EMAIL);
    });
    it('rate limits rapid submissions (5 pass, the 6th is 429)', async () => {
      // Dedicated IP (empty per-IP bucket) and a distinct email per attempt, so
      // the per-IP limit is the one that decides — the per-email guard (2 per
      // 10 min, docs/CONTRACTS.md §5) would otherwise reject first.
      const burstIp = e2eIp('burst');
      const burstEmails = Array.from({ length: 6 }, (_, index) =>
        e2eEmail(`burst-${index + 1}`),
      );
      const responses = await Promise.all(
        burstEmails.map((email, index) =>
          submit({ ...PAYLOAD, full_name: `${NAME} burst ${index + 1}`, email }, burstIp),
        ),
      );
      const statuses = responses.map((response) => response.status);
      const summary = `statuses: ${statuses.join(',')}`;

      expect(statuses.filter((status) => status === 201), summary).toHaveLength(5);
      expect(statuses.filter((status) => status === 429), summary).toHaveLength(1);

      const limited = responses.find((response) => response.status === 429);
      expect(limited?.headers.get('retry-after')).toBeTruthy();
      const body = (await limited?.json()) as { error: { code: string } };
      expect(body.error.code).toBe('rate_limited');

      // Five of the six attempts created exactly one row each; the blocked one
      // created nothing.
      const burstRows = await apiJson<Paged<Lead>>(
        `/api/crm/leads?search=${encodeURIComponent(`e2e-${RUN.toLowerCase()}-burst-`)}&limit=20`,
      );
      expect(burstRows.meta.total).toBe(5);
      expect(burstRows.data.every((lead) => lead.source === 'landing_page')).toBe(true);

      // The lead captured earlier is untouched by the burst.
      const listed = await apiJson<Paged<Lead>>(
        `/api/crm/leads?search=${encodeURIComponent(EMAIL)}&limit=10`,
      );
      expect(listed.meta.total).toBe(1);
    });

  },
);
