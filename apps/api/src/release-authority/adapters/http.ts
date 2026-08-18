import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ProviderAuthorityRequest,
  RunnerIdentity,
  StepObservation,
} from "@reviewrouter/features-release-rollout";
import {
  assertLegacyAmbiguityEvidence,
  assertOneShotMutationPermit,
  RecoveryEffectKind,
  assertRecoveryEffectObservation,
  type RecoveryEffectAuthorityPort,
  type MutationExecutionReceipt,
  type ProviderMutationReconciliation,
  type ProviderMutationResultIdentity,
} from "@reviewrouter/features-release-rollout";
import type {
  CreateProvisioningIntent,
  PersistRunnerRegistrationInput,
  RolloutBinding,
  RolloutClaimBinding,
  PersistedJob,
} from "../domain/model.js";
import type {
  LegacyAmbiguityEvidence,
  ReleaseMigrationPermit,
  ReleaseMigrationReceipt,
  ReleaseMigrationTransitionV1,
} from "@reviewrouter/features-release-rollout";
import type {
  ProviderAuthorityDecisionService,
  ReleaseAuthorityService,
  ReleaseRolloutReconciliationService,
  ReleaseServiceTransitionService,
  ProviderMutationAuthorityService,
  RunnerOperationsService,
} from "../application/services.js";
import {
  serviceTransitionAppendRequest,
  serviceTransitionBeginRequest,
} from "./service-transition-http-validation.js";
type PublicService<Service> = Pick<Service, keyof Service>;

export type ReleaseRolloutLedgerRouteDependencies = {
  authority: PublicService<ReleaseAuthorityService>;
  runnerOperations: PublicService<RunnerOperationsService>;
  reconciliation: PublicService<ReleaseRolloutReconciliationService>;
  serviceTransition?: PublicService<ReleaseServiceTransitionService>;
  providerAuthority?: PublicService<ProviderAuthorityDecisionService>;
  providerMutationAuthority?: PublicService<ProviderMutationAuthorityService>;
  providerAuthorityTokenSha256?: string;
  controlTokenSha256: string;
};

const mutationFingerprint = /^sha256:[a-f0-9]{64}$/u;
const legacyAmbiguityRequest = (value: unknown): LegacyAmbiguityEvidence => {
  try {
    return assertLegacyAmbiguityEvidence(value) ?? invalidMigrationRequest();
  } catch {
    return invalidMigrationRequest();
  }
};
const mutationResource = (value: unknown) => {
  const item = record(value);
  if (
    !exactKeys(item, ["provider", "kind", "id"]) ||
    item.provider !== "render" ||
    ![
      "service",
      "service_environment",
      "deploy_creation_slot",
      "job_creation_intent",
    ].includes(typeof item.kind === "string" ? item.kind : "") ||
    !nonemptyString(item.id)
  )
    throw Object.assign(new Error("provider_mutation_request_invalid"), {
      statusCode: 400,
    });
  return item as {
    provider: "render";
    kind:
      | "service"
      | "service_environment"
      | "deploy_creation_slot"
      | "job_creation_intent";
    id: string;
  };
};
const mutationExpected = (value: unknown) => {
  const item = record(value);
  if (
    !exactKeys(item, ["fingerprint", "version"]) ||
    typeof item.fingerprint !== "string" ||
    !mutationFingerprint.test(item.fingerprint) ||
    (item.version !== null && !nonemptyString(item.version))
  )
    throw Object.assign(new Error("provider_mutation_request_invalid"), {
      statusCode: 400,
    });
  return item as { fingerprint: string; version: string | null };
};
const mutationIssueRequest = (value: unknown) => {
  const body = record(value);
  if (
    !exactKeys(body, [
      "rolloutId",
      "operation",
      "resource",
      "ownerId",
      "expected",
      "leaseSeconds",
    ]) ||
    !nonemptyString(body.rolloutId) ||
    !nonemptyString(body.operation) ||
    !nonemptyString(body.ownerId) ||
    !Number.isSafeInteger(body.leaseSeconds) ||
    Number(body.leaseSeconds) < 5 ||
    Number(body.leaseSeconds) > 300
  )
    throw Object.assign(new Error("provider_mutation_request_invalid"), {
      statusCode: 400,
    });
  return {
    ...body,
    resource: mutationResource(body.resource),
    expected: mutationExpected(body.expected),
  } as Parameters<ProviderMutationAuthorityService["issue"]>[0];
};
const mutationPermitRequest = (value: unknown) => {
  try {
    return assertOneShotMutationPermit(value as never, new Date());
  } catch {
    throw Object.assign(new Error("provider_mutation_request_invalid"), {
      statusCode: 400,
    });
  }
};
const mutationReceiptRequest = (value: unknown): MutationExecutionReceipt => {
  const body = record(value);
  if (
    !exactKeys(body, [
      "rolloutId",
      "operation",
      "resource",
      "ownerId",
      "epoch",
      "permitId",
      "receiptId",
      "expected",
      "consumedAt",
    ]) ||
    !nonemptyString(body.rolloutId) ||
    !nonemptyString(body.operation) ||
    !nonemptyString(body.ownerId) ||
    !Number.isSafeInteger(body.epoch) ||
    Number(body.epoch) < 1 ||
    !nonemptyString(body.permitId) ||
    !nonemptyString(body.receiptId) ||
    !nonemptyString(body.consumedAt) ||
    !Number.isFinite(Date.parse(body.consumedAt))
  )
    throw Object.assign(new Error("provider_mutation_request_invalid"), {
      statusCode: 400,
    });
  return {
    ...body,
    resource: mutationResource(body.resource),
    expected: mutationExpected(body.expected),
  } as MutationExecutionReceipt;
};
const mutationObservationRequest = (value: unknown) => {
  const body = record(value);
  const resultIdentity =
    body.resultIdentity === undefined ? undefined : record(body.resultIdentity);
  const resource = mutationResource(body.resource);
  if (
    !exactKeys(body, [
      "resource",
      "state",
      "observedAt",
      ...(resultIdentity ? ["resultIdentity"] : []),
    ]) ||
    !nonemptyString(body.observedAt) ||
    !Number.isFinite(Date.parse(body.observedAt)) ||
    (resultIdentity !== undefined &&
      !(
        (exactKeys(resultIdentity, ["kind", "id"]) &&
          (resultIdentity.kind === "deploy" || resultIdentity.kind === "job") &&
          nonemptyString(resultIdentity.id) &&
          resultIdentity.id.length <= 256) ||
        (exactKeys(resultIdentity, [
          "kind",
          "environmentSha256",
          "environmentKeysSha256",
        ]) &&
          resultIdentity.kind === "environment" &&
          typeof resultIdentity.environmentSha256 === "string" &&
          /^sha256:[a-f0-9]{64}$/u.test(resultIdentity.environmentSha256) &&
          typeof resultIdentity.environmentKeysSha256 === "string" &&
          /^sha256:[a-f0-9]{64}$/u.test(resultIdentity.environmentKeysSha256))
      )) ||
    (resultIdentity?.kind === "environment" &&
      resource.kind !== "service_environment") ||
    (resultIdentity?.kind === "deploy" &&
      resource.kind !== "deploy_creation_slot") ||
    (resultIdentity?.kind === "job" &&
      resource.kind !== "job_creation_intent") ||
    (resultIdentity !== undefined && resource.kind === "service")
  )
    throw Object.assign(new Error("provider_mutation_request_invalid"), {
      statusCode: 400,
    });
  return {
    resource,
    state: mutationExpected(body.state),
    observedAt: body.observedAt,
    ...(resultIdentity
      ? { resultIdentity: resultIdentity as ProviderMutationResultIdentity }
      : {}),
  };
};

export type ReleaseControlRouteDependencies =
  ReleaseRolloutLedgerRouteDependencies;

function authorize(request: FastifyRequest, expected: string): void {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actual = createHash("sha256").update(token).digest();
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    expectedBuffer.length !== actual.length ||
    !timingSafeEqual(actual, expectedBuffer)
  )
    throw Object.assign(new Error("release_rollout_ledger_unauthorized"), {
      statusCode: 401,
    });
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("release_rollout_ledger_request_invalid"), {
      statusCode: 400,
    });
  return value as Record<string, unknown>;
};
const invalidRegistrationRequest = (): never => {
  throw Object.assign(
    new Error("release_runner_registration_request_invalid"),
    {
      statusCode: 400,
    },
  );
};
const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
};
const nonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const rolloutIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/u;
const commitSha = /^[a-f0-9]{40}$/u;
const sha256Digest = /^sha256:[a-f0-9]{64}$/u;
const rawSha256 = /^[a-f0-9]{64}$/u;
const postgresSystemIdentifier = /^[1-9][0-9]{0,19}$/u;
const positiveRunId = /^[1-9][0-9]{0,39}$/u;
const migrationName = /^\d{6}_[a-z0-9_]+$/u;
const imageDigest = /^sha256:[a-f0-9]{64}$/u;
const permitNonce = /^[a-f0-9]{32}$/u;

const invalidMigrationRequest = (): never => {
  throw Object.assign(new Error("release_migration_request_invalid"), {
    statusCode: 400,
  });
};

const stringMatching = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);
const requiredPattern = (value: unknown, pattern: RegExp): string => {
  if (typeof value === "string" && pattern.test(value)) return value;
  return invalidMigrationRequest();
};
const requiredArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  return invalidMigrationRequest();
};

const exactTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const migrationTransitionRequest = (
  value: unknown,
): ReleaseMigrationTransitionV1 => {
  const body = record(value);
  if (
    !exactKeys(body, [
      "schemaVersion",
      "commitSha",
      "releaseImageDigest",
      "migrationArtifactDigest",
      "orderedMigrationEntries",
      "preManifestIdentity",
      "orderedPendingEntriesSha256",
      "migrationBundleSha256",
      "allowedResumeManifestIdentities",
      "postManifestIdentity",
      "postCatalogDigest",
      "transitionSha256",
    ]) ||
    body.schemaVersion !== 1 ||
    !stringMatching(body.commitSha, commitSha) ||
    !stringMatching(body.releaseImageDigest, imageDigest) ||
    !stringMatching(body.migrationArtifactDigest, sha256Digest) ||
    !stringMatching(body.preManifestIdentity, sha256Digest) ||
    !stringMatching(body.orderedPendingEntriesSha256, sha256Digest) ||
    !stringMatching(body.migrationBundleSha256, sha256Digest) ||
    !stringMatching(body.postManifestIdentity, sha256Digest) ||
    !stringMatching(body.postCatalogDigest, sha256Digest) ||
    !stringMatching(body.transitionSha256, sha256Digest) ||
    !Array.isArray(body.orderedMigrationEntries) ||
    body.orderedMigrationEntries.length < 1 ||
    !Array.isArray(body.allowedResumeManifestIdentities) ||
    body.allowedResumeManifestIdentities.length < 2
  )
    invalidMigrationRequest();
  const orderedMigrationEntriesValue = requiredArray(
    body.orderedMigrationEntries,
  );
  const allowedResumeManifestIdentitiesValue = requiredArray(
    body.allowedResumeManifestIdentities,
  );
  const orderedMigrationEntries = orderedMigrationEntriesValue.map((entry) => {
    const item = record(entry);
    if (
      !exactKeys(item, ["migrationName", "migrationSqlSha256"]) ||
      !stringMatching(item.migrationName, migrationName) ||
      !stringMatching(item.migrationSqlSha256, rawSha256)
    )
      invalidMigrationRequest();
    return {
      migrationName: requiredPattern(item.migrationName, migrationName),
      migrationSqlSha256: requiredPattern(item.migrationSqlSha256, rawSha256),
    };
  });
  const allowedResumeManifestIdentities =
    allowedResumeManifestIdentitiesValue.map((entry) => {
      if (!stringMatching(entry, sha256Digest)) invalidMigrationRequest();
      return requiredPattern(entry, sha256Digest);
    });
  return {
    schemaVersion: 1,
    commitSha: requiredPattern(body.commitSha, commitSha),
    releaseImageDigest: requiredPattern(body.releaseImageDigest, imageDigest),
    migrationArtifactDigest: requiredPattern(
      body.migrationArtifactDigest,
      sha256Digest,
    ),
    orderedMigrationEntries,
    preManifestIdentity: requiredPattern(
      body.preManifestIdentity,
      sha256Digest,
    ),
    orderedPendingEntriesSha256: requiredPattern(
      body.orderedPendingEntriesSha256,
      sha256Digest,
    ),
    migrationBundleSha256: requiredPattern(
      body.migrationBundleSha256,
      sha256Digest,
    ),
    allowedResumeManifestIdentities,
    postManifestIdentity: requiredPattern(
      body.postManifestIdentity,
      sha256Digest,
    ),
    postCatalogDigest: requiredPattern(body.postCatalogDigest, sha256Digest),
    transitionSha256: requiredPattern(body.transitionSha256, sha256Digest),
  };
};

export const rolloutClaimRequest = (value: unknown): RolloutClaimBinding => {
  const body = record(value);
  if (
    !exactKeys(body, [
      "rolloutId",
      "expectedCommitSha",
      "runId",
      "runAttempt",
      "sourceSystemIdentifier",
      "targetSystemIdentifier",
      "targetRecoveryWitnessSha256",
      "migrationTransition",
    ]) ||
    !stringMatching(body.rolloutId, rolloutIdentifier) ||
    !stringMatching(body.expectedCommitSha, commitSha) ||
    !stringMatching(body.runId, positiveRunId) ||
    body.runAttempt !== 1 ||
    !stringMatching(body.sourceSystemIdentifier, postgresSystemIdentifier) ||
    !stringMatching(body.targetSystemIdentifier, postgresSystemIdentifier) ||
    body.sourceSystemIdentifier === body.targetSystemIdentifier ||
    !stringMatching(body.targetRecoveryWitnessSha256, rawSha256)
  )
    invalidMigrationRequest();
  return {
    rolloutId: requiredPattern(body.rolloutId, rolloutIdentifier),
    expectedCommitSha: requiredPattern(body.expectedCommitSha, commitSha),
    runId: requiredPattern(body.runId, positiveRunId),
    runAttempt: 1,
    sourceSystemIdentifier: requiredPattern(
      body.sourceSystemIdentifier,
      postgresSystemIdentifier,
    ),
    targetSystemIdentifier: requiredPattern(
      body.targetSystemIdentifier,
      postgresSystemIdentifier,
    ),
    targetRecoveryWitnessSha256: requiredPattern(
      body.targetRecoveryWitnessSha256,
      rawSha256,
    ),
    migrationTransition: migrationTransitionRequest(body.migrationTransition),
  };
};

export const migrationPermitRequest = (
  value: unknown,
): ReleaseMigrationPermit => {
  const body = record(value);
  if (
    !exactKeys(body, [
      "schemaVersion",
      "rolloutId",
      "runId",
      "runAttempt",
      "targetSystemIdentifier",
      "targetRecoveryWitnessSha256",
      "transitionSha256",
      "expectedPreviousReceiptSha256",
      "sourceLegacyAmbiguity",
      "eligibilityCutoff",
      "epoch",
      "nonce",
    ]) ||
    body.schemaVersion !== 1 ||
    !stringMatching(body.rolloutId, rolloutIdentifier) ||
    !stringMatching(body.runId, positiveRunId) ||
    body.runAttempt !== 1 ||
    !stringMatching(body.targetSystemIdentifier, postgresSystemIdentifier) ||
    !stringMatching(body.targetRecoveryWitnessSha256, rawSha256) ||
    !stringMatching(body.transitionSha256, sha256Digest) ||
    !stringMatching(body.expectedPreviousReceiptSha256, sha256Digest) ||
    !exactTimestamp(body.eligibilityCutoff) ||
    !Number.isSafeInteger(body.epoch) ||
    Number(body.epoch) < 1 ||
    !stringMatching(body.nonce, permitNonce)
  )
    invalidMigrationRequest();
  const sourceLegacyAmbiguity = legacyAmbiguityRequest(
    body.sourceLegacyAmbiguity,
  );
  if (
    sourceLegacyAmbiguity.rolloutId !== body.rolloutId ||
    sourceLegacyAmbiguity.eligibilityCutoff !== body.eligibilityCutoff
  )
    invalidMigrationRequest();
  return {
    schemaVersion: 1,
    rolloutId: requiredPattern(body.rolloutId, rolloutIdentifier),
    runId: requiredPattern(body.runId, positiveRunId),
    runAttempt: 1,
    targetSystemIdentifier: requiredPattern(
      body.targetSystemIdentifier,
      postgresSystemIdentifier,
    ),
    targetRecoveryWitnessSha256: requiredPattern(
      body.targetRecoveryWitnessSha256,
      rawSha256,
    ),
    transitionSha256: requiredPattern(body.transitionSha256, sha256Digest),
    expectedPreviousReceiptSha256: requiredPattern(
      body.expectedPreviousReceiptSha256,
      sha256Digest,
    ),
    sourceLegacyAmbiguity,
    eligibilityCutoff: exactTimestamp(body.eligibilityCutoff)
      ? body.eligibilityCutoff
      : invalidMigrationRequest(),
    epoch: Number(body.epoch),
    nonce: requiredPattern(body.nonce, permitNonce),
  };
};

export const migrationReceiptRequest = (
  value: unknown,
): ReleaseMigrationReceipt => {
  const body = record(value);
  const requiredKeys = [
    "step",
    "receiptId",
    "observedAt",
    "rolloutId",
    "expectedCommitSha",
    "runId",
    "runAttempt",
    "sourceSystemIdentifier",
    "targetSystemIdentifier",
    "observationSha256",
    "previousReceiptSha256",
    "receiptSha256",
    "migrationChecksum",
    "transitionSha256",
    "migrationArtifactDigest",
    "migrationBundleSha256",
    "preManifestIdentity",
    "postManifestIdentity",
    "postCatalogDigest",
    "permitEpoch",
    "permitNonce",
    "targetMigrationReceiptSha256",
    "targetMigrationEffectFingerprint",
  ];
  const actualKeys = Object.keys(body);
  if (
    (!exactKeys(body, requiredKeys) &&
      !exactKeys(body, [...requiredKeys, "provider"])) ||
    body.step !== "run_release_migration" ||
    !stringMatching(body.receiptId, rolloutIdentifier) ||
    !exactTimestamp(body.observedAt) ||
    !stringMatching(body.rolloutId, rolloutIdentifier) ||
    !stringMatching(body.expectedCommitSha, commitSha) ||
    !stringMatching(body.runId, positiveRunId) ||
    body.runAttempt !== 1 ||
    !stringMatching(body.sourceSystemIdentifier, postgresSystemIdentifier) ||
    !stringMatching(body.targetSystemIdentifier, postgresSystemIdentifier) ||
    body.sourceSystemIdentifier === body.targetSystemIdentifier ||
    !stringMatching(body.observationSha256, sha256Digest) ||
    !stringMatching(body.previousReceiptSha256, sha256Digest) ||
    !stringMatching(body.receiptSha256, sha256Digest) ||
    !stringMatching(body.migrationChecksum, sha256Digest) ||
    !stringMatching(body.transitionSha256, sha256Digest) ||
    !stringMatching(body.migrationArtifactDigest, sha256Digest) ||
    !stringMatching(body.migrationBundleSha256, sha256Digest) ||
    !stringMatching(body.preManifestIdentity, sha256Digest) ||
    !stringMatching(body.postManifestIdentity, sha256Digest) ||
    !stringMatching(body.postCatalogDigest, sha256Digest) ||
    !stringMatching(body.targetMigrationReceiptSha256, sha256Digest) ||
    !stringMatching(body.targetMigrationEffectFingerprint, sha256Digest) ||
    !Number.isSafeInteger(body.permitEpoch) ||
    Number(body.permitEpoch) < 1 ||
    !stringMatching(body.permitNonce, permitNonce) ||
    (actualKeys.includes("provider") && body.provider !== null)
  )
    invalidMigrationRequest();
  return {
    step: "run_release_migration",
    receiptId: requiredPattern(body.receiptId, rolloutIdentifier),
    observedAt: exactTimestamp(body.observedAt)
      ? body.observedAt
      : invalidMigrationRequest(),
    rolloutId: requiredPattern(body.rolloutId, rolloutIdentifier),
    expectedCommitSha: requiredPattern(body.expectedCommitSha, commitSha),
    runId: requiredPattern(body.runId, positiveRunId),
    runAttempt: 1,
    sourceSystemIdentifier: requiredPattern(
      body.sourceSystemIdentifier,
      postgresSystemIdentifier,
    ),
    targetSystemIdentifier: requiredPattern(
      body.targetSystemIdentifier,
      postgresSystemIdentifier,
    ),
    provider: undefined,
    observationSha256: requiredPattern(body.observationSha256, sha256Digest),
    previousReceiptSha256: requiredPattern(
      body.previousReceiptSha256,
      sha256Digest,
    ),
    receiptSha256: requiredPattern(body.receiptSha256, sha256Digest),
    migrationChecksum: requiredPattern(body.migrationChecksum, sha256Digest),
    transitionSha256: requiredPattern(body.transitionSha256, sha256Digest),
    migrationArtifactDigest: requiredPattern(
      body.migrationArtifactDigest,
      sha256Digest,
    ),
    migrationBundleSha256: requiredPattern(
      body.migrationBundleSha256,
      sha256Digest,
    ),
    preManifestIdentity: requiredPattern(
      body.preManifestIdentity,
      sha256Digest,
    ),
    postManifestIdentity: requiredPattern(
      body.postManifestIdentity,
      sha256Digest,
    ),
    postCatalogDigest: requiredPattern(body.postCatalogDigest, sha256Digest),
    permitEpoch: Number(body.permitEpoch),
    permitNonce: requiredPattern(body.permitNonce, permitNonce),
    targetMigrationReceiptSha256: requiredPattern(
      body.targetMigrationReceiptSha256,
      sha256Digest,
    ),
    targetMigrationEffectFingerprint: requiredPattern(
      body.targetMigrationEffectFingerprint,
      sha256Digest,
    ),
  };
};

export const migrationBeginRequest = (
  value: unknown,
  routeRolloutId: string,
) => {
  const body = record(value);
  if (
    !exactKeys(body, [
      "rolloutId",
      "expectedCommitSha",
      "runId",
      "runAttempt",
      "sourceSystemIdentifier",
      "targetSystemIdentifier",
      "targetRecoveryWitnessSha256",
      "transitionSha256",
      "expectedPreviousReceiptSha256",
      "sourceLegacyAmbiguity",
    ]) ||
    body.rolloutId !== routeRolloutId
  )
    invalidMigrationRequest();
  if (
    !stringMatching(body.rolloutId, rolloutIdentifier) ||
    !stringMatching(body.expectedCommitSha, commitSha) ||
    !stringMatching(body.runId, positiveRunId) ||
    body.runAttempt !== 1 ||
    !stringMatching(body.sourceSystemIdentifier, postgresSystemIdentifier) ||
    !stringMatching(body.targetSystemIdentifier, postgresSystemIdentifier) ||
    body.sourceSystemIdentifier === body.targetSystemIdentifier ||
    !stringMatching(body.targetRecoveryWitnessSha256, rawSha256) ||
    !stringMatching(body.transitionSha256, sha256Digest) ||
    !stringMatching(body.expectedPreviousReceiptSha256, sha256Digest)
  )
    invalidMigrationRequest();
  const sourceLegacyAmbiguity = legacyAmbiguityRequest(
    body.sourceLegacyAmbiguity,
  );
  if (
    sourceLegacyAmbiguity.rolloutId !== body.rolloutId ||
    sourceLegacyAmbiguity.sourceSystemIdentifier !== body.sourceSystemIdentifier
  )
    invalidMigrationRequest();
  return {
    rolloutId: requiredPattern(body.rolloutId, rolloutIdentifier),
    expectedCommitSha: requiredPattern(body.expectedCommitSha, commitSha),
    runId: requiredPattern(body.runId, positiveRunId),
    runAttempt: 1,
    sourceSystemIdentifier: requiredPattern(
      body.sourceSystemIdentifier,
      postgresSystemIdentifier,
    ),
    targetSystemIdentifier: requiredPattern(
      body.targetSystemIdentifier,
      postgresSystemIdentifier,
    ),
    targetRecoveryWitnessSha256: requiredPattern(
      body.targetRecoveryWitnessSha256,
      rawSha256,
    ),
    transitionSha256: requiredPattern(body.transitionSha256, sha256Digest),
    expectedPreviousReceiptSha256: requiredPattern(
      body.expectedPreviousReceiptSha256,
      sha256Digest,
    ),
    sourceLegacyAmbiguity,
  };
};

export const migrationCompleteRequest = (
  value: unknown,
  routeRolloutId: string,
) => {
  const body = record(value);
  if (!exactKeys(body, ["permit", "receipt"])) invalidMigrationRequest();
  const permit = migrationPermitRequest(body.permit);
  const receipt = migrationReceiptRequest(body.receipt);
  if (
    permit.rolloutId !== routeRolloutId ||
    receipt.rolloutId !== routeRolloutId
  )
    invalidMigrationRequest();
  return { permit, receipt };
};

export const migrationFailRequest = (
  value: unknown,
  routeRolloutId: string,
) => {
  const body = record(value);
  if (!exactKeys(body, ["permit", "reasonSha256"])) invalidMigrationRequest();
  const permit = migrationPermitRequest(body.permit);
  if (
    permit.rolloutId !== routeRolloutId ||
    !stringMatching(body.reasonSha256, sha256Digest)
  )
    invalidMigrationRequest();
  return {
    permit,
    reasonSha256: requiredPattern(body.reasonSha256, sha256Digest),
  };
};
const invalidEffectRequest = (): never => {
  throw Object.assign(new Error("release_runner_effect_request_invalid"), {
    statusCode: 400,
  });
};
const invalidRecoveryEffectRequest = (): never => {
  throw Object.assign(new Error("release_recovery_effect_request_invalid"), {
    statusCode: 400,
  });
};
const recoveryEffectKeyPattern = /^[a-z][a-z0-9_]*(?::[A-Za-z0-9._-]+)?$/u;
const recoveryOwnerPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const recoveryPermitPattern = /^[a-f0-9]{64}$/u;
const recoveryReceiptPattern = recoveryPermitPattern;
const recoveryKinds = Object.values(RecoveryEffectKind);
const recoveryBase = (value: unknown, rolloutId: string) => {
  const body = record(value);
  if (
    body.rolloutId !== rolloutId ||
    !nonemptyString(body.rolloutId) ||
    typeof body.effectKey !== "string" ||
    !recoveryEffectKeyPattern.test(body.effectKey)
  )
    invalidRecoveryEffectRequest();
  return body;
};
const recoveryEffectIntendRequest = (
  value: unknown,
  rolloutId: string,
): Parameters<RecoveryEffectAuthorityPort["intendRecoveryEffect"]>[0] => {
  const body = recoveryBase(value, rolloutId);
  const hasService = Object.hasOwn(body, "serviceId");
  if (
    !exactKeys(body, [
      "rolloutId",
      "effectKey",
      "kind",
      ...(hasService ? ["serviceId"] : []),
    ]) ||
    !recoveryKinds.includes(body.kind as never) ||
    (body.kind === RecoveryEffectKind.RestoreDatabaseWrites) !== !hasService ||
    (hasService && !nonemptyString(body.serviceId))
  )
    invalidRecoveryEffectRequest();
  return body as unknown as Parameters<
    RecoveryEffectAuthorityPort["intendRecoveryEffect"]
  >[0];
};
const recoveryEffectClaimRequest = (
  value: unknown,
  rolloutId: string,
): Parameters<RecoveryEffectAuthorityPort["claimRecoveryEffect"]>[0] => {
  const body = recoveryBase(value, rolloutId);
  if (
    !exactKeys(body, [
      "rolloutId",
      "effectKey",
      "kind",
      "ownerId",
      "leaseSeconds",
    ]) ||
    !recoveryKinds.includes(body.kind as never) ||
    typeof body.ownerId !== "string" ||
    !recoveryOwnerPattern.test(body.ownerId) ||
    !Number.isSafeInteger(body.leaseSeconds) ||
    Number(body.leaseSeconds) < 5 ||
    Number(body.leaseSeconds) > 300
  )
    invalidRecoveryEffectRequest();
  return body as unknown as Parameters<
    RecoveryEffectAuthorityPort["claimRecoveryEffect"]
  >[0];
};
const recoveryEffectConsumeRequest = (
  value: unknown,
  rolloutId: string,
): Parameters<
  RecoveryEffectAuthorityPort["consumeRecoveryEffectPermit"]
>[0] => {
  const body = recoveryBase(value, rolloutId);
  if (
    !exactKeys(body, [
      "rolloutId",
      "effectKey",
      "kind",
      "ownerId",
      "epoch",
      "permitToken",
    ]) ||
    !recoveryKinds.includes(body.kind as never) ||
    typeof body.ownerId !== "string" ||
    !recoveryOwnerPattern.test(body.ownerId) ||
    !Number.isSafeInteger(body.epoch) ||
    Number(body.epoch) < 1 ||
    typeof body.permitToken !== "string" ||
    !recoveryPermitPattern.test(body.permitToken)
  )
    invalidRecoveryEffectRequest();
  return body as unknown as Parameters<
    RecoveryEffectAuthorityPort["consumeRecoveryEffectPermit"]
  >[0];
};
const recoveryEffectCompleteRequest = (
  value: unknown,
  rolloutId: string,
): Parameters<RecoveryEffectAuthorityPort["completeRecoveryEffect"]>[0] => {
  const body = recoveryBase(value, rolloutId);
  if (
    !exactKeys(body, [
      "rolloutId",
      "effectKey",
      "kind",
      "ownerId",
      "epoch",
      "permitToken",
      "executionReceipt",
      "observation",
    ]) ||
    !recoveryKinds.includes(body.kind as never) ||
    typeof body.ownerId !== "string" ||
    !recoveryOwnerPattern.test(body.ownerId) ||
    !Number.isSafeInteger(body.epoch) ||
    Number(body.epoch) < 1 ||
    typeof body.permitToken !== "string" ||
    !recoveryPermitPattern.test(body.permitToken) ||
    typeof body.executionReceipt !== "string" ||
    !recoveryReceiptPattern.test(body.executionReceipt)
  )
    invalidRecoveryEffectRequest();
  try {
    assertRecoveryEffectObservation(body.kind as never, body.observation);
  } catch {
    invalidRecoveryEffectRequest();
  }
  return body as unknown as Parameters<
    RecoveryEffectAuthorityPort["completeRecoveryEffect"]
  >[0];
};
const recoveryEffectValidateExecutionRequest = (
  value: unknown,
  rolloutId: string,
): Parameters<
  RecoveryEffectAuthorityPort["validateRecoveryEffectExecution"]
>[0] => {
  const body = recoveryBase(value, rolloutId);
  if (
    !exactKeys(body, [
      "rolloutId",
      "effectKey",
      "kind",
      "ownerId",
      "epoch",
      "permitToken",
      "executionReceipt",
    ]) ||
    !recoveryKinds.includes(body.kind as never) ||
    typeof body.ownerId !== "string" ||
    !recoveryOwnerPattern.test(body.ownerId) ||
    !Number.isSafeInteger(body.epoch) ||
    Number(body.epoch) < 1 ||
    typeof body.permitToken !== "string" ||
    !recoveryPermitPattern.test(body.permitToken) ||
    typeof body.executionReceipt !== "string" ||
    !recoveryReceiptPattern.test(body.executionReceipt)
  )
    invalidRecoveryEffectRequest();
  return body as unknown as Parameters<
    RecoveryEffectAuthorityPort["validateRecoveryEffectExecution"]
  >[0];
};
const recoveryEffectReconcileRequest = (
  value: unknown,
  rolloutId: string,
): Parameters<RecoveryEffectAuthorityPort["reconcileRecoveryEffect"]>[0] => {
  const body = recoveryBase(value, rolloutId);
  if (
    !exactKeys(body, [
      "rolloutId",
      "effectKey",
      "kind",
      "ownerId",
      "epoch",
      "permitToken",
      "observation",
    ]) ||
    !recoveryKinds.includes(body.kind as never) ||
    typeof body.ownerId !== "string" ||
    !recoveryOwnerPattern.test(body.ownerId) ||
    !Number.isSafeInteger(body.epoch) ||
    Number(body.epoch) < 1 ||
    typeof body.permitToken !== "string" ||
    !recoveryPermitPattern.test(body.permitToken)
  )
    invalidRecoveryEffectRequest();
  try {
    assertRecoveryEffectObservation(body.kind as never, body.observation);
  } catch {
    invalidRecoveryEffectRequest();
  }
  return body as unknown as Parameters<
    RecoveryEffectAuthorityPort["reconcileRecoveryEffect"]
  >[0];
};
const persistedJobRequest = (value: unknown): PersistedJob => {
  const body = record(value);
  const observedAt = Date.parse(String(body.observedAt));
  const providerCreationNotBefore = Date.parse(
    String(body.providerCreationNotBefore),
  );
  if (
    !exactKeys(body, [
      "rolloutId",
      "serviceId",
      "jobId",
      "observedAt",
      "providerCreationNotBefore",
      "cleanupCanary",
      "lifecycle",
      "provisioningIntentId",
    ]) ||
    !nonemptyString(body.rolloutId) ||
    !nonemptyString(body.serviceId) ||
    !nonemptyString(body.jobId) ||
    typeof body.observedAt !== "string" ||
    typeof body.providerCreationNotBefore !== "string" ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(providerCreationNotBefore) ||
    observedAt < providerCreationNotBefore ||
    !nonemptyString(body.cleanupCanary) ||
    !["role", "cutover"].includes(String(body.lifecycle)) ||
    !intentIdPattern.test(String(body.provisioningIntentId))
  )
    throw Object.assign(new Error("release_runner_job_request_invalid"), {
      statusCode: 400,
    });
  return body as PersistedJob;
};
const intentIdPattern = /^rri-[a-f0-9]{64}$/u;
const claimantIdPattern =
  /^rrc-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const commandHashPattern = /^sha256:[a-f0-9]{64}$/u;
const sourceServiceIdPattern = /^srv-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const sourceFreezeRequest = (
  value: unknown,
  rolloutId: string,
  prepare = false,
) => {
  const body = record(value);
  const declared = body.declaredServiceIds;
  if (
    !exactKeys(body, [
      "rolloutId",
      "expectedCommitSha",
      "runId",
      "runAttempt",
      "sourceSystemIdentifier",
      "targetSystemIdentifier",
      "serviceId",
      "latestSuccessfulDeployId",
      "observedAt",
      "declaredServiceIds",
      ...(prepare ? ["beforeSuspended"] : []),
    ]) ||
    body.rolloutId !== rolloutId ||
    typeof body.expectedCommitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(body.expectedCommitSha) ||
    typeof body.runId !== "string" ||
    !/^[1-9][0-9]*$/u.test(body.runId) ||
    body.runAttempt !== 1 ||
    typeof body.sourceSystemIdentifier !== "string" ||
    !/^[0-9]+$/u.test(body.sourceSystemIdentifier) ||
    typeof body.targetSystemIdentifier !== "string" ||
    !/^[0-9]+$/u.test(body.targetSystemIdentifier) ||
    typeof body.serviceId !== "string" ||
    !sourceServiceIdPattern.test(body.serviceId) ||
    !nonemptyString(body.latestSuccessfulDeployId) ||
    typeof body.observedAt !== "string" ||
    !Number.isFinite(Date.parse(body.observedAt)) ||
    !Array.isArray(declared) ||
    declared.length < 1 ||
    declared.length > 100 ||
    declared.some(
      (id) => typeof id !== "string" || !sourceServiceIdPattern.test(id),
    ) ||
    new Set(declared).size !== declared.length ||
    !declared.includes(body.serviceId) ||
    (prepare && typeof body.beforeSuspended !== "boolean")
  )
    throw Object.assign(new Error("release_source_freeze_request_invalid"), {
      statusCode: 400,
    });
  return body;
};
const sourceFreezeCompletionRequest = (value: unknown, rolloutId: string) => {
  const body = record(value);
  const declared = body.declaredServiceIds;
  if (
    !exactKeys(body, [
      "rolloutId",
      "expectedCommitSha",
      "runId",
      "runAttempt",
      "sourceSystemIdentifier",
      "targetSystemIdentifier",
      "declaredServiceIds",
      "observedAt",
    ]) ||
    body.rolloutId !== rolloutId ||
    typeof body.expectedCommitSha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(body.expectedCommitSha) ||
    typeof body.runId !== "string" ||
    !/^[1-9][0-9]*$/u.test(body.runId) ||
    body.runAttempt !== 1 ||
    typeof body.sourceSystemIdentifier !== "string" ||
    !/^[0-9]+$/u.test(body.sourceSystemIdentifier) ||
    typeof body.targetSystemIdentifier !== "string" ||
    !/^[0-9]+$/u.test(body.targetSystemIdentifier) ||
    typeof body.observedAt !== "string" ||
    !Number.isFinite(Date.parse(body.observedAt)) ||
    !Array.isArray(declared) ||
    declared.length < 1 ||
    declared.length > 100 ||
    declared.some(
      (id) => typeof id !== "string" || !sourceServiceIdPattern.test(id),
    ) ||
    new Set(declared).size !== declared.length
  )
    throw Object.assign(
      new Error("release_source_freeze_completion_request_invalid"),
      { statusCode: 400 },
    );
  return body;
};
const serviceTransitionCompletionRequest = (
  value: unknown,
  rolloutId: string,
): {
  rolloutId: string;
  outcome: "target_staged" | "source_recovered";
} => {
  const body = record(value);
  if (
    !exactKeys(body, ["outcome"]) ||
    (body.outcome !== "target_staged" && body.outcome !== "source_recovered")
  )
    throw Object.assign(
      new Error("release_service_transition_request_invalid"),
      { statusCode: 400 },
    );
  return { rolloutId, outcome: body.outcome };
};
const effectPathBody = (
  value: unknown,
  intentId: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  const body = record(value);
  const keys = Object.keys(body);
  if (
    !intentIdPattern.test(intentId) ||
    !required.every((key) => keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
    body.intentId !== intentId ||
    !claimantIdPattern.test(String(body.claimantId)) ||
    !Number.isSafeInteger(body.expectedEpoch) ||
    Number(body.expectedEpoch) < 0
  )
    return invalidEffectRequest();
  return body;
};
const prepareEffectRequest = (value: unknown): CreateProvisioningIntent => {
  const body = record(value);
  if (
    !exactKeys(body, [
      "id",
      "rolloutId",
      "serviceId",
      "lifecycle",
      "workflowJobId",
      "runnerName",
      "createdAt",
      "startCommandSha256",
      "creationLeaseOwner",
    ]) ||
    !intentIdPattern.test(String(body.id)) ||
    !nonemptyString(body.rolloutId) ||
    !nonemptyString(body.serviceId) ||
    (body.lifecycle !== "role" && body.lifecycle !== "cutover") ||
    !nonemptyString(body.workflowJobId) ||
    !nonemptyString(body.runnerName) ||
    typeof body.createdAt !== "string" ||
    !Number.isFinite(Date.parse(body.createdAt)) ||
    !commandHashPattern.test(String(body.startCommandSha256)) ||
    !claimantIdPattern.test(String(body.creationLeaseOwner))
  )
    return invalidEffectRequest();
  return body as CreateProvisioningIntent;
};
const registrationRequest = (
  value: unknown,
): PersistRunnerRegistrationInput => {
  const body = record(value);
  if (
    !exactKeys(body, [
      "rolloutId",
      "lifecycle",
      "workflowJobId",
      "registration",
    ]) ||
    !nonemptyString(body.rolloutId) ||
    (body.lifecycle !== "role" && body.lifecycle !== "cutover") ||
    !nonemptyString(body.workflowJobId)
  )
    return invalidRegistrationRequest();
  const registration = record(body.registration);
  if (
    !exactKeys(registration, [
      "runnerId",
      "runnerGroupId",
      "labels",
      "uniqueLabel",
      "workFolder",
    ]) ||
    !Number.isSafeInteger(registration.runnerId) ||
    Number(registration.runnerId) <= 0 ||
    !Number.isSafeInteger(registration.runnerGroupId) ||
    Number(registration.runnerGroupId) <= 0 ||
    !Array.isArray(registration.labels) ||
    registration.labels.length === 0 ||
    registration.labels.length > 32 ||
    registration.labels.some(
      (label) =>
        typeof label !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(label),
    ) ||
    typeof registration.uniqueLabel !== "string" ||
    !/^rr-[A-Za-z0-9][A-Za-z0-9._-]{1,125}$/u.test(registration.uniqueLabel) ||
    !registration.labels.includes(registration.uniqueLabel) ||
    typeof registration.workFolder !== "string" ||
    !/^_work\/rr-[A-Za-z0-9][A-Za-z0-9._-]{1,125}$/u.test(
      registration.workFolder,
    )
  )
    return invalidRegistrationRequest();
  return {
    rolloutId: body.rolloutId,
    lifecycle: body.lifecycle,
    workflowJobId: body.workflowJobId,
    registration: {
      runnerId: Number(registration.runnerId),
      runnerGroupId: Number(registration.runnerGroupId),
      labels: Object.freeze([...registration.labels] as string[]),
      uniqueLabel: registration.uniqueLabel,
      workFolder: registration.workFolder,
    },
  };
};
export async function registerReleaseRolloutLedgerRoutes(
  app: FastifyInstance,
  dependencies: ReleaseRolloutLedgerRouteDependencies,
): Promise<void> {
  const control = async (request: FastifyRequest) =>
    authorize(request, dependencies.controlTokenSha256);
  const serviceTransition =
    (): PublicService<ReleaseServiceTransitionService> => {
      if (!dependencies.serviceTransition)
        throw Object.assign(
          new Error("release_service_transition_unavailable"),
          {
            statusCode: 503,
          },
        );
      return dependencies.serviceTransition;
    };
  const providerMutationAuthority =
    (): PublicService<ProviderMutationAuthorityService> => {
      if (!dependencies.providerMutationAuthority)
        throw Object.assign(
          new Error("provider_mutation_authority_unavailable"),
          { statusCode: 503 },
        );
      return dependencies.providerMutationAuthority;
    };
  const providerMutationControl = async (request: FastifyRequest) => {
    if (!dependencies.providerAuthorityTokenSha256)
      throw Object.assign(
        new Error("provider_mutation_authority_unavailable"),
        { statusCode: 503 },
      );
    return authorize(request, dependencies.providerAuthorityTokenSha256);
  };
  app.post(
    "/v1/provider-mutations/recover",
    { preHandler: providerMutationControl },
    async (request) =>
      providerMutationAuthority().recover(mutationIssueRequest(request.body)),
  );
  app.post(
    "/v1/provider-mutations/issue",
    { preHandler: providerMutationControl },
    async (request) =>
      providerMutationAuthority().issue(mutationIssueRequest(request.body)),
  );
  app.post(
    "/v1/provider-mutations/consume",
    { preHandler: providerMutationControl },
    async (request) =>
      providerMutationAuthority().consume(mutationPermitRequest(request.body)),
  );
  app.post(
    "/v1/provider-mutations/validate-execution",
    { preHandler: providerMutationControl },
    async (request) => ({
      authorized: await providerMutationAuthority().validateExecution(
        mutationReceiptRequest(request.body),
      ),
    }),
  );
  app.post(
    "/v1/provider-mutations/complete",
    { preHandler: providerMutationControl },
    async (request) => {
      const body = record(request.body);
      if (!exactKeys(body, ["receipt", "observation"])) invalidEffectRequest();
      await providerMutationAuthority().complete({
        receipt: mutationReceiptRequest(body.receipt),
        observation: mutationObservationRequest(body.observation),
      });
      return { completed: true };
    },
  );
  app.post(
    "/v1/provider-mutations/reconcile",
    { preHandler: providerMutationControl },
    async (request) => {
      const body = record(request.body);
      if (
        !body ||
        ![
          "precondition_drift",
          "execution_not_authorized",
          "ambiguous_forward_repair",
        ].includes(typeof body.result === "string" ? body.result : "")
      )
        invalidEffectRequest();
      await providerMutationAuthority().reconcile({
        result: body.result as ProviderMutationReconciliation["result"],
        receipt: mutationReceiptRequest(body.receipt),
        observation: mutationObservationRequest(body.observation),
      });
      return { reconciled: true };
    },
  );
  app.post(
    "/v1/service-transitions",
    { preHandler: control },
    async (request) => ({
      result: await serviceTransition().begin(
        serviceTransitionBeginRequest(request.body),
      ),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/checkpoints",
    { preHandler: control },
    async (request) => ({
      checkpoint: await serviceTransition().append(
        serviceTransitionAppendRequest(request.body, request.params.rolloutId),
      ),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/recovery-effects/intend",
    { preHandler: control },
    async (request) =>
      serviceTransition().intendRecoveryEffect(
        recoveryEffectIntendRequest(request.body, request.params.rolloutId),
      ),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/recovery-effects/claim",
    { preHandler: control },
    async (request) =>
      serviceTransition().claimRecoveryEffect(
        recoveryEffectClaimRequest(request.body, request.params.rolloutId),
      ),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/recovery-effects/consume",
    { preHandler: control },
    async (request) =>
      serviceTransition().consumeRecoveryEffectPermit(
        recoveryEffectConsumeRequest(request.body, request.params.rolloutId),
      ),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/recovery-effects/validate-execution",
    { preHandler: control },
    async (request) =>
      serviceTransition().validateRecoveryEffectExecution(
        recoveryEffectValidateExecutionRequest(
          request.body,
          request.params.rolloutId,
        ),
      ),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/recovery-effects/complete",
    { preHandler: control },
    async (request) =>
      serviceTransition().completeRecoveryEffect(
        recoveryEffectCompleteRequest(request.body, request.params.rolloutId),
      ),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/recovery-effects/reconcile",
    { preHandler: control },
    async (request) =>
      serviceTransition().reconcileRecoveryEffect(
        recoveryEffectReconcileRequest(request.body, request.params.rolloutId),
      ),
  );
  app.get<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/contract",
    { preHandler: control },
    async (request) =>
      serviceTransition().readContract(request.params.rolloutId),
  );
  app.get<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/checkpoints",
    { preHandler: control },
    async (request) => serviceTransition().read(request.params.rolloutId),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/service-transitions/:rolloutId/complete",
    { preHandler: control },
    async (request, reply) => {
      await serviceTransition().complete(
        serviceTransitionCompletionRequest(
          request.body,
          request.params.rolloutId,
        ),
      );
      return reply.code(204).send();
    },
  );
  app.post("/v1/rollouts/claim", { preHandler: control }, async (request) => ({
    result: await dependencies.authority.claim(
      rolloutClaimRequest(request.body),
    ),
  }));
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/source-freeze-completion",
    { preHandler: control },
    async (request) => {
      const validated = sourceFreezeCompletionRequest(
        request.body,
        request.params.rolloutId,
      );
      return {
        result: await dependencies.authority.completeSourceFreeze({
          rolloutId: request.params.rolloutId,
          expectedCommitSha: validated.expectedCommitSha,
          runId: validated.runId,
          runAttempt: validated.runAttempt,
          sourceSystemIdentifier: validated.sourceSystemIdentifier,
          targetSystemIdentifier: validated.targetSystemIdentifier,
          declaredServiceIds: validated.declaredServiceIds,
          observedAt: validated.observedAt,
        } as never),
      };
    },
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/source-freeze-preparations",
    { preHandler: control },
    async (request) => ({
      mutationRequired:
        await dependencies.authority.prepareSourceFreezeMutation({
          ...sourceFreezeRequest(request.body, request.params.rolloutId, true),
          rolloutId: request.params.rolloutId,
        } as never),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/cas",
    { preHandler: control },
    async (request) => ({
      changed: await dependencies.authority.cas({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/release-migration/begin",
    { preHandler: control },
    async (request) => ({
      permit: await dependencies.authority.beginReleaseMigration({
        ...migrationBeginRequest(request.body, request.params.rolloutId),
      }),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/release-migration/complete",
    { preHandler: control },
    async (request) => ({
      receipt: await dependencies.authority.completeReleaseMigration(
        migrationCompleteRequest(request.body, request.params.rolloutId),
      ),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/release-migration/fail",
    { preHandler: control },
    async (request) => {
      await dependencies.authority.failReleaseMigration(
        migrationFailRequest(request.body, request.params.rolloutId),
      );
      return { failed: true };
    },
  );
  app.get<{
    Params: { rolloutId: string };
    Querystring: { target_system_identifier: string };
  }>(
    "/v1/rollouts/:rolloutId/release-migration/checkpoint",
    { preHandler: control },
    async (request) =>
      await dependencies.authority.loadReleaseMigrationCheckpoint({
        rolloutId: request.params.rolloutId,
        targetSystemIdentifier: request.query.target_system_identifier,
      }),
  );
  app.put<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/activation-uncertain",
    { preHandler: control },
    async (request) => ({
      marked: await dependencies.authority.markUncertain({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as RolloutBinding),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/target-switch-fence",
    { preHandler: control },
    async (request) => {
      const fence = await dependencies.authority.fenceTargetSwitch({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never);
      return fence ? { changed: true, fence } : { changed: false };
    },
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/activation-authorization",
    { preHandler: control },
    async (request) => {
      const body = record(request.body);
      const authorization = await dependencies.authority.authorizeAndInstall({
        ...body,
        rolloutId: request.params.rolloutId,
      } as never);
      return { authorization };
    },
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/activation-finalize",
    { preHandler: control },
    async (request) => ({
      changed: await dependencies.authority.finalize(
        record(request.body) as never,
      ),
    }),
  );
  app.get<{
    Params: { rolloutId: string };
    Querystring: {
      source_system_identifier: string;
      target_system_identifier: string;
    };
  }>(
    "/v1/rollouts/:rolloutId/activation-state",
    { preHandler: control },
    async (request) => ({
      state: await dependencies.authority.state({
        rolloutId: request.params.rolloutId,
        sourceSystemIdentifier: request.query.source_system_identifier,
        targetSystemIdentifier: request.query.target_system_identifier,
      }),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/source-freeze-mutations",
    { preHandler: control },
    async (request) => ({
      result: await dependencies.authority.recordSourceFreezeMutation({
        ...sourceFreezeRequest(request.body, request.params.rolloutId),
        rolloutId: request.params.rolloutId,
      } as never),
    }),
  );
  app.get<{
    Params: { rolloutId: string };
    Querystring: {
      source_system_identifier: string;
      target_system_identifier: string;
    };
  }>(
    "/v1/rollouts/:rolloutId/authority-state",
    { preHandler: control },
    async (request) => ({
      state: await dependencies.authority.authorityState({
        rolloutId: request.params.rolloutId,
        sourceSystemIdentifier: request.query.source_system_identifier,
        targetSystemIdentifier: request.query.target_system_identifier,
      }),
    }),
  );
  app.get<{
    Params: { rolloutId: string };
    Querystring: {
      source_system_identifier: string;
      target_system_identifier: string;
    };
  }>(
    "/v1/rollouts/:rolloutId/compensation-checkpoint",
    { preHandler: control },
    async (request) =>
      dependencies.authority.compensationCheckpoint({
        rolloutId: request.params.rolloutId,
        sourceSystemIdentifier: request.query.source_system_identifier,
        targetSystemIdentifier: request.query.target_system_identifier,
      }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/verify-final-authority",
    { preHandler: control },
    async (request) => ({
      verified: await dependencies.authority.verifyFinalAuthority({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never),
    }),
  );
  app.post(
    "/v1/runner-jobs/intents",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.persistProvisioningIntent(
        prepareEffectRequest(request.body),
      ),
  );
  app.get<{ Querystring: { rollout_id: string } }>(
    "/v1/runner-jobs/intents",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.listIntents(request.query.rollout_id),
  );
  app.post(
    "/v1/runner-jobs/intents/:intentId/dispatch-permit",
    { preHandler: control },
    async (request) => {
      const intentId = (request.params as { intentId: string }).intentId;
      const body = effectPathBody(request.body, intentId, [
        "intentId",
        "claimantId",
        "startCommandSha256",
        "expectedEpoch",
        "leaseSeconds",
      ]);
      if (
        !commandHashPattern.test(String(body.startCommandSha256)) ||
        !Number.isSafeInteger(body.leaseSeconds) ||
        Number(body.leaseSeconds) < 30 ||
        Number(body.leaseSeconds) > 300
      )
        return invalidEffectRequest();
      return dependencies.runnerOperations.acquireProviderDispatchPermit(
        body as never,
      );
    },
  );
  app.post<{ Params: { intentId: string } }>(
    "/v1/runner-jobs/intents/:intentId/reconciliation",
    { preHandler: control },
    async (request) => {
      const body = effectPathBody(
        request.body,
        request.params.intentId,
        ["intentId", "claimantId", "expectedEpoch", "reconciliation"],
        ["jobId", "observation"],
      );
      const reconciliation = record(body.reconciliation);
      const result = reconciliation.result;
      if (
        (result !== "pending" && result !== "blocked") ||
        reconciliation.safeForCompensation !== false ||
        (result === "blocked" &&
          !["unknown", "duplicate", "timeout", "unresolved_legacy"].includes(
            String(reconciliation.reason),
          )) ||
        (body.jobId !== undefined && !nonemptyString(body.jobId)) ||
        (body.observation !== undefined &&
          (!body.observation ||
            typeof body.observation !== "object" ||
            Array.isArray(body.observation)))
      )
        return invalidEffectRequest();
      return dependencies.runnerOperations.reconcileProvisioningEffect(
        body as never,
      );
    },
  );
  app.post<{ Params: { intentId: string } }>(
    "/v1/runner-jobs/intents/:intentId/abandon",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.abandonPreparedEffect(
        effectPathBody(request.body, request.params.intentId, [
          "intentId",
          "claimantId",
          "expectedEpoch",
        ]) as never,
      ),
  );
  app.post(
    "/v1/runner-jobs",
    { preHandler: control },
    async (request, reply) => {
      await dependencies.runnerOperations.persistJob(
        persistedJobRequest(request.body),
      );
      return reply.code(204).send();
    },
  );
  app.get<{
    Querystring: {
      rollout_id: string;
      state?: string;
      lifecycle?: "role" | "cutover";
    };
  }>("/v1/runner-jobs", { preHandler: control }, async (request) =>
    request.query.lifecycle
      ? dependencies.runnerOperations.currentRunner(
          request.query.rollout_id,
          request.query.lifecycle,
        )
      : dependencies.runnerOperations.listOpenJobs(request.query.rollout_id),
  );
  app.get<{
    Querystring: { rollout_id: string; lifecycle: "role" | "cutover" };
  }>("/v1/runner-jobs/current", { preHandler: control }, async (request) =>
    dependencies.runnerOperations.currentRunner(
      request.query.rollout_id,
      request.query.lifecycle,
    ),
  );
  app.put<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/identity",
    { preHandler: control },
    async (request, reply) => {
      const body = record(request.body);
      await dependencies.runnerOperations.persistIdentity(
        request.params.jobId,
        body.identity as RunnerIdentity,
        body.observation as StepObservation,
      );
      return reply.code(204).send();
    },
  );
  app.put<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/terminal",
    { preHandler: control },
    async (request, reply) => {
      await dependencies.runnerOperations.markTerminal(
        request.params.jobId,
        record(request.body).observation as StepObservation,
      );
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/cleanup-observation",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.cleanupObservation(request.params.jobId),
  );
  app.get<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/cleanup-witness",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.cleanupWitness(request.params.jobId),
  );
  app.get<{
    Querystring: { rollout_id: string; lifecycle: "role" | "cutover" };
  }>(
    "/v1/runner-jobs/terminal-cleanup-fact",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.terminalCleanupFact(
        request.query.rollout_id,
        request.query.lifecycle,
      ),
  );
  app.post(
    "/v1/runner-jobs/registration",
    { preHandler: control },
    async (request, reply) => {
      await dependencies.runnerOperations.persistRegistration(
        registrationRequest(request.body),
      );
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/reconcile",
    { preHandler: control },
    async (request) =>
      dependencies.reconciliation.reconcile(request.params.rolloutId),
  );
  if (
    dependencies.providerAuthority &&
    dependencies.providerAuthorityTokenSha256
  )
    app.post(
      "/v1/provider-authority/decisions",
      {
        preHandler: async (request) =>
          authorize(request, dependencies.providerAuthorityTokenSha256!),
      },
      async (request) => {
        try {
          return await dependencies.providerAuthority!.decide(
            record(request.body) as unknown as ProviderAuthorityRequest,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (
            (error as { statusCode?: unknown })?.statusCode === 409 ||
            /provider authority (?:binding|receipt|state|replay) (?:denied|conflict)/u.test(
              message,
            )
          )
            throw Object.assign(
              new Error("provider_authority_decision_denied"),
              {
                statusCode: 409,
              },
            );
          throw error;
        }
      },
    );
}

export async function registerReleaseControlRoutes(
  app: FastifyInstance,
  dependencies: ReleaseControlRouteDependencies,
): Promise<void> {
  await registerReleaseRolloutLedgerRoutes(app, {
    ...dependencies,
  });
}
