import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import {
  Prisma,
  ReviewExecutionStateV2,
  ReviewInvestigationRuntimeProfileV1,
  ReviewInvestigationStateV1,
  ReviewProviderKindV2,
  ReviewTaskKindV2,
  ReviewWorkSlotStateV2,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImportSignedInvestigationEvaluation } from "../application/use-cases/import-signed-investigation-evaluation";
import {
  InvestigationEvaluationAttestationVersion,
  InvestigationEvaluationImportErrorCode,
  InvestigationEvaluationImportStatus,
  InvestigationEvaluationSignatureAlgorithm,
  canonicalEvaluationJson,
  type InvestigationEvaluationAttestationPayload,
  type InvestigationEvaluationRecord,
} from "../domain/investigation-evaluation";
import {
  InvestigationLegacyComparison,
  InvestigationOperationalFailure,
  InvestigationReplayOutcome,
  InvestigationTelemetryConclusion,
  InvestigationTelemetryEvidenceCompleteness,
  InvestigationTelemetryProvider,
  InvestigationTelemetrySource,
  type InvestigationTelemetrySample,
  type InvestigationTerminalOperationalTelemetrySample,
} from "../domain/investigation-telemetry";
import {
  InvestigationPromotionEvidenceFreshnessPolicy,
  InvestigationPromotionSigningKeyPolicy,
  InvestigationPromotionTrustErrorCode,
  InvestigationPromotionTrustProfileVersion,
} from "../domain/promotion-trust-profile";
import { ConfiguredEd25519InvestigationEvaluationVerifier } from "../infrastructure/crypto/configured-ed25519-investigation-evaluation-verifier";
import { PrismaInvestigationEvaluationRepository } from "../infrastructure/prisma/prisma-investigation-evaluation-repository";
import { PrismaInvestigationOperations } from "../infrastructure/prisma/prisma-investigation-operations";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("Prisma signed investigation evaluation import", () => {
  let prisma: PrismaClient;
  const suffix = randomUUID();
  const certificateHash = sha(`certificate-${suffix}`);
  const certificateId = `certificate-evaluation-${suffix}`;
  const investigationId = `investigation-evaluation-${suffix}`;
  const executionId = `execution-evaluation-${suffix}`;
  const workSlotId = `slot-evaluation-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  const repositoryConnectionId = `connection-${suffix}`;
  const scmRepositoryIdentityId = `repository-${suffix}`;
  const authorizationId = `authorization-${suffix}`;
  const limitsProfileId = `limits-${suffix}`;
  const sloProfileId = `slo-${suffix}`;
  const terminalSample = terminal(certificateHash, suffix);
  let derivedSampleId: string | undefined;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 2 });
    const canonical = canonicalEvaluationJson(terminalSample);
    const now = new Date("2026-08-03T11:40:00.000Z");
    const retainUntil = new Date("2026-08-10T11:40:00.000Z");
    await prisma.reviewProtocolLimitsV2.create({
      data: {
        protocolLimitsProfileId: limitsProfileId,
        limitsDigest: sha(`limits-${suffix}`),
        maxWorkSlots: 4,
        maxAttemptsPerSlot: 2,
        maxObservationBytes: 1_000_000,
        maxObservationFindings: 100,
        maxProjectionBytes: 1_000_000,
        maxProjectionFindings: 100,
        maxPublicationOperations: 100,
        maxPublicationChunks: 100,
        maxPublicationBodyBytes: 1_000_000,
        maxRequestBatchSize: 100,
        maxLeaseDurationMs: 120_000,
        maxResultReportDurationMs: 180_000,
        maxReconciliationDurationMs: 3_600_000,
        registeredAt: now,
      },
    });
    await prisma.reviewOperationalSloProfileV2.create({
      data: {
        operationalSloProfileId: sloProfileId,
        sloDigest: sha(`slo-${suffix}`),
        integrationEventDeliveryMs: 1_000,
        outboxClaimAgeMs: 1_000,
        missingCompletionProcessMs: 1_000,
        dueCompletionProcessMs: 1_000,
        publicationReconciliationMs: 1_000,
        v1DrainMs: 1_000,
        admissionMs: 1_000,
        pruningBacklogAgeMs: 1_000,
        ownerRefs: [],
        runbookRefs: [],
        registeredAt: now,
      },
    });
    await prisma.workspace.create({
      data: { id: workspaceId, slug: workspaceId, name: workspaceId },
    });
    await prisma.scmRepositoryIdentity.create({
      data: {
        scmRepositoryIdentityId,
        provider: "github",
        normalizedSourceBaseUrl: "https://github.com",
        externalRepositoryId: `external-${suffix}`,
        createdAt: now,
      },
    });
    await prisma.repositoryConnection.create({
      data: {
        id: repositoryConnectionId,
        workspaceId,
        provider: "github",
        sourceBaseUrl: "https://github.com",
        externalRepositoryId: `external-${suffix}`,
        scmRepositoryIdentityId,
        owner: "reviewrouter-test",
        name: `evaluation-${suffix}`,
        fullName: `reviewrouter-test/evaluation-${suffix}`,
        defaultBranch: "main",
        visibility: "private",
      },
    });
    await prisma.scmRepositoryIdentity.update({
      where: { scmRepositoryIdentityId },
      data: {
        currentWorkspaceId: workspaceId,
        currentRepositoryConnectionId: repositoryConnectionId,
        boundAt: now,
      },
    });
    const releaseDigest = sha(`release-${suffix}`);
    await prisma.producerRelease.create({
      data: {
        producerReleaseId: terminalSample.producerReleaseId,
        distributionKind: "hosted_composite",
        actionCommitSha: releaseDigest.slice(0, 40),
        runtimeCommitSha: releaseDigest.slice(24, 64),
        wrapperEntrypointDigest: releaseDigest,
        runtimeEntrypointDigest: sha(`runtime-${suffix}`),
        schemaDigest: sha(`schema-${suffix}`),
        capabilityProfile: "evaluation-real-test",
        protocolLimitsProfileId: limitsProfileId,
        operationalSloProfileId: sloProfileId,
        state: "registered",
        registeredAt: now,
      },
    });
    await prisma.reviewRunAuthorization.create({
      data: {
        authorizationId,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        pullRequestNumber: 1,
        sourceRunId: `source-run-${suffix}`,
        sourceRunAttempt: "1",
        workflowIdentityHash: sha(`workflow-${suffix}`),
        baseSha: sha(`base-${suffix}`),
        mergeBaseSha: sha(`merge-base-${suffix}`),
        headSha: sha(`head-${suffix}`),
        reviewRevisionHash: terminalSample.reviewRevisionHash,
        trustDomain: "trusted_local",
        producerReleaseId: terminalSample.producerReleaseId,
        selectedProtocolVersion: "review-action-v2",
        schemaDigest: sha(`schema-${suffix}`),
        protocolLimitsProfileId: limitsProfileId,
        operationalSloProfileId: sloProfileId,
        mutationEpoch: 1n,
        providerVoteLanes: [],
        authorizationSafetyDecisionHash: sha(`authorization-safety-${suffix}`),
        protocolOfferHash: sha(`protocol-offer-${suffix}`),
        oidcReplayKeyHash: `oidc-${suffix}`,
        tokenSigningKeyId: "evaluation-real-test",
        tokenIssuer: "reviewrouter-test",
        tokenAudience: "review-run",
        state: "active",
        expiresAt: retainUntil,
        maxExpiresAt: retainUntil,
        createdAt: now,
      },
    });
    await prisma.reviewExecutionV2.create({
      data: {
        executionId,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        pullRequestNumber: 1,
        generation: 1n,
        baseSha: sha(`base-${suffix}`),
        mergeBaseSha: sha(`merge-base-${suffix}`),
        headSha: sha(`head-${suffix}`),
        reviewRevisionHash: terminalSample.reviewRevisionHash,
        compatibilityKey: `compatibility-${suffix}`,
        planHash: sha(`plan-${suffix}`),
        startIdentityHash: sha(`start-${suffix}`),
        canonicalStartHash: sha(`canonical-start-${suffix}`),
        state: ReviewExecutionStateV2.completed,
        authorizationId,
        producerReleaseId: terminalSample.producerReleaseId,
        mutationEpoch: 1n,
        admissionSafetyDecisionHash: sha(`safety-${suffix}`),
        protocolLimitsProfileId: limitsProfileId,
        sourceRunId: `source-run-${suffix}`,
        sourceRunAttempt: "1",
        createdAt: now,
        updatedAt: now,
        admissionDeadlineAt: retainUntil,
        admissionCheckedAt: now,
        executionDeadlineAt: retainUntil,
        retainUntil,
      },
    });
    await prisma.reviewExecutionWorkSlotV2.create({
      data: {
        executionId,
        workSlotId,
        planOrdinal: 0,
        taskKind: ReviewTaskKindV2.code_review,
        providerKind: ReviewProviderKindV2.codex,
        providerVoteIdentityHash: sha(`provider-vote-${suffix}`),
        shardKey: `shard-${suffix}`,
        required: true,
        attemptBudget: 1,
        retryPolicyVersion: "retry.v1",
        state: ReviewWorkSlotStateV2.satisfied,
      },
    });
    await prisma.reviewInvestigation.create({
      data: {
        investigationId,
        naturalIdentityHash: sha(`investigation-${suffix}`),
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        pullRequestNumber: 1,
        trustDomain: "disposable_test",
        authorizationScopeHash: terminalSample.repositoryScopeHash,
        baseSha: sha(`base-${suffix}`),
        mergeBaseSha: sha(`merge-base-${suffix}`),
        headSha: sha(`head-${suffix}`),
        reviewRevisionHash: terminalSample.reviewRevisionHash,
        executionId,
        workSlotId,
        stableReviewUnitKey: `stable-unit-${suffix}`,
        providerVoteLaneId: sha(`lane-${suffix}`),
        providerStrategyId: "codex-disposable-test",
        runtimeProfile:
          ReviewInvestigationRuntimeProfileV1.gateway_attested_agent_v1,
        coverageContractVersion: "coverage-real.v1",
        expansionRulesVersion: "expansion-real.v1",
        criticPolicyVersion: "critic-real.v1",
        gatewayPolicyVersion: "gateway-real.v1",
        probePolicyVersion: "probe-real.v1",
        producerReleaseId: terminalSample.producerReleaseId,
        runtimeProfileVersion: "runtime-real.v1",
        searchPolicyVersion: "search-real.v1",
        policy: {},
        state: ReviewInvestigationStateV1.concluded,
        findings: [],
        turnProvenance: [],
        conclusion: "verified_clean",
        dossierDigest: sha(`dossier-${suffix}`),
        createdAt: now,
        updatedAt: now,
        retainUntil,
      },
    });
    await prisma.reviewInvestigationCertificate.create({
      data: {
        certificateId,
        certificateHash,
        investigationId,
        terminalVersion: 1n,
        dossierDigest: sha(`dossier-${suffix}`),
        reviewRevisionHash: terminalSample.reviewRevisionHash,
        stableReviewUnitKey: `stable-unit-${suffix}`,
        providerVoteLaneId: sha(`lane-${suffix}`),
        coverageContractVersion: "coverage-real.v1",
        expansionRulesVersion: "expansion-real.v1",
        gatewayPolicyVersion: "gateway-real.v1",
        criticPolicyVersion: "critic-real.v1",
        runtimeProfileVersion: "runtime-real.v1",
        producerReleaseId: terminalSample.producerReleaseId,
        conclusion: "verified_clean",
        findingSetHash: sha(`findings-${suffix}`),
        obligationSetHash: sha(`obligations-${suffix}`),
        receiptSetHash: sha(`receipts-${suffix}`),
        scopeHash: terminalSample.repositoryScopeHash,
        coverageStateHash: sha(`coverage-state-${suffix}`),
        contextAttestationSetHash: sha(`attestations-${suffix}`),
        turnProvenanceHash: sha(`provenance-${suffix}`),
        terminalProviderKind: "codex",
        terminalActualModel: terminalSample.actualModel,
        terminalOutcomeHash: sha(`outcome-${suffix}`),
        terminalObservationCanonicalJson: "{}",
        criticAttestationId: `critic-attestation-${suffix}`,
        criticAttestationHash: sha(`critic-attestation-${suffix}`),
        criticDecision: "accept",
        issuedAt: new Date("2026-08-03T11:45:00.000Z"),
        expiresAt: new Date("2026-08-10T11:45:00.000Z"),
      },
    });
    await prisma.reviewInvestigationTelemetrySample.create({
      data: {
        sampleId: terminalSample.sampleId,
        producerReleaseId: terminalSample.producerReleaseId,
        source: terminalSample.source,
        repositoryScopeHash: terminalSample.repositoryScopeHash,
        reviewRevisionHash: terminalSample.reviewRevisionHash,
        stableReviewUnitHash: terminalSample.stableReviewUnitHash,
        payload: JSON.parse(canonical),
        payloadHash: sha(canonical),
        collectedAt: new Date(terminalSample.collectedAt),
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.reviewInvestigationPromotionReport.deleteMany({
      where: { producerReleaseId: terminalSample.producerReleaseId },
    });
    await prisma.reviewInvestigationEvaluationAttestation.deleteMany({
      where: { investigationId },
    });
    await prisma.reviewInvestigationTelemetrySample.deleteMany({
      where: {
        sampleId: {
          in: [
            terminalSample.sampleId,
            ...(derivedSampleId ? [derivedSampleId] : []),
          ],
        },
      },
    });
    await prisma.reviewInvestigationCertificate.deleteMany({
      where: { certificateId },
    });
    await prisma.reviewInvestigation.deleteMany({ where: { investigationId } });
    await prisma.reviewExecutionWorkSlotV2.deleteMany({
      where: { executionId, workSlotId },
    });
    await prisma.reviewExecutionV2.deleteMany({ where: { executionId } });
    await prisma.reviewRunAuthorization.deleteMany({
      where: { authorizationId },
    });
    await prisma.producerRelease.deleteMany({
      where: { producerReleaseId: terminalSample.producerReleaseId },
    });
    await prisma.scmRepositoryIdentity.updateMany({
      where: { scmRepositoryIdentityId },
      data: {
        currentWorkspaceId: null,
        currentRepositoryConnectionId: null,
        unboundAt: new Date(),
      },
    });
    await prisma.repositoryConnection.deleteMany({
      where: { id: repositoryConnectionId },
    });
    await prisma.scmRepositoryIdentity.deleteMany({
      where: { scmRepositoryIdentityId },
    });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.reviewOperationalSloProfileV2.deleteMany({
      where: { operationalSloProfileId: sloProfileId },
    });
    await prisma.reviewProtocolLimitsV2.deleteMany({
      where: { protocolLimitsProfileId: limitsProfileId },
    });
    await prisma.$disconnect();
  });

  it("shows a committed import to a promotion snapshot waiting on the release lock", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = evaluationPayload();
    const envelope = {
      payload,
      signature: {
        algorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
        keyId: "real-evaluator-key",
        value: sign(
          null,
          Buffer.from(canonicalEvaluationJson(payload), "utf8"),
          privateKey,
        ).toString("base64url"),
      },
    } as const;
    const signatures = new ConfiguredEd25519InvestigationEvaluationVerifier([
      {
        keyId: "real-evaluator-key",
        publicKeySpkiBase64: publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64"),
        notBefore: "2026-08-01T00:00:00.000Z",
        verifyUntil: null,
      },
    ]);
    const clock = { now: () => new Date("2026-08-03T12:00:00.000Z") };
    const persistence = new PrismaInvestigationEvaluationRepository(prisma, {
      signatures,
      clock,
    });
    let committed:
      | Readonly<{
          record: InvestigationEvaluationRecord;
          derivedSample: InvestigationTelemetrySample;
        }>
      | undefined;
    const importer = new ImportSignedInvestigationEvaluation(
      signatures,
      {
        async findSubject() {
          return {
            terminalSample,
            terminalSamplePayloadHash: sha(
              canonicalEvaluationJson(terminalSample),
            ),
            investigationId,
            certificateId,
            certificateHash,
            certificateProducerReleaseId: terminalSample.producerReleaseId,
            certificateRepositoryScopeHash: terminalSample.repositoryScopeHash,
            certificateReviewRevisionHash: terminalSample.reviewRevisionHash,
            certificateStableReviewUnitKey: `stable-unit-${suffix}`,
            certificateConclusion: terminalSample.conclusion,
          };
        },
        commit: (input) => {
          committed = input;
          return persistence.commit(input);
        },
      },
      {
        async digestUtf8(value) {
          return sha(value);
        },
      },
      clock,
    );
    const promotionOperations = new PrismaInvestigationOperations(
      prisma,
      {
        currentProtocolVersion: "review-action-v2",
        supportedGatewayPolicyVersions: new Set(["gateway.v1"]),
        acceptedProducerReleaseIds: new Set([terminalSample.producerReleaseId]),
      },
      signatures,
    );
    const promotionRead = {
      producerReleaseId: terminalSample.producerReleaseId,
      validAt: "2026-08-03T12:00:00.000Z",
      trustProfile: {
        profileVersion: InvestigationPromotionTrustProfileVersion.V1,
        corpusVersion: payload.corpus.version,
        groundTruthSetHash: payload.corpus.groundTruthSetHash,
        evaluationPolicyVersion: payload.evaluationPolicyVersion,
        freshness: {
          policy:
            InvestigationPromotionEvidenceFreshnessPolicy.IssuedAtOrAfterAndUnexpired,
          issuedAtOrAfter: payload.issuedAt,
        },
        signingKeys: {
          policy:
            InvestigationPromotionSigningKeyPolicy.ApprovedLineageAllowlist,
          lineageId: "real-evaluator-lineage",
          policyVersion: "real-evaluator-lineage.v1",
          signatureAlgorithm: envelope.signature.algorithm,
          acceptedKeyIds: [envelope.signature.keyId],
        },
      },
    } as const;
    const reportCanonicalJson = canonicalEvaluationJson({
      generatedAt: promotionRead.validAt,
      producerReleaseId: terminalSample.producerReleaseId,
    });
    const gatePrisma = createPrismaClient({
      databaseUrl: databaseUrl!,
      poolMax: 1,
    });
    const observerPrisma = createPrismaClient({
      databaseUrl: databaseUrl!,
      poolMax: 1,
    });
    const gateLocked = deferred<number>();
    const releaseGate = deferred();
    const lockKey = `review-investigation-promotion:${terminalSample.producerReleaseId}`;
    const gatePromise = gatePrisma.$transaction(
      async (transaction) => {
        await transaction.$queryRaw`
          SELECT 1::integer AS acquired
          FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
        `;
        const [connection] = await transaction.$queryRaw<
          Array<{ backendPid: number }>
        >`SELECT pg_backend_pid()::integer AS "backendPid"`;
        if (!connection) throw new Error("promotion_gate_connection_missing");
        gateLocked.resolve(connection.backendPid);
        await releaseGate.promise;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 30_000,
      },
    );

    const { first, promotionSamples } = await runConcurrencyScenario();

    derivedSampleId = first.derivedSampleId;
    const replay = await importer.execute(envelope);
    if (!committed) throw new Error("evaluation_commit_not_captured");
    if (
      committed.derivedSample.evidenceCompleteness !==
      InvestigationTelemetryEvidenceCompleteness.FullyEvaluated
    ) {
      throw new Error("evaluation_derived_sample_not_fully_evaluated");
    }
    await expect(
      persistence.commit({
        record: committed.record,
        derivedSample: {
          ...committed.derivedSample,
          expectedDefectCount: 99,
        },
      }),
    ).rejects.toThrow("evaluation_derived_sample_binding_invalid");
    const conflictingPayload: InvestigationEvaluationAttestationPayload = {
      ...payload,
      attestationId: `evaluation-conflict-${suffix}`,
      facts: {
        ...payload.facts,
        groundTruth: {
          ...payload.facts.groundTruth,
          expectedDefectCount: 2,
        },
      },
    };
    const conflictingEnvelope = {
      payload: conflictingPayload,
      signature: {
        algorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
        keyId: "real-evaluator-key",
        value: sign(
          null,
          Buffer.from(canonicalEvaluationJson(conflictingPayload), "utf8"),
          privateKey,
        ).toString("base64url"),
      },
    } as const;
    await expect(importer.execute(conflictingEnvelope)).rejects.toMatchObject({
      code: InvestigationEvaluationImportErrorCode.Conflict,
    });
    const [record, derived] = await Promise.all([
      prisma.reviewInvestigationEvaluationAttestation.findUnique({
        where: { attestationId: payload.attestationId },
      }),
      prisma.reviewInvestigationTelemetrySample.findUnique({
        where: { sampleId: first.derivedSampleId },
      }),
    ]);
    expect(first.status).toBe(InvestigationEvaluationImportStatus.Imported);
    expect(replay.status).toBe(
      InvestigationEvaluationImportStatus.AlreadyImported,
    );
    expect(record).toMatchObject({
      terminalSampleId: terminalSample.sampleId,
      derivedSampleId: first.derivedSampleId,
      certificateHash,
      corpusVersion: "corpus-real.v1",
      evaluationPolicyVersion: "evaluation-policy.v1",
      payload: {
        corpus: {
          version: "corpus-real.v1",
          groundTruthSetHash: payload.corpus.groundTruthSetHash,
        },
        facts: payload.facts,
      },
    });
    expect(record?.payloadCanonicalJson).toBe(canonicalEvaluationJson(payload));
    expect(derived?.payload).toMatchObject({
      evidenceCompleteness: "fully_evaluated",
      falseClean: true,
      expectedDefectCount: 1,
      securityViolationCount: 0,
    });
    expect(promotionSamples).toMatchObject({
      status: "complete",
      samples: expect.arrayContaining([
        expect.objectContaining({
          sampleId: first.derivedSampleId,
          evidenceCompleteness: "fully_evaluated",
        }),
      ]),
    });
    await expect(
      promotionOperations.readPromotionSampleSet({
        ...promotionRead,
        trustProfile: {
          ...promotionRead.trustProfile,
          groundTruthSetHash: "f".repeat(64),
        },
      }),
    ).rejects.toMatchObject({
      code: InvestigationPromotionTrustErrorCode.EvaluationTrustMismatch,
    });
    await expect(
      promotionOperations.readPromotionSampleSet({
        ...promotionRead,
        validAt: payload.expiresAt,
      }),
    ).rejects.toMatchObject({
      code: InvestigationPromotionTrustErrorCode.EvaluationEvidenceStale,
    });
    await expect(
      prisma.reviewInvestigationEvaluationAttestation.count({
        where: { terminalSampleId: terminalSample.sampleId },
      }),
    ).resolves.toBe(1);

    async function runConcurrencyScenario() {
      let importPromise: Promise<
        Awaited<ReturnType<typeof importer.execute>>
      > | null = null;
      let reportPromise: ReturnType<
        typeof promotionOperations.withPromotionSnapshot
      > | null = null;
      try {
        const gateBackendPid = await Promise.race([
          gateLocked.promise,
          gatePromise.then(() => {
            throw new Error("promotion_gate_released_before_test");
          }),
        ]);
        importPromise = importer.execute(envelope).then((result) => {
          derivedSampleId = result.derivedSampleId;
          return result;
        });
        await waitForAdvisoryWaiterCount(observerPrisma, gateBackendPid, 1);
        reportPromise = promotionOperations.withPromotionSnapshot(
          promotionRead,
          async (telemetry) => ({
            result: telemetry,
            reportCanonicalJson,
            reportHash: sha(reportCanonicalJson),
          }),
        );
        await waitForAdvisoryWaiterCount(observerPrisma, gateBackendPid, 2);
        releaseGate.resolve();
        const [first, promotionSamples] = await Promise.all([
          importPromise,
          reportPromise,
        ]);
        await gatePromise;
        return { first, promotionSamples };
      } finally {
        releaseGate.resolve();
        const pending: Promise<unknown>[] = [gatePromise];
        if (importPromise) pending.push(importPromise);
        if (reportPromise) pending.push(reportPromise);
        await Promise.allSettled(pending);
        await Promise.all([
          gatePrisma.$disconnect(),
          observerPrisma.$disconnect(),
        ]);
      }
    }
  }, 20_000);

  function evaluationPayload(): InvestigationEvaluationAttestationPayload {
    return {
      attestationVersion: InvestigationEvaluationAttestationVersion.V1,
      attestationId: `evaluation-${suffix}`,
      issuedAt: "2026-08-03T11:55:00.000Z",
      expiresAt: "2026-08-03T13:00:00.000Z",
      subject: {
        terminalSampleId: terminalSample.sampleId,
        terminalSamplePayloadHash: sha(canonicalEvaluationJson(terminalSample)),
        investigationId,
        certificateId,
        certificateHash,
        producerReleaseId: terminalSample.producerReleaseId,
        repositoryScopeHash: terminalSample.repositoryScopeHash,
        reviewRevisionHash: terminalSample.reviewRevisionHash,
        stableReviewUnitHash: terminalSample.stableReviewUnitHash,
      },
      corpus: {
        version: "corpus-real.v1",
        groundTruthSetHash: sha(`ground-truth-${suffix}`),
      },
      evaluationPolicyVersion: "evaluation-policy.v1",
      facts: {
        groundTruth: {
          expectedDefectCount: 1,
          detectedDefectCount: 0,
          detectedDefectSetHash: sha(`detected-${suffix}`),
        },
        security: {
          evaluationHash: sha(`security-${suffix}`),
          violationCount: 0,
        },
        legacy: {
          resultHash: sha(`legacy-${suffix}`),
          comparison: InvestigationLegacyComparison.InvestigationImproved,
        },
      },
    };
  }
});

async function waitForAdvisoryWaiterCount(
  prisma: PrismaClient,
  holderBackendPid: number,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [locks] = await prisma.$queryRaw<Array<{ waiterCount: number }>>`
      SELECT COUNT(*)::integer AS "waiterCount"
      FROM pg_locks AS waiting
      JOIN pg_locks AS held
        ON waiting.locktype = held.locktype
        AND waiting.database IS NOT DISTINCT FROM held.database
        AND waiting.classid IS NOT DISTINCT FROM held.classid
        AND waiting.objid IS NOT DISTINCT FROM held.objid
        AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
      WHERE held.pid = ${holderBackendPid}
        AND held.locktype = 'advisory'
        AND held.granted
        AND NOT waiting.granted
    `;
    if ((locks?.waiterCount ?? 0) >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`promotion_lock_waiters_missing:${expectedCount}`);
}

function deferred<Value = void>(): Readonly<{
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function terminal(
  certificateHash: string,
  suffix: string,
): InvestigationTerminalOperationalTelemetrySample {
  return {
    sampleId: `terminal-${certificateHash}`,
    collectedAt: "2026-08-03T11:50:00.000Z",
    source: InvestigationTelemetrySource.Shadow,
    evidenceCompleteness:
      InvestigationTelemetryEvidenceCompleteness.TerminalOperational,
    repositoryScopeHash: sha(`scope-${suffix}`),
    reviewRevisionHash: sha(`revision-${suffix}`),
    stableReviewUnitHash: sha(`stable-unit-${suffix}`),
    producerReleaseId: `release-${suffix}`,
    provider: InvestigationTelemetryProvider.Codex,
    actualModel: "gpt-5.6",
    conclusion: InvestigationTelemetryConclusion.VerifiedClean,
    findingCount: 0,
    expectedDefectCount: null,
    detectedDefectCount: null,
    falseClean: null,
    legacyComparison: InvestigationLegacyComparison.NotCompared,
    replayOutcome: InvestigationReplayOutcome.Miss,
    failure: InvestigationOperationalFailure.None,
    semanticTurns: 2,
    criticCycles: 1,
    gatewayOperations: 5,
    promptTokens: 700,
    completionTokens: 300,
    totalTokens: 1_000,
    durationMs: 10_000,
    timeToFirstFindingMs: null,
    capacityWaitMs: null,
    protocolBytes: 1_000,
    retainedBytes: null,
    securityViolationCount: null,
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
