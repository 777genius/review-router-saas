BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- This is deliberately isolated from 000079 so the metadata-only constraint
-- installation commits before PostgreSQL scans existing grant rows.
ALTER TABLE "HostedCodexInvocationGrant"
  VALIDATE CONSTRAINT "HostedCodexInvocationGrant_output_budget_check";

COMMIT;
