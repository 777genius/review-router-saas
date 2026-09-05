import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Minimal, real FK graph for the canary's source execution, no publication. */
export async function seedCanaryPgSourceCatalog(prisma: PrismaClient) {
  const now = new Date();
  await prisma.scmRepositoryIdentity.create({
    data: {
      scmRepositoryIdentityId: "phase-scm",
      provider: "github",
      normalizedSourceBaseUrl: "https://github.com",
      externalRepositoryId: "123456789",
      createdAt: now,
    },
  });
  await prisma.repositoryConnection.update({
    where: { id: "phase-repository" },
    data: { scmRepositoryIdentityId: "phase-scm" },
  });
  await prisma.reviewProtocolLimitsV2.create({
    data: {
      protocolLimitsProfileId: "phase-limits",
      limitsDigest: sha("limits"),
      maxWorkSlots: 1,
      maxAttemptsPerSlot: 1,
      maxObservationBytes: 4096,
      maxObservationFindings: 10,
      maxProjectionBytes: 4096,
      maxProjectionFindings: 10,
      maxPublicationOperations: 10,
      maxPublicationChunks: 10,
      maxPublicationBodyBytes: 4096,
      maxRequestBatchSize: 1,
      maxLeaseDurationMs: 60000,
      maxResultReportDurationMs: 60000,
      maxReconciliationDurationMs: 60000,
      registeredAt: now,
    },
  });
  await prisma.reviewOperationalSloProfileV2.create({
    data: {
      operationalSloProfileId: "phase-slo",
      sloDigest: sha("slo"),
      integrationEventDeliveryMs: 1000,
      outboxClaimAgeMs: 1000,
      missingCompletionProcessMs: 1000,
      dueCompletionProcessMs: 1000,
      publicationReconciliationMs: 1000,
      v1DrainMs: 1000,
      admissionMs: 1000,
      pruningBacklogAgeMs: 1000,
      ownerRefs: ["fixture"],
      runbookRefs: ["fixture"],
      registeredAt: now,
    },
  });
  await prisma.producerRelease.create({
    data: {
      producerReleaseId: "phase-release",
      distributionKind: "public_reusable",
      actionCommitSha: "a".repeat(40),
      runtimeCommitSha: "a".repeat(40),
      runtimeEntrypointDigest: sha("entrypoint"),
      schemaDigest: sha("schema"),
      capabilityProfile: "fixture",
      protocolLimitsProfileId: "phase-limits",
      operationalSloProfileId: "phase-slo",
      registeredAt: now,
    },
  });
}

export async function seedCanaryPgSourceExecution(
  prisma: PrismaClient,
  runId: number,
  issued: Date,
  expires: Date,
) {
  const scope = {
    workspaceId: "phase-workspace",
    repositoryConnectionId: "phase-repository",
    scmRepositoryIdentityId: "phase-scm",
    pullRequestNumber: runId,
  };
  const revision = {
    baseSha: "c".repeat(40),
    mergeBaseSha: "c".repeat(40),
    headSha: "c".repeat(40),
    reviewRevisionHash: sha(String(runId)),
  };
  const source = { sourceRunId: String(runId), sourceRunAttempt: "2" };
  await prisma.reviewRunAuthorization.create({
    data: {
      ...scope,
      ...revision,
      ...source,
      authorizationId: `phase-authorization-${runId}`,
      workflowIdentityHash: sha("workflow"),
      trustDomain: "trusted_managed",
      producerReleaseId: "phase-release",
      selectedProtocolVersion: "2",
      schemaDigest: sha("schema"),
      protocolLimitsProfileId: "phase-limits",
      operationalSloProfileId: "phase-slo",
      mutationEpoch: 1n,
      providerVoteLanes: [],
      authorizationSafetyDecisionHash: sha("safety"),
      protocolOfferHash: sha("offer"),
      oidcReplayKeyHash: sha(`oidc-${runId}`),
      tokenSigningKeyId: "fixture",
      tokenIssuer: "fixture",
      tokenAudience: "fixture",
      expiresAt: expires,
      maxExpiresAt: expires,
      createdAt: issued,
    },
  });
  await prisma.reviewExecutionV2.create({
    data: {
      ...scope,
      ...revision,
      ...source,
      executionId: `execution-${runId}`,
      generation: 1n,
      compatibilityKey: sha("compatibility"),
      planHash: sha("plan"),
      startIdentityHash: sha(`start-${runId}`),
      canonicalStartHash: sha(`canonical-${runId}`),
      authorizationId: `phase-authorization-${runId}`,
      producerReleaseId: "phase-release",
      mutationEpoch: 1n,
      admissionSafetyDecisionHash: sha("safety"),
      protocolLimitsProfileId: "phase-limits",
      createdAt: issued,
      updatedAt: issued,
      admissionDeadlineAt: expires,
      executionDeadlineAt: expires,
      retainUntil: expires,
    },
  });
  await prisma.reviewRequestedIntent.create({
    data: {
      ...scope,
      ...revision,
      ...source,
      requestId: `phase-review-${runId}`,
      triggerKind: "pull_request_synchronized",
      deliveryIdentityHash: sha(`delivery-${runId}`),
      canonicalRequestHash: sha(`request-${runId}`),
      notBefore: issued,
      executionId: `execution-${runId}`,
      createdAt: issued,
      updatedAt: issued,
      retainUntil: expires,
    },
  });
}
