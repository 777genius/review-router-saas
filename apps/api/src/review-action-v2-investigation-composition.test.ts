import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ContextCriticDecision,
  InvestigationTurnProviderKind,
  InvestigationLeaseAcquireStatus,
  InvestigationObligationKind,
  InvestigationObligationOrigin,
  InvestigationObligationState,
  ReviewInvestigationConclusion,
  ReviewInvestigationNextActionKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
  canonicalInvestigationCertificateCandidate,
  reviewInvestigationCoverageProfileV2,
  type ReviewInvestigation,
  type ReviewInvestigationReadModel,
} from "@reviewrouter/features-review-investigations";
import {
  ReviewActionV2ProtocolErrorCode,
  ReviewInvestigationMutationResultStatus,
  ReviewInvestigationLeaseResultStatus,
  ReviewActionV2OperationId,
  ReviewInvestigationPublishedRuntimeProfile,
  canonicalizeReviewActionV2Request,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  reviewInvestigationExtensionV1,
  type ReviewActionV2RequestMap,
  type ReviewInvestigationConcludeRequest,
  type ReviewInvestigationLeaseAcquireRequest,
  type ReviewInvestigationOpenV2Request,
  type ReviewInvestigationTurnPlanRequest,
  type ReviewInvestigationReplayV2Request,
} from "@reviewrouter/protocol-review-action-v2";
import {
  InvestigationShadowEvidenceConclusion,
  InvestigationShadowEvidenceCriticDecision,
  ProviderExecutionProfile,
  ReviewProviderKind as EvidenceProviderKind,
  ReviewTaskKind as EvidenceTaskKind,
  buildProviderInvocationIdentity,
  canonicalInvestigationShadowCertificate,
  serializeProviderInvocationManifestCanonicalWireJson,
} from "@reviewrouter/features-review-evidence";
import {
  ProducerReleaseState,
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenResolutionStatus,
  canonicalJson,
  type ReviewRunAuthorization,
} from "@reviewrouter/features-review-run-control";
import {
  ReviewExecutionProviderKind,
  ReviewExecutionState,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewTaskKind as ExecutionTaskKind,
  ReviewWorkSlotState,
} from "@reviewrouter/features-review-executions";
import { composeReviewActionV2InvestigationRoutes } from "./review-action-v2-investigation-composition.js";

const investigationLeaseHandlerStubs = {
  investigationLeaseQueries: {} as never,
  investigationLeaseCapabilities: {} as never,
  nextInvestigationLeaseId: () => "investigation-lease-1",
  nextInvestigationAttemptId: () => "investigation-attempt-1",
  investigationLeaseTiming: {
    initialLeaseDurationMs: 60_000,
    renewLeaseDurationMs: 60_000,
    retentionDurationMs: 3_600_000,
  },
} as const;

describe("Review Action v2 investigation composition", () => {
  it("keeps the shadow certificate digest preimage identical to the investigation issuer", () => {
    const certificate = concludedInvestigation().certificate!;
    const { certificateHash, ...candidate } = certificate;

    expect(certificateHash).toMatch(/^[a-f0-9]{64}$/u);

    expect(
      canonicalInvestigationShadowCertificate({
        ...candidate,
        certificateHash: certificate.certificateHash,
        conclusion: InvestigationShadowEvidenceConclusion.Findings,
        terminalProviderKind: EvidenceProviderKind.Codex,
        criticDecision: InvestigationShadowEvidenceCriticDecision.Accept,
      }),
    ).toBe(canonicalInvestigationCertificateCandidate(candidate));
  });

  it("rejects an unsupported coverage profile before opening an investigation", async () => {
    const openExecute = vi.fn();
    const releaseLookup = vi.fn();
    const routes = composeReviewActionV2InvestigationRoutes({
      enabled: true,
      runtime: {
        readServerTime: async () => now,
        createRequestId: () => "request-generated",
      },
      handlers: {
        ...investigationLeaseHandlerStubs,
        authorizations: authorizationResolver(),
        authorizationQueries: {} as never,
        executionQueries: {
          findExecution: vi.fn().mockResolvedValue({
            execution: {
              ...executionSnapshot().execution,
              workSlots: [
                {
                  workSlotId: "slot-1",
                  shardKey: "unit-1",
                  providerVoteIdentityHash: "lane-1",
                  providerKind: ReviewExecutionProviderKind.Codex,
                },
              ],
            },
          }),
        } as never,
        producerReleases: {
          findProducerReleaseById: releaseLookup,
        } as never,
        investigations: {
          open: { execute: openExecute } as never,
          restore: {} as never,
          planTurn: {} as never,
          acquireLease: {} as never,
          renewLease: {} as never,
          releaseLease: {} as never,
          commitTurn: {} as never,
          abortTurn: {} as never,
          conclude: {} as never,
          replay: {} as never,
          prepareReplay: vi.fn() as never,
          hydrateTurnObligations: null,
        },
        capabilities: {} as never,
        digest,
        now: () => now,
        rollout: allowingRollout,
        terminalShadowEvidence: { execute: vi.fn() } as never,
        crossRevisionReplayEnabled: false,
        replayPreparation: vi.fn() as never,
      },
    });
    const unsupportedContract = {
      ...reviewInvestigationCoverageProfileV2,
      gatewayPolicyVersion: "context-gateway-v999",
      producerReleaseId: authorization.producerReleaseId,
    };
    const policy = activeInvestigation().policy;
    const seedObligations: readonly unknown[] = [];
    const initialReceipts: readonly unknown[] = [];
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationOpenV2,
      {
        ...envelope("open-unsupported-profile"),
        authorizationToken: "authorization-token",
        idempotencyKey: "open-unsupported-profile-1",
        requestBodyHash: sha("placeholder"),
        authorizationId: authorization.authorizationId,
        executionId: "execution-1",
        workSlotId: "slot-1",
        reviewRevisionHash: authorization.reviewRevisionHash,
        stableReviewUnitKey: "unit-1",
        providerVoteLaneId: "lane-1",
        providerStrategyId: "strategy-1",
        runtimeProfile:
          ReviewInvestigationPublishedRuntimeProfile.GatewayAttestedAgentV1,
        coverageContractCanonicalJson: canonicalJson(unsupportedContract),
        coverageContractHash: sha(canonicalJson(unsupportedContract)),
        investigationPolicyCanonicalJson: canonicalJson(policy),
        investigationPolicyHash: sha(canonicalJson(policy)),
        seedObligationsCanonicalJson: canonicalJson(seedObligations),
        seedObligationsHash: sha(canonicalJson(seedObligations)),
        initialReceiptsCanonicalJson: canonicalJson(initialReceipts),
        initialReceiptsHash: sha(canonicalJson(initialReceipts)),
        investigationManifestCanonicalJson: "{}",
        investigationManifestHash: sha("{}"),
      } satisfies ReviewInvestigationOpenV2Request,
    );

    await expect(routes.openV2!.execute(request)).rejects.toMatchObject({
      statusCode: 403,
      errorCode: ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      issues: ["investigation_coverage_profile_unsupported"],
    });
    expect(releaseLookup).not.toHaveBeenCalled();
    expect(openExecute).not.toHaveBeenCalled();
  });

  it("acquires a dedicated shadow lease bound to the planned turn and manifest", async () => {
    const manifestCanonicalJson = canonicalJson({ manifestVersion: 1 });
    const manifestHash = sha("investigation-manifest");
    const aggregate = {
      ...activeInvestigation(),
      providerStrategyId: sha("provider-strategy"),
      investigationManifestCanonicalJson: manifestCanonicalJson,
      investigationManifestHash: manifestHash,
    } as ReviewInvestigation;
    const lease = {
      leaseId: "investigation-lease-1",
      attemptId: "investigation-attempt-1",
      fencingToken: 7n,
      expiresAt: "2026-08-02T10:10:00.000Z",
      resultReportUntil: "2026-08-02T10:20:00.000Z",
    };
    const acquire = vi.fn().mockResolvedValue({
      status: InvestigationLeaseAcquireStatus.Acquired,
      lease,
    });
    const issue = vi.fn().mockResolvedValue("shadow-lease-capability");
    const routes = composeReviewActionV2InvestigationRoutes({
      enabled: true,
      runtime: {
        readServerTime: async () => now,
        createRequestId: () => "request-generated",
      },
      handlers: {
        ...investigationLeaseHandlerStubs,
        authorizations: authorizationResolver(),
        authorizationQueries: {} as never,
        executionQueries: {
          findExecution: vi.fn().mockResolvedValue(executionSnapshot()),
        } as never,
        investigations: {
          restore: { snapshot: vi.fn().mockResolvedValue(aggregate) },
          acquireLease: { execute: acquire },
        } as never,
        capabilities: {
          verifyInvestigationTurn: vi.fn().mockResolvedValue({
            authorizationId: authorization.authorizationId,
            executionId: aggregate.executionId,
            workSlotId: aggregate.workSlotId,
            reviewRevisionHash: aggregate.revision.reviewRevisionHash,
            investigationId: aggregate.investigationId,
            investigationVersion: aggregate.version,
            dossierDigest: aggregate.dossierDigest,
            turnId: aggregate.activeTurn!.turnId,
          }),
        } as never,
        investigationLeaseCapabilities: {
          prepareIdentity: vi.fn().mockResolvedValue({
            capabilityId: "investigation-capability-1",
            signingKeyId: "shadow-key-1",
          }),
          issue,
        } as never,
        digest,
        now: () => now,
        rollout: allowingRollout,
        terminalShadowEvidence: { execute: vi.fn() } as never,
        crossRevisionReplayEnabled: false,
        replayPreparation: vi.fn() as never,
      },
    });
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationLeaseAcquire,
      {
        ...envelope("investigation-lease-acquire"),
        authorizationToken: "authorization-token",
        idempotencyKey: "investigation-lease-acquire-1",
        requestBodyHash: sha("placeholder"),
        investigationId: aggregate.investigationId,
        expectedVersion: aggregate.version.toString(10),
        turnId: aggregate.activeTurn!.turnId,
        turnCapability: "turn-capability",
        providerStrategyId: aggregate.providerStrategyId,
        investigationManifestCanonicalJson: manifestCanonicalJson,
        investigationManifestHash: manifestHash,
        acquireRequestId: "investigation-acquire-request-1",
        ownerIdHash: sha("investigation-owner"),
      } satisfies ReviewInvestigationLeaseAcquireRequest,
    );

    await expect(routes.acquireLease!.execute(request)).resolves.toMatchObject({
      statusCode: 201,
      result: {
        status: ReviewInvestigationLeaseResultStatus.Acquired,
        leaseId: lease.leaseId,
        attemptId: lease.attemptId,
        fencingToken: "7",
        leaseCapability: "shadow-lease-capability",
      },
    });
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        investigationId: aggregate.investigationId,
        turnId: aggregate.activeTurn!.turnId,
        authorizationId: authorization.authorizationId,
        mutationEpoch: authorization.mutationEpoch,
        providerStrategyId: aggregate.providerStrategyId,
        investigationManifestHash: manifestHash,
        leaseId: "investigation-lease-1",
        attemptId: "investigation-attempt-1",
        leaseCapabilityId: "investigation-capability-1",
        capabilitySigningKeyId: "shadow-key-1",
      }),
    );
    expect(issue).toHaveBeenCalledOnce();
  });

  it("projects terminal shadow evidence after conclude and heals on idempotent retry", async () => {
    const projection = vi.fn().mockResolvedValue({ status: "idempotent" });
    const telemetry = vi.fn().mockResolvedValue(undefined);
    const { routes, concludeExecute } = concludeHarness({
      projection,
      telemetry,
    });
    const request = await concludeRequest();

    await expect(routes.conclude!.execute(request)).resolves.toMatchObject({
      statusCode: 201,
    });
    await expect(routes.conclude!.execute(request)).resolves.toMatchObject({
      statusCode: 201,
    });

    expect(concludeExecute).toHaveBeenCalledTimes(2);
    expect(projection).toHaveBeenCalledTimes(2);
    expect(projection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        investigationId: "investigation-1",
        certifiedDossierDigest: sha("dossier"),
        certificate: expect.objectContaining({
          certificateId: "certificate-1",
        }),
      }),
    );
    expect(telemetry).toHaveBeenCalledTimes(2);
  });

  it("returns a retryable ambiguous outcome and heals projection on the same conclude retry", async () => {
    const projection = vi
      .fn()
      .mockRejectedValueOnce(new Error("database_down"))
      .mockResolvedValueOnce({ status: "projected" });
    const telemetry = vi.fn();
    const rollout = {
      assertAllowed: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error("rollout_disabled_after_conclusion")),
    };
    const { routes, concludeExecute } = concludeHarness({
      projection,
      telemetry,
      rollout,
    });
    const request = await concludeRequest();

    await expect(routes.conclude!.execute(request)).rejects.toMatchObject({
      statusCode: 503,
      errorCode: ReviewActionV2ProtocolErrorCode.AmbiguousOutcome,
      issues: ["investigation_shadow_evidence_projection_pending"],
    });
    await expect(routes.conclude!.execute(request)).resolves.toMatchObject({
      statusCode: 201,
    });
    expect(concludeExecute).toHaveBeenCalledTimes(2);
    expect(projection).toHaveBeenCalledTimes(2);
    expect(telemetry).toHaveBeenCalledOnce();
    expect(rollout.assertAllowed).toHaveBeenCalledOnce();
  });

  it("returns a canonical turn brief bound to the restored active turn", async () => {
    const aggregate = activeInvestigation();
    const readModel = activeReadModel();
    const rollout = { assertAllowed: vi.fn().mockResolvedValue(undefined) };
    const hydratedRequirement =
      '{"kind":"complete_page_chain","query":"transient-query"}';
    const hydrateTurnObligations = vi.fn().mockResolvedValue([
      {
        obligationId: aggregate.obligations[0]!.obligationId,
        kind: aggregate.obligations[0]!.kind,
        canonicalSubject: aggregate.obligations[0]!.canonicalSubject,
        canonicalRequirement: hydratedRequirement,
        riskPriority: aggregate.obligations[0]!.riskPriority,
        origin: aggregate.obligations[0]!.origin,
      },
    ]);
    const routes = composeReviewActionV2InvestigationRoutes({
      enabled: true,
      runtime: {
        readServerTime: async () => now,
        createRequestId: () => "request-generated",
      },
      handlers: {
        ...investigationLeaseHandlerStubs,
        authorizations: {
          async resolveReviewRunAuthorizationToken() {
            return {
              status: ReviewRunAuthorizationTokenResolutionStatus.Valid,
              authorization: authorization as unknown as ReviewRunAuthorization,
            };
          },
        },
        authorizationQueries: {} as never,
        executionQueries: {
          findExecution: vi.fn().mockResolvedValue(executionSnapshot()),
        } as never,
        investigations: {
          open: {} as never,
          restore: {
            snapshot: vi.fn().mockResolvedValue(aggregate),
            execute: vi.fn().mockResolvedValue(readModel),
          } as never,
          planTurn: { execute: vi.fn() } as never,
          acquireLease: {} as never,
          renewLease: {} as never,
          releaseLease: {} as never,
          commitTurn: {} as never,
          abortTurn: {} as never,
          conclude: {} as never,
          replay: {} as never,
          prepareReplay: vi.fn() as never,
          hydrateTurnObligations: {
            execute: hydrateTurnObligations,
          } as never,
        },
        capabilities: {
          issueInvestigationTurn: vi
            .fn()
            .mockResolvedValue("turn.capability.value"),
        } as never,
        digest,
        now: () => now,
        rollout,
        terminalShadowEvidence: { execute: vi.fn() } as never,
        crossRevisionReplayEnabled: false,
        replayPreparation: vi.fn() as never,
      },
    });
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationTurnPlan,
      {
        ...envelope("plan-turn"),
        authorizationToken: "authorization-token",
        idempotencyKey: "plan-turn-1",
        requestBodyHash: sha("placeholder"),
        investigationId: aggregate.investigationId,
        expectedVersion: String(aggregate.version),
        dossierDigest: aggregate.dossierDigest,
        leaseDurationMs: 60_000,
        maxObligationsForTurn: 4,
        turnBudgetHash: sha("turn-budget"),
      } satisfies ReviewInvestigationTurnPlanRequest,
    );

    const response = await routes.planTurn!.execute(request);
    const brief = JSON.parse(response.result.turnBriefCanonicalJson!);

    expect(response.result.status).toBe(
      ReviewInvestigationMutationResultStatus.Applied,
    );
    expect(response.result.turnBriefHash).toBe(
      sha(response.result.turnBriefCanonicalJson!),
    );
    expect(brief).toEqual({
      briefVersion: 1,
      investigationId: aggregate.investigationId,
      investigationVersion: aggregate.version,
      dossierDigest: aggregate.dossierDigest,
      turnId: aggregate.activeTurn!.turnId,
      purpose: aggregate.activeTurn!.purpose,
      maximumSemanticRiskPriority: 100,
      obligations: [
        {
          obligationId: sha("obligation"),
          kind: InvestigationObligationKind.ChangedContent,
          canonicalSubject: "src/review.ts",
          canonicalRequirement: hydratedRequirement,
          riskPriority: 100,
          origin: InvestigationObligationOrigin.CoverageContract,
        },
      ],
    });
    expect(rollout.assertAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "recording" }),
    );
    expect(hydrateTurnObligations).toHaveBeenCalledWith({
      investigation: aggregate,
      obligationIds: aggregate.activeTurn!.obligationIds,
    });
  });

  it("binds aggregate semantic risk to an empty critic turn brief", async () => {
    const base = activeInvestigation();
    const changed = {
      ...base.obligations[0]!,
      riskPriority: 900_000,
      state: InvestigationObligationState.Satisfied,
    };
    const activeTurn = {
      ...base.activeTurn!,
      purpose: ReviewInvestigationTurnPurpose.Critic,
      obligationIds: [],
    };
    const aggregate = {
      ...base,
      activeTurn,
      obligations: [
        {
          ...changed,
          obligationId: sha("inventory-obligation"),
          kind: InvestigationObligationKind.InventoryWitness,
          riskPriority: 1_000_000,
        },
        changed,
        {
          ...changed,
          obligationId: sha("critic-obligation"),
          kind: InvestigationObligationKind.ContextCritic,
          riskPriority: 999_999,
        },
      ],
    } as ReviewInvestigation;
    const readModel = {
      ...activeReadModel(),
      openObligationCount: 0,
      satisfiedObligationCount: 3,
      nextAction: ReviewInvestigationNextActionKind.RunCritic,
      turn: activeTurn,
    } as ReviewInvestigationReadModel;
    const routes = composeReviewActionV2InvestigationRoutes({
      enabled: true,
      runtime: {
        readServerTime: async () => now,
        createRequestId: () => "request-generated",
      },
      handlers: {
        ...investigationLeaseHandlerStubs,
        authorizations: authorizationResolver(),
        authorizationQueries: {} as never,
        executionQueries: {
          findExecution: vi.fn().mockResolvedValue(executionSnapshot()),
        } as never,
        investigations: {
          open: {} as never,
          restore: {
            snapshot: vi.fn().mockResolvedValue(aggregate),
            execute: vi.fn().mockResolvedValue(readModel),
          } as never,
          planTurn: { execute: vi.fn() } as never,
          acquireLease: {} as never,
          renewLease: {} as never,
          releaseLease: {} as never,
          commitTurn: {} as never,
          abortTurn: {} as never,
          conclude: {} as never,
          replay: {} as never,
          prepareReplay: vi.fn() as never,
          hydrateTurnObligations: null,
        },
        capabilities: {
          issueInvestigationTurn: vi
            .fn()
            .mockResolvedValue("turn.capability.value"),
        } as never,
        digest,
        now: () => now,
        rollout: allowingRollout,
        terminalShadowEvidence: { execute: vi.fn() } as never,
        crossRevisionReplayEnabled: false,
        replayPreparation: vi.fn() as never,
      },
    });
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationTurnPlan,
      {
        ...envelope("plan-empty-critic"),
        authorizationToken: "authorization-token",
        idempotencyKey: "plan-empty-critic-1",
        requestBodyHash: sha("placeholder"),
        investigationId: aggregate.investigationId,
        expectedVersion: String(aggregate.version),
        dossierDigest: aggregate.dossierDigest,
        leaseDurationMs: 60_000,
        maxObligationsForTurn: 4,
        turnBudgetHash: sha("turn-budget"),
      } satisfies ReviewInvestigationTurnPlanRequest,
    );

    const response = await routes.planTurn!.execute(request);
    expect(JSON.parse(response.result.turnBriefCanonicalJson!)).toMatchObject({
      purpose: ReviewInvestigationTurnPurpose.Critic,
      maximumSemanticRiskPriority: 900_000,
      obligations: [],
    });
  });

  it("binds replay to the authorized target revision and source scope", async () => {
    const targetPolicy = activeInvestigation().policy;
    const targetContract = {
      ...reviewInvestigationCoverageProfileV2,
      producerReleaseId: authorization.producerReleaseId,
    };
    const targetSeedEnvelope = {
      contract: "review_investigation_seed_envelope.v1",
      obligations: [
        {
          kind: InvestigationObligationKind.InventoryWitness,
          canonicalSubject: "target-inventory",
          canonicalRequirement: "target-inventory-complete",
          riskPriority: 1_000_000,
        },
      ],
      probePlanHash: sha("target-probe-plan"),
      requestedModel: "gpt-test",
      reviewPromptHash: sha("target-review-prompt"),
    };
    const targetSeedCanonicalJson = canonicalJson(targetSeedEnvelope);
    const targetSeedHash = sha(targetSeedCanonicalJson);
    const targetProviderVoteLaneId = sha("target-lane");
    const targetManifest = {
      manifestVersion: 1,
      scopeHash: await authorizationScopeHash(),
      taskKindSet: [EvidenceTaskKind.FindingDiscovery],
      providerKind: EvidenceProviderKind.Codex,
      providerCapabilityHash: sha("target-capability"),
      requestedModel: targetSeedEnvelope.requestedModel,
      providerPolicyVersion: "codex-provider-policy.v2-t0",
      producerReleaseId: authorization.producerReleaseId,
      selectedProtocolVersion: authorization.selectedProtocolVersion,
      providerRequestEnvelopeHash: targetSeedHash,
      outputSchemaHash: sha("target-schema"),
      reviewConfigHash: sha("target-config"),
      runtimeCompatibilityKey: sha("target-runtime"),
      filePatchManifestHash: sha("target-patch"),
      contextManifestHash: sha("target-context"),
      memoryBundleHash: null,
      codeGraphProjectionHash: null,
      lifecycleTargetSetHash: null,
      liveLifecycleStateHash: null,
      toolPolicyHash: sha("target-tools"),
      executionProfile: ProviderExecutionProfile.InvestigationGatewayV1,
      baseTreeHash: sha("target-base-tree"),
      environmentContractHash: sha("target-environment"),
    } as const;
    const targetManifestCanonicalJson =
      serializeProviderInvocationManifestCanonicalWireJson(targetManifest);
    const targetIdentity = await buildProviderInvocationIdentity(digest, {
      manifest: targetManifest,
      providerVoteIdentityHash: targetProviderVoteLaneId,
    });
    const targetProviderStrategyId = targetIdentity.providerInvocationKey;
    const source = {
      ...activeInvestigation(),
      state: ReviewInvestigationState.Concluded,
      activeTurn: null,
      revision: {
        ...activeInvestigation().revision,
        headSha: "4".repeat(40),
        reviewRevisionHash: sha("source-revision"),
      },
      scope: {
        ...activeInvestigation().scope,
        authorizationScopeHash: await authorizationScopeHash(),
      },
    } as ReviewInvestigation;
    const replayExecute = vi.fn().mockResolvedValue(activeReadModel());
    const routes = composeReviewActionV2InvestigationRoutes({
      enabled: true,
      runtime: {
        readServerTime: async () => now,
        createRequestId: () => "request-generated",
      },
      handlers: {
        ...investigationLeaseHandlerStubs,
        authorizations: {
          async resolveReviewRunAuthorizationToken() {
            return {
              status: ReviewRunAuthorizationTokenResolutionStatus.Valid,
              authorization: authorization as unknown as ReviewRunAuthorization,
            };
          },
        },
        authorizationQueries: {} as never,
        executionQueries: {
          findExecution: vi.fn().mockResolvedValue({
            execution: {
              executionId: "execution-target",
              authorizationId: authorization.authorizationId,
              workspaceId: authorization.workspaceId,
              repositoryConnectionId: authorization.repositoryConnectionId,
              scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
              pullRequestNumber: authorization.pullRequestNumber,
              revision: {
                reviewRevisionHash: authorization.reviewRevisionHash,
              },
              state: ReviewExecutionState.Running,
              workSlots: [
                {
                  workSlotId: "slot-target",
                  taskKind: ExecutionTaskKind.FindingDiscovery,
                  providerKind: ReviewExecutionProviderKind.Codex,
                  providerVoteIdentityHash: targetProviderVoteLaneId,
                  shardKey: "unit-target",
                  state: ReviewWorkSlotState.Leased,
                  activeLeaseId: "lease-target",
                },
              ],
            },
            stream: {
              activeExecutionId: "execution-target",
              currentRevision: {
                reviewRevisionHash: authorization.reviewRevisionHash,
              },
            },
            activeLeases: [
              {
                leaseId: "lease-target",
                executionId: "execution-target",
                workSlotId: "slot-target",
                purpose: ReviewInvocationLeasePurpose.ProviderExecution,
                state: ReviewInvocationLeaseState.Active,
                expiresAt: new Date(now.getTime() + 60_000),
                attemptId: "attempt-target",
                preparedManifestCanonicalJson: targetManifestCanonicalJson,
                preparedManifestKey: sha("target-manifest"),
                authorizationId: authorization.authorizationId,
                producerReleaseId: authorization.producerReleaseId,
                reviewRevisionHash: authorization.reviewRevisionHash,
                providerVoteIdentityHash: targetProviderVoteLaneId,
                providerInvocationKey: targetProviderStrategyId,
              },
            ],
          }),
        } as never,
        producerReleases: {
          findProducerReleaseById: vi.fn().mockResolvedValue({
            state: ProducerReleaseState.Registered,
            contextGatewayPolicyVersion:
              reviewInvestigationCoverageProfileV2.gatewayPolicyVersion,
            reviewInvestigationProfile: {
              capability: "review_investigation_v1",
              coverageProfileHash: sha(
                canonicalJson(reviewInvestigationCoverageProfileV2),
              ),
              policyHash: sha(canonicalJson(targetPolicy)),
            },
          }),
        } as never,
        investigations: {
          open: {} as never,
          restore: { snapshot: vi.fn().mockResolvedValue(source) } as never,
          planTurn: {} as never,
          acquireLease: {} as never,
          renewLease: {} as never,
          releaseLease: {} as never,
          commitTurn: {} as never,
          abortTurn: {} as never,
          conclude: {} as never,
          replay: { execute: replayExecute } as never,
          prepareReplay: vi.fn() as never,
          hydrateTurnObligations: null,
        },
        capabilities: {} as never,
        digest,
        now: () => now,
        rollout: allowingRollout,
        terminalShadowEvidence: { execute: vi.fn() } as never,
        crossRevisionReplayEnabled: false,
        replayPreparation: vi.fn() as never,
      },
    });
    const targetScope = {
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
      trustDomain: authorization.trustDomain,
      authorizationScopeHash: await authorizationScopeHash(),
    };
    const targetRevision = {
      baseSha: authorization.baseSha,
      mergeBaseSha: authorization.mergeBaseSha,
      headSha: authorization.headSha,
      reviewRevisionHash: authorization.reviewRevisionHash,
    };
    const replayProofs = [
      { obligationId: sha("obligation"), replayProofId: "proof-1" },
    ];
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationReplayV2,
      {
        ...envelope("replay-investigation"),
        authorizationToken: "authorization-token",
        authorizationId: authorization.authorizationId,
        idempotencyKey: "replay-1",
        requestBodyHash: sha("placeholder"),
        sourceInvestigationId: source.investigationId,
        sourceCertificateHash: sha("certificate"),
        targetExecutionId: "execution-target",
        targetWorkSlotId: "slot-target",
        stableReviewUnitKey: "unit-target",
        providerVoteLaneId: targetProviderVoteLaneId,
        providerStrategyId: targetProviderStrategyId,
        investigationManifestCanonicalJson: targetManifestCanonicalJson,
        investigationManifestHash: targetIdentity.manifestKey,
        runtimeProfile:
          ReviewInvestigationPublishedRuntimeProfile.GatewayAttestedAgentV1,
        coverageContractCanonicalJson: canonicalJson(targetContract),
        coverageContractHash: sha(canonicalJson(targetContract)),
        investigationPolicyCanonicalJson: canonicalJson(targetPolicy),
        investigationPolicyHash: sha(canonicalJson(targetPolicy)),
        seedObligationsCanonicalJson: targetSeedCanonicalJson,
        seedObligationsHash: targetSeedHash,
        initialReceiptsCanonicalJson: "[]",
        initialReceiptsHash: sha("[]"),
        targetScopeCanonicalJson: canonicalJson(targetScope),
        targetScopeHash: sha(canonicalJson(targetScope)),
        targetRevisionCanonicalJson: canonicalJson(targetRevision),
        targetRevisionHash: sha(canonicalJson(targetRevision)),
        replayProofsCanonicalJson: canonicalJson(replayProofs),
        replayProofsHash: sha(canonicalJson(replayProofs)),
      } satisfies ReviewInvestigationReplayV2Request,
    );

    await expect(routes.replayV2!.execute(request)).resolves.toMatchObject({
      statusCode: 201,
      result: { status: ReviewInvestigationMutationResultStatus.Applied },
    });
    expect(replayExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInvestigationId: source.investigationId,
        targetExecutionId: "execution-target",
        targetRevision,
        targetStableReviewUnitKey: "unit-target",
        targetProviderStrategyId,
        targetInvestigationManifestCanonicalJson: targetManifestCanonicalJson,
        targetInvestigationManifestHash: targetIdentity.manifestKey,
        targetSeedObligations: targetSeedEnvelope.obligations,
        targetInitialReceipts: [],
        replayProofs,
      }),
    );
  });
});

const allowingRollout = {
  async assertAllowed() {},
};

const now = new Date("2026-08-02T10:00:00.000Z");
const revisionHash = sha("revision");
const authorization = {
  authorizationId: "authorization-1",
  mutationEpoch: 1n,
  state: ReviewRunAuthorizationState.Active,
  expiresAt: new Date("2026-08-02T11:00:00.000Z"),
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-1",
  scmRepositoryIdentityId: "scm-1",
  pullRequestNumber: 42,
  trustDomain: "trusted_local",
  baseSha: "1".repeat(40),
  mergeBaseSha: "2".repeat(40),
  headSha: "3".repeat(40),
  reviewRevisionHash: revisionHash,
  producerReleaseId: "release-1",
  selectedProtocolVersion: "review_action_v2",
  reviewInvestigationAuthorizationDescriptorCanonicalJson: canonicalJson({
    authorizationDescriptorVersion: 3,
    capability: "review_investigation_v1",
    coverageProfileHash: sha("coverage-profile"),
    extensionCanonicalizerDigest:
      reviewInvestigationExtensionV1.canonicalizerDigest,
    extensionId: reviewInvestigationExtensionV1.extensionId,
    extensionSchemaDigest: reviewInvestigationExtensionV1.schemaDigest,
    policyHash: sha("policy"),
    providerCapabilities: [
      {
        capabilities: ["cross_revision_replay", "recording", "shadow"],
        providerKind: "codex",
      },
    ],
  }),
} as const;

function executionSnapshot() {
  return {
    execution: {
      authorizationId: authorization.authorizationId,
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
      revision: { reviewRevisionHash: authorization.reviewRevisionHash },
      workSlots: [
        {
          workSlotId: "slot-1",
          providerKind: ReviewExecutionProviderKind.Codex,
        },
      ],
    },
  };
}

async function authorizationScopeHash(): Promise<string> {
  return digest.digestUtf8(
    canonicalJson({
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
    }),
  );
}

function activeInvestigation(): ReviewInvestigation {
  const obligationId = sha("obligation");
  return {
    investigationId: "investigation-1",
    version: 2,
    state: ReviewInvestigationState.TurnLeased,
    dossierDigest: sha("dossier"),
    scope: {
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
      trustDomain: authorization.trustDomain,
      authorizationScopeHash: sha("authorization-scope"),
    },
    revision: {
      baseSha: authorization.baseSha,
      mergeBaseSha: authorization.mergeBaseSha,
      headSha: authorization.headSha,
      reviewRevisionHash: revisionHash,
    },
    executionId: "execution-1",
    workSlotId: "slot-1",
    stableReviewUnitKey: "unit-1",
    providerVoteLaneId: "lane-1",
    providerStrategyId: "strategy-1",
    runtimeProfile: ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1,
    contract: {
      coverageContractVersion: "coverage-v1",
      expansionRulesVersion: "expansion-v1",
      criticPolicyVersion: "critic-v1",
      gatewayPolicyVersion: "context-gateway-v4",
      producerReleaseId: "release-1",
      runtimeProfileVersion: "runtime-v1",
    },
    policy: {
      policyId: "policy-1",
      maxObligations: 32,
      maxExpansionDepth: 3,
      maxSemanticTurns: 8,
      maxOperationalAttempts: 12,
      maxCriticCycles: 2,
      maxFindings: 128,
      maxProposalsPerTurn: 16,
      maxReceiptsPerTurn: 128,
    },
    obligations: [
      {
        obligationId,
        coverageContractVersion: "coverage-v1",
        stableReviewUnitKey: "unit-1",
        kind: InvestigationObligationKind.ChangedContent,
        canonicalSubject: "src/review.ts",
        canonicalRequirement: "inspect complete changed content",
        riskPriority: 100,
        origin: InvestigationObligationOrigin.CoverageContract,
        state: InvestigationObligationState.Open,
        receipt: null,
        unresolvableReason: null,
      },
    ],
    findings: [],
    turns: [],
    activeTurn: {
      turnId: "turn-1",
      purpose: ReviewInvestigationTurnPurpose.Discovery,
      leasedAtVersion: 2,
      dossierDigest: sha("dossier"),
      obligationIds: [obligationId],
      semanticTurnOrdinal: 1,
      criticCycleOrdinal: 0,
      leasedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    },
    semanticTurns: 0,
    operationalAttempts: 1,
    criticCycles: 0,
    nextEligibleAt: null,
    certificate: null,
    conclusion: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  } as unknown as ReviewInvestigation;
}

function activeReadModel(): ReviewInvestigationReadModel {
  const aggregate = activeInvestigation();
  return {
    investigationId: aggregate.investigationId,
    version: aggregate.version,
    state: aggregate.state,
    dossierDigest: aggregate.dossierDigest,
    openObligationCount: 1,
    satisfiedObligationCount: 0,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 0,
    operationalAttempts: 1,
    criticCycles: 0,
    nextEligibleAt: null,
    nextAction: ReviewInvestigationNextActionKind.RunTurn,
    turn: aggregate.activeTurn,
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    conclusion: null,
  };
}

function authorizationResolver() {
  return {
    async resolveReviewRunAuthorizationToken() {
      return {
        status: ReviewRunAuthorizationTokenResolutionStatus.Valid,
        authorization: authorization as unknown as ReviewRunAuthorization,
      };
    },
  };
}

function concludeHarness(input: {
  readonly projection: ReturnType<typeof vi.fn>;
  readonly telemetry: ReturnType<typeof vi.fn>;
  readonly rollout?: typeof allowingRollout;
}) {
  const before = {
    ...activeInvestigation(),
    state: ReviewInvestigationState.ReadyToConclude,
    activeTurn: null,
    version: 7,
  } as ReviewInvestigation;
  const concluded = concludedInvestigation();
  let restoreCalls = 0;
  const concludeExecute = vi.fn().mockResolvedValue(concludedReadModel());
  const routes = composeReviewActionV2InvestigationRoutes({
    enabled: true,
    runtime: {
      readServerTime: async () => now,
      createRequestId: () => "request-generated",
    },
    handlers: {
      ...investigationLeaseHandlerStubs,
      authorizations: authorizationResolver(),
      authorizationQueries: {} as never,
      executionQueries: {
        findExecution: vi.fn().mockResolvedValue(executionSnapshot()),
      } as never,
      investigations: {
        open: {} as never,
        restore: {
          snapshot: vi.fn().mockImplementation(async () => {
            restoreCalls += 1;
            return restoreCalls === 1 ? before : concluded;
          }),
        } as never,
        planTurn: {} as never,
        acquireLease: {} as never,
        renewLease: {} as never,
        releaseLease: {} as never,
        commitTurn: {} as never,
        abortTurn: {} as never,
        conclude: { execute: concludeExecute } as never,
        replay: {} as never,
        prepareReplay: vi.fn() as never,
        hydrateTurnObligations: null,
      },
      capabilities: {} as never,
      digest,
      now: () => now,
      rollout: input.rollout ?? allowingRollout,
      terminalShadowEvidence: { execute: input.projection } as never,
      terminalTelemetry: { recordConcluded: input.telemetry } as never,
      crossRevisionReplayEnabled: false,
      replayPreparation: vi.fn() as never,
    },
  });
  return { routes, concludeExecute };
}

async function concludeRequest(): Promise<ReviewInvestigationConcludeRequest> {
  return withBodyHash(ReviewActionV2OperationId.ReviewInvestigationConclude, {
    ...envelope("conclude-investigation"),
    authorizationToken: "authorization-token",
    idempotencyKey: "conclude-1",
    requestBodyHash: sha("placeholder"),
    investigationId: "investigation-1",
    expectedVersion: "7",
    dossierDigest: sha("dossier"),
    certificateTtlMs: 86_400_000,
  });
}

function concludedInvestigation(): ReviewInvestigation {
  const base = activeInvestigation();
  return {
    ...base,
    dossierDigest: sha("concluded-dossier"),
    version: 8,
    state: ReviewInvestigationState.Concluded,
    activeTurn: null,
    conclusion: ReviewInvestigationConclusion.Findings,
    certificate: {
      certificateId: "certificate-1",
      certificateHash: sha("certificate"),
      investigationId: base.investigationId,
      investigationVersion: 7,
      dossierDigest: base.dossierDigest,
      reviewRevisionHash: base.revision.reviewRevisionHash,
      stableReviewUnitKey: base.stableReviewUnitKey,
      providerVoteLaneId: base.providerVoteLaneId,
      coverageContractVersion: base.contract.coverageContractVersion,
      expansionRulesVersion: base.contract.expansionRulesVersion,
      gatewayPolicyVersion: base.contract.gatewayPolicyVersion,
      criticPolicyVersion: base.contract.criticPolicyVersion,
      runtimeProfileVersion: base.contract.runtimeProfileVersion,
      producerReleaseId: base.contract.producerReleaseId,
      conclusion: ReviewInvestigationConclusion.Findings,
      findingSetHash: sha("findings"),
      obligationSetHash: sha("obligations"),
      receiptSetHash: sha("receipts"),
      scopeHash: sha("scope"),
      coverageStateHash: sha("coverage"),
      contextAttestationSetHash: sha("attestations"),
      turnProvenanceHash: sha("provenance"),
      terminalProviderKind: InvestigationTurnProviderKind.Codex,
      terminalActualModel: "gpt-5.6-codex",
      terminalOutcomeHash: sha("terminal"),
      terminalObservationCanonicalJson: "{}",
      criticAttestationId: "critic-attestation-1",
      criticAttestationHash: sha("critic-attestation"),
      criticDecision: ContextCriticDecision.Accept,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    },
  } as ReviewInvestigation;
}

function concludedReadModel(): ReviewInvestigationReadModel {
  const aggregate = concludedInvestigation();
  return {
    ...activeReadModel(),
    version: aggregate.version,
    state: aggregate.state,
    nextAction: ReviewInvestigationNextActionKind.Terminal,
    turn: null,
    certificateId: aggregate.certificate!.certificateId,
    certificateHash: aggregate.certificate!.certificateHash,
    terminalProviderKind: aggregate.certificate!.terminalProviderKind,
    terminalActualModel: aggregate.certificate!.terminalActualModel,
    terminalObservationCanonicalJson:
      aggregate.certificate!.terminalObservationCanonicalJson,
    terminalOutcomeHash: aggregate.certificate!.terminalOutcomeHash,
    conclusion: aggregate.conclusion,
  };
}

async function withBodyHash<O extends ReviewActionV2OperationId>(
  operation: O,
  request: ReviewActionV2RequestMap[O],
): Promise<ReviewActionV2RequestMap[O]> {
  return {
    ...request,
    requestBodyHash: sha(canonicalizeReviewActionV2Request(operation, request)),
  };
}

function envelope(requestId: string) {
  return {
    protocolVersion: reviewActionV2PublishedProtocolVersion,
    schemaDigest: reviewActionV2PublishedSchemaDigest,
    requestId,
  };
}

const digest = {
  async digestUtf8(value: string) {
    return sha(value);
  },
  async digest(value: Uint8Array) {
    return createHash("sha256").update(value).digest("hex");
  },
};

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
