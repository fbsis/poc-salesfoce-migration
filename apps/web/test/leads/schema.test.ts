import { describe, expect, it } from 'vitest';
import {
  honeypotTripped,
  parseLeadSubmission,
  stripControlChars,
} from '../../lib/leads/schema';

const valid = {
  full_name: 'Maria Silva',
  email: 'Maria.Silva@Example.COM',
  phone: '+55 11 99999-0000',
  property_interest: 'House',
  message: 'Looking for a 3-bed near the park',
  consent: true,
};

describe('lead schema', () => {
  it('accepts a valid submission and normalises email + optional empties', () => {
    const result = parseLeadSubmission(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.email).toBe('maria.silva@example.com');
    expect(result.data.full_name).toBe('Maria Silva');
    expect(result.data.property_interest).toBe('House');

    const sparse = parseLeadSubmission({
      full_name: 'Ana',
      email: 'ana@example.com',
      phone: '',
      property_interest: '',
      message: '',
      consent: true,
    });
    expect(sparse.ok).toBe(true);
    if (!sparse.ok) return;
    expect(sparse.data.phone).toBeNull();
    expect(sparse.data.property_interest).toBeNull();
    expect(sparse.data.message).toBeNull();
  });

  it('trims and strips control, zero-width and bidi characters before validating', () => {
    expect(stripControlChars('Ma\u200Bria\u202E Si\u0000lva\uFEFF')).toBe('Maria Silva');
    const result = parseLeadSubmission({
      ...valid,
      full_name: '  \u200BMaria\u202E Silva\u0007  ',
      message: 'line\u200Bone',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.full_name).toBe('Maria Silva');
    expect(result.data.message).toBe('lineone');
  });

  it('rejects a name shorter than 2 characters (counted after stripping)', () => {
    const result = parseLeadSubmission({ ...valid, full_name: ' A\u200B ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.full_name).toBeTypeOf('string');
  });

  it('rejects an over-long name', () => {
    const result = parseLeadSubmission({ ...valid, full_name: 'a'.repeat(121) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.full_name).toMatch(/120/);
  });

  it('rejects an invalid email and an over-long email', () => {
    const bad = parseLeadSubmission({ ...valid, email: 'bad' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.fieldErrors.email).toBeTypeOf('string');

    const long = parseLeadSubmission({ ...valid, email: `${'a'.repeat(250)}@example.com` });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.fieldErrors.email).toMatch(/254/);
  });

  it('rejects a missing or false consent', () => {
    const missing = parseLeadSubmission({ ...valid, consent: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.fieldErrors.consent).toMatch(/privacy notice/i);

    const denied = parseLeadSubmission({ ...valid, consent: false });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.fieldErrors.consent).toMatch(/privacy notice/i);

    const stringy = parseLeadSubmission({ ...valid, consent: 'true' });
    expect(stringy.ok).toBe(false);
  });

  it('rejects an oversized message and oversized phone', () => {
    const long = parseLeadSubmission({ ...valid, message: 'x'.repeat(2001) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.fieldErrors.message).toMatch(/2000/);

    const accepts = parseLeadSubmission({ ...valid, message: 'x'.repeat(2000) });
    expect(accepts.ok).toBe(true);

    const phone = parseLeadSubmission({ ...valid, phone: '1'.repeat(41) });
    expect(phone.ok).toBe(false);
    if (!phone.ok) expect(phone.fieldErrors.phone).toMatch(/40/);
  });

  it('collects one error per invalid field', () => {
    const result = parseLeadSubmission({ full_name: 'X', email: 'bad', consent: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(['consent', 'email', 'full_name']);
  });

  it('detects a filled honeypot but not an empty or absent one', () => {
    expect(honeypotTripped({ company_website: '' })).toBe(false);
    expect(honeypotTripped({ company_website: '   ' })).toBe(false);
    expect(honeypotTripped({})).toBe(false);
    expect(honeypotTripped({ company_website: 'https://spam.example' })).toBe(true);
    expect(honeypotTripped(null)).toBe(false);
  });
});
