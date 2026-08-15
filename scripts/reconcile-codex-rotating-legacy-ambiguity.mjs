import { createHash } from "node:crypto";

const exactAcknowledgement = "all_prior_installers_and_writers_are_stopped";
const knownIntentStatuses = Object.freeze([
  "completed",
  "failed",
  "pending",
  "remote_outcome_unknown",
]);
const ambiguousIntentStatuses = Object.freeze([
  "pending",
  "remote_outcome_unknown",
]);

const quoted = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sha256 = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

export const legacyAmbiguityInventorySql = String.raw`
SELECT json_build_object(
  'activeLeaseIds', coalesce((SELECT json_agg("id" ORDER BY "id") FROM "CodexOAuthLease" WHERE "status" IN ('preleased','finalized')), '[]'::json),
  'fetchedSetupIds', coalesce((SELECT json_agg("id" ORDER BY "id") FROM "CodexOAuthSetupManifest" WHERE "status" = 'fetched'), '[]'::json),
  'pendingIntentIds', coalesce((SELECT json_agg("id" ORDER BY "id") FROM "CodexOAuthWritebackIntent" WHERE "status" = 'pending'), '[]'::json),
  'intentStatuses', coalesce((SELECT json_agg(DISTINCT "status" ORDER BY "status") FROM "CodexOAuthWritebackIntent"), '[]'::json)
)::text`;

function parseInventory(value) {
  const parsed = JSON.parse(value.trim());
  for (const key of [
    "activeLeaseIds",
    "fetchedSetupIds",
    "pendingIntentIds",
    "intentStatuses",
  ]) {
    if (
      !Array.isArray(parsed[key]) ||
      parsed[key].some((item) => typeof item !== "string")
    )
      throw new Error("legacy_reconciliation_inventory_invalid");
  }
  const unknown = parsed.intentStatuses.filter(
    (status) => !knownIntentStatuses.includes(status),
  );
  if (unknown.length)
    throw new Error(
      `legacy_reconciliation_intent_status_unclassified:${unknown.join(",")}`,
    );
  return parsed;
}

export function legacyAmbiguityReconciliationEffectSql(input) {
  const expected = JSON.stringify({
    activeLeaseIds: input.inventory.activeLeaseIds,
    fetchedSetupIds: input.inventory.fetchedSetupIds,
    pendingIntentIds: input.inventory.pendingIntentIds,
    intentStatuses: input.inventory.intentStatuses,
  });
  const ambiguous = ambiguousIntentStatuses.map(quoted).join(",");
  return String.raw`
DO $reconcile$
DECLARE
  observed jsonb;
  target record;
  request_id text;
  next_epoch bigint;
BEGIN
  LOCK TABLE "CodexOAuthProviderInstance", "CodexOAuthLease", "CodexOAuthSetupManifest", "CodexOAuthWritebackIntent", "CodexOAuthSetupRecoveryRequest" IN SHARE ROW EXCLUSIVE MODE;
  SELECT jsonb_build_object(
    'activeLeaseIds', coalesce((SELECT jsonb_agg("id" ORDER BY "id") FROM "CodexOAuthLease" WHERE "status" IN ('preleased','finalized')), '[]'::jsonb),
    'fetchedSetupIds', coalesce((SELECT jsonb_agg("id" ORDER BY "id") FROM "CodexOAuthSetupManifest" WHERE "status" = 'fetched'), '[]'::jsonb),
    'pendingIntentIds', coalesce((SELECT jsonb_agg("id" ORDER BY "id") FROM "CodexOAuthWritebackIntent" WHERE "status" = 'pending'), '[]'::jsonb),
    'intentStatuses', coalesce((SELECT jsonb_agg(DISTINCT "status" ORDER BY "status") FROM "CodexOAuthWritebackIntent"), '[]'::jsonb)
  ) INTO observed;
  IF observed <> ${quoted(expected)}::jsonb THEN
    RAISE EXCEPTION 'legacy_reconciliation_inventory_changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "CodexOAuthWritebackIntent"
    WHERE "status" NOT IN (${knownIntentStatuses.map(quoted).join(",")})
  ) THEN RAISE EXCEPTION 'legacy_reconciliation_intent_status_unclassified'; END IF;
  IF EXISTS (
    SELECT 1 FROM "CodexOAuthLease" lease
    JOIN "CodexOAuthProviderInstance" provider ON provider."id"=lease."providerInstanceRowId"
    WHERE lease."status" IN ('preleased','finalized') AND NOT (
      lease."expiresAt" <= clock_timestamp()
      AND lease."mutationEpoch" < provider."mutationEpoch"
      AND provider."mutationOwner"='recovery'
      AND provider."mutationOwnerId"='versioned-namespace-cutover:'||provider."id"
      AND NOT EXISTS (SELECT 1 FROM "CodexOAuthWritebackIntent" intent WHERE intent."leaseId"=lease."id" AND intent."status" IN (${ambiguous}))
    )
  ) THEN RAISE EXCEPTION 'legacy_reconciliation_lease_not_eligible'; END IF;
  IF EXISTS (
    SELECT 1 FROM "CodexOAuthSetupManifest" manifest
    JOIN "CodexOAuthProviderInstance" provider ON provider."id"=manifest."providerInstanceRowId"
    WHERE manifest."status"='fetched' AND NOT (
      manifest."expiresAt" <= clock_timestamp()
      AND manifest."mutationEpoch" < provider."mutationEpoch"
      AND provider."mutationOwner"='recovery'
      AND provider."mutationOwnerId"='versioned-namespace-cutover:'||provider."id"
    )
  ) THEN RAISE EXCEPTION 'legacy_reconciliation_fetched_setup_not_eligible'; END IF;

  FOR target IN
    SELECT DISTINCT provider."id"
    FROM "CodexOAuthSetupManifest" manifest
    JOIN "CodexOAuthProviderInstance" provider ON provider."id"=manifest."providerInstanceRowId"
    WHERE manifest."status"='fetched'
    ORDER BY provider."id"
  LOOP
    request_id := 'legacy-cutover:${input.rolloutId}:' || target."id";
    UPDATE "CodexOAuthProviderInstance"
    SET "mutationEpoch"="mutationEpoch"+1,
        "mutationOwner"='recovery',
        "mutationOwnerId"='setup-recovery:'||request_id,
        "state"='unknown_auth_state',
        "updatedAt"=clock_timestamp()
    WHERE "id"=target."id"
    RETURNING "mutationEpoch" INTO next_epoch;
    INSERT INTO "CodexOAuthSetupRecoveryRequest" (
      "id", "providerInstanceRowId", "recoveryRequestId", "actor",
      "acknowledgement", "mutationEpoch", "databaseRecoveryWitness",
      "mode", "state", "requestedAt", "activatedAt", "updatedAt"
    ) VALUES (
      request_id, target."id", request_id, 'release-cutover:${input.rolloutId}',
      ${quoted(exactAcknowledgement)}, next_epoch, ${quoted(input.recoveryWitnessSha256)},
      'forced_reseed', 'active', clock_timestamp(), clock_timestamp(), clock_timestamp()
    );
    UPDATE "CodexOAuthSetupManifest"
    SET "status"='recovered', "consumedAt"=clock_timestamp(),
        "confirmationJson"=jsonb_build_object(
          'recoveryRequestId', request_id,
          'acknowledgedSecretMayHaveChanged', true,
          'recoveryEpoch', next_epoch::text,
          'legacyInventorySha256', ${quoted(input.inventorySha256)}
        )
    WHERE "providerInstanceRowId"=target."id" AND "status"='fetched';
    UPDATE "CodexOAuthSetupRecoveryRequest"
    SET "state"='superseded', "completedAt"=clock_timestamp(), "updatedAt"=clock_timestamp()
    WHERE "id"=request_id;
  END LOOP;

  UPDATE "CodexOAuthLease" SET "status"='expired'
  WHERE "status" IN ('preleased','finalized');
END
$reconcile$;
`;
}

/**
 * Fixed, non-public reconciliation procedure installed beside the guarded
 * migration executor. Runtime data is validated as values; no SQL text is
 * accepted from the migration login.
 */
export function guardedLegacyAmbiguityReconciliationProcedureSql(ownerRole) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(ownerRole))
    throw new Error("legacy_reconciliation_owner_invalid");
  const sentinel = {
    inventory: {
      activeLeaseIds: ["rr-sentinel-active"],
      fetchedSetupIds: ["rr-sentinel-fetched"],
      pendingIntentIds: ["rr-sentinel-pending"],
      intentStatuses: ["completed"],
    },
    inventorySha256: `sha256:${"1".repeat(64)}`,
    recoveryWitnessSha256: "2".repeat(64),
    rolloutId: "rr-sentinel-rollout",
  };
  const expected = JSON.stringify(sentinel.inventory);
  const effect = legacyAmbiguityReconciliationEffectSql(sentinel);
  const start = effect.indexOf("DO $reconcile$\n") + "DO $reconcile$\n".length;
  const end = effect.lastIndexOf("\n$reconcile$;");
  if (start < "DO $reconcile$\n".length || end < start)
    throw new Error("legacy_reconciliation_guard_body_invalid");
  const body = effect
    .slice(start, end)
    .replace(
      "BEGIN\n",
      `BEGIN
  IF jsonb_typeof(requested_inventory) IS DISTINCT FROM 'object'
     OR requested_inventory_sha256 !~ '^sha256:[a-f0-9]{64}$'
     OR requested_recovery_witness_sha256 !~ '^[a-f0-9]{64}$'
     OR requested_rollout_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$'
  THEN RAISE EXCEPTION 'legacy_reconciliation_guard_input_invalid'; END IF;
`,
    )
    .replace(quoted(expected), "requested_inventory")
    .replaceAll(
      `'legacy-cutover:${sentinel.rolloutId}:'`,
      `'legacy-cutover:'||requested_rollout_id||':'`,
    )
    .replaceAll(
      `'release-cutover:${sentinel.rolloutId}'`,
      `'release-cutover:'||requested_rollout_id`,
    )
    .replaceAll(
      quoted(sentinel.recoveryWitnessSha256),
      "requested_recovery_witness_sha256",
    )
    .replaceAll(quoted(sentinel.inventorySha256), "requested_inventory_sha256");
  return `CREATE OR REPLACE PROCEDURE public.reviewrouter_reconcile_legacy_ambiguity(
  requested_rollout_id text, requested_recovery_witness_sha256 text,
  requested_inventory jsonb, requested_inventory_sha256 text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $rr_guarded_legacy_reconciliation_v1$
${body}
$rr_guarded_legacy_reconciliation_v1$;
ALTER PROCEDURE public.reviewrouter_reconcile_legacy_ambiguity(text,text,jsonb,text)
  OWNER TO ${ownerRole};
REVOKE ALL ON PROCEDURE public.reviewrouter_reconcile_legacy_ambiguity(text,text,jsonb,text)
  FROM PUBLIC;`;
}

export function legacyAmbiguityReconciliationSql(input) {
  return String.raw`
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';
${legacyAmbiguityReconciliationEffectSql(input)}
COMMIT;
`;
}

export function prepareLegacyAmbiguityReconciliation(input, run) {
  const observe = (step) =>
    parseInventory(
      run(
        step,
        "psql",
        [
          input.databaseUrl,
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--command",
          legacyAmbiguityInventorySql,
        ],
        { env: input.env },
      ),
    );
  const first = observe("legacy_ambiguity_inventory_first");
  run(
    "legacy_ambiguity_stabilization",
    "psql",
    [
      input.databaseUrl,
      "--no-psqlrc",
      "--quiet",
      "--command",
      "SELECT pg_sleep(0.2)",
    ],
    { env: input.env },
  );
  const second = observe("legacy_ambiguity_inventory_second");
  const firstCanonical = JSON.stringify(first);
  const secondCanonical = JSON.stringify(second);
  if (firstCanonical !== secondCanonical)
    throw new Error("legacy_reconciliation_inventory_not_stable");
  const inventorySha256 = sha256(secondCanonical);
  return Object.freeze({
    input: Object.freeze({
      inventory: second,
      inventorySha256,
      recoveryWitnessSha256: input.recoveryWitnessSha256,
      rolloutId: input.rolloutId,
    }),
    effectSql: legacyAmbiguityReconciliationEffectSql({
      inventory: second,
      inventorySha256,
      recoveryWitnessSha256: input.recoveryWitnessSha256,
      rolloutId: input.rolloutId,
    }),
    receipt: Object.freeze({
      version: 1,
      acknowledgement: exactAcknowledgement,
      inventory: second,
      inventorySha256,
      stableSamples: 2,
      status: "reconciled",
    }),
  });
}

export function verifyLegacyAmbiguityReconciliation(input, run, prepared) {
  const after = parseInventory(
    run(
      "legacy_ambiguity_inventory_after",
      "psql",
      [
        input.databaseUrl,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        legacyAmbiguityInventorySql,
      ],
      { env: input.env },
    ),
  );
  if (
    after.activeLeaseIds.length ||
    after.fetchedSetupIds.length ||
    after.pendingIntentIds.length
  )
    throw new Error("legacy_reconciliation_raw_status_not_zero");
  return Object.freeze({ ...prepared.receipt, after });
}

export function reconcileLegacyAmbiguity(input, run) {
  const prepared = prepareLegacyAmbiguityReconciliation(input, run);
  run("legacy_ambiguity_reconcile", "psql", [
    input.databaseUrl,
    "--no-psqlrc",
    "--quiet",
    "--command",
    legacyAmbiguityReconciliationSql(prepared.input),
  ]);
  return verifyLegacyAmbiguityReconciliation(input, run, prepared);
}
