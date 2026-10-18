-- The Contract Registry's tables (plan M5, ADR-0008), in the registry schema this
-- service owns. Moved out of the POS migrations when the registry became its own
-- service (plan M9, ADR-0013): the idempotency table from the POS's 0002_sales.sql,
-- and the releases from its 0004_contract_releases.sql.

-- The claim-first idempotency protocol (ADR-0004): a row is inserted before the work
-- and completed in the same transaction, so other sessions only ever see finished
-- rows. A concurrent insert of the same (scope, key) waits on this primary key.
CREATE TABLE idempotency_keys (
  scope           text NOT NULL,
  key             uuid NOT NULL,
  operation       text NOT NULL,
  fingerprint     bytea NOT NULL CHECK (length(fingerprint) = 32),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Append-only: a release is never updated or deleted, so a number always means the
-- same contract.
CREATE TABLE contract_releases (
  number       integer PRIMARY KEY CHECK (number >= 1),
  -- Canonical compact JSON, stored as `json` (not `jsonb`) so the exact bytes that
  -- were hashed come back out.
  ir           json NOT NULL,
  ir_sha256    text NOT NULL CHECK (ir_sha256 ~ '^[0-9a-f]{64}$'),
  ir_version   text NOT NULL,
  modules      jsonb NOT NULL,
  changes      jsonb NOT NULL,
  published_by text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION contract_releases_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'contract_releases is append-only';
END;
$$;

CREATE TRIGGER contract_releases_append_only
  BEFORE UPDATE OR DELETE ON contract_releases
  FOR EACH ROW EXECUTE FUNCTION contract_releases_append_only();
