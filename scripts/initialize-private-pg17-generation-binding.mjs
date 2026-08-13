#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  decomposePostgresConnection,
  RedactedProcessCommandAdapter,
} from "../packages/features/release-rollout/src/index.ts";

const identifier = /^[0-9]+$/u;
const sha256 = /^[a-f0-9]{64}$/u;

const required = (env, name) => {
  const value = env[name];
  if (!value)
    throw new Error(`private_pg17_generation_binding_required:${name}`);
  return value;
};

export function canonicalGenerationBindingSql(input) {
  return `BEGIN;
DO $binding$
DECLARE
  actual_system_identifier text;
  current_binding jsonb;
  next_binding jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(1381126735, 1195529550);
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'target generation is not PostgreSQL 17';
  END IF;
  IF current_user <> session_user OR current_user <> 'reviewrouter_role_bootstrap' THEN
    RAISE EXCEPTION 'generation binding caller is not the bootstrap owner';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_database
    WHERE datname = current_database() AND datdba = current_user::regrole
  ) THEN
    RAISE EXCEPTION 'generation binding caller does not own target database';
  END IF;
  SELECT system_identifier::text INTO actual_system_identifier
  FROM pg_control_system();
  IF actual_system_identifier <> '${input.targetSystemIdentifier}'
     OR actual_system_identifier = '${input.sourceSystemIdentifier}' THEN
    RAISE EXCEPTION 'target generation system identifier mismatch';
  END IF;
  SELECT shobj_description(oid, 'pg_database')::jsonb INTO current_binding
  FROM pg_database WHERE datname = current_database();
  next_binding := jsonb_build_object(
    'version', 1,
    'systemIdentifier', actual_system_identifier,
    'recoveryWitnessSha256', '${input.targetRecoveryWitnessSha256}'
  );
  IF current_binding = next_binding THEN
    RETURN;
  END IF;
  IF current_binding IS NOT NULL AND NOT (
    jsonb_typeof(current_binding) = 'object' AND (
      (
        (SELECT count(*) FROM jsonb_object_keys(current_binding)) = 1
        AND current_binding ? 'recoveryWitnessSha256'
        AND jsonb_typeof(current_binding->'recoveryWitnessSha256') = 'string'
        AND current_binding->>'recoveryWitnessSha256' = '${input.sourceRecoveryWitnessSha256}'
      ) OR (
        (
          (SELECT count(*) FROM jsonb_object_keys(current_binding)) = 3
          OR (
            (SELECT count(*) FROM jsonb_object_keys(current_binding)) = 4
            AND current_binding ? 'consumedMigrationEvidence'
          )
        )
        AND current_binding ?& ARRAY['version','systemIdentifier','recoveryWitnessSha256']
        AND current_binding->'version' IN ('1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb)
        AND jsonb_typeof(current_binding->'systemIdentifier') = 'string'
        AND jsonb_typeof(current_binding->'recoveryWitnessSha256') = 'string'
        AND current_binding->>'systemIdentifier' = '${input.sourceSystemIdentifier}'
        AND current_binding->>'recoveryWitnessSha256' = '${input.sourceRecoveryWitnessSha256}'
        AND (
          NOT current_binding ? 'consumedMigrationEvidence'
          OR jsonb_typeof(current_binding->'consumedMigrationEvidence') = 'array'
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'existing database generation binding is not the expected restored source';
  END IF;
  EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), next_binding::text);
END
$binding$;
SELECT json_build_object(
  'systemIdentifier', system.system_identifier::text,
  'recoveryWitnessSha256', binding.value->>'recoveryWitnessSha256',
  'version', binding.value->'version',
  'caller', current_user,
  'postgresMajor', current_setting('server_version_num')::integer / 10000
)
FROM pg_control_system() system
CROSS JOIN LATERAL (
  SELECT shobj_description(database.oid, 'pg_database')::jsonb AS value
  FROM pg_database database WHERE database.datname = current_database()
) binding;
COMMIT;`;
}

export function executePrivatePg17GenerationBinding(
  env = process.env,
  commands = new RedactedProcessCommandAdapter(),
) {
  const input = {
    sourceSystemIdentifier: required(
      env,
      "REVIEW_ROUTER_SOURCE_DATABASE_SYSTEM_IDENTIFIER",
    ),
    targetSystemIdentifier: required(
      env,
      "REVIEW_ROUTER_TARGET_DATABASE_SYSTEM_IDENTIFIER",
    ),
    sourceRecoveryWitnessSha256: required(
      env,
      "REVIEW_ROUTER_SOURCE_RECOVERY_WITNESS_SHA256",
    ),
    targetRecoveryWitnessSha256: required(
      env,
      "REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256",
    ),
  };
  if (
    !identifier.test(input.sourceSystemIdentifier) ||
    !identifier.test(input.targetSystemIdentifier) ||
    input.sourceSystemIdentifier === input.targetSystemIdentifier ||
    !sha256.test(input.sourceRecoveryWitnessSha256) ||
    !sha256.test(input.targetRecoveryWitnessSha256) ||
    input.sourceRecoveryWitnessSha256 === input.targetRecoveryWitnessSha256
  )
    throw new Error("private_pg17_generation_binding_identity_invalid");

  const targetUrl = required(env, "REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL");
  const connection = decomposePostgresConnection(targetUrl);
  let output;
  try {
    output = commands.execute(
      "psql",
      [
        ...connection.args,
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--tuples-only",
        "--no-align",
      ],
      { env: connection.env, input: canonicalGenerationBindingSql(input) },
    ).stdout;
  } catch (error) {
    throw new Error("private_pg17_generation_binding_failed", { cause: error });
  } finally {
    connection.cleanup();
  }
  const observed = JSON.parse(
    output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("{")) ?? "null",
  );
  if (
    observed?.systemIdentifier !== input.targetSystemIdentifier ||
    observed?.recoveryWitnessSha256 !== input.targetRecoveryWitnessSha256 ||
    observed?.version !== 1 ||
    observed?.caller !== "reviewrouter_role_bootstrap" ||
    observed?.postgresMajor !== 17
  )
    throw new Error("private_pg17_generation_binding_unproven");
  return Object.freeze({
    step: "initialize_target_generation_binding",
    observedAt: new Date().toISOString(),
    facts: Object.freeze({
      ...observed,
      observationSha256: `sha256:${createHash("sha256").update(JSON.stringify(observed)).digest("hex")}`,
    }),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(executePrivatePg17GenerationBinding())}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "private_pg17_generation_binding_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
