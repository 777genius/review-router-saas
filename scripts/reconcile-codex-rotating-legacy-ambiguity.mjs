import { createHash } from "node:crypto";
import { assertLegacyAmbiguityEvidence } from "../packages/features/release-rollout/src/domain/trusted-rollout-evidence.js";

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

const inventoryKeys = Object.freeze([
  "activeLeaseIds",
  "fetchedSetupIds",
  "pendingIntentIds",
  "intentStatuses",
]);

const inventoryProjectionSql = (jsonType = "jsonb") => String.raw`${
  jsonType === "json" ? "json_build_object" : "jsonb_build_object"
}(
    'activeLeaseIds', coalesce((SELECT ${jsonType === "json" ? "json_agg" : "jsonb_agg"}("id" ORDER BY "id") FROM "CodexOAuthLease" WHERE "status" IN ('preleased','finalized')), '[]'::${jsonType}),
    'fetchedSetupIds', coalesce((SELECT ${jsonType === "json" ? "json_agg" : "jsonb_agg"}("id" ORDER BY "id") FROM "CodexOAuthSetupManifest" WHERE "status" = 'fetched'), '[]'::${jsonType}),
    'pendingIntentIds', coalesce((SELECT ${jsonType === "json" ? "json_agg" : "jsonb_agg"}("id" ORDER BY "id") FROM "CodexOAuthWritebackIntent" WHERE "status" = 'pending'), '[]'::${jsonType}),
    'intentStatuses', coalesce((SELECT ${jsonType === "json" ? "json_agg" : "jsonb_agg"}(DISTINCT "status" ORDER BY "status") FROM "CodexOAuthWritebackIntent"), '[]'::${jsonType})
  )`;

export const legacyAmbiguityInventorySql = String.raw`
SELECT ${inventoryProjectionSql("json")}::text`;

const canonicalInventoryTextSql = (inventoryExpression) => String.raw`(
    SELECT '{"activeLeaseIds":[' || coalesce((
      SELECT string_agg(to_jsonb(value)::text, ',' ORDER BY ordinal)
      FROM jsonb_array_elements_text(${inventoryExpression}->'activeLeaseIds')
        WITH ORDINALITY AS elements(value, ordinal)
    ), '') || '],"fetchedSetupIds":[' || coalesce((
      SELECT string_agg(to_jsonb(value)::text, ',' ORDER BY ordinal)
      FROM jsonb_array_elements_text(${inventoryExpression}->'fetchedSetupIds')
        WITH ORDINALITY AS elements(value, ordinal)
    ), '') || '],"pendingIntentIds":[' || coalesce((
      SELECT string_agg(to_jsonb(value)::text, ',' ORDER BY ordinal)
      FROM jsonb_array_elements_text(${inventoryExpression}->'pendingIntentIds')
        WITH ORDINALITY AS elements(value, ordinal)
    ), '') || '],"intentStatuses":[' || coalesce((
      SELECT string_agg(to_jsonb(value)::text, ',' ORDER BY ordinal)
      FROM jsonb_array_elements_text(${inventoryExpression}->'intentStatuses')
        WITH ORDINALITY AS elements(value, ordinal)
    ), '') || ']}'
  )`;

const inventoryInputValidationSql = (inventory, digest) => String.raw`
  IF jsonb_typeof(${inventory}) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(${inventory})) <> 4
     OR NOT ${inventory} ?& ARRAY[${inventoryKeys.map(quoted).join(",")}]
     OR ${digest} !~ '^sha256:[a-f0-9]{64}$'
     OR EXISTS (
       SELECT 1 FROM unnest(ARRAY[${inventoryKeys.map(quoted).join(",")}]) key
       WHERE jsonb_typeof(${inventory}->key) IS DISTINCT FROM 'array'
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(${inventory}->key) item
            WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
          )
     )
  THEN RAISE EXCEPTION 'legacy_reconciliation_guard_input_invalid'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${inventory}->'intentStatuses') status
    WHERE status NOT IN (${knownIntentStatuses.map(quoted).join(",")})
  ) THEN RAISE EXCEPTION 'legacy_reconciliation_intent_status_unclassified'; END IF;`;

function parseInventory(value) {
  const parsed = JSON.parse(value.trim());
  if (
    parsed === null ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    Object.keys(parsed).length !== inventoryKeys.length ||
    inventoryKeys.some((key) => !Object.hasOwn(parsed, key))
  )
    throw new Error("legacy_reconciliation_inventory_invalid");
  for (const key of inventoryKeys) {
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
  const ambiguous = ambiguousIntentStatuses.map(quoted).join(",");
  const requestedInventory = `${quoted(JSON.stringify(input.inventory))}::jsonb`;
  return String.raw`
DO $reconcile$
DECLARE
  target record;
  request_id text;
  next_epoch bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CodexOAuthWritebackIntent"
    WHERE "status" NOT IN (${knownIntentStatuses.map(quoted).join(",")})
  ) THEN RAISE EXCEPTION 'legacy_reconciliation_intent_status_unclassified'; END IF;
  IF jsonb_array_length(${requestedInventory}->'pendingIntentIds') > 0
     OR EXISTS (
       SELECT 1 FROM "CodexOAuthWritebackIntent"
       WHERE "status" IN (${ambiguous})
     )
  THEN RAISE EXCEPTION 'legacy_reconciliation_unresolved_intent'; END IF;
  IF EXISTS (
    SELECT 1 FROM "CodexOAuthLease"
    WHERE "status" IN ('preleased','finalized')
      AND NOT (${requestedInventory}->'activeLeaseIds' ? "id")
  ) OR EXISTS (
    SELECT 1 FROM "CodexOAuthSetupManifest"
    WHERE "status"='fetched'
      AND NOT (${requestedInventory}->'fetchedSetupIds' ? "id")
  ) THEN RAISE EXCEPTION 'legacy_reconciliation_inventory_addition'; END IF;
  IF EXISTS (
    SELECT 1 FROM "CodexOAuthLease" lease
    JOIN "CodexOAuthProviderInstance" provider ON provider."id"=lease."providerInstanceRowId"
    WHERE lease."status" IN ('preleased','finalized')
      AND (${requestedInventory}->'activeLeaseIds' ? lease."id") AND NOT (
      lease."expiresAt" <= ${quoted(input.eligibilityCutoff)}::timestamptz
      AND lease."mutationEpoch" < provider."mutationEpoch"
      AND provider."mutationOwner"='recovery'
      AND provider."mutationOwnerId"='versioned-namespace-cutover:'||provider."id"
      AND NOT EXISTS (SELECT 1 FROM "CodexOAuthWritebackIntent" intent WHERE intent."leaseId"=lease."id" AND intent."status" IN (${ambiguous}))
    )
  ) THEN RAISE EXCEPTION 'legacy_reconciliation_lease_not_eligible'; END IF;
  IF EXISTS (
    SELECT 1 FROM "CodexOAuthSetupManifest" manifest
    JOIN "CodexOAuthProviderInstance" provider ON provider."id"=manifest."providerInstanceRowId"
    WHERE manifest."status"='fetched'
      AND (${requestedInventory}->'fetchedSetupIds' ? manifest."id") AND NOT (
      manifest."expiresAt" <= ${quoted(input.eligibilityCutoff)}::timestamptz
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
      AND (${requestedInventory}->'fetchedSetupIds' ? manifest."id")
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
    WHERE "providerInstanceRowId"=target."id" AND "status"='fetched'
      AND (${requestedInventory}->'fetchedSetupIds' ? "id");
    UPDATE "CodexOAuthSetupRecoveryRequest"
    SET "state"='superseded', "completedAt"=clock_timestamp(), "updatedAt"=clock_timestamp()
    WHERE "id"=request_id;
  END LOOP;

  UPDATE "CodexOAuthLease" SET "status"='expired'
  WHERE "status" IN ('preleased','finalized')
    AND (${requestedInventory}->'activeLeaseIds' ? "id");
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
    eligibilityCutoff: "2026-08-15T00:00:00.000Z",
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
      () => `BEGIN
${inventoryInputValidationSql("requested_inventory", "requested_inventory_sha256")}
  IF requested_recovery_witness_sha256 !~ '^[a-f0-9]{64}$'
     OR requested_rollout_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$'
  THEN RAISE EXCEPTION 'legacy_reconciliation_guard_input_invalid'; END IF;
  IF 'sha256:'||encode(sha256(convert_to(
       ${canonicalInventoryTextSql("requested_inventory")},'UTF8')),'hex')
       IS DISTINCT FROM requested_inventory_sha256
  THEN RAISE EXCEPTION 'legacy_reconciliation_inventory_digest_invalid'; END IF;
`,
    )
    .replaceAll(quoted(expected), "requested_inventory")
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
  const cutoffBoundBody = body.replaceAll(
    `${quoted(sentinel.eligibilityCutoff)}::timestamptz`,
    "requested_eligibility_cutoff",
  );
  return `DROP PROCEDURE IF EXISTS public.reviewrouter_reconcile_legacy_ambiguity(
  text,text,jsonb,text);
CREATE OR REPLACE PROCEDURE public.reviewrouter_reconcile_legacy_ambiguity(
  requested_rollout_id text, requested_recovery_witness_sha256 text,
  requested_inventory jsonb, requested_inventory_sha256 text,
  requested_eligibility_cutoff timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $rr_guarded_legacy_reconciliation_v1$
${cutoffBoundBody}
$rr_guarded_legacy_reconciliation_v1$;
ALTER PROCEDURE public.reviewrouter_reconcile_legacy_ambiguity(text,text,jsonb,text,timestamptz)
  OWNER TO ${ownerRole};
REVOKE ALL ON PROCEDURE public.reviewrouter_reconcile_legacy_ambiguity(text,text,jsonb,text,timestamptz)
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
  void run;
  let evidence;
  try {
    evidence = assertLegacyAmbiguityEvidence(input.legacyAmbiguity);
  } catch {
    throw new Error("legacy_reconciliation_source_evidence_invalid");
  }
  if (
    input.rolloutId !== evidence.rolloutId ||
    input.eligibilityCutoff !== evidence.eligibilityCutoff
  )
    throw new Error("legacy_reconciliation_source_evidence_invalid");
  const inventory = parseInventory(
    JSON.stringify({
      activeLeaseIds: evidence.activeLeaseIds,
      fetchedSetupIds: evidence.fetchedSetupIds,
      pendingIntentIds: evidence.pendingIntentIds,
      intentStatuses: evidence.intentStatuses,
    }),
  );
  const inventorySha256 = sha256(JSON.stringify(inventory));
  if (
    inventorySha256 !== evidence.inventorySha256 ||
    evidence.observations.some(
      (sample) => sample.inventorySha256 !== evidence.inventorySha256,
    )
  )
    throw new Error("legacy_reconciliation_source_evidence_invalid");
  return Object.freeze({
    input: Object.freeze({
      inventory,
      inventorySha256,
      recoveryWitnessSha256: input.recoveryWitnessSha256,
      rolloutId: input.rolloutId,
      eligibilityCutoff: input.eligibilityCutoff,
    }),
    effectSql: legacyAmbiguityReconciliationEffectSql({
      inventory,
      inventorySha256,
      recoveryWitnessSha256: input.recoveryWitnessSha256,
      rolloutId: input.rolloutId,
      eligibilityCutoff: input.eligibilityCutoff,
    }),
    evidence: Object.freeze(evidence),
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
  if (!prepared.receipt || prepared.receipt.status !== "reconciled")
    throw new Error("legacy_reconciliation_database_receipt_invalid");
  return Object.freeze(prepared.receipt);
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
