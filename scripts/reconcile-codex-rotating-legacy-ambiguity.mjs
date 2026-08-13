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

export function legacyAmbiguityReconciliationSql(input) {
  const expected = JSON.stringify({
    activeLeaseIds: input.inventory.activeLeaseIds,
    fetchedSetupIds: input.inventory.fetchedSetupIds,
    pendingIntentIds: input.inventory.pendingIntentIds,
    intentStatuses: input.inventory.intentStatuses,
  });
  const ambiguous = ambiguousIntentStatuses.map(quoted).join(",");
  return String.raw`
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';
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
COMMIT;
`;
}

export function reconcileLegacyAmbiguity(input, run) {
  const first = parseInventory(
    run("legacy_ambiguity_inventory_first", "psql", [
      input.databaseUrl,
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--command",
      legacyAmbiguityInventorySql,
    ]),
  );
  run("legacy_ambiguity_stabilization", "psql", [
    input.databaseUrl,
    "--no-psqlrc",
    "--quiet",
    "--command",
    "SELECT pg_sleep(0.2)",
  ]);
  const second = parseInventory(
    run("legacy_ambiguity_inventory_second", "psql", [
      input.databaseUrl,
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--command",
      legacyAmbiguityInventorySql,
    ]),
  );
  const firstCanonical = JSON.stringify(first);
  const secondCanonical = JSON.stringify(second);
  if (firstCanonical !== secondCanonical)
    throw new Error("legacy_reconciliation_inventory_not_stable");
  const inventorySha256 = sha256(secondCanonical);
  run("legacy_ambiguity_reconcile", "psql", [
    input.databaseUrl,
    "--no-psqlrc",
    "--quiet",
    "--command",
    legacyAmbiguityReconciliationSql({
      inventory: second,
      inventorySha256,
      recoveryWitnessSha256: input.recoveryWitnessSha256,
      rolloutId: input.rolloutId,
    }),
  ]);
  const after = parseInventory(
    run("legacy_ambiguity_inventory_after", "psql", [
      input.databaseUrl,
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--command",
      legacyAmbiguityInventorySql,
    ]),
  );
  if (
    after.activeLeaseIds.length ||
    after.fetchedSetupIds.length ||
    after.pendingIntentIds.length
  )
    throw new Error("legacy_reconciliation_raw_status_not_zero");
  return Object.freeze({
    version: 1,
    acknowledgement: exactAcknowledgement,
    inventory: second,
    inventorySha256,
    stableSamples: 2,
    after,
    status: "reconciled",
  });
}
