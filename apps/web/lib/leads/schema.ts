/**
 * Validation for the public lead endpoint (docs/CONTRACTS.md §5).
 *
 * Kept free of `@poc/core`/`pg` imports so it can be imported from anywhere
 * (route handler, tests, client components) without pulling a DB driver in.
 *
 * Order of operations: strip control characters → trim → validate. Everything
 * is done *before* validation so a payload padded with zero-width or bidi
 * marks cannot smuggle an otherwise-invalid value past the length checks.
 */
import { z } from 'zod';

/**
 * C0/C1 controls, DEL, soft hyphen, zero-width space/joiners, LRM/RLM, bidi
 * embedding/override marks, word joiner + invisible operators, BOM.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/** Strip control/zero-width/bidi characters. Non-strings pass through untouched. */
export function stripControlChars(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(CONTROL_CHARS, '');
}

function sanitizeText(value: unknown): unknown {
  const stripped = stripControlChars(value);
  if (typeof stripped !== 'string') return stripped;
  return stripped.trim();
}

export const EMAIL_MAX = 254;
export const NAME_MIN = 2;
export const NAME_MAX = 120;
export const PHONE_MAX = 40;
export const INTEREST_MAX = 120;
export const MESSAGE_MAX = 2000;

/** Mirrors the rule in `@poc/core`'s `emailSchema`: one @, a dot in the domain. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const optionalText = (max: number, label: string) =>
  z
    .string()
    .max(max, `${label} must be at most ${max} characters`)
    .nullable()
    .optional()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value));

export const leadSubmissionSchema = z.object({
  full_name: z
    .string()
    .min(NAME_MIN, 'Please enter your full name')
    .max(NAME_MAX, `Full name must be at most ${NAME_MAX} characters`),
  email: z
    .string()
    .min(1, 'Please enter your email address')
    .max(EMAIL_MAX, `Email must be at most ${EMAIL_MAX} characters`)
    .refine((value) => EMAIL_PATTERN.test(value), 'Please enter a valid email address')
    .transform((value) => value.toLowerCase()),
  phone: optionalText(PHONE_MAX, 'Phone'),
  property_interest: optionalText(INTEREST_MAX, 'Property interest'),
  message: optionalText(MESSAGE_MAX, 'Message'),
  consent: z
    .boolean({
      required_error: 'Please accept the privacy notice',
      invalid_type_error: 'Please accept the privacy notice',
    })
    .refine((value) => value === true, {
      message: 'Please accept the privacy notice',
    }),
});

export type LeadSubmission = z.infer<typeof leadSubmissionSchema>;

export type LeadFieldErrors = Partial<Record<keyof LeadSubmission | 'company_website', string>>;

export type LeadParseResult =
  | { ok: true; data: LeadSubmission }
  | { ok: false; fieldErrors: LeadFieldErrors };

/** Honeypot: filled means a bot; the route answers 200 and stores nothing. */
export function honeypotTripped(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const value = (input as Record<string, unknown>).company_website;
  if (value === undefined || value === null) return false;
  return typeof value !== 'string' || value.trim() !== '';
}

function sanitizePayload(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = sanitizeText(value);
  }
  return out;
}

/** Validate a raw request body, returning `{ field: message }` on failure. */
export function parseLeadSubmission(input: unknown): LeadParseResult {
  const source = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const result = leadSubmissionSchema.safeParse(sanitizePayload(source));
  if (result.success) return { ok: true, data: result.data };

  const fieldErrors: LeadFieldErrors = {};
  for (const issue of result.error.issues) {
    const key = (issue.path.length > 0 ? issue.path[0] : '_') as keyof LeadFieldErrors;
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return { ok: false, fieldErrors };
}
