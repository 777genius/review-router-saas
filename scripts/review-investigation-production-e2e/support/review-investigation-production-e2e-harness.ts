import { Buffer } from "node:buffer";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  ContextAttestationPersistenceStatus,
  ContextLeaseAuthorityKind,
  ContextGatewayV4OperationKind,
  ContextGatewayV4OutcomeKind,
  ContextProviderKind,
  activateGatewaySession,
  contextGatewayV4ManifestVersion,
  contextGatewayV4PolicyVersion,
  createAcceptedDependencyAttestation,
  openGatewaySession,
  sealGatewaySession,
  type ContextGatewayV4Event,
  type ContextGatewayV4Manifest,
  type EncryptedContextReplayMaterial,
} from "../../../packages/features/review-context-attestation/src/index.js";
import { PrismaContextAttestationStore } from "../../../packages/features/review-context-attestation/src/composition/index.js";
import {
  ProviderExecutionProfile,
  buildProviderInvocationIdentity,
  serializeProviderInvocationManifestCanonicalWireJson,
} from "../../../packages/features/review-evidence/src/index.js";
import {
  ContextCriticDecision,
  InvestigationEvidenceRequirementKind,
  InvestigationObligationKind,
  InvestigationOperationKind,
  InvestigationOperationRevision,
  InvestigationProbeKind,
  InvestigationTextSearchMatchMode,
  InvestigationTurnProviderKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationTurnPurpose,
  canonicalFileObligationSubject,
  canonicalInvestigationEvidenceRequirement,
  canonicalInvestigationTerminalObservation,
  canonicalInvestigationTurnObservation,
  canonicalInventoryObligationSubjectV2,
  canonicalPageObligationSubjectV2,
  canonicalStandardTextSearchOperationInput,
  obligationEvidenceRequirementVersionV2,
  parseSuppliedInvestigationEvidenceRequirement,
  relationSearchProofVersion,
  reviewInvestigationCoverageProfileV2,
  type InvestigationTurnObservation,
  type ReviewInvestigationPolicy,
  type SeedInvestigationObligation,
} from "../../../packages/features/review-investigations/src/index.js";
import { PrismaInvestigationStore } from "../../../packages/features/review-investigations/src/composition/index.js";
import {
  InvestigationEvaluationAttestationVersion,
  InvestigationEvaluationSignatureAlgorithm,
  InvestigationLegacyComparison,
  InvestigationPromotionEvidenceFreshnessPolicy,
  InvestigationPromotionSigningKeyPolicy,
  InvestigationPromotionTrustProfileVersion,
  InvestigationTelemetrySource,
  canonicalEvaluationJson,
  type InvestigationEvaluationAttestationPayload,
  type InvestigationPromotionProfileIdentity,
  type InvestigationPromotionTrustProfile,
  type SignedInvestigationEvaluationAttestation,
} from "../../../packages/features/review-investigation-operations/src/index.js";
import { ReviewInvocationLeasePurpose } from "../../../packages/features/review-executions/src/index.js";
import { canonicalJson } from "../../../packages/features/review-run-control/src/index.js";
import {
  createPrismaClient,
  type PrismaClient,
} from "../../../packages/platform/db/src/index.js";
import {
  ReviewActionV2OperationId,
  ReviewInvestigationMutationResultStatus,
  ReviewInvestigationNextAction,
  ReviewInvestigationOpenResultStatus,
  ReviewInvestigationLeaseResultStatus,
  ReviewInvestigationPublishedRuntimeProfile,
  ReviewInvocationLeaseResultStatus,
  canonicalizeReviewActionV2Request,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  type ReviewActionV2RequestMap,
  type ReviewInvestigationConcludeRequest,
  type ReviewInvestigationLeaseAcquireRequest,
  type ReviewInvestigationLeaseReleaseRequest,
  type ReviewInvestigationOpenV2Request,
  type ReviewInvestigationTurnCommitRequest,
  type ReviewInvestigationTurnPlanRequest,
  type ReviewInvocationLeaseAcquireRequest,
  type ReviewInvocationLeaseReleaseRequest,
} from "../../../packages/protocol-review-action-v2/src/index.js";
import {
  composeReviewActionV2ProductionRoutes,
  reviewInvestigationPrivateMaterialActiveKeyIdEnv,
  reviewInvestigationPrivateMaterialKeysEnv,
  reviewInvestigationPrivateMaterialTtlEnv,
  type ReviewActionV2ProductionRoutes,
} from "../../../apps/api/src/review-action-v2-production-composition.js";
import {
  StoredReviewInvestigationTerminalTelemetrySamples,
  composePrismaReviewInvestigationOperations,
  type ReviewInvestigationTerminalTelemetrySamplePort,
} from "../../../apps/api/src/review-investigation-operations-composition.js";
import {
  createReviewActionV2E2EHarness,
  assertDisposableDatabaseUrl,
  resetReviewActionV2E2EDatabase,
  type ReviewActionV2E2EAuthorization,
  type ReviewActionV2E2EFlow,
  type ReviewActionV2E2EHarness,
} from "../../review-action-v2-production-e2e/support/review-action-v2-e2e-harness.js";

const pullRequestNumber = 42;
const sourcePath = "src/disposable-review.txt";
const sourcePathHash = sha256(sourcePath);
const relatedPathHash = sha256("src/disposable-caller.txt");
const referenceQuery = "disposableReviewSymbol";
const referenceQueryHash = sha256(referenceQuery);
const referenceOperationInputHash = sha256(
  canonicalStandardTextSearchOperationInput(referenceQueryHash),
);
const relationQueryDigest = sha256(referenceQuery);
const inventoryTreeOid = "e".repeat(40);
const inventoryAggregateItemCount = 1;
const inventoryAggregateHash = sha256(
  canonicalJson({ paths: [sourcePathHash], treeOid: inventoryTreeOid }),
);
const inventoryAggregatePathCount = 1;
const inventoryAggregatePathSetHash = sha256(canonicalJson([sourcePathHash]));
const gatewayBinaryHash = "f".repeat(64);
const actualModel = "gpt-5.6-sol";
const privateMaterialKeyId = "review-investigation-e2e-private-material";
const providerAttemptBudget = 8;
const evaluationCorpusVersion = "production-shaped-disposable-corpus.v1";
const evaluationGroundTruthSetHash = sha256(
  "production-shaped-disposable-ground-truth.v1",
);
const evaluationPolicyVersion = "production-shaped-evaluation.v1";
const evaluationSigningKeyId = "production-shaped-e2e-evaluator";
const evaluationSigningKeyLineageId = "production-shaped-e2e-evaluator-lineage";
const evaluationSigningKeyPolicyVersion =
  "production-shaped-e2e-evaluator-lineage.v1";

export const productionInvestigationPolicy: ReviewInvestigationPolicy =
  Object.freeze({
    policyId: "production-shaped-disposable-e2e.v1",
    maxObligations: 64,
    maxExpansionDepth: 4,
    maxSemanticTurns: 8,
    maxOperationalAttempts: 8,
    maxCriticCycles: 2,
    maxFindings: 32,
    maxProposalsPerTurn: 16,
    maxReceiptsPerTurn: 64,
    maxSeedProbesPerFile: 48,
    maxSeedProbesOverall: 384,
  });

type InvestigationExecution = Readonly<{
  flow: ReviewActionV2E2EFlow;
  workspaceId: string;
  repositoryConnectionId: string;
  scmRepositoryIdentityId: string;
  stableReviewUnitKey: string;
  providerVoteLaneId: string;
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
}>;

type InvestigationRead = Readonly<{
  investigationId: string;
  investigationVersion: string;
  dossierDigest: string;
  nextAction: ReviewInvestigationNextAction;
  certificateId: string | null;
  certificateHash: string | null;
}>;

type TurnBriefObligation = Readonly<{
  obligationId: string;
  kind: InvestigationObligationKind;
  canonicalRequirement: string;
}>;

type TurnBrief = Readonly<{
  turnId: string;
  purpose: ReviewInvestigationTurnPurpose;
  obligations: readonly TurnBriefObligation[];
}>;

type ActiveLease = Readonly<{
  leaseId: string;
  attemptId: string;
  leaseCapability: string;
  fencingToken: string;
}>;

export type CompletedInvestigationFlow = Readonly<{
  investigationId: string;
  certificateId: string;
  certificateHash: string;
  terminalSampleId: string;
  executionId: string;
  expansionObligationCount: number;
  duplicateOpenVersion: string;
  duplicateCommitVersion: string;
  duplicateConcludeVersion: string;
}>;

export class ReviewInvestigationProductionE2EHarness {
  readonly base: ReviewActionV2E2EHarness;
  readonly databaseUrl: string;
  readonly policyHash: string;
  readonly coverageProfileHash: string;
  readonly promotionTrustProfile: InvestigationPromotionTrustProfile;
  readonly promotionProfile: InvestigationPromotionProfileIdentity;
  private prisma: PrismaClient;
  private routes: ReviewActionV2ProductionRoutes;
  private restartedPrisma: PrismaClient | null = null;
  private authorization: ReviewActionV2E2EAuthorization | null = null;
  private readonly operationDiagnostics: string[] = [];
  private readonly evaluatorPrivateKey: KeyObject;
  private readonly evaluationPublicKeysJson: string;

  private constructor(input: {
    databaseUrl: string;
    base: ReviewActionV2E2EHarness;
    policyHash: string;
    coverageProfileHash: string;
    promotionTrustProfile: InvestigationPromotionTrustProfile;
    evaluatorPrivateKey: KeyObject;
    evaluationPublicKeysJson: string;
  }) {
    this.databaseUrl = input.databaseUrl;
    this.base = input.base;
    this.prisma = input.base.prisma;
    this.policyHash = input.policyHash;
    this.coverageProfileHash = input.coverageProfileHash;
    this.promotionTrustProfile = input.promotionTrustProfile;
    this.promotionProfile = Object.freeze({
      id: "production",
      version: "2026-08.v1",
    });
    this.evaluatorPrivateKey = input.evaluatorPrivateKey;
    this.evaluationPublicKeysJson = input.evaluationPublicKeysJson;
    this.routes = this.composeRoutes(this.prisma);
  }

  static async create(
    databaseUrl: string,
  ): Promise<ReviewInvestigationProductionE2EHarness> {
    const policyHash = sha256(canonicalJson(productionInvestigationPolicy));
    const coverageProfileHash = sha256(
      canonicalJson(reviewInvestigationCoverageProfileV2),
    );
    const base = await createReviewActionV2E2EHarness(databaseUrl, {
      investigationProfile: {
        coverageProfileHash,
        policyHash,
        gatewayPolicyVersion: contextGatewayV4PolicyVersion,
      },
      protocolMaxAttemptsPerSlot: providerAttemptBudget,
      environmentOverrides: {
        [reviewInvestigationPrivateMaterialActiveKeyIdEnv]:
          privateMaterialKeyId,
        [reviewInvestigationPrivateMaterialKeysEnv]: JSON.stringify({
          [privateMaterialKeyId]: Buffer.alloc(32, 11).toString("base64url"),
        }),
        [reviewInvestigationPrivateMaterialTtlEnv]: "3600000",
      },
    });
    const evaluator = generateKeyPairSync("ed25519");
    const now = Date.now();
    const promotionTrustProfile: InvestigationPromotionTrustProfile =
      Object.freeze({
        profileVersion: InvestigationPromotionTrustProfileVersion.V1,
        corpusVersion: evaluationCorpusVersion,
        groundTruthSetHash: evaluationGroundTruthSetHash,
        evaluationPolicyVersion,
        freshness: Object.freeze({
          policy:
            InvestigationPromotionEvidenceFreshnessPolicy.IssuedAtOrAfterAndUnexpired,
          issuedAtOrAfter: new Date(now - 86_400_000).toISOString(),
        }),
        signingKeys: Object.freeze({
          policy:
            InvestigationPromotionSigningKeyPolicy.ApprovedLineageAllowlist,
          lineageId: evaluationSigningKeyLineageId,
          policyVersion: evaluationSigningKeyPolicyVersion,
          signatureAlgorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
          acceptedKeyIds: Object.freeze([evaluationSigningKeyId]),
        }),
      });
    return new ReviewInvestigationProductionE2EHarness({
      databaseUrl,
      base,
      policyHash,
      coverageProfileHash,
      promotionTrustProfile,
      evaluatorPrivateKey: evaluator.privateKey,
      evaluationPublicKeysJson: JSON.stringify([
        {
          keyId: evaluationSigningKeyId,
          publicKeySpkiBase64: evaluator.publicKey
            .export({ format: "der", type: "spki" })
            .toString("base64"),
          notBefore: new Date(now - 86_400_000).toISOString(),
          verifyUntil: null,
        },
      ]),
    });
  }

  get client(): PrismaClient {
    return this.prisma;
  }

  async close(): Promise<void> {
    await this.restartedPrisma?.$disconnect();
    await this.base.close();
  }

  async restartControlPlane(): Promise<void> {
    await this.restartedPrisma?.$disconnect();
    this.restartedPrisma = createPrismaClient({
      databaseUrl: this.databaseUrl,
      poolMax: 8,
    });
    this.prisma = this.restartedPrisma;
    this.routes = this.composeRoutes(this.prisma);
  }

  async runVerifiedClean(input: {
    label: string;
    expandRelations: boolean;
    terminalSource:
      | InvestigationTelemetrySource.Shadow
      | InvestigationTelemetrySource.DisposableFixture;
    restartAfterFirstCommit?: boolean;
  }): Promise<CompletedInvestigationFlow> {
    const execution = await this.createExecution();
    const { opened: open, duplicateOpenVersion } = await (async () => {
      const lease = await this.acquireTurnLease(
        execution,
        `${input.label}-open`,
      );
      try {
        const opened = await this.openInvestigation(execution, input.label);
        const duplicateOpen = await requiredHandler(
          this.routes.investigation.openV2,
        ).execute(opened.request);
        ensure(
          duplicateOpen.result.investigationId ===
            opened.read.investigationId &&
            duplicateOpen.result.investigationVersion ===
              opened.read.investigationVersion,
          "duplicate_open_not_idempotent",
        );
        await expectFailure(
          requiredHandler(this.routes.investigation.openV2).execute(
            await this.conflictingOpenRequest(opened.request),
          ),
          "conflicting_open_replay_accepted",
        );
        return Object.freeze({
          opened,
          duplicateOpenVersion: requiredString(
            duplicateOpen.result.investigationVersion,
          ),
        });
      } finally {
        await this.releaseTurnLease(execution, lease, `${input.label}-open`);
      }
    })();

    let current = open.read;
    let discoveryOrdinal = 0;
    let duplicateCommitVersion = "";
    while (current.nextAction === ReviewInvestigationNextAction.RunTurn) {
      discoveryOrdinal += 1;
      const plan = await this.planTurn(
        execution,
        current,
        `${input.label}-discovery-${discoveryOrdinal}`,
      );
      const lease = await this.acquireInvestigationTurnLease(
        execution,
        plan.read,
        plan.brief,
        plan.turnCapability,
        `${input.label}-discovery-${discoveryOrdinal}`,
      );
      const commit = await this.commitTurn({
        execution,
        current: plan.read,
        brief: plan.brief,
        turnCapability: plan.turnCapability,
        lease,
        label: `${input.label}-discovery-${discoveryOrdinal}`,
        expandRelations: input.expandRelations,
        critic: false,
        concurrentDuplicate: discoveryOrdinal === 1,
      });
      if (discoveryOrdinal === 1) {
        duplicateCommitVersion = requiredValue(
          commit.concurrentDuplicateRead,
          "concurrent_duplicate_commit_missing",
        ).investigationVersion;
        ensure(
          duplicateCommitVersion === commit.read.investigationVersion,
          "concurrent_duplicate_commit_not_idempotent",
        );
        await expectFailure(
          requiredHandler(this.routes.investigation.commitTurn).execute(
            await conflictingCommitRequest(commit.request),
          ),
          "conflicting_commit_replay_accepted",
        );
      }
      await this.releaseInvestigationTurnLease(
        execution,
        lease,
        `${input.label}-discovery-${discoveryOrdinal}`,
      );
      current = commit.read;
      if (discoveryOrdinal === 1 && input.restartAfterFirstCommit) {
        await this.restartControlPlane();
      }
    }
    ensure(
      current.nextAction === ReviewInvestigationNextAction.RunCritic,
      "critic_not_requested",
    );
    const criticPlan = await this.planTurn(
      execution,
      current,
      `${input.label}-critic`,
    );
    const criticLease = await this.acquireInvestigationTurnLease(
      execution,
      criticPlan.read,
      criticPlan.brief,
      criticPlan.turnCapability,
      `${input.label}-critic`,
    );
    const critic = await this.commitTurn({
      execution,
      current: criticPlan.read,
      brief: criticPlan.brief,
      turnCapability: criticPlan.turnCapability,
      lease: criticLease,
      label: `${input.label}-critic`,
      expandRelations: false,
      critic: true,
    });
    await this.releaseInvestigationTurnLease(
      execution,
      criticLease,
      `${input.label}-critic`,
    );
    ensure(
      critic.read.nextAction === ReviewInvestigationNextAction.Conclude,
      "investigation_not_ready_to_conclude",
    );
    if (
      input.terminalSource === InvestigationTelemetrySource.DisposableFixture
    ) {
      this.routes = this.composeRoutes(
        this.prisma,
        disposableFixtureTerminalSamples(this.prisma),
      );
    }
    const concluded = await this.conclude(
      execution,
      critic.read,
      `${input.label}-conclude`,
    );
    const concludeReplay = await requiredHandler(
      this.routes.investigation.conclude,
    ).execute(concluded.request);
    ensure(
      concludeReplay.result.investigationVersion ===
        concluded.read.investigationVersion,
      "duplicate_conclude_not_idempotent",
    );
    this.routes = this.composeRoutes(this.prisma);

    const expansionObligationCount =
      await this.prisma.reviewInvestigationObligation.count({
        where: {
          investigationId: concluded.read.investigationId,
          origin: "deterministic_expansion",
          kind: "direct_caller",
        },
      });
    const certificateHash = requiredString(concluded.read.certificateHash);
    const terminalSampleId = `terminal-${certificateHash}`;
    const terminalSampleCount =
      await this.prisma.reviewInvestigationTelemetrySample.count({
        where: { sampleId: terminalSampleId },
      });
    ensure(
      terminalSampleCount === 1,
      `terminal_telemetry_missing:${this.operationDiagnostics.join(",")}`,
    );
    ensure(
      this.operationDiagnostics.length === 0,
      `terminal_telemetry_diagnostics:${this.operationDiagnostics.join(",")}`,
    );
    await this.assertProviderAttemptBudget(execution);
    return Object.freeze({
      investigationId: concluded.read.investigationId,
      certificateId: requiredString(concluded.read.certificateId),
      certificateHash,
      terminalSampleId,
      executionId: execution.flow.executionId,
      expansionObligationCount,
      duplicateOpenVersion,
      duplicateCommitVersion,
      duplicateConcludeVersion: requiredString(
        concludeReplay.result.investigationVersion,
      ),
    });
  }

  async importEvaluation(flow: CompletedInvestigationFlow, label: string) {
    const row =
      await this.prisma.reviewInvestigationTelemetrySample.findUniqueOrThrow({
        where: { sampleId: flow.terminalSampleId },
      });
    const sample = record(row.payload);
    const now = new Date();
    const payload: InvestigationEvaluationAttestationPayload = {
      attestationVersion: InvestigationEvaluationAttestationVersion.V1,
      attestationId: `evaluation-${label}-${randomUUID()}`,
      issuedAt: new Date(now.getTime() - 1_000).toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      subject: {
        terminalSampleId: flow.terminalSampleId,
        terminalSamplePayloadHash: row.payloadHash,
        investigationId: flow.investigationId,
        certificateId: flow.certificateId,
        certificateHash: flow.certificateHash,
        producerReleaseId: requiredString(sample.producerReleaseId),
        repositoryScopeHash: requiredString(sample.repositoryScopeHash),
        reviewRevisionHash: requiredString(sample.reviewRevisionHash),
        stableReviewUnitHash: requiredString(sample.stableReviewUnitHash),
      },
      corpus: {
        version: evaluationCorpusVersion,
        groundTruthSetHash: evaluationGroundTruthSetHash,
      },
      evaluationPolicyVersion,
      facts: {
        groundTruth: {
          expectedDefectCount: 0,
          detectedDefectCount: 0,
          detectedDefectSetHash: sha256("empty-defect-set"),
        },
        security: {
          evaluationHash: sha256(`security:${label}`),
          violationCount: 0,
        },
        legacy: {
          resultHash: sha256(`legacy:${label}`),
          comparison: InvestigationLegacyComparison.Agree,
        },
      },
    };
    const envelope = this.signEvaluation(payload);
    const operations = this.operationsComposition();
    const importer = requiredValue(
      operations.operatorRoutes.evaluationImports,
      "evaluation_import_route_missing",
    );
    const first = await importer.execute(envelope);
    const replay = await importer.execute(envelope);
    await expectFailure(
      importer.execute(
        this.signEvaluation({
          ...payload,
          attestationId: `evaluation-conflict-${label}-${randomUUID()}`,
          facts: {
            ...payload.facts,
            groundTruth: {
              ...payload.facts.groundTruth,
              detectedDefectSetHash: sha256(`conflict:${label}`),
            },
          },
        }),
      ),
      "conflicting_evaluation_replay_accepted",
    );
    return Object.freeze({ first, replay });
  }

  async generatePromotionReport(
    profile: InvestigationPromotionProfileIdentity = this.promotionProfile,
  ) {
    const reports = requiredValue(
      this.operationsComposition().operatorRoutes.promotionReports,
      "promotion_report_route_missing",
    );
    return reports.execute({
      producerReleaseId: this.base.producerReleaseId,
      profile,
    });
  }

  async assertSupersededHeadFailsClosed(label: string): Promise<void> {
    const execution = await this.createExecution();
    const lease = await this.acquireTurnLease(execution, `${label}-open`);
    const opened = await (async () => {
      try {
        return await this.openInvestigation(execution, label);
      } finally {
        await this.releaseTurnLease(execution, lease, `${label}-open`);
      }
    })();
    const before = await this.prisma.reviewInvestigation.findUniqueOrThrow({
      where: { investigationId: opened.read.investigationId },
      select: {
        version: true,
        state: true,
        activeTurnId: true,
        certificateId: true,
      },
    });
    await this.base.movePersistedCurrentRevision({
      headSha: "9".repeat(40),
      reviewRevisionHash: sha256(`${label}:moved-head`),
    });
    await expectFailure(
      this.planTurn(execution, opened.read, `${label}-superseded`),
      "superseded_investigation_planned",
    );
    const persisted = await this.prisma.reviewInvestigation.findUniqueOrThrow({
      where: { investigationId: opened.read.investigationId },
      select: {
        version: true,
        state: true,
        activeTurnId: true,
        certificateId: true,
      },
    });
    ensure(
      persisted.version === before.version &&
        persisted.state === before.state &&
        persisted.activeTurnId === before.activeTurnId &&
        persisted.certificateId === before.certificateId,
      "superseded_investigation_mutated",
    );
  }

  private composeRoutes(
    prisma: PrismaClient,
    investigationTelemetrySamples?: ReviewInvestigationTerminalTelemetrySamplePort,
  ): ReviewActionV2ProductionRoutes {
    return composeReviewActionV2ProductionRoutes({
      enabled: true,
      env: this.base.env,
      runtime: {
        readServerTime: async () => new Date(),
        createRequestId: () => `investigation-e2e-${randomUUID()}`,
      },
      prisma,
      recordInvestigationOperationsDiagnostic: (code) => {
        this.operationDiagnostics.push(code);
      },
      ...(investigationTelemetrySamples
        ? { investigationTelemetrySamples }
        : {}),
    });
  }

  private operationsComposition() {
    return composePrismaReviewInvestigationOperations({
      prisma: this.prisma,
      operatorCredentialSha256: sha256("x".repeat(64)),
      promotionCredentialSha256: sha256("y".repeat(64)),
      evaluationImportCredentialSha256: sha256("z".repeat(64)),
      evaluationPublicKeysJson: this.evaluationPublicKeysJson,
      promotionPolicyProfilesJson: JSON.stringify([
        {
          identity: this.promotionProfile,
          trustProfile: this.promotionTrustProfile,
          thresholds: {
            minSeededSamples: 1,
            minShadowSamples: 1,
            maxUnexplainedDisagreements: 0,
            maxP95TotalTokens: 100_000,
            maxP95DurationMs: 600_000,
          },
        },
      ]),
      now: () => new Date(),
    });
  }

  private async createExecution(): Promise<InvestigationExecution> {
    this.authorization ??= await this.base.authorize();
    const setupFlow = await this.base.createCommittedFlow({
      slotCount: 2,
      attachSlotCount: 0,
      attemptBudget: providerAttemptBudget,
      authorization: this.authorization,
    });
    await this.base.releaseProviderLease(setupFlow);
    const investigationWorkSlotId = `${setupFlow.executionId}-slot-1`;
    const [execution, slot] = await Promise.all([
      this.prisma.reviewExecutionV2.findUniqueOrThrow({
        where: { executionId: setupFlow.executionId },
        select: { baseSha: true, mergeBaseSha: true, headSha: true },
      }),
      this.prisma.reviewExecutionWorkSlotV2.findUniqueOrThrow({
        where: {
          executionId_workSlotId: {
            executionId: setupFlow.executionId,
            workSlotId: investigationWorkSlotId,
          },
        },
        select: { shardKey: true, providerVoteIdentityHash: true },
      }),
    ]);
    const seedEnvelope = investigationSeedEnvelope(
      setupFlow.reviewRevisionHash,
    );
    const manifest = Object.freeze({
      ...setupFlow.manifest,
      requestedModel: actualModel,
      providerRequestEnvelopeHash: sha256(canonicalJson(seedEnvelope)),
      executionProfile: ProviderExecutionProfile.InvestigationGatewayV1,
    });
    const identity = await buildProviderInvocationIdentity(digestPort, {
      manifest,
      providerVoteIdentityHash: slot.providerVoteIdentityHash,
    });
    const flow = Object.freeze({
      ...setupFlow,
      workSlotId: investigationWorkSlotId,
      manifest,
      manifestCanonicalJson:
        serializeProviderInvocationManifestCanonicalWireJson(manifest),
      manifestKey: identity.manifestKey,
      providerInvocationKey: identity.providerInvocationKey,
    });
    return Object.freeze({
      flow,
      workspaceId: this.base.workspaceId,
      repositoryConnectionId: this.base.repositoryConnectionId,
      scmRepositoryIdentityId: this.base.scmRepositoryIdentityId,
      stableReviewUnitKey: slot.shardKey,
      providerVoteLaneId: slot.providerVoteIdentityHash,
      ...execution,
    });
  }

  private async openInvestigation(
    execution: InvestigationExecution,
    label: string,
  ) {
    const contract = Object.freeze({
      ...reviewInvestigationCoverageProfileV2,
      producerReleaseId: this.base.producerReleaseId,
    });
    const seedEnvelope = investigationSeedEnvelope(
      execution.flow.reviewRevisionHash,
    );
    const seedEnvelopeCanonicalJson = canonicalJson(seedEnvelope);
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationOpenV2,
      {
        ...envelope(`${label}-open`),
        authorizationToken: execution.flow.authorizationToken,
        idempotencyKey: `${label}-open`,
        requestBodyHash: zeroHash,
        authorizationId: execution.flow.authorizationId,
        executionId: execution.flow.executionId,
        workSlotId: execution.flow.workSlotId,
        reviewRevisionHash: execution.flow.reviewRevisionHash,
        stableReviewUnitKey: execution.stableReviewUnitKey,
        providerVoteLaneId: execution.providerVoteLaneId,
        providerStrategyId: execution.flow.providerInvocationKey,
        runtimeProfile:
          ReviewInvestigationPublishedRuntimeProfile.GatewayAttestedAgentV1,
        coverageContractCanonicalJson: canonicalJson(contract),
        coverageContractHash: sha256(canonicalJson(contract)),
        investigationPolicyCanonicalJson: canonicalJson(
          productionInvestigationPolicy,
        ),
        investigationPolicyHash: this.policyHash,
        seedObligationsCanonicalJson: seedEnvelopeCanonicalJson,
        seedObligationsHash: sha256(seedEnvelopeCanonicalJson),
        initialReceiptsCanonicalJson: canonicalJson([]),
        initialReceiptsHash: sha256(canonicalJson([])),
        investigationManifestCanonicalJson:
          execution.flow.manifestCanonicalJson,
        investigationManifestHash: execution.flow.manifestKey,
      } satisfies ReviewInvestigationOpenV2Request,
    );
    const response = await requiredHandler(
      this.routes.investigation.openV2,
    ).execute(request);
    ensure(
      response.result.status === ReviewInvestigationOpenResultStatus.Opened,
      "investigation_open_failed",
    );
    return Object.freeze({ request, read: readInvestigation(response.result) });
  }

  private async conflictingOpenRequest(
    request: ReviewInvestigationOpenV2Request,
  ): Promise<ReviewInvestigationOpenV2Request> {
    const current = record(JSON.parse(request.seedObligationsCanonicalJson));
    const changed = {
      ...current,
      obligations: array(current.obligations).map((seed, index) =>
        index === 0
          ? {
              ...record(seed),
              riskPriority: requiredNumber(record(seed).riskPriority) + 1,
            }
          : seed,
      ),
    };
    return withBodyHash(ReviewActionV2OperationId.ReviewInvestigationOpenV2, {
      ...request,
      requestBodyHash: zeroHash,
      seedObligationsCanonicalJson: canonicalJson(changed),
      seedObligationsHash: sha256(canonicalJson(changed)),
    });
  }

  private async planTurn(
    execution: InvestigationExecution,
    current: InvestigationRead,
    label: string,
  ) {
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationTurnPlan,
      {
        ...envelope(`${label}-plan`),
        authorizationToken: execution.flow.authorizationToken,
        idempotencyKey: `${label}-plan`,
        requestBodyHash: zeroHash,
        investigationId: current.investigationId,
        expectedVersion: current.investigationVersion,
        dossierDigest: current.dossierDigest,
        leaseDurationMs: 120_000,
        maxObligationsForTurn: 16,
        turnBudgetHash: sha256(`${label}:turn-budget`),
      } satisfies ReviewInvestigationTurnPlanRequest,
    );
    const response = await requiredHandler(
      this.routes.investigation.planTurn,
    ).execute(request);
    ensure(
      response.result.status ===
        ReviewInvestigationMutationResultStatus.Applied,
      "investigation_turn_plan_failed",
    );
    return Object.freeze({
      request,
      response,
      read: readInvestigation(response.result),
      brief: parseTurnBrief(response.result.turnBriefCanonicalJson),
      turnCapability: requiredString(response.result.turnCapability),
    });
  }

  private async commitTurn(input: {
    execution: InvestigationExecution;
    current: InvestigationRead;
    brief: TurnBrief;
    turnCapability: string;
    lease: ActiveLease;
    label: string;
    expandRelations: boolean;
    critic: boolean;
    concurrentDuplicate?: boolean;
  }) {
    const prepared = prepareTurnObservation({
      investigationId: input.current.investigationId,
      investigationVersion: Number(input.current.investigationVersion),
      brief: input.brief,
      attemptId: input.lease.attemptId,
      label: input.label,
      expandRelations: input.expandRelations,
      critic: input.critic,
    });
    const accepted = await persistAcceptedAttestation({
      prisma: this.prisma,
      execution: input.execution,
      lease: input.lease,
      observation: prepared.observation,
      events: prepared.events,
      label: input.label,
    });
    const canonicalObservation = canonicalInvestigationTurnObservation(
      prepared.observation,
    );
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationTurnCommit,
      {
        ...envelope(`${input.label}-commit`),
        authorizationToken: input.execution.flow.authorizationToken,
        leaseCapability: input.lease.leaseCapability,
        idempotencyKey: `${input.label}-commit`,
        requestBodyHash: zeroHash,
        investigationId: input.current.investigationId,
        expectedVersion: input.current.investigationVersion,
        turnId: input.brief.turnId,
        turnCapability: input.turnCapability,
        sourceLeaseId: input.lease.leaseId,
        fencingToken: input.lease.fencingToken,
        acceptedAttestationId: accepted.attestationId,
        acceptedAttestationHash: accepted.attestationHash,
        turnObservationCanonicalJson: canonicalObservation,
        turnObservationHash: sha256(canonicalObservation),
      } satisfies ReviewInvestigationTurnCommitRequest,
    );
    const handler = requiredHandler(this.routes.investigation.commitTurn);
    const responses = input.concurrentDuplicate
      ? await Promise.all([handler.execute(request), handler.execute(request)])
      : [await handler.execute(request)];
    const reads = responses.map((response) => {
      ensure(
        response.result.status ===
          ReviewInvestigationMutationResultStatus.Applied,
        "investigation_turn_commit_failed",
      );
      return readInvestigation(response.result);
    });
    if (input.concurrentDuplicate) {
      const first = requiredValue(
        reads[0],
        "investigation_turn_commit_read_missing",
      );
      ensure(
        BigInt(first.investigationVersion) ===
          BigInt(input.current.investigationVersion) + 1n,
        "concurrent_duplicate_commit_version_drift",
      );
      const receiptCount =
        await this.prisma.reviewInvestigationCommandReceipt.count({
          where: {
            investigationId: input.current.investigationId,
            commandId: request.idempotencyKey,
          },
        });
      ensure(receiptCount === 1, "concurrent_duplicate_commit_receipt_drift");
    }
    return Object.freeze({
      request,
      read: requiredValue(reads[0], "investigation_turn_commit_read_missing"),
      concurrentDuplicateRead: reads[1] ?? null,
    });
  }

  private async conclude(
    execution: InvestigationExecution,
    current: InvestigationRead,
    label: string,
  ) {
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationConclude,
      {
        ...envelope(label),
        authorizationToken: execution.flow.authorizationToken,
        idempotencyKey: label,
        requestBodyHash: zeroHash,
        investigationId: current.investigationId,
        expectedVersion: current.investigationVersion,
        dossierDigest: current.dossierDigest,
        certificateTtlMs: 86_400_000,
      } satisfies ReviewInvestigationConcludeRequest,
    );
    const response = await requiredHandler(
      this.routes.investigation.conclude,
    ).execute(request);
    return Object.freeze({ request, read: readInvestigation(response.result) });
  }

  private async acquireTurnLease(
    execution: InvestigationExecution,
    label: string,
  ): Promise<ActiveLease> {
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvocationLeaseAcquire,
      {
        ...envelope(`${label}-lease-acquire`),
        authorizationToken: execution.flow.authorizationToken,
        idempotencyKey: `${label}-lease-acquire`,
        requestBodyHash: zeroHash,
        executionId: execution.flow.executionId,
        workSlotId: execution.flow.workSlotId,
        purpose: ReviewInvocationLeasePurpose.ProviderExecution,
        manifestCanonicalJson: execution.flow.manifestCanonicalJson,
        manifestKey: execution.flow.manifestKey,
        providerVoteIdentityHash: execution.providerVoteLaneId,
        providerInvocationKey: execution.flow.providerInvocationKey,
        acquireRequestId: `${label}-lease-acquire`,
        ownerIdHash: execution.flow.ownerIdHash,
      } satisfies ReviewInvocationLeaseAcquireRequest,
    );
    const response = await requiredHandler(
      this.routes.execution.acquireLease,
    ).execute(request);
    if (response.result.status !== ReviewInvocationLeaseResultStatus.Acquired) {
      const slot =
        await this.prisma.reviewExecutionWorkSlotV2.findUniqueOrThrow({
          where: {
            executionId_workSlotId: {
              executionId: execution.flow.executionId,
              workSlotId: execution.flow.workSlotId,
            },
          },
          select: { attemptBudget: true, nextAttemptOrdinal: true },
        });
      throw new Error(
        `investigation_turn_lease_not_acquired:${response.result.status}:attempts=${slot.nextAttemptOrdinal - 1}/${slot.attemptBudget}`,
      );
    }
    return Object.freeze({
      leaseId: requiredString(response.result.leaseId),
      attemptId: requiredString(response.result.attemptId),
      leaseCapability: requiredString(response.result.leaseCapability),
      fencingToken: requiredString(response.result.fencingToken),
    });
  }

  private async acquireInvestigationTurnLease(
    execution: InvestigationExecution,
    current: InvestigationRead,
    brief: TurnBrief,
    turnCapability: string,
    label: string,
  ): Promise<ActiveLease> {
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationLeaseAcquire,
      {
        ...envelope(`${label}-investigation-lease-acquire`),
        authorizationToken: execution.flow.authorizationToken,
        idempotencyKey: `${label}-investigation-lease-acquire`,
        requestBodyHash: zeroHash,
        investigationId: current.investigationId,
        expectedVersion: current.investigationVersion,
        turnId: brief.turnId,
        turnCapability,
        providerStrategyId: execution.flow.providerInvocationKey,
        investigationManifestCanonicalJson:
          execution.flow.manifestCanonicalJson,
        investigationManifestHash: execution.flow.manifestKey,
        acquireRequestId: `${label}-investigation-lease-acquire`,
        ownerIdHash: execution.flow.ownerIdHash,
      } satisfies ReviewInvestigationLeaseAcquireRequest,
    );
    const response = await requiredHandler(
      this.routes.investigation.acquireLease,
    ).execute(request);
    ensure(
      response.result.status ===
        ReviewInvestigationLeaseResultStatus.Acquired ||
        response.result.status ===
          ReviewInvestigationLeaseResultStatus.Restored,
      `investigation_shadow_lease_not_acquired:${response.result.status}`,
    );
    return Object.freeze({
      leaseId: requiredString(response.result.leaseId),
      attemptId: requiredString(response.result.attemptId),
      leaseCapability: requiredString(response.result.leaseCapability),
      fencingToken: requiredString(response.result.fencingToken),
    });
  }

  private async releaseInvestigationTurnLease(
    execution: InvestigationExecution,
    lease: ActiveLease,
    label: string,
  ): Promise<void> {
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationLeaseRelease,
      {
        ...envelope(`${label}-investigation-lease-release`),
        leaseCapability: lease.leaseCapability,
        idempotencyKey: `${label}-investigation-lease-release`,
        requestBodyHash: zeroHash,
        leaseId: lease.leaseId,
        ownerIdHash: execution.flow.ownerIdHash,
        fencingToken: lease.fencingToken,
        releaseRequestId: `${label}-investigation-lease-release`,
      } satisfies ReviewInvestigationLeaseReleaseRequest,
    );
    const response = await requiredHandler(
      this.routes.investigation.releaseLease,
    ).execute(request);
    ensure(
      response.result.status === ReviewInvestigationLeaseResultStatus.Expired,
      `investigation_committed_lease_cleanup_drift:${response.result.status}`,
    );
  }

  private async assertProviderAttemptBudget(
    execution: InvestigationExecution,
  ): Promise<void> {
    const slot = await this.prisma.reviewExecutionWorkSlotV2.findUniqueOrThrow({
      where: {
        executionId_workSlotId: {
          executionId: execution.flow.executionId,
          workSlotId: execution.flow.workSlotId,
        },
      },
      select: { attemptBudget: true, nextAttemptOrdinal: true },
    });
    const attemptsUsed = slot.nextAttemptOrdinal - 1;
    ensure(
      slot.attemptBudget === providerAttemptBudget,
      `investigation_provider_attempt_budget_drift:${slot.attemptBudget}`,
    );
    ensure(
      attemptsUsed > 0 && attemptsUsed < slot.attemptBudget,
      `investigation_provider_attempt_budget_exhausted:${attemptsUsed}/${slot.attemptBudget}`,
    );
  }

  private async releaseTurnLease(
    execution: InvestigationExecution,
    lease: ActiveLease,
    label: string,
  ): Promise<void> {
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvocationLeaseRelease,
      {
        ...envelope(`${label}-lease-release`),
        leaseCapability: lease.leaseCapability,
        idempotencyKey: `${label}-lease-release`,
        requestBodyHash: zeroHash,
        leaseId: lease.leaseId,
        ownerIdHash: execution.flow.ownerIdHash,
        fencingToken: lease.fencingToken,
        releaseRequestId: `${label}-lease-release`,
      } satisfies ReviewInvocationLeaseReleaseRequest,
    );
    const response = await requiredHandler(
      this.routes.execution.releaseLease,
    ).execute(request);
    ensure(
      response.result.status === ReviewInvocationLeaseResultStatus.Applied,
      "investigation_turn_lease_not_released",
    );
  }

  private signEvaluation(
    payload: InvestigationEvaluationAttestationPayload,
  ): SignedInvestigationEvaluationAttestation {
    return Object.freeze({
      payload,
      signature: Object.freeze({
        algorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
        keyId: evaluationSigningKeyId,
        value: sign(
          null,
          Buffer.from(canonicalEvaluationJson(payload), "utf8"),
          this.evaluatorPrivateKey,
        ).toString("base64url"),
      }),
    });
  }
}

export async function createReviewInvestigationProductionE2EHarness(
  databaseUrl: string,
): Promise<ReviewInvestigationProductionE2EHarness> {
  return ReviewInvestigationProductionE2EHarness.create(databaseUrl);
}

export async function resetReviewInvestigationProductionE2EDatabase(
  databaseUrl: string,
): Promise<void> {
  assertDisposableDatabaseUrl(databaseUrl);
  const prisma = createPrismaClient({ databaseUrl, poolMax: 2 });
  try {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        "ReviewInvestigationEvaluationAttestation",
        "ReviewInvestigationPromotionReport",
        "ReviewInvestigationTelemetrySample",
        "ReviewInvestigationShadowEvidence",
        "ReviewInvestigationCertificate",
        "ReviewInvestigationPrivateMaterial",
        "ReviewInvestigationReceipt",
        "ReviewInvestigationTurn",
        "ReviewInvestigationObligation",
        "ReviewInvestigationCommandReceipt",
        "ReviewInvestigation",
        "ReviewContextTargetReplayProof",
        "ReviewContextReplayMaterial",
        "ReviewContextDependencyAttestation",
        "ReviewContextGatewaySession"
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await prisma.$disconnect();
  }
  await resetReviewActionV2E2EDatabase(databaseUrl);
}

function seeds(
  reviewRevisionHash: string,
): readonly SeedInvestigationObligation[] {
  const inventoryRequirement = Object.freeze({
    requirementVersion: obligationEvidenceRequirementVersionV2,
    kind: InvestigationEvidenceRequirementKind.CompleteInventory,
    reviewRevisionHash,
    treeOid: inventoryTreeOid,
    aggregateItemCount: inventoryAggregateItemCount,
    aggregateHash: inventoryAggregateHash,
    aggregatePathCount: inventoryAggregatePathCount,
    aggregatePathSetHash: inventoryAggregatePathSetHash,
  });
  return Object.freeze([
    Object.freeze({
      kind: InvestigationObligationKind.InventoryWitness,
      canonicalSubject:
        canonicalInventoryObligationSubjectV2(inventoryRequirement),
      canonicalRequirement:
        canonicalInvestigationEvidenceRequirement(inventoryRequirement),
      riskPriority: 100,
    }),
    Object.freeze({
      kind: InvestigationObligationKind.ChangedContent,
      canonicalSubject: canonicalFileObligationSubject({
        pathHash: sourcePathHash,
        revision: InvestigationOperationRevision.Head,
      }),
      canonicalRequirement: canonicalInvestigationEvidenceRequirement({
        requirementVersion: obligationEvidenceRequirementVersionV2,
        kind: InvestigationEvidenceRequirementKind.CompleteChangedFile,
        path: sourcePath,
        pathHash: sourcePathHash,
        revision: InvestigationOperationRevision.Head,
      }),
      riskPriority: 100,
    }),
    Object.freeze({
      kind: InvestigationObligationKind.DirectReferenceSearch,
      canonicalSubject: canonicalPageObligationSubjectV2({
        obligationKind: InvestigationObligationKind.DirectReferenceSearch,
        initialOperationInputHash: referenceOperationInputHash,
        probeKind: InvestigationProbeKind.DeclarationIdentifier,
        queryHash: referenceQueryHash,
      }),
      canonicalRequirement: canonicalInvestigationEvidenceRequirement({
        requirementVersion: obligationEvidenceRequirementVersionV2,
        kind: InvestigationEvidenceRequirementKind.CompletePageChain,
        operationKind: InvestigationOperationKind.TextSearch,
        initialOperationInputHash: referenceOperationInputHash,
        matchMode: InvestigationTextSearchMatchMode.FixedString,
        query: referenceQuery,
        queryHash: referenceQueryHash,
        probeKind: InvestigationProbeKind.DeclarationIdentifier,
        paths: ["."],
        pageSize: 500,
        revision: InvestigationOperationRevision.Head,
        sourcePathHash,
        searchPolicyVersion:
          reviewInvestigationCoverageProfileV2.searchPolicyVersion,
      }),
      riskPriority: 90,
    }),
  ]);
}

function investigationSeedEnvelope(reviewRevisionHash: string) {
  return Object.freeze({
    contract: "review_investigation_seed_envelope.v1",
    obligations: seeds(reviewRevisionHash),
    probePlanHash: sha256(
      canonicalJson({
        changedPaths: [sourcePath],
        probes: [referenceQueryHash],
        reviewRevisionHash,
      }),
    ),
    requestedModel: actualModel,
    reviewPromptHash: sha256(
      canonicalJson({ reviewRevisionHash, prompt: "production-shaped-e2e" }),
    ),
  });
}

function prepareTurnObservation(input: {
  investigationId: string;
  investigationVersion: number;
  brief: TurnBrief;
  attemptId: string;
  label: string;
  expandRelations: boolean;
  critic: boolean;
}): Readonly<{
  observation: InvestigationTurnObservation;
  events: readonly ContextGatewayV4Event[];
}> {
  const events: ContextGatewayV4Event[] = [];
  const claims: Array<{
    obligationId: string;
    operationReceiptIds: readonly string[];
  }> = [];
  const discoveryClaims: Array<{
    sourceObligationId: string;
    query: string;
    operationReceiptIds: readonly string[];
  }> = [];
  if (input.critic) {
    events.push(fileEvent(input.label, events.length + 1, sourcePathHash));
  } else {
    for (const obligation of input.brief.obligations) {
      const requirement = parseSuppliedInvestigationEvidenceRequirement(
        obligation.canonicalRequirement,
      );
      const receiptIds: string[] = [];
      switch (requirement.kind) {
        case InvestigationEvidenceRequirementKind.CompleteInventory: {
          const event = pageEvent({
            label: `${input.label}:inventory`,
            sequence: events.length + 1,
            operationKind: ContextGatewayV4OperationKind.CanonicalInventory,
            operationInputHash: sha256("canonical-inventory-input"),
            queryDigest: sha256("canonical-inventory-query"),
            pathHashes: [sourcePathHash],
            aggregateHash: inventoryAggregateHash,
            aggregatePathSetHash: inventoryAggregatePathSetHash,
          });
          events.push(event);
          receiptIds.push(requiredString(event.operationReceiptId));
          break;
        }
        case InvestigationEvidenceRequirementKind.CompleteChangedFile:
        case InvestigationEvidenceRequirementKind.CompleteFile: {
          const event = fileEvent(
            `${input.label}:changed-file`,
            events.length + 1,
            requirement.pathHash,
          );
          events.push(event);
          receiptIds.push(requiredString(event.operationReceiptId));
          break;
        }
        case InvestigationEvidenceRequirementKind.CompletePageChain: {
          const event = pageEvent({
            label: `${input.label}:reference-search`,
            sequence: events.length + 1,
            operationKind: ContextGatewayV4OperationKind.TextSearch,
            operationInputHash: requirement.initialOperationInputHash,
            queryDigest: relationQueryDigest,
            pathHashes: input.expandRelations ? [relatedPathHash] : [],
          });
          events.push(event);
          receiptIds.push(requiredString(event.operationReceiptId));
          if (input.expandRelations) {
            discoveryClaims.push(
              Object.freeze({
                sourceObligationId: obligation.obligationId,
                query: requirement.query,
                operationReceiptIds: Object.freeze([...receiptIds]),
              }),
            );
          }
          break;
        }
        case InvestigationEvidenceRequirementKind.CompleteRelationContext: {
          if (
            requirement.requirementVersion !==
            obligationEvidenceRequirementVersionV2
          ) {
            throw new Error("unexpected_legacy_relation_obligation");
          }
          if (
            requirement.searchProofVersion === relationSearchProofVersion ||
            requirement.requiredQueryDigest !== undefined
          ) {
            const search = pageEvent({
              label: `${input.label}:relation-search`,
              sequence: events.length + 1,
              operationKind: ContextGatewayV4OperationKind.TextSearch,
              operationInputHash: requirement.initialOperationInputHash,
              queryDigest: sha256(`${input.label}:relation-query`),
              pathHashes: requirement.requiredPathHashes,
            });
            events.push(search);
            receiptIds.push(requiredString(search.operationReceiptId));
          }
          for (const pathHash of requirement.requiredPathHashes) {
            const file = fileEvent(
              `${input.label}:relation-file:${pathHash}`,
              events.length + 1,
              pathHash,
            );
            events.push(file);
            receiptIds.push(requiredString(file.operationReceiptId));
          }
          break;
        }
        case InvestigationEvidenceRequirementKind.CompleteGitFact:
          throw new Error("unexpected_git_fact_obligation");
      }
      claims.push(
        Object.freeze({
          obligationId: obligation.obligationId,
          operationReceiptIds: Object.freeze(receiptIds),
        }),
      );
    }
  }
  chainEvents(events, sha256(`${input.label}:event-chain-seed`));
  const observation: InvestigationTurnObservation = Object.freeze({
    outputVersion: 2,
    findings: Object.freeze([]),
    obligationProposals: Object.freeze([]) as readonly [],
    closureClaims: Object.freeze(claims),
    operationBackedDiscoveryClaims: Object.freeze(discoveryClaims),
    unresolvableClaims: Object.freeze([]),
    criticDecision: input.critic ? ContextCriticDecision.Accept : null,
    observationVersion: 2,
    invocationId: `invocation-${sha256(
      `${input.investigationId}:${input.brief.turnId}:${input.attemptId}`,
    )}`,
    turnId: input.brief.turnId,
    dossierVersion: input.investigationVersion,
    purpose: input.brief.purpose,
    actualProviderKind: InvestigationTurnProviderKind.Codex,
    actualModel,
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    usage: Object.freeze({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 110,
    }),
    durationMs: 1_000,
    schemaComplete: true,
    streamComplete: true,
    contextAttestationReference: `attestation-${sha256(input.label)}`,
  });
  return Object.freeze({ observation, events: Object.freeze(events) });
}

async function persistAcceptedAttestation(input: {
  prisma: PrismaClient;
  execution: InvestigationExecution;
  lease: ActiveLease;
  observation: InvestigationTurnObservation;
  events: readonly ContextGatewayV4Event[];
  label: string;
}) {
  const nowMs = Date.now();
  const sessionId = `gateway-session-${sha256(input.label)}`;
  const attestationId = input.observation.contextAttestationReference;
  const eventChainSeedHash = sha256(`${input.label}:event-chain-seed`);
  const manifest: ContextGatewayV4Manifest = {
    manifestVersion: contextGatewayV4ManifestVersion,
    gatewayPolicyVersion: contextGatewayV4PolicyVersion,
    gatewayBinaryHash,
    checkoutTreeOid: input.execution.headSha,
    eventChainSeedHash,
    authenticatedChainHash: input.events.at(-1)!.eventHash,
    complete: true,
    confinementTainted: false,
    terminalFailureClass: null,
    events: input.events,
  };
  const active = activateGatewaySession(
    openGatewaySession({
      sessionId,
      scope: {
        workspaceId: input.execution.workspaceId,
        repositoryConnectionId: input.execution.repositoryConnectionId,
        scmRepositoryIdentityId: input.execution.scmRepositoryIdentityId,
        pullRequestNumber,
      },
      sourceRevision: {
        baseSha: input.execution.baseSha,
        mergeBaseSha: input.execution.mergeBaseSha,
        headSha: input.execution.headSha,
        reviewRevisionHash: input.execution.flow.reviewRevisionHash,
        checkoutTreeOid: input.execution.headSha,
      },
      sourceExecutionId: input.execution.flow.executionId,
      sourceWorkSlotId: input.execution.flow.workSlotId,
      attemptId: input.lease.attemptId,
      openingIntentHash: sha256(`${input.label}:opening-intent`),
      sourceLeaseAuthorityKind: ContextLeaseAuthorityKind.InvestigationShadow,
      sourceLeaseId: input.lease.leaseId,
      sourceFencingToken: input.lease.fencingToken,
      providerKind: ContextProviderKind.Codex,
      requestedModel: actualModel,
      trustedCapabilityProfile: "exact_revision_v2",
      gatewayBinaryHash,
      gatewayPolicyVersion: contextGatewayV4PolicyVersion,
      producerReleaseId: input.execution.flow.manifest.producerReleaseId,
      selectedProtocolVersion:
        input.execution.flow.manifest.selectedProtocolVersion,
      confinementProofHash: sha256(`${input.label}:confinement`),
      eventChainSeedHash,
      openedAtMs: nowMs - 1_000,
      expiresAtMs: nowMs + 600_000,
    }),
    nowMs - 900,
  );
  const sealed = sealGatewaySession(active, {
    eventCount: input.events.length,
    sealedAtMs: nowMs - 800,
  });
  const terminalOutcomeHash = sha256(
    canonicalInvestigationTerminalObservation(input.observation),
  );
  const replayMaterial: EncryptedContextReplayMaterial = {
    sessionId,
    algorithm: "aes-256-gcm-v1",
    keyId: "production-shaped-e2e-key",
    nonceBase64Url: Buffer.alloc(12, 1).toString("base64url"),
    authTagBase64Url: Buffer.alloc(16, 2).toString("base64url"),
    ciphertextBase64Url: Buffer.from("{}", "utf8").toString("base64url"),
    associatedDataHash: sha256(`${input.label}:aad`),
    plaintextHash: sha256(`${input.label}:plaintext`),
    byteCount: 2,
    expiresAtMs: nowMs + 600_000,
  };
  const accepted = createAcceptedDependencyAttestation({
    attestationId,
    attestationHash: sha256(`${input.label}:attestation`),
    session: sealed,
    manifest,
    actualModel,
    terminalOutcomeHash,
    replayMaterialHash: replayMaterial.plaintextHash,
    acceptedAtMs: nowMs - 700,
    reuseExpiresAtMs: nowMs + 300_000,
  });
  const store = new PrismaContextAttestationStore(input.prisma);
  const opened = await store.openSession(active);
  ensure(
    opened.status === ContextAttestationPersistenceStatus.Created,
    "gateway_session_not_created",
  );
  const persisted = await store.acceptAttestation({
    expectedSession: sealed,
    acceptedSession: accepted.session,
    attestation: accepted.attestation,
    replayMaterial,
  });
  ensure(
    persisted.status === ContextAttestationPersistenceStatus.Created,
    "context_attestation_not_created",
  );
  return accepted.attestation;
}

function pageEvent(input: {
  label: string;
  sequence: number;
  operationKind:
    | ContextGatewayV4OperationKind.CanonicalInventory
    | ContextGatewayV4OperationKind.TextSearch;
  operationInputHash: string;
  queryDigest: string;
  pathHashes: readonly string[];
  aggregateHash?: string;
  aggregatePathSetHash?: string;
}): ContextGatewayV4Event {
  return {
    sequence: input.sequence,
    previousEventHash: zeroHash,
    eventHash: sha256(`${input.label}:event`),
    operationKey: sha256(`${input.label}:operation-key`),
    operationKind: input.operationKind,
    outcome: ContextGatewayV4OutcomeKind.Succeeded,
    failureClass: null,
    operation: {
      kind: input.operationKind,
      inputHash: input.operationInputHash,
    },
    result: {
      treeOid: inventoryTreeOid,
      queryDigest: input.queryDigest,
      cursorInputHash: null,
      pageOrdinal: 0,
      pageItemCount: input.pathHashes.length,
      pageItemsHash: sha256(`${input.label}:page-items`),
      pagePathHashes: [...input.pathHashes],
      aggregatePathCount: input.pathHashes.length,
      aggregatePathSetHash:
        input.aggregatePathSetHash ?? sha256(canonicalJson(input.pathHashes)),
      aggregateItemCount: input.pathHashes.length,
      aggregateHash:
        input.aggregateHash ??
        sha256(canonicalJson({ label: input.label, paths: input.pathHashes })),
      complete: true,
      nextCursorHash: null,
    },
    operationReceiptId: sha256(`${input.label}:receipt`),
    sanitizedReason: null,
  };
}

function fileEvent(
  label: string,
  sequence: number,
  pathHash: string,
): ContextGatewayV4Event {
  return {
    sequence,
    previousEventHash: zeroHash,
    eventHash: sha256(`${label}:event`),
    operationKey: sha256(`${label}:operation-key`),
    operationKind: ContextGatewayV4OperationKind.FileRead,
    outcome: ContextGatewayV4OutcomeKind.Succeeded,
    failureClass: null,
    operation: {
      kind: ContextGatewayV4OperationKind.FileRead,
      inputHash: sha256(`${label}:input`),
    },
    result: {
      revision: InvestigationOperationRevision.Head,
      treeOid: inventoryTreeOid,
      pathHash,
      mode: "100644",
      blobOid: sha256(`${label}:blob`).slice(0, 40),
      contentHash: sha256(`${label}:content`),
      startByte: 0,
      byteCount: 64,
      eof: true,
      complete: true,
    },
    operationReceiptId: sha256(`${label}:receipt`),
    sanitizedReason: null,
  };
}

function chainEvents(events: ContextGatewayV4Event[], seed: string): void {
  let previous = seed;
  for (let index = 0; index < events.length; index += 1) {
    events[index] = Object.freeze({
      ...events[index]!,
      sequence: index + 1,
      previousEventHash: previous,
    });
    previous = events[index]!.eventHash;
  }
}

function disposableFixtureTerminalSamples(
  prisma: PrismaClient,
): ReviewInvestigationTerminalTelemetrySamplePort {
  const defaults = new StoredReviewInvestigationTerminalTelemetrySamples(
    new PrismaInvestigationStore(prisma),
    {
      async resolveSource() {
        return InvestigationTelemetrySource.Shadow;
      },
    },
  );
  return {
    async findTerminalSample(input) {
      const terminal = await defaults.findTerminalSample(input);
      return terminal
        ? Object.freeze({
            ...terminal,
            sample: Object.freeze({
              ...terminal.sample,
              source: InvestigationTelemetrySource.DisposableFixture,
            }),
          })
        : null;
    },
  };
}

async function conflictingCommitRequest(
  request: ReviewInvestigationTurnCommitRequest,
): Promise<ReviewInvestigationTurnCommitRequest> {
  const parsed = record(JSON.parse(request.turnObservationCanonicalJson));
  const changed = canonicalJson({
    ...parsed,
    durationMs: Number(parsed.durationMs) + 1,
  });
  return withBodyHash(ReviewActionV2OperationId.ReviewInvestigationTurnCommit, {
    ...request,
    requestBodyHash: zeroHash,
    turnObservationCanonicalJson: changed,
    turnObservationHash: sha256(changed),
  });
}

function parseTurnBrief(value: string | undefined): TurnBrief {
  const root = record(JSON.parse(requiredString(value)));
  if (!Array.isArray(root.obligations)) {
    throw new Error("turn_brief_obligations_invalid");
  }
  return Object.freeze({
    turnId: requiredString(root.turnId),
    purpose: requiredString(root.purpose) as ReviewInvestigationTurnPurpose,
    obligations: Object.freeze(
      root.obligations.map((value) => {
        const obligation = record(value);
        return Object.freeze({
          obligationId: requiredString(obligation.obligationId),
          kind: requiredString(obligation.kind) as InvestigationObligationKind,
          canonicalRequirement: requiredString(obligation.canonicalRequirement),
        });
      }),
    ),
  });
}

function readInvestigation(value: {
  readonly investigationId?: string | null;
  readonly investigationVersion?: string | null;
  readonly dossierDigest?: string | null;
  readonly nextAction?: ReviewInvestigationNextAction | null;
  readonly certificateId?: string | null;
  readonly certificateHash?: string | null;
}): InvestigationRead {
  return Object.freeze({
    investigationId: requiredString(value.investigationId),
    investigationVersion: requiredString(value.investigationVersion),
    dossierDigest: requiredString(value.dossierDigest),
    nextAction: requiredValue(value.nextAction, "next_action_missing"),
    certificateId: value.certificateId ?? null,
    certificateHash: value.certificateHash ?? null,
  });
}

async function withBodyHash<Operation extends ReviewActionV2OperationId>(
  operation: Operation,
  request: ReviewActionV2RequestMap[Operation],
): Promise<ReviewActionV2RequestMap[Operation]> {
  return {
    ...request,
    requestBodyHash: sha256(
      canonicalizeReviewActionV2Request(operation, request),
    ),
  };
}

function envelope(requestId: string) {
  return {
    protocolVersion: reviewActionV2PublishedProtocolVersion,
    schemaDigest: reviewActionV2PublishedSchemaDigest,
    requestId,
  } as const;
}

async function expectFailure(
  promise: Promise<unknown>,
  errorCode: string,
): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(errorCode);
}

function requiredHandler<T>(value: T | undefined): NonNullable<T> {
  if (!value) throw new Error("investigation_e2e_handler_missing");
  return value;
}

function requiredValue<T>(value: T | null | undefined, error: string): T {
  if (value === null || value === undefined) throw new Error(error);
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("investigation_e2e_string_expected");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("investigation_e2e_record_expected");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("investigation_e2e_array_expected");
  }
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("investigation_e2e_number_expected");
  }
  return value;
}

function ensure(condition: boolean, error: string): asserts condition {
  if (!condition) throw new Error(error);
}

const digestPort = {
  async digest(value: Uint8Array): Promise<string> {
    return createHash("sha256").update(value).digest("hex");
  },
  async digestUtf8(value: string): Promise<string> {
    return sha256(value);
  },
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const zeroHash = "0".repeat(64);
