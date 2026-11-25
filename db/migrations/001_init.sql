-- POC CRM schema. Idempotent: safe to re-run.
-- Salesforce-synced rows carry salesforce_id + source='salesforce'; locally
-- captured rows have salesforce_id NULL and source='local' | 'landing_page'.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- accounts
CREATE TABLE IF NOT EXISTS accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salesforce_id         text UNIQUE,
  name                  text NOT NULL,
  industry              text,
  website               text,
  billing_country       text,
  owner_name            text,
  source                text NOT NULL DEFAULT 'local'
                          CHECK (source IN ('salesforce', 'local')),
  salesforce_updated_at timestamptz,
  synced_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounts_name_idx   ON accounts (lower(name));
CREATE INDEX IF NOT EXISTS accounts_source_idx ON accounts (source);
DROP TRIGGER IF EXISTS accounts_set_updated_at ON accounts;
CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- contacts
CREATE TABLE IF NOT EXISTS contacts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salesforce_id         text UNIQUE,
  account_id            uuid REFERENCES accounts (id) ON DELETE SET NULL,
  first_name            text,
  last_name             text,
  email                 text,
  phone                 text,
  title                 text,
  source                text NOT NULL DEFAULT 'local'
                          CHECK (source IN ('salesforce', 'local')),
  salesforce_updated_at timestamptz,
  synced_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_account_idx ON contacts (account_id);
CREATE INDEX IF NOT EXISTS contacts_email_idx   ON contacts (lower(email));
DROP TRIGGER IF EXISTS contacts_set_updated_at ON contacts;
CREATE TRIGGER contacts_set_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------- opportunities
CREATE TABLE IF NOT EXISTS opportunities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salesforce_id         text UNIQUE,
  account_id            uuid REFERENCES accounts (id) ON DELETE SET NULL,
  name                  text NOT NULL,
  stage                 text NOT NULL DEFAULT 'Prospecting'
                          CHECK (stage IN ('Prospecting', 'Qualification', 'Proposal',
                                           'Negotiation', 'Closed Won', 'Closed Lost')),
  amount                numeric(14, 2) NOT NULL DEFAULT 0,
  close_date            date,
  owner_name            text,
  probability           integer,
  source                text NOT NULL DEFAULT 'local'
                          CHECK (source IN ('salesforce', 'local')),
  salesforce_updated_at timestamptz,
  synced_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunities_account_idx ON opportunities (account_id);
CREATE INDEX IF NOT EXISTS opportunities_stage_idx   ON opportunities (stage);
DROP TRIGGER IF EXISTS opportunities_set_updated_at ON opportunities;
CREATE TRIGGER opportunities_set_updated_at BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------------- leads
CREATE TABLE IF NOT EXISTS leads (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salesforce_id         text UNIQUE,
  full_name             text NOT NULL,
  email                 text NOT NULL,
  phone                 text,
  company               text,
  property_interest     text,
  message               text,
  status                text NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new', 'contacted', 'qualified', 'closed')),
  source                text NOT NULL DEFAULT 'landing_page'
                          CHECK (source IN ('landing_page', 'salesforce', 'manual')),
  consent               boolean NOT NULL DEFAULT false,
  consent_at            timestamptz,
  salesforce_updated_at timestamptz,
  synced_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_email_idx     ON leads (lower(email));
CREATE INDEX IF NOT EXISTS leads_status_idx    ON leads (status);
CREATE INDEX IF NOT EXISTS leads_source_idx    ON leads (source);
CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at DESC);
DROP TRIGGER IF EXISTS leads_set_updated_at ON leads;
CREATE TRIGGER leads_set_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Contacts/opportunities can arrive before their parent Account (CDC ordering).
-- The pending lookup is parked here until linkOrphanRecords() resolves it.
CREATE TABLE IF NOT EXISTS sf_orphan_links (
  entity                text NOT NULL CHECK (entity IN ('contact', 'opportunity')),
  local_id              uuid NOT NULL,
  account_salesforce_id text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity, local_id)
);
CREATE INDEX IF NOT EXISTS sf_orphan_links_account_idx
  ON sf_orphan_links (account_salesforce_id);

-- -------------------------------------------------------- cdc checkpoints
CREATE TABLE IF NOT EXISTS cdc_checkpoints (
  channel       text PRIMARY KEY,
  replay_id     bigint,
  last_event_at timestamptz,
  status        text NOT NULL DEFAULT 'idle'
                  CHECK (status IN ('idle', 'connected', 'replaying', 'error')),
  error         text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------- cdc log
-- event_id = '<channel>:<replayId>' gives us idempotent apply (dedupe).
CREATE TABLE IF NOT EXISTS cdc_events (
  id           bigserial PRIMARY KEY,
  event_id     text NOT NULL UNIQUE,
  channel      text NOT NULL,
  object_name  text NOT NULL,
  record_id    text NOT NULL,
  change_type  text NOT NULL
                 CHECK (change_type IN ('CREATE', 'UPDATE', 'DELETE', 'UNDELETE')),
  replay_id    bigint,
  payload      jsonb,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'applied', 'skipped_stale', 'ignored', 'failed')),
  error        text,
  latency_ms   integer,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS cdc_events_channel_idx  ON cdc_events (channel, replay_id DESC);
CREATE INDEX IF NOT EXISTS cdc_events_record_idx   ON cdc_events (object_name, record_id);
CREATE INDEX IF NOT EXISTS cdc_events_received_idx ON cdc_events (received_at DESC);

-- -------------------------------------------------------------- sync runs
CREATE TABLE IF NOT EXISTS sync_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('bulk_extract', 'cdc', 'reconcile')),
  status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'success', 'failed')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  records_read    integer NOT NULL DEFAULT 0,
  records_written integer NOT NULL DEFAULT 0,
  error           text,
  details         jsonb
);
CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs (started_at DESC);
