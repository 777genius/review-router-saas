BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE "release_rollout_ledger" (
  "rollout_id" text PRIMARY KEY,
  "expected_commit_sha" text NOT NULL CHECK ("expected_commit_sha" ~ '^[a-f0-9]{40}$'),
  "run_id" text NOT NULL CHECK ("run_id" ~ '^[1-9][0-9]*$'),
  "run_attempt" integer NOT NULL CHECK ("run_attempt" = 1),
  "source_system_identifier" text NOT NULL CHECK ("source_system_identifier" ~ '^[0-9]+$'),
  "target_system_identifier" text NOT NULL CHECK ("target_system_identifier" ~ '^[0-9]+$'),
  "authoritative_system_identifier" text NOT NULL,
  "activation_boundary" text NOT NULL CHECK ("activation_boundary" IN ('before','uncertain','activated')),
  "source_permanently_ineligible" boolean NOT NULL DEFAULT false,
  "last_receipt_sha256" text NOT NULL CHECK ("last_receipt_sha256" ~ '^sha256:[a-f0-9]{64}$'),
  "claim_version" integer NOT NULL DEFAULT 1 CHECK ("claim_version" > 0),
  "target_switch_nonce" text CHECK ("target_switch_nonce" ~ '^[a-f0-9]{32}$'),
  "target_switch_version" integer NOT NULL DEFAULT 0 CHECK ("target_switch_version" >= 0),
  "target_switch_fenced_at" timestamptz(3),
  "activation_fence_nonce" text CHECK ("activation_fence_nonce" ~ '^[a-f0-9]{32}$'),
  "activation_fence_version" integer NOT NULL DEFAULT 0 CHECK ("activation_fence_version" >= 0),
  "activation_job_id" text CHECK ("activation_job_id" ~ '^[1-9][0-9]*$'),
  "activation_target_deploy_ids" jsonb,
  "activation_fenced_at" timestamptz(3),
  "activation_receipt" jsonb,
  "claimed_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK ("source_system_identifier" <> "target_system_identifier"),
  CHECK ("authoritative_system_identifier" IN ("source_system_identifier","target_system_identifier")),
  CHECK (NOT "source_permanently_ineligible" OR "authoritative_system_identifier" = "target_system_identifier")
);

CREATE TABLE "release_rollout_receipt_ledger" (
  "receipt_sha256" text PRIMARY KEY CHECK ("receipt_sha256" ~ '^sha256:[a-f0-9]{64}$'),
  "rollout_id" text NOT NULL REFERENCES "release_rollout_ledger"("rollout_id") ON DELETE RESTRICT,
  "step" text NOT NULL,
  "provider_binding" jsonb,
  "previous_receipt_sha256" text NOT NULL CHECK ("previous_receipt_sha256" ~ '^sha256:[a-f0-9]{64}$'),
  "activation_boundary" text NOT NULL CHECK ("activation_boundary" IN ('before','activated')),
  "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("rollout_id","step")
);

CREATE TABLE "release_runner_provisioning_intent" (
  "intent_id" text PRIMARY KEY CHECK ("intent_id" ~ '^rri-[a-f0-9]{64}$'),
  "rollout_id" text NOT NULL REFERENCES "release_rollout_ledger"("rollout_id") ON DELETE RESTRICT,
  "service_id" text NOT NULL,
  "lifecycle" text NOT NULL CHECK ("lifecycle" IN ('role','cutover')),
  "workflow_job_id" text NOT NULL CHECK ("workflow_job_id" ~ '^[1-9][0-9]*$'),
  "runner_name" text NOT NULL,
  "created_at" timestamptz(3) NOT NULL,
  "provider_job_id" text,
  "outcome" text CHECK ("outcome" IN ('bound','persistence_failed_cleaned','persistence_failed_unknown')),
  "reconciliation_observation" jsonb,
  "reconciled_at" timestamptz(3),
  "registration" jsonb,
  UNIQUE ("rollout_id","lifecycle")
);

CREATE TABLE "release_runner_job_ledger" (
  "job_id" text PRIMARY KEY,
  "rollout_id" text NOT NULL REFERENCES "release_rollout_ledger"("rollout_id") ON DELETE RESTRICT,
  "provisioning_intent_id" text NOT NULL REFERENCES "release_runner_provisioning_intent"("intent_id") ON DELETE RESTRICT,
  "service_id" text NOT NULL,
  "observed_at" timestamptz(3) NOT NULL,
  "cleanup_canary" text NOT NULL,
  "lifecycle" text NOT NULL CHECK ("lifecycle" IN ('role','cutover')),
  "terminal_at" timestamptz(3),
  "cleanup_observation" jsonb,
  "cleanup_provider_witness" jsonb,
  "runner_identity" jsonb,
  "provision_observation" jsonb,
  UNIQUE ("rollout_id","lifecycle"),
  CHECK ("terminal_at" IS NULL OR "terminal_at" >= "observed_at")
);

REVOKE ALL ON TABLE "release_rollout_ledger" FROM PUBLIC;
REVOKE ALL ON TABLE "release_rollout_receipt_ledger" FROM PUBLIC;
REVOKE ALL ON TABLE "release_runner_provisioning_intent" FROM PUBLIC;
REVOKE ALL ON TABLE "release_runner_job_ledger" FROM PUBLIC;

COMMIT;
