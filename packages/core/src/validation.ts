/**
 * Zod schemas for every create/update input, plus the enum schemas the HTTP API
 * and MCP server reuse (docs/CONTRACTS.md §3/§4).
 *
 * Services validate through these; `validate()` converts a Zod failure into
 * `AppError('validation_error')` with field-keyed details.
 */
import { z } from 'zod';
import { AppError } from './errors';
import { MAX_LIMIT } from './pagination';

// ------------------------------------------------------------------- enums

export const entitySourceSchema = z.enum(['salesforce', 'local']);
export const opportunityStageSchema = z.enum([
  'Prospecting',
  'Qualification',
  'Proposal',
  'Negotiation',
  'Closed Won',
  'Closed Lost',
]);
export const leadStatusSchema = z.enum(['new', 'contacted', 'qualified', 'closed']);
export const leadSourceSchema = z.enum(['landing_page', 'salesforce', 'manual']);
export const changeTypeSchema = z.enum(['CREATE', 'UPDATE', 'DELETE', 'UNDELETE']);
export const cdcEventStatusSchema = z.enum([
  'pending',
  'applied',
  'skipped_stale',
  'ignored',
  'failed',
]);
export const syncRunKindSchema = z.enum(['bulk_extract', 'cdc', 'reconcile']);
export const syncRunStatusSchema = z.enum(['running', 'success', 'failed']);

// ------------------------------------------------------------- primitives

/** uuid or salesforce id — a non-empty string; shape is checked at lookup. */
export const idSchema = z.string().trim().min(1, 'id is required').max(64);

/** An optional reference to an account (uuid or salesforce id); '' means null. */
export const optionalIdRefSchema = z
  .union([idSchema, z.literal('')])
  .nullable()
  .optional()
  .transform((value) => (value === '' ? null : value));

export const limitSchema = z.coerce.number().int().min(1).max(MAX_LIMIT).optional();
export const offsetSchema = z.coerce.number().int().min(0).optional();

export const searchSchema = z.string().trim().max(200).optional();

const text = (max: number) => z.string().trim().max(max);

const nullableText = (max: number) => text(max).nullable();

const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'invalid date');

const timestampSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'expected an ISO timestamp');

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'invalid email address');

/** numeric(14,2): at most 12 integer digits, 2 decimals. */
export const amountSchema = z
  .union([z.number(), z.string()])
  .refine((value) => {
    const raw = typeof value === 'number' ? String(value) : value.trim();
    if (raw === '') return false;
    return /^-?\d+(\.\d{1,2})?$/.test(raw) || (typeof value === 'number' && Number.isFinite(value));
  }, 'expected a numeric amount with at most 2 decimals')
  .refine((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed < 1e12;
  }, 'amount must be >= 0 and fit numeric(14,2)');

const probabilitySchema = z.number().int().min(0).max(100);

// --------------------------------------------------------------- accounts

export const createAccountSchema = z.object({
  name: text(255).min(1, 'name is required'),
  industry: nullableText(120).optional(),
  website: nullableText(255).optional(),
  billing_country: nullableText(120).optional(),
  owner_name: nullableText(160).optional(),
});

export const updateAccountSchema = z.object({
  name: text(255).min(1, 'name must not be empty').optional(),
  industry: nullableText(120).optional(),
  website: nullableText(255).optional(),
  billing_country: nullableText(120).optional(),
  owner_name: nullableText(160).optional(),
});

// --------------------------------------------------------------- contacts

const contactFields = {
  first_name: nullableText(120).optional(),
  last_name: nullableText(120).optional(),
  email: emailSchema.nullable().optional(),
  phone: nullableText(40).optional(),
  title: nullableText(160).optional(),
  account_id: optionalIdRefSchema,
};

export const createContactSchema = z
  .object(contactFields)
  .refine(
    (value) => Boolean(value.first_name || value.last_name || value.email),
    'at least one of first_name, last_name or email is required',
  );

export const updateContactSchema = z.object(contactFields);

// ---------------------------------------------------------- opportunities

export const createOpportunitySchema = z.object({
  name: text(255).min(1, 'name is required'),
  account_id: optionalIdRefSchema,
  stage: opportunityStageSchema.optional(),
  amount: amountSchema.optional(),
  close_date: isoDateSchema.nullable().optional(),
  owner_name: nullableText(160).optional(),
  probability: probabilitySchema.nullable().optional(),
});

export const updateOpportunitySchema = z.object({
  name: text(255).min(1, 'name must not be empty').optional(),
  account_id: optionalIdRefSchema,
  stage: opportunityStageSchema.optional(),
  amount: amountSchema.optional(),
  close_date: isoDateSchema.nullable().optional(),
  owner_name: nullableText(160).optional(),
  probability: probabilitySchema.nullable().optional(),
});

// ------------------------------------------------------------------ leads

export const createLeadSchema = z.object({
  full_name: text(200).min(2, 'full_name must be at least 2 characters'),
  email: emailSchema,
  phone: nullableText(40).optional(),
  company: nullableText(200).optional(),
  property_interest: nullableText(120).optional(),
  message: nullableText(2000).optional(),
  source: leadSourceSchema.optional(),
  status: leadStatusSchema.optional(),
  consent: z.boolean().optional(),
});

export const updateLeadSchema = z.object({
  full_name: text(200).min(2, 'full_name must be at least 2 characters').optional(),
  email: emailSchema.optional(),
  phone: nullableText(40).optional(),
  company: nullableText(200).optional(),
  property_interest: nullableText(120).optional(),
  message: nullableText(2000).optional(),
  status: leadStatusSchema.optional(),
});

export const updateLeadStatusSchema = z.object({ status: leadStatusSchema });

// ------------------------------------------------------- list params (§4)

export const listAccountsParamsSchema = z.object({
  search: searchSchema,
  source: entitySourceSchema.optional(),
  limit: limitSchema,
  offset: offsetSchema,
});

export const listContactsParamsSchema = z.object({
  search: searchSchema,
  account_id: idSchema.optional(),
  limit: limitSchema,
  offset: offsetSchema,
});

export const listOpportunitiesParamsSchema = z.object({
  search: searchSchema,
  stage: opportunityStageSchema.optional(),
  account_id: idSchema.optional(),
  limit: limitSchema,
  offset: offsetSchema,
});

export const listLeadsParamsSchema = z.object({
  search: searchSchema,
  status: leadStatusSchema.optional(),
  source: leadSourceSchema.optional(),
  created_since: timestampSchema.optional(),
  limit: limitSchema,
  offset: offsetSchema,
});

export const leadSummaryParamsSchema = z.object({ since: timestampSchema.optional() });

export const listCdcEventsParamsSchema = z.object({
  limit: limitSchema,
  status: cdcEventStatusSchema.optional(),
});

export const createSyncRunSchema = z.object({
  kind: syncRunKindSchema,
  details: z.unknown().optional(),
});

// ----------------------------------------------------------------- helpers

export type FieldErrors = Record<string, string>;

export function fieldErrorsFromZod(error: z.ZodError): FieldErrors {
  const details: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    if (!details[key]) details[key] = issue.message;
  }
  return details;
}

/**
 * Parse `input` with `schema`, throwing `AppError('validation_error')` with
 * `{ field: message }` details on failure.
 */
export function validate<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const details = fieldErrorsFromZod(result.error);
    const first = Object.entries(details)[0];
    const message = first ? `${first[0]}: ${first[1]}` : 'Invalid input';
    throw new AppError('validation_error', message, details);
  }
  return result.data as z.infer<S>;
}

/** Non-throwing variant, for callers that want to branch on the result. */
export function tryValidate<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; details: FieldErrors } {
  const result = schema.safeParse(input ?? {});
  if (result.success) return { ok: true, data: result.data as z.infer<S> };
  return { ok: false, details: fieldErrorsFromZod(result.error) };
}
