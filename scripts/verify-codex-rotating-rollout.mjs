#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertTrustedGitHubEvidence,
  fetchTrustedGitHubEvidence,
  gitBlobSha,
} from "./lib/github-actions-trusted-evidence.mjs";
import {
  isGenerationBoundMigrationReceipt,
  normalizeMigrationEvidenceReceipts,
} from "./lib/codex-rotating-migration-receipts.mjs";
import {
  catalogColumnKey,
  codexRotatingCatalogCheckNames,
  codexRotatingCheckDefinitions,
  codexRotatingCatalogColumnKeys,
  codexRotatingCatalogForeignKeyNames,
  codexRotatingCatalogForeignKeys,
  codexRotatingCatalogIndexNames,
  codexRotatingCatalogTables,
  codexRotatingFunctionBodyDigests,
  codexRotatingIndexDefinitions,
  codexRotatingPartialIndexPredicates,
  codexRotatingDatabaseRoles,
  codexRotatingFunctions as exactFunctions,
  codexRotatingTriggers as exactTriggers,
  codexRotatingCatalogColumns,
  codexRotatingPrimaryKeys as exactPrimaryKeys,
  codexRotatingProviderRuntimeUpdateColumns,
} from "./codex-rotating-production-writer-schema.mjs";
import { assertCompleteAdmittedRecoveryEvidence } from "./capture-codex-rotating-production-writer.mjs";

/**
 * Runtime validators below are the trust boundary for observation data. Their
 * compile-time producer contracts live in codex-rotating-rollout-observations.ts.
 * @typedef {import("./codex-rotating-rollout-observations.js").ProductionWriterObservation} ProductionWriterObservation
 * @typedef {import("./codex-rotating-rollout-observations.js").WorkflowRunInventoryObservation} WorkflowRunInventoryObservation
 * @typedef {import("./codex-rotating-rollout-observations.js").CanaryRuntimeObservation} CanaryRuntimeObservation
 */

const checkoutRoot = resolve(import.meta.dirname, "..");
const migrations = [
  {
    id: "000060_codex_oauth_setup_serialization",
    sourceFile:
      "packages/platform/db/prisma/migrations/000060_codex_oauth_setup_serialization/migration.sql",
  },
  {
    id: "000061_codex_oauth_provider_mutation_fence",
    sourceFile:
      "packages/platform/db/prisma/migrations/000061_codex_oauth_provider_mutation_fence/migration.sql",
  },
  {
    id: "000062_codex_oauth_remote_outcome_unknown",
    sourceFile:
      "packages/platform/db/prisma/migrations/000062_codex_oauth_remote_outcome_unknown/migration.sql",
  },
  {
    id: "000063_codex_oauth_setup_payload_claim",
    sourceFile:
      "packages/platform/db/prisma/migrations/000063_codex_oauth_setup_payload_claim/migration.sql",
  },
  {
    id: "000064_codex_oauth_versioned_secret_namespaces",
    sourceFile:
      "packages/platform/db/prisma/migrations/000064_codex_oauth_versioned_secret_namespaces/migration.sql",
    expectedSha256:
      "4da4352108efd684a8bc6ddefa19353181a8a74758c32ed890527c2aec2ae666",
  },
  {
    id: "000065_codex_oauth_authority_acl_hardening",
    sourceFile:
      "packages/platform/db/prisma/migrations/000065_codex_oauth_authority_acl_hardening/migration.sql",
    expectedSha256:
      "ca8d554dd71cbdeaf0a66e007aa7ef391627c0a9d97b10a27e1113308087342c",
  },
  {
    id: "000066_codex_oauth_rotating_cascade_authority",
    sourceFile:
      "packages/platform/db/prisma/migrations/000066_codex_oauth_rotating_cascade_authority/migration.sql",
    expectedSha256:
      "3b9b6385fde3120793aff052ba00c1afbd09011585d73a8184d0e73de8934af8",
  },
  {
    id: "000073_codex_oauth_active_namespace_refresh",
    sourceFile:
      "packages/platform/db/prisma/migrations/000073_codex_oauth_active_namespace_refresh/migration.sql",
    expectedSha256:
      "3e5b6606f22c8bec6f75f52f48b693806d597fa283155f6e033844c4f6be4de6",
  },
];
const checkedInRotatingMigrations = readdirSync(
  resolve(checkoutRoot, "packages/platform/db/prisma/migrations"),
)
  .filter((name) => /^0000(?:6[0-9]|[7-9][0-9])_codex_oauth_/u.test(name))
  .sort();
if (
  JSON.stringify(checkedInRotatingMigrations) !==
  JSON.stringify(migrations.map(({ id }) => id))
) {
  throw new Error("Codex rotating migration source inventory is not exact");
}
const exactServiceRoles = new Map([
  ["reviewrouter-api", "api"],
  ["reviewrouter-web", "web"],
  ["reviewrouter-worker", "worker"],
]);
const releaseMigrationRole = codexRotatingDatabaseRoles.releaseMigration;
const effectAuthorityRole = codexRotatingDatabaseRoles.effectAuthority;
const runtimeDatabaseRoles = codexRotatingDatabaseRoles.runtime;
const exactForeignKeys = codexRotatingCatalogForeignKeys.map(
  ({ name }) => name,
);
const exactForeignKeyByName = new Map(
  codexRotatingCatalogForeignKeys.map((foreignKey) => [
    foreignKey.name,
    foreignKey,
  ]),
);
const exactFunctionBodyDigestByName = new Map(
  codexRotatingFunctionBodyDigests.map(({ name, bodySha256 }) => [
    name,
    bodySha256,
  ]),
);
const exactCheckDefinitionByName = new Map(
  codexRotatingCheckDefinitions.map((entry) => [entry.name, entry]),
);
const exactIndexDefinitionDigestByName = new Map(
  codexRotatingIndexDefinitions.map((entry) => [
    entry.name,
    entry.definitionSha256,
  ]),
);
const exactPartialIndexPredicateDigestByName = new Map(
  codexRotatingPartialIndexPredicates.map((entry) => [
    entry.name,
    entry.predicateSha256,
  ]),
);
const exactCases = [
  "legacy-consumed-confirmation-replay",
  "v1-workflow-after-v2-publication",
  "v2-workflow-fence-aware",
];
const exactChecks = [...codexRotatingCatalogCheckNames];
const exactIndexes = codexRotatingCatalogIndexNames.filter(
  (name) => !name.endsWith("_pkey"),
);
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
export function canonicalJson(value) {
  return `${JSON.stringify(sortJson(value))}\n`;
}
export function sha256Utf8(value) {
  return sha256(Buffer.from(value, "utf8"));
}

export async function runCodexRotatingRolloutVerifierCli(
  _args,
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  try {
    const workflowPath =
      ".github/workflows/codex-rotating-rollout-evidence.yml";
    const required = (name) => {
      const value = process.env[name];
      if (!value) throw new Error(`missing ${name}`);
      return value;
    };
    const headSha = required("REVIEW_ROUTER_ROLLOUT_EVIDENCE_HEAD_SHA");
    const trusted = await fetchTrustedGitHubEvidence({
      token: required("REVIEW_ROUTER_ROLLOUT_GITHUB_TOKEN"),
      repository: "777genius/review-router-saas",
      repositoryId: required("REVIEW_ROUTER_ROLLOUT_EVIDENCE_REPOSITORY_ID"),
      workflowPath,
      workflowSha: gitBlobSha(
        readFileSync(resolve(checkoutRoot, workflowPath)),
      ),
      workflowRef: headSha,
      headSha,
      rolloutId: required("REVIEW_ROUTER_ROLLOUT_EVIDENCE_ROLLOUT_ID"),
      runId: required("REVIEW_ROUTER_ROLLOUT_EVIDENCE_RUN_ID"),
      runAttempt: required("REVIEW_ROUTER_ROLLOUT_EVIDENCE_RUN_ATTEMPT"),
      jobId: required("REVIEW_ROUTER_ROLLOUT_EVIDENCE_JOB_ID"),
      jobName: "trusted-rollout-evidence",
      artifactId: required("REVIEW_ROUTER_ROLLOUT_EVIDENCE_ARTIFACT_ID"),
      artifactName: required("REVIEW_ROUTER_ROLLOUT_EVIDENCE_ARTIFACT_NAME"),
    });
    const result = verifyCodexRotatingRollout(trusted);
    if (!result.ok) {
      for (const failure of result.failures) stderr.write(`FAIL: ${failure}\n`);
      return 1;
    }
    stdout.write(`PASS proof-bundle-sha256=${result.proofBundleSha256}\n`);
    return 0;
  } catch (error) {
    stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "trusted rollout evidence verification failed"}\n`,
    );
    return 1;
  }
}

export function verifyCodexRotatingRollout(trustedEvidence) {
  const trusted = assertTrustedGitHubEvidence(trustedEvidence);
  const result = inspectCodexRotatingRolloutStructure(
    trusted.evidence?.rollout,
    {
      readArtifact: trusted.readArtifact,
      expectedRolloutId: trusted.evidence.rolloutId,
    },
  );
  const executionBound =
    trusted.evidence.execution?.headSha === result.observedCommit;
  const proofBundleSha256 = sha256Utf8(
    canonicalJson({
      artifactDigest: trusted.receipt.artifactDigest,
      providerResponses: trusted.receipt.observedResponseSha256,
      rolloutProofBundleSha256: result.proofBundleSha256,
    }),
  );
  return {
    ...result,
    ok: result.ok && executionBound,
    failures: executionBound
      ? result.failures
      : [
          ...result.failures,
          "trusted workflow execution commit does not match the deployed release",
        ],
    proofBundleSha256,
  };
}

export function inspectCodexRotatingRolloutStructure(evidence, options = {}) {
  const failures = [];
  const need = (condition, message) => {
    if (!condition) failures.push(message);
  };
  need(evidence?.version === 3, "evidence must use receipt-bound version 3");
  need(
    hasExactKeys(evidence, ["artifacts", "rolloutId", "version"]) &&
      typeof evidence?.rolloutId === "string" &&
      evidence.rolloutId.length > 0 &&
      (!options.expectedRolloutId ||
        evidence.rolloutId === options.expectedRolloutId),
    "top-level self-reported rollout fields are prohibited",
  );
  need(
    hasExactKeys(evidence?.artifacts, [
      "canaryRuntime",
      "compatibilityProbe",
      "database",
      "deployments",
      "events",
      "workflowRuns",
    ]),
    "all four observed artifacts are required",
  );

  const loaded = {};
  for (const name of [
    "database",
    "deployments",
    "compatibilityProbe",
    "events",
    "canaryRuntime",
    "workflowRuns",
  ]) {
    const descriptor = evidence?.artifacts?.[name];
    need(
      hasExactKeys(
        descriptor,
        [
          "compatibilityProbe",
          "database",
          "deployments",
          "workflowRuns",
        ].includes(name)
          ? ["path", "sha256", "sourceFile", "sourceFileSha256"]
          : ["path", "sha256"],
      ),
      `${name} artifact descriptor is invalid`,
    );
    const artifact = loadArtifact(descriptor, options);
    need(artifact.digestValid, `${name} artifact digest mismatched`);
    need(artifact.value !== null, `${name} artifact is unreadable`);
    loaded[name] = artifact.value;
  }

  const databaseFacts = verifyDatabase(
    loaded.database,
    evidence?.artifacts?.database,
    need,
    options,
  );
  const deploymentFacts = verifyDeployments(
    loaded.deployments,
    evidence?.artifacts?.deployments,
    need,
    options,
  );
  need(
    databaseFacts?.callerCommit === deploymentFacts.commit &&
      databaseFacts?.callerImageDigest === deploymentFacts.imageDigest,
    "release-migration caller is not bound to the deployed immutable release",
  );
  need(
    databaseFacts?.callerRolloutId === evidence?.rolloutId,
    "release-migration caller is not derived from the exact rollout receipt",
  );
  need(
    databaseFacts?.recoveryWitnessSha256 ===
      deploymentFacts.runtimeWitnessSha256,
    "database witness is not independently bound to the authenticated runtime secret observation",
  );
  const compatibilityFacts = verifyCompatibility(
    loaded.compatibilityProbe,
    evidence?.artifacts?.compatibilityProbe,
    deploymentFacts,
    need,
    options,
  );
  const workflowFacts = verifyWorkflowRuns(
    loaded.workflowRuns,
    evidence?.artifacts?.workflowRuns,
    need,
    options,
  );
  const canaryFacts = verifyCanaryRuntime(
    loaded.canaryRuntime,
    deploymentFacts,
    need,
  );
  verifyEvents(
    loaded.events,
    deploymentFacts,
    compatibilityFacts,
    need,
    {
      database: evidence?.artifacts?.database?.sha256,
      compatibilityProbe: evidence?.artifacts?.compatibilityProbe?.sha256,
    },
    canaryFacts,
    workflowFacts,
  );

  return {
    ok: failures.length === 0,
    failures,
    observedCommit: deploymentFacts?.commit ?? null,
    observedImageDigest: deploymentFacts?.imageDigest ?? null,
    proofBundleSha256: sha256Utf8(canonicalJson(evidence?.artifacts ?? null)),
  };
}

function verifyDatabase(db, descriptor, need, options) {
  const captureSource = readCheckout(descriptor?.sourceFile, options);
  need(
    descriptor?.sourceFile ===
      "scripts/capture-codex-rotating-production-writer.mjs" &&
      captureSource !== null &&
      sha256(captureSource) === descriptor?.sourceFileSha256,
    "production database capture executable source digest mismatched",
  );
  need(
    hasExactKeys(db, [
      "observationVersion",
      "source",
      "captureKind",
      "rehearsal",
      "databaseIdentity",
      "isWriter",
      "recoveryWitnessSha256",
      "databaseGenerationBinding",
      "admittedRecoveryEvidence",
      "databaseAuthorization",
      "callerIdentity",
      "postgresVersion",
      "unsafeWork",
      "recoveryOwnerId",
      "catalogManifest",
      "migrationSources",
      "history",
      "catalog",
      "effectivePrincipalInventory",
      "effectivePrincipalDecision",
      "drainObservations",
    ]) &&
      db?.observationVersion === 6 &&
      db?.source === "production-postgresql-writer" &&
      db?.captureKind === "database-query" &&
      db?.rehearsal === false,
    "database observation must come from the actual production writer",
  );
  need(
    db?.effectivePrincipalInventory?.version === 1 &&
      Array.isArray(db?.effectivePrincipalInventory?.roles) &&
      Array.isArray(db?.effectivePrincipalInventory?.memberships) &&
      Array.isArray(db?.effectivePrincipalInventory?.grants) &&
      db?.effectivePrincipalDecision?.accepted === true &&
      Array.isArray(db?.effectivePrincipalDecision?.violations) &&
      db.effectivePrincipalDecision.violations.length === 0 &&
      /^sha256:[a-f0-9]{64}$/u.test(
        db?.effectivePrincipalDecision?.inventorySha256 ?? "",
      ) &&
      /^sha256:[a-f0-9]{64}$/u.test(
        db?.effectivePrincipalDecision?.policySha256 ?? "",
      ),
    "effective principal inventory or canonical policy attestation invalid",
  );
  need(
    hasExactKeys(db?.databaseIdentity, [
      "currentDatabase",
      "currentSchema",
      "serverAddress",
      "systemIdentifier",
    ]) &&
      [
        db?.databaseIdentity?.currentDatabase,
        db?.databaseIdentity?.currentSchema,
        db?.databaseIdentity?.serverAddress,
        db?.databaseIdentity?.systemIdentifier,
      ].every((value) => typeof value === "string" && value.length > 0) &&
      db.databaseIdentity.currentSchema === "public",
    "production database identity is incomplete",
  );
  need(db?.isWriter === true, "database observation is not from a writer");
  let normalizedMigrationReceipts = [];
  try {
    normalizedMigrationReceipts = normalizeMigrationEvidenceReceipts(
      db?.databaseGenerationBinding?.consumedMigrationEvidence,
    );
  } catch {
    need(false, "database migration receipt history is malformed");
  }
  need(
    hasExactKeys(db?.databaseGenerationBinding, [
      "consumedMigrationEvidence",
      "recoveryWitnessSha256",
      "systemIdentifier",
      "version",
    ]) &&
      db.databaseGenerationBinding.version === 4 &&
      normalizedMigrationReceipts.length > 0 &&
      normalizedMigrationReceipts.every(
        (receipt) =>
          receipt.receiptVersion !== 4 ||
          isGenerationBoundMigrationReceipt(
            receipt,
            db.databaseGenerationBinding,
          ),
      ) &&
      typeof db.databaseGenerationBinding.systemIdentifier === "string" &&
      db.databaseGenerationBinding.systemIdentifier ===
        db?.databaseIdentity?.systemIdentifier &&
      typeof db.databaseGenerationBinding.recoveryWitnessSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(
        db.databaseGenerationBinding.recoveryWitnessSha256 ?? "",
      ) &&
      db.recoveryWitnessSha256 ===
        db.databaseGenerationBinding.recoveryWitnessSha256,
    "database recovery witness is not stored against this database generation",
  );
  try {
    assertCompleteAdmittedRecoveryEvidence(
      db?.admittedRecoveryEvidence,
      db?.recoveryWitnessSha256,
      db?.databaseIdentity?.systemIdentifier,
    );
  } catch {
    need(
      false,
      "admitted recovery evidence is incomplete or not source-bound to this database generation",
    );
  }
  need(
    hasExactKeys(db?.callerIdentity, [
      "commit",
      "databaseRole",
      "artifactDigest",
      "artifactId",
      "claimedAt",
      "id",
      "imageDigest",
      "jobId",
      "kind",
      "platform",
      "rolloutId",
      "runAttempt",
      "runId",
      "sessionUser",
      "receiptVersion",
      "recoveryWitnessSha256",
      "systemIdentifier",
      "workflowPath",
    ]) &&
      db?.callerIdentity?.kind === "trusted-github-release-migration" &&
      db?.callerIdentity?.id === "release-migration" &&
      db?.callerIdentity?.platform === "github-actions" &&
      db?.callerIdentity?.databaseRole ===
        codexRotatingDatabaseRoles.releaseMigration &&
      db?.callerIdentity?.sessionUser ===
        codexRotatingDatabaseRoles.releaseMigration &&
      /^sha256:[a-f0-9]{64}$/u.test(db?.callerIdentity?.artifactDigest ?? "") &&
      [
        db?.callerIdentity?.artifactId,
        db?.callerIdentity?.jobId,
        db?.callerIdentity?.rolloutId,
        db?.callerIdentity?.runId,
      ].every((value) => typeof value === "string" && value.length > 0) &&
      Number.isSafeInteger(db?.callerIdentity?.runAttempt) &&
      db.callerIdentity.runAttempt > 0 &&
      db?.callerIdentity?.workflowPath ===
        ".github/workflows/codex-rotating-release-migration.yml" &&
      Number.isFinite(Date.parse(db?.callerIdentity?.claimedAt ?? "")) &&
      /^[a-f0-9]{40}$/u.test(db?.callerIdentity?.commit ?? "") &&
      /^sha256:[a-f0-9]{64}$/u.test(db?.callerIdentity?.imageDigest ?? "") &&
      db?.callerIdentity?.receiptVersion === 4 &&
      isGenerationBoundMigrationReceipt(
        db?.callerIdentity,
        db?.databaseGenerationBinding,
      ),
    "production migration caller is not the canonical database role and trusted GitHub receipt",
  );
  const callerReceiptFields = [
    "artifactDigest",
    "artifactId",
    "claimedAt",
    "commit",
    "imageDigest",
    "jobId",
    "rolloutId",
    "runAttempt",
    "runId",
    "receiptVersion",
    "recoveryWitnessSha256",
    "systemIdentifier",
    "workflowPath",
  ];
  const matchingCallerReceipts = normalizedMigrationReceipts.filter((receipt) =>
    callerReceiptFields.every(
      (key) => receipt?.[key] === db?.callerIdentity?.[key],
    ),
  );
  need(
    matchingCallerReceipts.length === 1 &&
      normalizedMigrationReceipts.filter(
        (receipt) => receipt?.rolloutId === db?.callerIdentity?.rolloutId,
      ).length === 1,
    "production migration caller must match exactly one unspliced database receipt",
  );
  verifyDatabaseAuthorization(db?.databaseAuthorization, need);
  verifyDrainObservations(
    db?.drainObservations,
    db?.databaseIdentity,
    db?.recoveryWitnessSha256,
    need,
  );
  need(
    /^17\./u.test(db?.postgresVersion ?? ""),
    "database observation is not PostgreSQL 17",
  );
  const unsafeWork = db?.unsafeWork;
  need(
    hasExactKeys(unsafeWork, [
      "activeLeasesWithoutPositiveEpoch",
      "activeManifestsWithoutPositiveEpoch",
      "pendingIntents",
      "pendingIntentsWithoutPositiveEpoch",
    ]) &&
      Object.values(unsafeWork).every(
        (value) => Number.isInteger(value) && value >= 0,
      ) &&
      Object.values(unsafeWork).reduce((sum, value) => sum + value, 0) === 0,
    "database observation has unsafe active work",
  );
  need(
    /^(?:setup-recovery|versioned-namespace-cutover):.+/u.test(
      db?.recoveryOwnerId ?? "",
    ),
    "production recovery owner identity is invalid",
  );
  const catalogManifestSource = readCheckout(
    db?.catalogManifest?.sourceFile,
    options,
  );
  need(
    hasExactKeys(db?.catalogManifest, ["sha256", "sourceFile"]) &&
      db.catalogManifest.sourceFile ===
        "scripts/codex-rotating-production-writer-schema.mjs" &&
      catalogManifestSource !== null &&
      sha256(catalogManifestSource) === db.catalogManifest.sha256,
    "database catalog manifest source digest mismatched",
  );
  need(
    JSON.stringify(db?.migrationSources?.map((entry) => entry.id)) ===
      JSON.stringify(migrations.map((entry) => entry.id)),
    "database migration sources are not the ordered combined release",
  );
  for (const migration of migrations) {
    const source = readCheckout(migration.sourceFile, options);
    const digest = source ? sha256(source) : null;
    if (migration.expectedSha256) {
      need(
        digest === migration.expectedSha256,
        `${migration.id} checked-in forward migration digest mismatched`,
      );
    }
    const observedSource = db?.migrationSources?.find(
      (entry) => entry.id === migration.id,
    );
    need(
      observedSource?.sha256 === digest,
      `${migration.id} source digest mismatched`,
    );
    const current = db?.history?.filter(
      (entry) =>
        entry.migration_name === migration.id &&
        entry.finished === true &&
        entry.current === true,
    );
    need(
      current?.length === 1,
      `${migration.id} migration history is not exactly one current success`,
    );
    need(
      current?.[0]?.checksum === digest,
      `${migration.id} migration history checksum mismatched`,
    );
    need(
      current?.[0]?.applied_steps_count === 1,
      `${migration.id} migration did not record one applied step`,
    );
  }
  need(
    equalSorted(
      db?.catalog?.tables?.map((entry) => entry.name),
      codexRotatingCatalogTables,
    ) &&
      db?.catalog?.tables?.every(
        (entry) =>
          hasExactKeys(entry, [
            "forceRowSecurity",
            "kind",
            "name",
            "persistence",
            "rowSecurity",
          ]) &&
          entry.kind === "r" &&
          entry.persistence === "p" &&
          entry.rowSecurity === false &&
          entry.forceRowSecurity === false,
      ),
    "database owned table catalog is not exact",
  );
  need(
    hasExactKeys(db?.catalog?.inventory, [
      "checks",
      "columns",
      "foreignKeys",
      "functions",
      "indexes",
      "triggers",
    ]) &&
      equalSorted(
        db?.catalog?.inventory?.columns,
        codexRotatingCatalogColumnKeys,
      ) &&
      equalSorted(
        db?.catalog?.inventory?.checks,
        codexRotatingCatalogCheckNames,
      ) &&
      equalSorted(
        db?.catalog?.inventory?.indexes,
        codexRotatingCatalogIndexNames,
      ) &&
      equalSorted(
        db?.catalog?.inventory?.foreignKeys,
        codexRotatingCatalogForeignKeyNames,
      ) &&
      equalSorted(db?.catalog?.inventory?.triggers, exactTriggers) &&
      equalSorted(db?.catalog?.inventory?.functions, exactFunctions),
    "database rotating OAuth catalog inventory is not exact",
  );
  need(
    exactCatalogColumns(db?.catalog?.columns),
    "database owned column catalog is not exact",
  );
  need(
    equalSorted(
      db?.catalog?.triggers?.map((entry) => entry.name),
      exactTriggers,
    ),
    "database trigger catalog is not exact",
  );
  need(
    db?.catalog?.triggers?.every((entry) => exactTriggerBinding(entry)),
    "database trigger bindings are not exact",
  );
  const invalidFunctionDefinitions = (db?.catalog?.functions ?? [])
    .filter((entry) => !exactFunctionDefinition(entry))
    .map((entry) => entry.name)
    .sort();
  need(
    equalSorted(
      db?.catalog?.functions?.map((entry) => entry.name),
      exactFunctions,
    ) && invalidFunctionDefinitions.length === 0,
    invalidFunctionDefinitions.length === 0
      ? "database trigger function definitions are not exact"
      : `database trigger function definitions are not exact: ${invalidFunctionDefinitions.join(", ")}`,
  );
  need(
    equalSorted(
      db?.catalog?.checks?.map((entry) => entry.name),
      exactChecks,
    ),
    "database check catalog is not exact",
  );
  need(
    db?.catalog?.checks?.every((entry) => exactCheckDefinition(entry)),
    "database check definitions/validation flags are not exact",
  );
  need(
    equalSorted(
      db?.catalog?.indexes?.map((entry) => entry.name),
      exactIndexes,
    ),
    "database index catalog is not exact",
  );
  need(
    db?.catalog?.indexes?.every((entry) => exactIndexDefinition(entry)),
    "database index definitions/flags are not exact",
  );
  need(
    equalSorted(
      db?.catalog?.foreignKeys?.map((entry) => entry.name),
      exactForeignKeys,
    ) && db?.catalog?.foreignKeys?.every(exactForeignKeyDefinition),
    "database recovery-ledger foreign keys are not exact",
  );
  need(
    equalSorted(
      db?.catalog?.primaryKeys?.map((entry) => entry.name),
      exactPrimaryKeys.map(({ name }) => name),
    ) &&
      db?.catalog?.primaryKeys?.every((entry) => {
        const expected = exactPrimaryKeys.find(
          ({ name }) => name === entry.name,
        );
        return (
          expected &&
          hasExactKeys(entry, ["definition", "name", "table", "validated"]) &&
          entry.table === expected.table &&
          entry.definition === expected.definition &&
          entry.validated === expected.validated
        );
      }),
    "database evidence primary keys are not exact",
  );
  need(
    exactFunctionCatalogAcl(db?.catalog?.privileges?.functions),
    "database owned function privileges are not exact",
  );
  need(
    exactColumnCatalogAcl(db?.catalog?.privileges?.columns),
    "database column privileges retain stale grants",
  );
  need(
    exactCatalogAcl(
      db?.catalog?.privileges?.tables,
      codexRotatingCatalogTables,
      [releaseMigrationRole, effectAuthorityRole, ...runtimeDatabaseRoles],
      null,
    ),
    "database owned table privileges are not exact",
  );
  return {
    recoveryWitnessSha256: db?.recoveryWitnessSha256,
    callerCommit: db?.callerIdentity?.commit,
    callerImageDigest: db?.callerIdentity?.imageDigest,
    callerRolloutId: db?.callerIdentity?.rolloutId,
  };
}

function exactCatalogAcl(entries, objects, grantees, fixedPrivileges) {
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        !hasExactKeys(entry, [
          "grantable",
          "grantee",
          "grantor",
          "name",
          "privilege",
        ]),
    )
  )
    return false;
  const ownerPrivileges = fixedPrivileges ?? [
    "DELETE",
    "INSERT",
    "MAINTAIN",
    "REFERENCES",
    "SELECT",
    "TRIGGER",
    "TRUNCATE",
    "UPDATE",
  ];
  const runtimePrivileges = ["INSERT", "SELECT", "UPDATE"];
  const expected = [];
  for (const name of objects) {
    for (const grantee of grantees) {
      const privileges =
        grantee === releaseMigrationRole
          ? ownerPrivileges
          : grantee === effectAuthorityRole ||
              name === "CodexOAuthDatabaseAuthorityKey" ||
              name === "CodexOAuthDatabaseAuthorityReceipt"
            ? []
            : name === "CodexOAuthChildIdentityQuarantine" ||
                name === "CodexOAuthProviderIdentityQuarantine"
              ? ["SELECT"]
              : name === "CodexOAuthProviderInstance"
                ? ["INSERT", "SELECT"]
                : runtimePrivileges;
      for (const privilege of privileges)
        expected.push({
          name,
          grantee,
          grantor: releaseMigrationRole,
          privilege,
          grantable: false,
        });
    }
  }
  const key = (entry) =>
    JSON.stringify([
      entry.name,
      entry.grantee,
      entry.grantor,
      entry.privilege,
      entry.grantable,
    ]);
  return equalSorted(entries.map(key), expected.map(key));
}

function exactColumnCatalogAcl(entries) {
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        !hasExactKeys(entry, [
          "grantable",
          "grantee",
          "grantor",
          "name",
          "privilege",
        ]),
    )
  ) {
    return false;
  }
  const expected = runtimeDatabaseRoles.flatMap((grantee) =>
    codexRotatingProviderRuntimeUpdateColumns.map((column) => ({
      name: `CodexOAuthProviderInstance.${column}`,
      grantee,
      grantor: releaseMigrationRole,
      privilege: "UPDATE",
      grantable: false,
    })),
  );
  const key = (entry) =>
    JSON.stringify([
      entry.name,
      entry.grantee,
      entry.grantor,
      entry.privilege,
      entry.grantable,
    ]);
  return equalSorted(entries.map(key), expected.map(key));
}

function exactFunctionCatalogAcl(entries) {
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        !hasExactKeys(entry, [
          "grantable",
          "grantee",
          "grantor",
          "name",
          "privilege",
        ]),
    )
  ) {
    return false;
  }
  const runtimeExecute = new Map([
    ["codex_oauth_consume_database_authority", [...runtimeDatabaseRoles]],
    ["codex_oauth_database_authority_challenge", [...runtimeDatabaseRoles]],
    ["codex_oauth_authorize_setup_confirmation", ["reviewrouter_web"]],
    ["codex_oauth_authorize_runtime_confirmation", ["reviewrouter_api"]],
    ["codex_oauth_authorize_runtime_completion", ["reviewrouter_api"]],
    ["codex_oauth_provider_identity_repair_challenge", ["reviewrouter_web"]],
    ["codex_oauth_repair_quarantined_provider", ["reviewrouter_web"]],
    ["codex_oauth_sign_database_authority", [effectAuthorityRole]],
  ]);
  const expected = exactFunctions.flatMap((name) => [
    {
      name,
      grantee: releaseMigrationRole,
      grantor: releaseMigrationRole,
      privilege: "EXECUTE",
      grantable: false,
    },
    ...(runtimeExecute.get(name) ?? []).map((grantee) => ({
      name,
      grantee,
      grantor: releaseMigrationRole,
      privilege: "EXECUTE",
      grantable: false,
    })),
  ]);
  const key = (entry) =>
    JSON.stringify([
      entry.name,
      entry.grantee,
      entry.grantor,
      entry.privilege,
      entry.grantable,
    ]);
  return equalSorted(entries.map(key), expected.map(key));
}

export function verifyCodexRotatingDatabaseCatalog(
  catalog,
  { verifyPrivileges = true } = {},
) {
  const catalogMessages = new Set([
    "database owned table catalog is not exact",
    "database rotating OAuth catalog inventory is not exact",
    "database owned column catalog is not exact",
    "database trigger catalog is not exact",
    "database trigger bindings are not exact",
    "database trigger function definitions are not exact",
    "database check catalog is not exact",
    "database check definitions/validation flags are not exact",
    "database index catalog is not exact",
    "database index definitions/flags are not exact",
    "database recovery-ledger foreign keys are not exact",
    "database evidence primary keys are not exact",
    "database owned function privileges are not exact",
    "database owned table privileges are not exact",
  ]);
  const failures = [];
  verifyDatabase(
    { catalog },
    {},
    (condition, message) => {
      if (catalogMessages.has(message) && !condition) failures.push(message);
    },
    {},
  );
  if (!verifyPrivileges) {
    const structuralFailures = failures.filter(
      (failure) =>
        failure !== "database owned function privileges are not exact" &&
        failure !== "database owned table privileges are not exact",
    );
    return {
      ok: structuralFailures.length === 0,
      failures: structuralFailures,
    };
  }
  return { ok: failures.length === 0, failures };
}

function verifyDatabaseAuthorization(authorization, need) {
  const releaseRole = codexRotatingDatabaseRoles.releaseMigration;
  const bootstrapRole = "reviewrouter_role_bootstrap";
  const expectedRoleNames = [
    releaseRole,
    codexRotatingDatabaseRoles.effectAuthority,
    ...codexRotatingDatabaseRoles.runtime,
  ];
  const expectedBootstrapMembershipRoles = [...expectedRoleNames].sort();
  const roles = authorization?.roles ?? [];
  const membershipGrantors = new Set(
    Array.isArray(authorization?.memberships)
      ? authorization.memberships.map((entry) => entry.grantor)
      : [],
  );
  need(
    hasExactKeys(authorization, [
      "databaseOwner",
      "memberships",
      "nonReleaseOwnedCatalogObjects",
      "nonReleaseOwnedFunctions",
      "releaseRoleSettableByLoginRoles",
      "roles",
      "schemaOwner",
    ]) &&
      authorization.databaseOwner === bootstrapRole &&
      authorization.schemaOwner === releaseRole &&
      equalSorted(
        roles.map((entry) => entry.name),
        expectedRoleNames,
      ),
    "database bootstrap ownership, schema DDL ownership, and canonical role inventory are not exclusive",
  );
  need(
    roles.every((entry) => {
      if (
        !hasExactKeys(entry, [
          "bypassRls",
          "allSequenceUsage",
          "anySequenceSelectOrUpdate",
          "authorityTablePrivileges",
          "canLogin",
          "canSetReleaseRole",
          "createDatabase",
          "createRole",
          "databaseCreate",
          "ddlTablePrivileges",
          "migrationHistoryPrivileges",
          "name",
          "ownsCatalogObject",
          "ownsRepositoryConnection",
          "providerSetupStateDelete",
          "providerSetupStateInsert",
          "providerSetupStateSelect",
          "providerSetupStateUpdate",
          "replication",
          "repositoryConnectionDelete",
          "repositoryConnectionColumnInsert",
          "repositoryConnectionColumnReferences",
          "repositoryConnectionColumnSelect",
          "repositoryConnectionColumnUpdate",
          "repositoryConnectionInsert",
          "repositoryConnectionSelect",
          "repositoryConnectionUpdate",
          "schemaCreate",
          "schemaUsage",
          "superuser",
        ]) ||
        entry.canLogin !== true ||
        entry.superuser !== false ||
        entry.createDatabase !== false ||
        entry.createRole !== false ||
        entry.replication !== false ||
        entry.bypassRls !== false ||
        entry.schemaUsage !== true
      ) {
        return false;
      }
      const isRelease = entry.name === releaseRole;
      const isRuntime = runtimeDatabaseRoles.includes(entry.name);
      const isEffectAuthority = entry.name === effectAuthorityRole;
      const columnPrivilegeArraysAreValid =
        Array.isArray(entry.repositoryConnectionColumnSelect) &&
        Array.isArray(entry.repositoryConnectionColumnInsert) &&
        Array.isArray(entry.repositoryConnectionColumnUpdate) &&
        Array.isArray(entry.repositoryConnectionColumnReferences);
      const releaseColumnsAreFull =
        columnPrivilegeArraysAreValid &&
        entry.repositoryConnectionColumnSelect.length > 0 &&
        equalSorted(
          entry.repositoryConnectionColumnInsert,
          entry.repositoryConnectionColumnSelect,
        ) &&
        equalSorted(
          entry.repositoryConnectionColumnUpdate,
          entry.repositoryConnectionColumnSelect,
        ) &&
        equalSorted(
          entry.repositoryConnectionColumnReferences,
          entry.repositoryConnectionColumnSelect,
        );
      const runtimeColumnsAreSelectOnly =
        columnPrivilegeArraysAreValid &&
        entry.repositoryConnectionColumnSelect.length > 0 &&
        entry.repositoryConnectionColumnInsert.length === 0 &&
        entry.repositoryConnectionColumnUpdate.length === 0 &&
        entry.repositoryConnectionColumnReferences.length === 0;
      const effectColumnsAreEmpty =
        isEffectAuthority &&
        columnPrivilegeArraysAreValid &&
        entry.repositoryConnectionColumnSelect.length === 0 &&
        entry.repositoryConnectionColumnInsert.length === 0 &&
        entry.repositoryConnectionColumnUpdate.length === 0 &&
        entry.repositoryConnectionColumnReferences.length === 0;
      return (
        entry.databaseCreate === isRelease &&
        entry.schemaCreate === isRelease &&
        entry.canSetReleaseRole === isRelease &&
        entry.ownsCatalogObject === isRelease &&
        entry.ownsRepositoryConnection === isRelease &&
        entry.ddlTablePrivileges === isRelease &&
        entry.migrationHistoryPrivileges === isRelease &&
        entry.providerSetupStateSelect === (isRelease || isRuntime) &&
        entry.providerSetupStateInsert === (isRelease || isRuntime) &&
        entry.providerSetupStateUpdate === (isRelease || isRuntime) &&
        entry.providerSetupStateDelete === (isRelease || isRuntime) &&
        entry.allSequenceUsage === (isRelease || isRuntime) &&
        entry.anySequenceSelectOrUpdate === isRelease &&
        entry.authorityTablePrivileges === isRelease &&
        entry.repositoryConnectionSelect === (isRelease || isRuntime) &&
        entry.repositoryConnectionInsert === isRelease &&
        entry.repositoryConnectionUpdate === isRelease &&
        entry.repositoryConnectionDelete === isRelease &&
        (isRelease
          ? releaseColumnsAreFull
          : isRuntime
            ? runtimeColumnsAreSelectOnly
            : effectColumnsAreEmpty)
      );
    }) &&
      Array.isArray(authorization?.memberships) &&
      authorization.memberships.length ===
        expectedBootstrapMembershipRoles.length &&
      JSON.stringify(
        authorization.memberships.map((entry) => entry.role).sort(),
      ) === JSON.stringify(expectedBootstrapMembershipRoles) &&
      authorization.memberships.every(
        (entry) =>
          hasExactKeys(entry, [
            "adminOption",
            "grantor",
            "inheritOption",
            "member",
            "role",
            "setOption",
          ]) &&
          entry.member === bootstrapRole &&
          entry.grantor !== bootstrapRole &&
          !expectedRoleNames.includes(entry.grantor) &&
          entry.adminOption === true &&
          entry.inheritOption === false &&
          entry.setOption === false,
      ) &&
      membershipGrantors.size === 1 &&
      JSON.stringify(authorization?.releaseRoleSettableByLoginRoles) ===
        JSON.stringify([releaseRole]) &&
      Array.isArray(authorization?.nonReleaseOwnedCatalogObjects) &&
      authorization.nonReleaseOwnedCatalogObjects.length === 0 &&
      Array.isArray(authorization?.nonReleaseOwnedFunctions) &&
      authorization.nonReleaseOwnedFunctions.length === 0,
    "runtime database roles can perform DDL or assume the release-migration role",
  );
}

function exactCatalogColumns(columns) {
  if (
    !Array.isArray(columns) ||
    columns.length !== codexRotatingCatalogColumns.length
  ) {
    return false;
  }
  const actual = new Map(
    columns.map((entry) => [catalogColumnKey(entry), entry]),
  );
  if (actual.size !== columns.length) return false;
  return codexRotatingCatalogColumns.every((expected) => {
    const entry = actual.get(catalogColumnKey(expected));
    return (
      hasExactKeys(entry, [
        "defaultExpression",
        "generated",
        "identity",
        "name",
        "nullable",
        "ordinal",
        "table",
        "type",
      ]) &&
      entry.table === expected.table &&
      entry.name === expected.name &&
      Number.isInteger(entry.ordinal) &&
      entry.ordinal > 0 &&
      entry.type === expected.type &&
      entry.nullable === expected.nullable &&
      normalizeCatalogDefault(entry.defaultExpression) ===
        normalizeCatalogDefault(expected.defaultExpression) &&
      entry.identity === "" &&
      entry.generated === ""
    );
  });
}

function normalizeCatalogDefault(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/::(?:bigint|integer|boolean)\b/giu, "")
    .replace(/^\((.*)\)$/u, "$1")
    .trim()
    .toUpperCase();
}

function exactForeignKeyDefinition(entry) {
  const expected = exactForeignKeyByName.get(entry?.name);
  return (
    expected !== undefined &&
    hasExactKeys(entry, ["definition", "name", "table", "validated"]) &&
    entry.table === expected.table &&
    entry.definition === expected.definition &&
    entry.validated === true
  );
}

function verifyDrainObservations(
  observations,
  databaseIdentity,
  recoveryWitnessSha256,
  need,
) {
  need(
    Array.isArray(observations) && observations.length === 2,
    "exactly two production drain observations are required",
  );
  if (!Array.isArray(observations) || observations.length !== 2) return;
  need(
    observations.every(
      (entry) =>
        hasExactKeys(entry, [
          "activeLeases",
          "databaseIdentity",
          "fetchedSetups",
          "isWriter",
          "observedAt",
          "pendingIntents",
          "recoveryWitnessSha256",
          "writerInFlight",
        ]) &&
        [
          entry.activeLeases,
          entry.fetchedSetups,
          entry.pendingIntents,
          entry.writerInFlight,
        ].every((value) => value === 0) &&
        Number.isFinite(Date.parse(entry.observedAt ?? "")),
    ) &&
      Date.parse(observations[1].observedAt) >
        Date.parse(observations[0].observedAt),
    "production in-flight barrier was not stably zero across two observations",
  );
  need(
    databaseIdentity &&
      Object.keys(databaseIdentity).length === 4 &&
      /^[a-f0-9]{64}$/u.test(recoveryWitnessSha256 ?? "") &&
      observations.every(
        (entry) =>
          entry.isWriter === true &&
          JSON.stringify(entry.databaseIdentity) ===
            JSON.stringify(databaseIdentity) &&
          entry.recoveryWitnessSha256 === recoveryWitnessSha256,
      ),
    "drain observations are not bound to one database incarnation and recovery witness",
  );
}

function exactTriggerBinding(entry) {
  const bindings = {
    CodexOAuthChildIdentityQuarantine_cascade_guard: [
      "CodexOAuthChildIdentityQuarantine",
      "codex_oauth_runtime_referential_action_guard",
      11,
    ],
    CodexOAuthDatabaseAuthorityReceipt_one_shot_guard: [
      "CodexOAuthDatabaseAuthorityReceipt",
      "codex_oauth_database_authority_receipt_guard",
      27,
    ],
    CodexOAuthProviderInstance_identity_guard: [
      "CodexOAuthProviderInstance",
      "codex_oauth_provider_identity_guard",
      23,
    ],
    CodexOAuthProviderInstance_mutation_transition_guard: [
      "CodexOAuthProviderInstance",
      "codex_oauth_provider_mutation_transition_guard",
      19,
    ],
    CodexOAuthSetupManifest_identity_fence_guard: [
      "CodexOAuthSetupManifest",
      "codex_oauth_child_identity_fence_guard",
      23,
    ],
    CodexOAuthSetupManifest_evidence_guard: [
      "CodexOAuthSetupManifest",
      "codex_oauth_setup_manifest_evidence_guard",
      31,
    ],
    CodexOAuthSecretNamespace_tombstone_guard: [
      "CodexOAuthSecretNamespace",
      "codex_oauth_secret_namespace_tombstone_guard",
      31,
    ],
    CodexOAuthSetupPayloadClaim_evidence_guard: [
      "CodexOAuthSetupPayloadClaim",
      "codex_oauth_setup_claim_evidence_guard",
      31,
    ],
    CodexOAuthSetupDispatchAttempt_evidence_guard: [
      "CodexOAuthSetupDispatchAttempt",
      "codex_oauth_setup_attempt_evidence_guard",
      31,
    ],
    CodexOAuthSetupRecoveryRequest_evidence_guard: [
      "CodexOAuthSetupRecoveryRequest",
      "codex_oauth_setup_recovery_evidence_guard",
      31,
    ],
    CodexOAuthLease_identity_fence_guard: [
      "CodexOAuthLease",
      "codex_oauth_child_identity_fence_guard",
      23,
    ],
    CodexOAuthLease_cascade_guard: [
      "CodexOAuthLease",
      "codex_oauth_runtime_referential_action_guard",
      11,
    ],
    CodexOAuthProviderIdentityQuarantine_cascade_guard: [
      "CodexOAuthProviderIdentityQuarantine",
      "codex_oauth_runtime_referential_action_guard",
      11,
    ],
    CodexOAuthProviderInstance_cascade_guard: [
      "CodexOAuthProviderInstance",
      "codex_oauth_runtime_referential_action_guard",
      11,
    ],
    CodexOAuthSecretNamespace_cascade_guard: [
      "CodexOAuthSecretNamespace",
      "codex_oauth_runtime_referential_action_guard",
      11,
    ],
    CodexOAuthSetupDispatchAttempt_cascade_guard: [
      "CodexOAuthSetupDispatchAttempt",
      "codex_oauth_runtime_referential_action_guard",
      11,
    ],
    CodexOAuthSetupManifest_cascade_guard: [
      "CodexOAuthSetupManifest",
      "codex_oauth_runtime_referential_action_guard",
      11,
    ],
    CodexOAuthSetupPayloadClaim_cascade_guard: [
      "CodexOAuthSetupPayloadClaim",
      "codex_oauth_runtime_referential_action_guard",
      11,
    ],
    CodexOAuthSetupRecoveryRequest_cascade_guard: [
      "CodexOAuthSetupRecoveryRequest",
      "codex_oauth_runtime_referential_action_guard",
      11,
    ],
    CodexOAuthWritebackIntent_cascade_guard: [
      "CodexOAuthWritebackIntent",
      "codex_oauth_runtime_referential_action_guard",
      11,
    ],
    CodexOAuthWritebackIntent_identity_fence_guard: [
      "CodexOAuthWritebackIntent",
      "codex_oauth_child_identity_fence_guard",
      23,
    ],
    CodexOAuthWritebackIntent_runtime_evidence_guard: [
      "CodexOAuthWritebackIntent",
      "codex_oauth_runtime_writeback_evidence_guard",
      31,
    ],
    RepositoryConnection_codex_oauth_identity_guard: [
      "RepositoryConnection",
      "codex_oauth_repository_identity_guard",
      17,
    ],
    RepositoryConnection_runtime_referential_action_guard: [
      "RepositoryConnection",
      "codex_oauth_runtime_referential_action_guard",
      27,
    ],
  };
  return (
    hasExactKeys(entry, ["enabled", "function", "name", "table", "type"]) &&
    entry.enabled === "O" &&
    JSON.stringify([entry.table, entry.function, entry.type]) ===
      JSON.stringify(bindings[entry.name])
  );
}
function exactFunctionDefinition(entry) {
  const bodySha256 = exactFunctionBodyDigestByName.get(entry?.name);
  const expectedArguments =
    {
      codex_oauth_authorize_runtime_completion:
        "target_intent_id text, target_signature text",
      codex_oauth_authorize_runtime_confirmation:
        "target_intent_id text, target_executor_owner text, target_response_code integer, target_signature text",
      codex_oauth_authorize_setup_confirmation:
        "target_attempt_id text, target_response_code integer, target_signature text",
      codex_oauth_consume_database_authority:
        "target_effect text, target_owner_id text, target_effect_code integer",
      codex_oauth_database_authority_challenge:
        "target_effect text, target_owner_id text, target_effect_code integer",
      codex_oauth_provider_identity_transition:
        "provider_row_id text, old_workspace_id text, old_repository_id text, old_provider_instance_id text, old_auth_mode text, old_secret_name text, new_workspace_id text, new_repository_id text, new_provider_instance_id text, new_auth_mode text, new_secret_name text",
      codex_oauth_provider_identity_repair_challenge:
        "provider_row_id text, old_workspace_id text, old_repository_id text, old_provider_instance_id text, old_auth_mode text, old_secret_name text, old_repository_provider text, old_github_repository_id bigint, old_external_repository_id text, new_workspace_id text, new_repository_id text, new_provider_instance_id text, new_auth_mode text, new_secret_name text, new_github_repository_id bigint",
      codex_oauth_sign_database_authority: "target_challenge text",
      codex_oauth_repair_quarantined_child:
        "target_kind text, target_id text, replacement_lease_id text DEFAULT NULL::text",
      codex_oauth_repair_quarantined_provider:
        "provider_row_id text, old_workspace_id text, old_repository_id text, old_provider_instance_id text, old_auth_mode text, old_secret_name text, old_repository_provider text, old_github_repository_id bigint, old_external_repository_id text, new_workspace_id text, new_repository_id text, new_provider_instance_id text, new_auth_mode text, new_secret_name text, new_github_repository_id bigint, target_signature text",
    }[entry?.name] ?? "";
  const expectedResult = entry?.name?.startsWith("codex_oauth_authorize_")
    ? "void"
    : entry?.name === "codex_oauth_consume_database_authority"
      ? "boolean"
      : entry?.name === "codex_oauth_database_authority_challenge" ||
          entry?.name === "codex_oauth_sign_database_authority" ||
          entry?.name === "codex_oauth_provider_identity_transition" ||
          entry?.name === "codex_oauth_provider_identity_repair_challenge"
        ? "text"
        : entry?.name?.includes("repair")
          ? "void"
          : "trigger";
  const securityDefinerFunction =
    entry?.name?.startsWith("codex_oauth_authorize_") ||
    entry?.name === "codex_oauth_consume_database_authority" ||
    entry?.name === "codex_oauth_sign_database_authority" ||
    entry?.name === "codex_oauth_provider_identity_repair_challenge" ||
    entry?.name === "codex_oauth_provider_identity_guard" ||
    entry?.name === "codex_oauth_runtime_referential_action_guard" ||
    entry?.name === "codex_oauth_repair_quarantined_provider";
  const fixedSearchPathFunction =
    securityDefinerFunction ||
    entry?.name === "codex_oauth_database_authority_challenge" ||
    entry?.name === "codex_oauth_database_authority_receipt_guard" ||
    entry?.name === "codex_oauth_provider_identity_transition" ||
    entry?.name === "codex_oauth_provider_identity_repair_challenge";
  return (
    typeof bodySha256 === "string" &&
    hasExactKeys(entry, [
      "arguments",
      "bodySha256",
      "config",
      "language",
      "leakproof",
      "name",
      "owner",
      "parallel",
      "procost",
      "prokind",
      "prorows",
      "proretset",
      "prosupport",
      "resultType",
      "securityDefiner",
      "strict",
      "volatility",
    ]) &&
    entry?.securityDefiner === securityDefinerFunction &&
    entry.owner === releaseMigrationRole &&
    entry.prokind === "f" &&
    entry.proretset === false &&
    entry.prosupport === null &&
    entry.procost === 100 &&
    entry.prorows === 0 &&
    JSON.stringify(entry?.config) ===
      JSON.stringify(
        fixedSearchPathFunction ? ["search_path=pg_catalog, public"] : null,
      ) &&
    entry.language === "plpgsql" &&
    entry.volatility === "v" &&
    entry.parallel === "u" &&
    entry.leakproof === false &&
    entry.strict === false &&
    entry.resultType === expectedResult &&
    entry.arguments === expectedArguments &&
    entry.bodySha256 === bodySha256
  );
}
function exactCheckDefinition(entry) {
  const canonical = exactCheckDefinitionByName.get(entry?.name);
  const expectedTable = entry?.name?.split("_", 1)[0];
  const tokens = {
    CodexOAuthDatabaseAuthorityKey_singleton_check: ["singleton"],
    CodexOAuthLease_pullRequestNumber_check: ["pullRequestNumber"],
    CodexOAuthProviderInstance_mutation_fence_check: [
      "mutationEpoch",
      "mutationOwner",
      "mutationOwnerId",
      "runtime",
      "setup",
      "recovery",
    ],
    CodexOAuthSetupManifest_epoch_check: [
      "status",
      "issued",
      "fetched",
      "mutationEpoch",
    ],
    CodexOAuthLease_epoch_check: [
      "status",
      "preleased",
      "finalized",
      "mutationEpoch",
    ],
    CodexOAuthWritebackIntent_epoch_check: [
      "status",
      "pending",
      "mutationEpoch",
    ],
    CodexOAuthSetupRecoveryRequest_epoch_check: ["mutationEpoch"],
    CodexOAuthSetupRecoveryRequest_contract_check: [
      "forced_reseed",
      "forced_reseed_account_switch",
      "account_switch_is_intended",
      "manifest_issued",
      "completed",
    ],
    CodexOAuthSetupRecoveryRequest_database_recovery_witness_check: [
      "databaseRecoveryWitness",
    ],
    CodexOAuthSetupManifest_payload_claim_complete_check: [
      "payloadVersion",
      "payloadGenerationHash",
      "payloadAccountFingerprint",
      "payloadByteSize",
      "payloadClaimedAt",
    ],
    CodexOAuthSetupManifest_recovery_expiry_check: [
      "recoveryExpiresAt",
      "lastFetchedAt",
    ],
    CodexOAuthSetupManifest_database_recovery_witness_check: [
      "databaseRecoveryWitness",
    ],
    CodexOAuthSetupPayloadClaim_payload_check: [
      "payloadVersion",
      "canonicalizationVersion",
      "accountIdentityAlgorithm",
      "databaseRecoveryWitness",
      "prepared",
      "retired_confirmed",
      "retired_active",
    ],
    CodexOAuthSecretNamespace_lifecycle_check: [
      "retired_ambiguous",
      "permanentlyRetired",
      "workflowSourceCommitSha",
      "workflowSourceBlobSha",
      "workflowSemanticSha256",
      "trusted_default_branch_revision",
      "attestedRepositoryId",
    ],
    CodexOAuthSecretNamespace_name_check: [
      "secretName",
      "REVIEWROUTER_CODEX_AUTH_JSON_R",
    ],
    CodexOAuthSecretNamespace_recovery_witness_check: [
      "databaseRecoveryWitness",
    ],
    CodexOAuthSetupDispatchAttempt_lifecycle_check: [
      "dispatch_authorized",
      "retired_ambiguous",
      "retired_confirmed",
      "definiteResponseCode",
    ],
    CodexOAuthProviderInstance_active_namespace_pair_check: [
      "activeSecretNamespaceId",
      "activeSecretNamespaceEpoch",
      "activeSecretNamespaceName",
    ],
    CodexOAuthLease_secret_namespace_pair_check: [
      "secretNamespaceId",
      "secretNamespaceEpoch",
    ],
    CodexOAuthWritebackIntent_versioned_dispatch_check: [
      "dispatchAttemptId",
      "secretNamespaceId",
      "dispatchAuthorizedAt",
    ],
    CodexOAuthWritebackIntent_executor_lease_check: [
      "dispatchAttemptId",
      "executorOwner",
      "executorLeaseExpiresAt",
      "dispatchAuthorizedAt",
    ],
    CodexOAuthWritebackIntent_provider_response_check: [
      "providerResponseCode",
      "201",
      "204",
    ],
    CodexOAuthWritebackIntent_database_incarnation_check: [
      "databaseIncarnation",
    ],
    CodexOAuthWritebackIntent_database_recovery_witness_check: [
      "databaseRecoveryWitness",
    ],
    CodexOAuthWritebackIntent_account_identity_check: [
      "accountIdentityHash",
      "accountIdentityAlgorithm",
      "provider_issuer_subject_account_v1",
    ],
    CodexOAuthWritebackIntent_recovery_resolution_check: [
      "recoveryRequestRowId",
      "recoveryResolvedAt",
    ],
  }[entry?.name];
  const expectedValidated =
    entry?.name === "CodexOAuthSetupRecoveryRequest_epoch_check" ||
    !entry?.name?.endsWith("_epoch_check");
  return (
    Array.isArray(tokens) &&
    canonical !== undefined &&
    hasExactKeys(entry, [
      "definition",
      "definitionSha256",
      "name",
      "table",
      "validated",
    ]) &&
    entry.table === expectedTable &&
    entry?.validated === expectedValidated &&
    entry.validated === canonical.validated &&
    entry.definitionSha256 === canonical.definitionSha256
  );
}
function exactIndexDefinition(entry) {
  const expectedDefinitionSha256 = exactIndexDefinitionDigestByName.get(
    entry?.name,
  );
  const expectedPredicateSha256 =
    exactPartialIndexPredicateDigestByName.get(entry?.name) ?? null;
  const keys = {
    CodexOAuthLease_expiresAt_idx: ["expiresAt"],
    CodexOAuthLease_leaseKey_key: ["leaseKey"],
    CodexOAuthLease_providerInstanceId_status_idx: [
      "providerInstanceId",
      "status",
    ],
    CodexOAuthLease_repositoryId_status_idx: ["repositoryId", "status"],
    CodexOAuthLease_workspaceId_status_idx: ["workspaceId", "status"],
    CodexOAuthProviderInstance_activeLeaseExpiresAt_idx: [
      "activeLeaseExpiresAt",
    ],
    CodexOAuthProviderInstance_providerInstanceId_key: ["providerInstanceId"],
    CodexOAuthProviderInstance_repositoryId_authMode_key: [
      "repositoryId",
      "authMode",
    ],
    CodexOAuthProviderInstance_repositoryId_state_idx: [
      "repositoryId",
      "state",
    ],
    CodexOAuthProviderInstance_workspaceId_state_idx: ["workspaceId", "state"],
    CodexOAuthSetupManifest_expiresAt_idx: ["expiresAt"],
    CodexOAuthSetupManifest_providerInstanceId_status_idx: [
      "providerInstanceId",
      "status",
    ],
    CodexOAuthSetupManifest_repositoryId_status_idx: ["repositoryId", "status"],
    CodexOAuthSetupManifest_setupNonce_key: ["setupNonce"],
    CodexOAuthWritebackIntent_leaseId_status_idx: ["leaseId", "status"],
    CodexOAuthWritebackIntent_providerInstanceId_status_idx: [
      "providerInstanceId",
      "status",
    ],
    CodexOAuthWritebackIntent_providerInstanceId_idempotencyKey_key: [
      "providerInstanceId",
      "idempotencyKey",
    ],
    CodexOAuthSetupManifest_one_active_provider_key: ["providerInstanceRowId"],
    CodexOAuthProviderInstance_mutation_owner_idx: [
      "mutationOwner",
      "mutationEpoch",
    ],
    CodexOAuthSetupManifest_provider_epoch_idx: [
      "providerInstanceRowId",
      "mutationEpoch",
    ],
    CodexOAuthLease_provider_epoch_idx: [
      "providerInstanceRowId",
      "mutationEpoch",
    ],
    CodexOAuthWritebackIntent_provider_epoch_idx: [
      "providerInstanceRowId",
      "mutationEpoch",
    ],
    CodexOAuthChildIdentityQuarantine_provider_idx: [
      "providerInstanceRowId",
      "resolvedAt",
    ],
    CodexOAuthSetupRecoveryRequest_provider_request_key: [
      "providerInstanceRowId",
      "recoveryRequestId",
    ],
    CodexOAuthSetupRecoveryRequest_latestManifestId_key: ["latestManifestId"],
    CodexOAuthSetupRecoveryRequest_provider_state_idx: [
      "providerInstanceRowId",
      "state",
    ],
    CodexOAuthSetupRecoveryRequest_one_active_provider_key: [
      "providerInstanceRowId",
    ],
    CodexOAuthSetupManifest_recovery_expiry_idx: [
      "status",
      "recoveryExpiresAt",
    ],
    CodexOAuthSetupPayloadClaim_provider_operation_key: [
      "providerInstanceRowId",
      "operationId",
    ],
    CodexOAuthSetupPayloadClaim_provider_epoch_key: [
      "providerInstanceRowId",
      "recoveryEpoch",
    ],
    CodexOAuthSetupPayloadClaim_confirmedAttemptId_key: ["confirmedAttemptId"],
    CodexOAuthSetupPayloadClaim_one_active_per_provider_key: [
      "providerInstanceRowId",
    ],
    CodexOAuthSetupPayloadClaim_provider_status_idx: [
      "providerInstanceRowId",
      "status",
    ],
    CodexOAuthSecretNamespace_secretName_key: ["secretName"],
    CodexOAuthSecretNamespace_provider_epoch_key: [
      "providerInstanceRowId",
      "namespaceEpoch",
    ],
    CodexOAuthSecretNamespace_provider_status_idx: [
      "providerInstanceRowId",
      "status",
    ],
    CodexOAuthSecretNamespace_id_epoch_key: ["id", "namespaceEpoch"],
    CodexOAuthSecretNamespace_id_epoch_name_key: [
      "id",
      "namespaceEpoch",
      "secretName",
    ],
    CodexOAuthSecretNamespace_provider_id_key: ["providerInstanceRowId", "id"],
    CodexOAuthSetupDispatchAttempt_namespaceId_key: ["namespaceId"],
    CodexOAuthSetupDispatchAttempt_claim_idempotency_key: [
      "claimId",
      "idempotencyKey",
    ],
    CodexOAuthSetupDispatchAttempt_claim_ordinal_key: ["claimId", "ordinal"],
    CodexOAuthSetupDispatchAttempt_claim_status_idx: ["claimId", "status"],
    CodexOAuthProviderInstance_activeSecretNamespaceId_key: [
      "activeSecretNamespaceId",
    ],
    CodexOAuthWritebackIntent_dispatchAttemptId_key: ["dispatchAttemptId"],
    CodexOAuthWritebackIntent_secretNamespaceId_idx: ["secretNamespaceId"],
    CodexOAuthWritebackIntent_versioned_lease_key: ["leaseId"],
  }[entry?.name];
  const predicateTokens = {
    CodexOAuthSetupManifest_one_active_provider_key: [
      "status",
      "issued",
      "fetched",
    ],
    CodexOAuthSetupRecoveryRequest_one_active_provider_key: [
      "state",
      "active",
      "manifest_issued",
    ],
    CodexOAuthSetupPayloadClaim_one_active_per_provider_key: [
      "status",
      "active",
    ],
    CodexOAuthWritebackIntent_versioned_lease_key: [
      "databaseIncarnation",
      "IS NOT NULL",
    ],
  }[entry?.name];
  const expectedOpclasses = keys?.map((key) =>
    ["mutationEpoch", "recoveryEpoch", "namespaceEpoch"].includes(key)
      ? "int8_ops"
      : key === "ordinal"
        ? "int4_ops"
        : ["resolvedAt", "expiresAt", "activeLeaseExpiresAt"].includes(key)
          ? "timestamp_ops"
          : key === "recoveryExpiresAt"
            ? "timestamptz_ops"
            : "text_ops",
  );
  return (
    Array.isArray(keys) &&
    hasExactKeys(entry, [
      "definition",
      "definitionSha256",
      "includeCount",
      "keyCount",
      "keys",
      "method",
      "name",
      "opclasses",
      "options",
      "predicate",
      "predicateSha256",
      "ready",
      "unique",
      "valid",
    ]) &&
    entry?.valid === true &&
    entry?.ready === true &&
    entry.method === "btree" &&
    entry.keyCount === keys.length &&
    entry.includeCount === 0 &&
    JSON.stringify(entry.keys) === JSON.stringify(keys) &&
    JSON.stringify(entry.opclasses) === JSON.stringify(expectedOpclasses) &&
    JSON.stringify(entry.options) === JSON.stringify(keys.map(() => 0)) &&
    entry?.unique ===
      [
        "CodexOAuthSetupManifest_one_active_provider_key",
        "CodexOAuthSetupRecoveryRequest_provider_request_key",
        "CodexOAuthSetupRecoveryRequest_latestManifestId_key",
        "CodexOAuthSetupRecoveryRequest_one_active_provider_key",
        "CodexOAuthSetupPayloadClaim_one_active_per_provider_key",
        "CodexOAuthSetupPayloadClaim_provider_operation_key",
        "CodexOAuthSetupPayloadClaim_provider_epoch_key",
        "CodexOAuthSetupPayloadClaim_confirmedAttemptId_key",
        "CodexOAuthSecretNamespace_secretName_key",
        "CodexOAuthSecretNamespace_provider_epoch_key",
        "CodexOAuthSecretNamespace_id_epoch_key",
        "CodexOAuthSecretNamespace_id_epoch_name_key",
        "CodexOAuthSecretNamespace_provider_id_key",
        "CodexOAuthSetupDispatchAttempt_namespaceId_key",
        "CodexOAuthSetupDispatchAttempt_claim_idempotency_key",
        "CodexOAuthSetupDispatchAttempt_claim_ordinal_key",
        "CodexOAuthProviderInstance_activeSecretNamespaceId_key",
        "CodexOAuthWritebackIntent_dispatchAttemptId_key",
        "CodexOAuthWritebackIntent_versioned_lease_key",
        "CodexOAuthLease_leaseKey_key",
        "CodexOAuthProviderInstance_providerInstanceId_key",
        "CodexOAuthProviderInstance_repositoryId_authMode_key",
        "CodexOAuthSetupManifest_setupNonce_key",
        "CodexOAuthWritebackIntent_providerInstanceId_idempotencyKey_key",
      ].includes(entry?.name) &&
    typeof expectedDefinitionSha256 === "string" &&
    entry.definitionSha256 === expectedDefinitionSha256 &&
    entry.predicateSha256 === expectedPredicateSha256 &&
    (predicateTokens ? entry?.predicate.length > 0 : entry?.predicate === "") &&
    keys.every((key) =>
      `${entry?.definition} ${entry?.predicate}`.includes(key),
    )
  );
}

function verifyProviderCapture(
  observation,
  descriptor,
  provider,
  need,
  options,
) {
  const source = readCheckout(descriptor?.sourceFile, options);
  need(
    descriptor?.sourceFile ===
      "scripts/codex-rotating-provider-provenance.mjs" &&
      source !== null &&
      sha256(source) === descriptor?.sourceFileSha256,
    `${provider} provider capture executable source digest mismatched`,
  );
  const raw = observation?.rawResponses;
  const host = provider === "Render" ? "api.render.com" : "api.github.com";
  const rawValid =
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((entry) => {
      let url;
      try {
        url = new URL(entry?.url);
      } catch {
        return false;
      }
      return (
        (hasExactKeys(entry, ["body", "bodySha256", "status", "url"]) ||
          hasExactKeys(entry, [
            "body",
            "bodySha256",
            "nextUrl",
            "status",
            "url",
          ])) &&
        url.protocol === "https:" &&
        url.hostname === host &&
        entry.status === 200 &&
        entry.bodySha256 === sha256Utf8(canonicalJson(entry.body).trimEnd())
      );
    });
  need(
    rawValid &&
      observation?.captureIdentity?.authenticated === true &&
      observation.captureIdentity.apiHost === host &&
      Number.isFinite(
        Date.parse(observation.captureIdentity.observedAt ?? ""),
      ) &&
      observation.captureIdentity.rawResponsesSha256 ===
        sha256Utf8(canonicalJson(raw).trimEnd()),
    `${provider} evidence lacks an authenticated immutable capture identity`,
  );
  return rawValid ? canonicalJson(raw) : "";
}

function verifyDeployments(observation, descriptor, need, options) {
  verifyProviderCapture(observation, descriptor, "Render", need, options);
  const rawResponses = observation?.rawResponses ?? [];
  need(
    observation?.observationVersion === 3 &&
      observation?.source === "render-api" &&
      hasExactKeys(observation, [
        "observationVersion",
        "source",
        "captureIdentity",
        "rawResponses",
        "database",
        "services",
        "runtimeWitness",
      ]) &&
      hasExactKeys(observation.captureIdentity, [
        "ownerId",
        "ownerName",
        "apiHost",
        "authenticated",
        "observedAt",
        "rawResponsesSha256",
      ]),
    "deployments must be captured from the Render API",
  );
  const services = observation?.services ?? [];
  need(
    hasExactKeys(observation?.database, ["id", "name", "ownerId", "version"]) &&
      /^dpg-[A-Za-z0-9_-]+$/u.test(observation.database.id ?? "") &&
      observation.database.name === "reviewrouter-db" &&
      /^17(?:\.|$)/u.test(observation.database.version ?? ""),
    "Render database observation is not PostgreSQL 17",
  );
  need(
    observation?.database?.ownerId === observation?.captureIdentity?.ownerId &&
      rawResponses.some(
        (response) =>
          response?.url ===
            `https://api.render.com/v1/owners/${encodeURIComponent(observation?.captureIdentity?.ownerId ?? "")}` &&
          response?.body?.id === observation?.captureIdentity?.ownerId &&
          response?.body?.name === observation?.captureIdentity?.ownerName,
      ) &&
      rawResponses.some(
        (response) =>
          response?.url ===
            `https://api.render.com/v1/postgres/${encodeURIComponent(observation?.database?.id ?? "")}` &&
          response?.body?.id === observation?.database?.id &&
          response?.body?.name === observation?.database?.name &&
          String(response?.body?.version) === observation?.database?.version &&
          (response?.body?.ownerId ?? response?.body?.owner?.id) ===
            observation?.database?.ownerId,
      ),
    "Render database is not bound to the authenticated owner and raw API facts",
  );
  need(
    equalSorted(
      services.map((entry) => entry.name),
      [...exactServiceRoles.keys()],
    ),
    "deployments must cover api, web, and worker exactly",
  );
  need(
    services.every(
      (entry) =>
        hasExactKeys(entry, [
          "role",
          "name",
          "serviceId",
          "deployId",
          "commit",
          "imageDigest",
          "status",
          "rotatingMutationAdmission",
          "preDeployCommand",
          "serviceMigrationCallerEnabled",
          "observedAt",
        ]) &&
        rawResponses.some((response) => {
          const preDeployCommand =
            response?.body?.serviceDetails?.envSpecificDetails
              ?.preDeployCommand;
          return (
            response?.url ===
              `https://api.render.com/v1/services/${encodeURIComponent(entry.serviceId)}` &&
            response?.body?.id === entry.serviceId &&
            response?.body?.name === entry.name &&
            typeof preDeployCommand === "string" &&
            (preDeployCommand || null) === entry.preDeployCommand &&
            (preDeployCommand !== "") === entry.serviceMigrationCallerEnabled
          );
        }) &&
        rawResponses.some(
          (response) =>
            response?.url ===
              `https://api.render.com/v1/services/${encodeURIComponent(entry.serviceId)}/deploys/${encodeURIComponent(entry.deployId)}` &&
            response?.body?.id === entry.deployId &&
            (response?.body?.commit?.id ?? response?.body?.commitId) ===
              entry.commit &&
            (response?.body?.image?.digest ?? response?.body?.imageDigest) ===
              entry.imageDigest &&
            response?.body?.status === entry.status &&
            (response?.body?.updatedAt ?? response?.body?.createdAt) ===
              entry.observedAt,
        ) &&
        rawResponses.some(
          (response) =>
            response?.url ===
              `https://api.render.com/v1/services/${encodeURIComponent(entry.serviceId)}/env-vars/REVIEW_ROUTER_CODEX_ROTATING_MUTATION_ADMISSION` &&
            response?.body?.value === entry.rotatingMutationAdmission,
        ),
    ),
    "Render deployment facts are not derivable from immutable raw API responses",
  );
  need(
    services.every(
      (entry) =>
        exactServiceRoles.get(entry.name) === entry.role &&
        /^srv-[A-Za-z0-9_-]+$/u.test(entry.serviceId ?? "") &&
        /^dep-[A-Za-z0-9_-]+$/u.test(entry.deployId ?? ""),
    ),
    "Render deployment service names, roles, or immutable IDs are invalid",
  );
  need(
    new Set(services.map((entry) => entry.serviceId)).size === 3,
    "Render deployment service identities are not unique",
  );
  need(
    hasExactKeys(observation?.runtimeWitness, [
      "key",
      "observations",
      "sha256",
    ]) &&
      /^[a-f0-9]{64}$/u.test(observation?.runtimeWitness?.sha256 ?? "") &&
      observation.runtimeWitness.key ===
        "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS" &&
      Array.isArray(observation.runtimeWitness.observations) &&
      observation.runtimeWitness.observations.length === 8 &&
      equalSorted(
        observation.runtimeWitness.observations.map(
          (entry) => `${entry.phase}:${entry.role}`,
        ),
        [
          "after:api",
          "after:web",
          "after:witness",
          "after:worker",
          "before:api",
          "before:web",
          "before:witness",
          "before:worker",
        ],
      ) &&
      ["api", "web", "worker", "witness"].every(
        (role) =>
          new Set(
            observation.runtimeWitness.observations
              .filter((entry) => entry.role === role)
              .map((entry) => entry.serviceId),
          ).size === 1,
      ) &&
      observation.runtimeWitness.observations.every(
        (entry) =>
          hasExactKeys(entry, [
            "phase",
            "role",
            "serviceId",
            "sourceResponseSha256",
          ]) &&
          ["before", "after"].includes(entry.phase) &&
          typeof entry.serviceId === "string" &&
          entry.serviceId.length > 0 &&
          /^[a-f0-9]{64}$/u.test(entry.sourceResponseSha256 ?? "") &&
          observation.rawResponses.some(
            (response) =>
              response?.url ===
                `https://api.render.com/v1/services/${encodeURIComponent(entry.serviceId)}/env-vars/REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS` &&
              response?.bodySha256 === entry.sourceResponseSha256 &&
              hasExactKeys(response?.body, [
                "key",
                "observationPhase",
                "valueSha256",
              ]) &&
              response.body.key === "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS" &&
              response.body.observationPhase === entry.phase &&
              response.body.valueSha256 === observation.runtimeWitness.sha256,
          ) &&
          (entry.role === "witness"
            ? !services.some((service) => service.serviceId === entry.serviceId)
            : services.some(
                (service) =>
                  service.role === entry.role &&
                  service.serviceId === entry.serviceId,
              )),
      ),
    "Render runtime witness observation is absent, mixed, or not source-bound",
  );
  const commits = new Set(services.map((entry) => entry.commit));
  const images = new Set(services.map((entry) => entry.imageDigest));
  need(
    commits.size === 1 && /^[a-f0-9]{40}$/u.test([...commits][0] ?? ""),
    "deployed services do not converge on one exact commit",
  );
  need(
    images.size === 1 && /^sha256:[a-f0-9]{64}$/u.test([...images][0] ?? ""),
    "deployed services do not converge on one exact image digest",
  );
  need(
    services.every((entry) => entry.rotatingMutationAdmission === "off"),
    "rotating OAuth mutation admission was not off during convergence",
  );
  need(
    services.every(
      (entry) =>
        entry.preDeployCommand === null &&
        entry.serviceMigrationCallerEnabled === false,
    ),
    "Render services still expose independent migration callers",
  );
  need(
    services.every((entry) =>
      Number.isFinite(Date.parse(entry.observedAt ?? "")),
    ),
    "deployment observation timestamps are invalid",
  );
  return {
    commit: [...commits][0],
    imageDigest: [...images][0],
    lastObservedAt: Math.max(
      ...services.map((entry) => Date.parse(entry.observedAt ?? "")),
    ),
    runtimeWitnessSha256: observation?.runtimeWitness?.sha256,
  };
}

function verifyCompatibility(probe, descriptor, deployment, need, options) {
  const source = readCheckout(descriptor?.sourceFile, options);
  need(
    source !== null && sha256(source) === descriptor?.sourceFileSha256,
    "compatibility-probe executable source digest mismatched",
  );
  need(
    probe?.observationVersion === 1 && probe?.exitCode === 0,
    "compatibility probe did not execute successfully",
  );
  need(
    probe?.candidateCommit === deployment.commit &&
      probe?.candidateImageDigest === deployment.imageDigest,
    "compatibility probe did not execute against deployed candidate",
  );
  need(
    /^[a-f0-9]{40}$/u.test(probe?.bridgeCommit ?? "") &&
      /^sha256:[a-f0-9]{64}$/u.test(probe?.bridgeImageDigest ?? ""),
    "compatibility probe is not bound to the exact bridge commit and image",
  );
  need(
    probe?.readerRestartCount >= 1,
    "compatibility probe did not observe a reader restart",
  );
  need(
    Array.isArray(probe?.cases) &&
      probe.cases.length === exactCases.length &&
      probe.cases.every(
        (entry, index) =>
          entry.id === exactCases[index] &&
          entry.conclusion === "pass" &&
          entry.observationDigest ===
            sha256Utf8(canonicalJson(entry.observations)),
      ) &&
      exactCompatibilityObservations(probe.cases),
    "compatibility probe cases are missing executable observations or derived digests",
  );
  return {
    bridgeCommit: probe?.bridgeCommit,
    bridgeImageDigest: probe?.bridgeImageDigest,
  };
}

function exactCompatibilityObservations(cases) {
  const replay = cases[0]?.observations;
  const queuedV1 = cases[1]?.observations;
  const v2 = cases[2]?.observations;
  return (
    hasExactKeys(replay, [
      "firstResponseSha256",
      "firstStatus",
      "readerProcessIds",
      "replayResponseSha256",
      "replayStatus",
    ]) &&
    replay.firstStatus === 200 &&
    replay.replayStatus === 200 &&
    replay.firstResponseSha256 === replay.replayResponseSha256 &&
    /^[a-f0-9]{64}$/u.test(replay.firstResponseSha256 ?? "") &&
    Array.isArray(replay.readerProcessIds) &&
    replay.readerProcessIds.length === 2 &&
    replay.readerProcessIds[0] !== replay.readerProcessIds[1] &&
    hasExactKeys(queuedV1, [
      "mutationCount",
      "publishedV2At",
      "queuedWorkflowSha",
      "result",
      "startedAt",
      "workflowSchemaVersion",
    ]) &&
    /^[a-f0-9]{40}$/u.test(queuedV1.queuedWorkflowSha ?? "") &&
    queuedV1.workflowSchemaVersion === 1 &&
    queuedV1.result === "rejected_before_oauth_mutation" &&
    queuedV1.mutationCount === 0 &&
    Date.parse(queuedV1.startedAt) >= Date.parse(queuedV1.publishedV2At) &&
    hasExactKeys(v2, [
      "fenceObserved",
      "mutationEpoch",
      "publishedWorkflowDigest",
      "result",
      "workflowSchemaVersion",
    ]) &&
    v2.workflowSchemaVersion === 2 &&
    v2.result === "success" &&
    v2.fenceObserved === true &&
    Number.isInteger(v2.mutationEpoch) &&
    v2.mutationEpoch > 0 &&
    /^sha256:[a-f0-9]{64}$/u.test(v2.publishedWorkflowDigest ?? "")
  );
}

function exactGitHubCohortPages(observation) {
  const cohort = observation?.cohort;
  if (
    !hasExactKeys(cohort, [
      "perPage",
      "repositoryFullName",
      "repositoryId",
      "statuses",
      "workflow",
    ]) ||
    !/^[1-9][0-9]*$/u.test(cohort.repositoryId ?? "") ||
    !/^[^/]+\/[^/]+$/u.test(cohort.repositoryFullName ?? "") ||
    cohort.perPage !== 100 ||
    JSON.stringify(cohort.statuses) !==
      JSON.stringify(["queued", "in_progress"])
  )
    return false;
  const [owner, repository] = cohort.repositoryFullName.split("/");
  const pages = (observation.rawResponses ?? []).filter(
    (entry) => entry?.body && Array.isArray(entry.body.workflow_runs),
  );
  for (const status of cohort.statuses) {
    const cohortPages = pages.filter((entry) => {
      let url;
      try {
        url = new URL(entry.url);
      } catch {
        return false;
      }
      return (
        url.pathname ===
          `/repos/${owner}/${repository}/actions/workflows/${cohort.workflow}/runs` &&
        url.searchParams.get("status") === status &&
        url.searchParams.get("per_page") === "100"
      );
    });
    if (cohortPages.length === 0) return false;
    const byUrl = new Map(cohortPages.map((entry) => [entry.url, entry]));
    let expected = `https://api.github.com/repos/${owner}/${repository}/actions/workflows/${cohort.workflow}/runs?status=${status}&per_page=100&page=1`;
    const visited = new Set();
    while (expected) {
      const page = byUrl.get(expected);
      if (
        !page ||
        visited.has(expected) ||
        page.body.workflow_runs.length > 100
      )
        return false;
      visited.add(expected);
      if (page.nextUrl === null && page.body.workflow_runs.length === 100)
        return false;
      expected = page.nextUrl;
    }
    if (visited.size !== cohortPages.length) return false;
  }
  return true;
}

function verifyWorkflowRuns(observation, descriptor, need, options) {
  const raw = verifyProviderCapture(
    observation,
    descriptor,
    "GitHub",
    need,
    options,
  );
  const supportedWorkflowSchemaVersions = [1, 2, 3, 4];
  const hasExactSupportedSchemaInventory = (versions) =>
    Array.isArray(versions) &&
    JSON.stringify(versions) ===
      JSON.stringify(supportedWorkflowSchemaVersions);
  need(
    observation?.observationVersion === 2 &&
      observation?.source === "github-actions-api" &&
      hasExactSupportedSchemaInventory(
        observation?.supportedWorkflowSchemaVersions,
      ),
    "workflow-run inventory must be captured from the GitHub Actions API",
  );
  need(
    Array.isArray(observation?.observations) &&
      observation.observations.every(exactGitHubCohortPages) &&
      raw.includes(observation?.cohort?.repositoryId ?? ""),
    "workflow-run inventory does not prove exact repository/workflow cohort pagination",
  );
  const samples = observation?.observations;
  need(
    Array.isArray(samples) && samples.length === 2,
    "workflow-run inventory requires two observations",
  );
  if (!Array.isArray(samples) || samples.length !== 2) return null;
  const validRun = (run) =>
    hasExactKeys(run, [
      "event",
      "headSha",
      "repositoryId",
      "runId",
      "status",
      "workflowBlobSha",
      "workflowPath",
      "workflowSchemaVersion",
    ]) &&
    ["queued", "in_progress"].includes(run.status) &&
    supportedWorkflowSchemaVersions.includes(run.workflowSchemaVersion) &&
    /^[a-f0-9]{40}$/u.test(run.headSha ?? "") &&
    typeof run.workflowPath === "string" &&
    String(run.runId).length > 0;
  need(
    samples.every(
      (sample) =>
        hasExactKeys(sample, [
          "captureIdentity",
          "cohort",
          "inventoriedWorkflowSchemaVersions",
          "observedAt",
          "rawResponses",
          "runs",
        ]) &&
        hasExactSupportedSchemaInventory(
          sample.inventoriedWorkflowSchemaVersions,
        ) &&
        Number.isFinite(Date.parse(sample?.observedAt ?? "")) &&
        sample?.cohort?.repositoryId === observation?.cohort?.repositoryId &&
        sample?.captureIdentity?.authenticated === true &&
        Array.isArray(sample?.rawResponses) &&
        sample.rawResponses.length > 0 &&
        Array.isArray(sample?.runs) &&
        sample.runs.every(
          (run) =>
            validRun(run) &&
            run.repositoryId === observation.cohort.repositoryId &&
            canonicalJson(sample.rawResponses).includes(run.runId) &&
            canonicalJson(sample.rawResponses).includes(run.workflowBlobSha),
        ),
    ),
    "queued/in-progress supported workflow-schema inventory is incomplete",
  );
  const firstIds = new Set(samples[0]?.runs?.map((run) => String(run.runId)));
  const arrivals = (samples[1]?.runs ?? []).filter(
    (run) => !firstIds.has(String(run.runId)),
  );
  need(
    Date.parse(samples[1]?.observedAt ?? "") >
      Date.parse(samples[0]?.observedAt ?? "") && arrivals.length === 0,
    "new queued/in-progress supported workflow-schema work arrived between observations",
  );
  return { secondObservedAt: Date.parse(samples[1]?.observedAt ?? "") };
}

function verifyCanaryRuntime(observation, deployment, need) {
  need(
    observation?.observationVersion === 1 &&
      observation?.source === "canary-runtime" &&
      observation?.disposable === true,
    "canary evidence must come from the disposable runtime",
  );
  need(
    observation?.flags?.runtime === "1" &&
      observation?.flags?.newWorkAdmission === "1" &&
      observation?.flags?.setupIssuance === "1",
    "canary runtime did not observe all cutover flags enabled",
  );
  need(
    Array.isArray(observation?.approvedRepositories) &&
      observation.approvedRepositories.length === 1 &&
      observation.approvedRepositories[0] === observation.repositoryFullName,
    "canary runtime was not restricted to exactly one disposable target",
  );
  need(
    observation?.runtimeCommit === deployment.commit &&
      observation?.runtimeImageDigest === deployment.imageDigest,
    "canary runtime is not bound to the deployed commit and image",
  );
  need(
    [
      observation?.installerV1Digest,
      observation?.installerV2Digest,
      observation?.workflowV2Digest,
      observation?.runtimePublicationDigest,
    ].every((digest) => /^sha256:[a-f0-9]{64}$/u.test(digest ?? "")),
    "canary publication digests are incomplete",
  );
  return observation;
}

function verifyEvents(
  events,
  deployment,
  compatibility,
  need,
  artifactDigests,
  canaryRuntime,
  workflowFacts,
) {
  need(
    events?.observationVersion === 1 &&
      events?.source === "operator-command-log",
    "events artifact source is invalid",
  );
  const sequence = events?.events ?? [];
  const expected = [
    "bridge_replay_ready",
    "workflow_v2_published",
    "setup_issuance_disabled",
    "pre_kill_switch_drain_zero",
    "mutation_admission_disabled",
    "post_kill_switch_drain_zero",
    "migrations_completed",
    "services_converged",
    "canary_allowlisted",
    "canary_admission_opened",
    "canary_passed",
    "canary_admission_closed",
    "canary_allowlist_deleted",
    "widening_approved",
    "widening_admission_opened",
  ];
  need(
    sequence.map((entry) => entry.type).join(",") === expected.join(","),
    "full-drain bridge events are missing or out of order",
  );
  need(
    sequence.every(
      (entry, index) =>
        Number.isFinite(Date.parse(entry.observedAt ?? "")) &&
        (index === 0 ||
          Date.parse(entry.observedAt) >=
            Date.parse(sequence[index - 1].observedAt)),
    ),
    "event timestamps are invalid or out of order",
  );
  const bridge = sequence.find((entry) => entry.type === "bridge_replay_ready");
  need(
    /^[a-f0-9]{40}$/u.test(bridge?.commit ?? "") &&
      /^sha256:[a-f0-9]{64}$/u.test(bridge?.imageDigest ?? "") &&
      bridge?.commit === compatibility.bridgeCommit &&
      bridge?.imageDigest === compatibility.bridgeImageDigest &&
      bridge?.databaseCompatibility === "pre-000061" &&
      bridge?.exactConsumedReplayObserved === true,
    "bridge event lacks pre-000061 compatibility, exact commit/image, or consumed-replay observation",
  );
  const publication = sequence.find(
    (entry) => entry.type === "workflow_v2_published",
  );
  need(
    [
      publication?.installerV1Digest,
      publication?.installerV2Digest,
      publication?.workflowV2Digest,
    ].every((digest) => /^sha256:[a-f0-9]{64}$/u.test(digest ?? "")),
    "v1/v2 installer and v2 workflow publication digests are missing",
  );
  need(
    publication?.installerV1Digest === canaryRuntime?.installerV1Digest &&
      publication?.installerV2Digest === canaryRuntime?.installerV2Digest &&
      publication?.workflowV2Digest === canaryRuntime?.workflowV2Digest,
    "published installer/workflow digests are not bound to canary runtime evidence",
  );
  need(
    publication?.v2IssuanceCount === 0,
    "v2 issuance was observed before v1/v2 installer and workflow publication",
  );
  const issuanceDisabled = sequence.find(
    (entry) => entry.type === "setup_issuance_disabled",
  );
  need(
    issuanceDisabled?.setupIssuance === "off" &&
      issuanceDisabled?.probe?.httpStatus === 503 &&
      issuanceDisabled?.probe?.code ===
        "codex_rotating_setup_issuance_quiesced",
    "setup issuance was not observably quiesced before the full kill switch",
  );
  const disabled = sequence.find(
    (entry) => entry.type === "mutation_admission_disabled",
  );
  need(
    disabled?.globalMutationAdmission === "off" &&
      disabled?.setupIssuance === "off" &&
      disabled?.exactConsumedReplayStillAvailable === true,
    "both rotating OAuth mutation switches must be observed off",
  );
  for (const type of [
    "pre_kill_switch_drain_zero",
    "post_kill_switch_drain_zero",
  ]) {
    const drain = sequence.find((entry) => entry.type === type);
    need(
      drain?.activeLeases === 0 &&
        drain?.fetchedSetups === 0 &&
        drain?.pendingIntents === 0 &&
        drain?.queuedOldWorkflows === 0,
      `${type} observation is not zero, including queued old workflows`,
    );
  }
  need(
    Date.parse(
      sequence.find((entry) => entry.type === "post_kill_switch_drain_zero")
        ?.observedAt ?? "",
    ) >= (workflowFacts?.secondObservedAt ?? Number.POSITIVE_INFINITY),
    "drain event precedes the second no-arrival workflow observation",
  );
  const migration = sequence.find(
    (entry) => entry.type === "migrations_completed",
  );
  need(
    JSON.stringify(migration?.ids) ===
      JSON.stringify(migrations.map((entry) => entry.id)),
    "event log does not prove ordered combined migration IDs",
  );
  need(
    migration?.databaseArtifactSha256 === artifactDigests.database,
    "migration event is not bound to the production database artifact",
  );
  const convergence = sequence.find(
    (entry) => entry.type === "services_converged",
  );
  need(
    convergence?.commit === deployment.commit &&
      convergence?.imageDigest === deployment.imageDigest &&
      convergence?.mutationAdmission === "off" &&
      Date.parse(convergence?.observedAt ?? "") >= deployment.lastObservedAt,
    "event convergence is not bound to observed deployment with admission off",
  );
  const canary = sequence.find((entry) => entry.type === "canary_allowlisted");
  need(
    canary?.globalMutationAdmission === "off" && canary?.disposable === true,
    "canary was not disposable and allowlisted with the global switch off",
  );
  const canaryAdmission = sequence.find(
    (entry) => entry.type === "canary_admission_opened",
  );
  need(
    canaryAdmission?.scope === "single-disposable-repository" &&
      canaryAdmission?.allowlistCount === 1 &&
      canaryAdmission?.runtimeFlag === "1" &&
      canaryAdmission?.newWorkAdmissionFlag === "1" &&
      canaryAdmission?.setupIssuanceFlag === "1",
    "canary admission was not restricted to one disposable repository",
  );
  const canaryPassed = sequence.find((entry) => entry.type === "canary_passed");
  need(
    canaryPassed?.compatibilityArtifactSha256 ===
      artifactDigests.compatibilityProbe &&
      canaryPassed?.runtimePublicationDigest ===
        canaryRuntime?.runtimePublicationDigest,
    "canary pass is not bound to the compatibility-probe artifact digest",
  );
  const canaryClosed = sequence.find(
    (entry) => entry.type === "canary_admission_closed",
  );
  const canaryDeleted = sequence.find(
    (entry) => entry.type === "canary_allowlist_deleted",
  );
  need(
    canaryClosed?.runtimeFlag === "0" &&
      canaryClosed?.newWorkAdmissionFlag === "0" &&
      canaryClosed?.setupIssuanceFlag === "0" &&
      Date.parse(canaryClosed?.observedAt ?? "") <
        Date.parse(canaryDeleted?.observedAt ?? ""),
    "canary flags did not return to zero before allowlist deletion",
  );
  need(
    canaryDeleted?.allowlistCount === 0 &&
      canaryDeleted?.runtimeFlag === "0" &&
      canaryDeleted?.newWorkAdmissionFlag === "0" &&
      canaryDeleted?.setupIssuanceFlag === "0",
    "clearing the canary allowlist while admission is on is prohibited",
  );
  const widening = sequence.find((entry) => entry.type === "widening_approved");
  const wideningOpened = sequence.find(
    (entry) => entry.type === "widening_admission_opened",
  );
  need(
    Array.isArray(widening?.approvedRepositories) &&
      widening.approvedRepositories.length > 0,
    "widening requires a nonempty explicit approved cohort",
  );
  need(
    wideningOpened?.runtimeFlag === "1" &&
      wideningOpened?.newWorkAdmissionFlag === "1" &&
      wideningOpened?.setupIssuanceFlag === "1" &&
      wideningOpened?.allowlistCount ===
        widening?.approvedRepositories?.length &&
      wideningOpened.allowlistCount > 0,
    "widening admission did not retain a nonempty approved cohort",
  );
  need(
    sequence.every(
      (entry) =>
        entry.allowlistCount !== 0 ||
        (entry.runtimeFlag !== "1" &&
          entry.newWorkAdmissionFlag !== "1" &&
          entry.setupIssuanceFlag !== "1"),
    ),
    "allowlist was cleared while admission was enabled",
  );
  need(
    events?.rollbackFloorCommit === deployment.commit,
    "rollback floor must be the fence-aware deployed commit",
  );
  need(
    events?.prohibitedRollbackCommit === "e642d1ed",
    "e642d1ed must be explicitly prohibited after 000061",
  );
}

function loadArtifact(descriptor, options) {
  if (!descriptor || typeof descriptor.path !== "string")
    return { value: null, digestValid: false };
  try {
    const path = options.evidenceDirectory
      ? resolve(options.evidenceDirectory, descriptor.path)
      : descriptor.path;
    const bytes = options.readArtifact
      ? options.readArtifact(path)
      : readFileSync(path);
    return {
      value: JSON.parse(bytes.toString("utf8")),
      digestValid:
        /^[a-f0-9]{64}$/u.test(descriptor.sha256 ?? "") &&
        sha256(bytes) === descriptor.sha256,
    };
  } catch {
    return { value: null, digestValid: false };
  }
}

function readCheckout(sourceFile, options) {
  if (typeof sourceFile !== "string") return null;
  const path = resolve(checkoutRoot, sourceFile);
  if (!path.startsWith(`${checkoutRoot}${sep}`)) return null;
  try {
    return options.readSource ? options.readSource(path) : readFileSync(path);
  } catch {
    return null;
  }
}
function hasExactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    equalSorted(Object.keys(value), keys)
  );
}
function equalSorted(left, right) {
  return (
    JSON.stringify([...(left ?? [])].sort()) ===
    JSON.stringify([...right].sort())
  );
}
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runCodexRotatingRolloutVerifierCli(
    process.argv.slice(2),
  );
