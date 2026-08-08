import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewInvestigationNextActionKind,
  ReviewInvestigationState,
  reviewInvestigationCoverageProfileV4,
} from "@reviewrouter/features-review-investigations";
import {
  ProviderExecutionProfile,
  ReviewProviderKind,
  ReviewTaskKind,
  buildProviderInvocationIdentity,
  serializeProviderInvocationManifestCanonicalWireJson,
} from "@reviewrouter/features-review-evidence";
import {
  ReviewExecutionProviderKind,
  ReviewExecutionState,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewTaskKind as ExecutionTaskKind,
  ReviewWorkSlotState,
} from "@reviewrouter/features-review-executions";
import {
  ProducerReleaseState,
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenResolutionStatus,
  canonicalJson,
} from "@reviewrouter/features-review-run-control";
import {
  ReviewActionV2OperationId,
  ReviewInvestigationPublishedRuntimeProfile,
  canonicalizeReviewActionV2Request,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  reviewInvestigationExtensionV1,
  type ReviewActionV2RequestMap,
  type ReviewInvestigationOpenV2Request,
  type ReviewInvestigationOpenRequest,
} from "@reviewrouter/protocol-review-action-v2";
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

const now = new Date("2026-08-04T12:00:00.000Z");
const policy = Object.freeze({
  policyId: "review-investigation-shadow.v1",
  maxObligations: 64,
  maxExpansionDepth: 8,
  maxSemanticTurns: 12,
  maxOperationalAttempts: 24,
  maxCriticCycles: 3,
  maxFindings: 256,
  maxProposalsPerTurn: 128,
  maxReceiptsPerTurn: 256,
  maxSeedProbesPerFile: 48,
  maxSeedProbesOverall: 384,
});
const authorization = Object.freeze({
  authorizationId: "authorization-1",
  state: ReviewRunAuthorizationState.Active,
  expiresAt: new Date("2026-08-04T13:00:00.000Z"),
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-1",
  scmRepositoryIdentityId: "scm-1",
  pullRequestNumber: 42,
  trustDomain: "trusted_local",
  baseSha: "1".repeat(40),
  mergeBaseSha: "2".repeat(40),
  headSha: "3".repeat(40),
  reviewRevisionHash: sha("revision"),
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
      { capabilities: ["recording"], providerKind: "codex" },
    ],
  }),
});
const baseObligations = Object.freeze([
  inventoryObligation(sha("inventory-aggregate")),
  obligation("changed_content", "src/service.ts"),
  obligation("direct_reference_search", "refreshAccount"),
]);

describe("Review Action v2 trusted investigation seed binding", () => {
  it("keeps the frozen base-v2 open path usable without extension manifest fields", async () => {
    const trustedEnvelope = envelope(baseObligations);
    const extended = await openRequest(trustedEnvelope);
    const harness = harnessFor({
      trustedEnvelope,
      legacyLeaseBinding: {
        preparedManifestKey: extended.investigationManifestHash,
        providerInvocationKey: extended.providerStrategyId,
      },
    });
    const baseRequest: Record<string, unknown> = { ...extended };
    delete baseRequest.investigationManifestCanonicalJson;
    delete baseRequest.investigationManifestHash;
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvestigationOpen,
      baseRequest as unknown as ReviewInvestigationOpenRequest,
    );

    await expect(harness.routes.open!.execute(request)).resolves.toMatchObject({
      statusCode: 201,
    });
    expect(harness.open).toHaveBeenCalledWith(
      expect.not.objectContaining({
        investigationManifestCanonicalJson: expect.anything(),
        investigationManifestHash: expect.anything(),
      }),
    );
  });

  it("rejects open-v2 when the signed authorization did not negotiate the extension", async () => {
    const trustedEnvelope = envelope(baseObligations);
    const harness = harnessFor({
      trustedEnvelope,
      authorizationOverride: {
        ...authorization,
        reviewInvestigationAuthorizationDescriptorCanonicalJson: null,
      } as never,
    });

    await expect(
      harness.routes.openV2!.execute(await openRequest(trustedEnvelope)),
    ).rejects.toMatchObject({
      statusCode: 403,
      issues: ["review_investigation_extension_not_authorized"],
    });
    expect(harness.open).not.toHaveBeenCalled();
  });

  it("passes only obligations from the lease-bound canonical envelope to domain Open", async () => {
    const trustedEnvelope = envelope(baseObligations);
    const harness = harnessFor({ trustedEnvelope });

    await expect(
      harness.routes.openV2!.execute(await openRequest(trustedEnvelope)),
    ).resolves.toMatchObject({ statusCode: 201 });

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.open).toHaveBeenCalledWith(
      expect.objectContaining({ seedObligations: baseObligations }),
    );
  });

  it.each([
    ["omitted probe", baseObligations.slice(0, 2)],
    [
      "extra changed path",
      [...baseObligations, obligation("changed_content", "src/extra.ts")],
    ],
    [
      "different canonical inventory aggregate",
      [
        inventoryObligation(sha("different-inventory-aggregate")),
        ...baseObligations.slice(1),
      ],
    ],
  ])(
    "rejects a recomputed request hash for a %s",
    async (_name, obligations) => {
      const trustedEnvelope = envelope(baseObligations);
      const tamperedEnvelope = envelope(obligations);
      const harness = harnessFor({ trustedEnvelope });

      await expect(
        harness.routes.openV2!.execute(
          await openRequest(tamperedEnvelope, undefined, trustedEnvelope),
        ),
      ).rejects.toMatchObject({
        statusCode: 412,
        issues: ["investigation_seed_prepared_manifest_mismatch"],
      });
      expect(harness.open).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", { leaseMode: "missing" as const }],
    ["different-work-slot", { leaseMode: "different-work-slot" as const }],
    ["multiple", { leaseMode: "multiple" as const }],
    ["expired", { leaseMode: "expired" as const }],
    ["non-provider-execution", { leaseMode: "observation" as const }],
  ])(
    "does not depend on a %s authoritative provider-execution lease",
    async (_name, options) => {
      const trustedEnvelope = envelope(baseObligations);
      const harness = harnessFor({ trustedEnvelope, ...options });

      await expect(
        harness.routes.openV2!.execute(await openRequest(trustedEnvelope)),
      ).resolves.toMatchObject({ statusCode: 201 });
      expect(harness.open).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      "non-investigation profile",
      { executionProfile: ProviderExecutionProfile.ContextGatewayV1 },
    ],
    ["different model", { requestedModel: "gpt-other" }],
    ["different release", { producerReleaseId: "release-other" }],
    ["different scope", { scopeHash: sha("scope-other") }],
  ])(
    "rejects a prepared manifest with %s",
    async (_name, manifestOverrides) => {
      const trustedEnvelope = envelope(baseObligations);
      const harness = harnessFor({ trustedEnvelope, manifestOverrides });

      await expect(
        harness.routes.openV2!.execute(
          await openRequest(trustedEnvelope, manifestOverrides),
        ),
      ).rejects.toMatchObject({
        statusCode: 412,
        issues: ["investigation_seed_prepared_manifest_mismatch"],
      });
      expect(harness.open).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown envelope fields even when the prepared manifest commits that hash", async () => {
    const malformed = {
      ...envelope(baseObligations),
      unexpected: true,
    };
    const harness = harnessFor({ trustedEnvelope: malformed });

    await expect(
      harness.routes.openV2!.execute(await openRequest(malformed)),
    ).rejects.toMatchObject({
      statusCode: 400,
      issues: ["investigation_seed_envelope_invalid"],
    });
    expect(harness.open).not.toHaveBeenCalled();
  });
});

function harnessFor(input: {
  readonly trustedEnvelope: Readonly<Record<string, unknown>>;
  readonly leaseMode?:
    | "active"
    | "missing"
    | "multiple"
    | "expired"
    | "observation"
    | "different-work-slot";
  readonly manifestOverrides?: Readonly<Record<string, unknown>>;
  readonly legacyLeaseBinding?: Readonly<{
    preparedManifestKey: string;
    providerInvocationKey: string;
  }>;
  readonly authorizationOverride?: typeof authorization;
}) {
  const activeAuthorization = input.authorizationOverride ?? authorization;
  const trustedEnvelopeCanonicalJson = canonicalJson(
    input.trustedEnvelope as never,
  );
  const trustedEnvelopeHash = sha(trustedEnvelopeCanonicalJson);
  const manifestCanonicalJson =
    serializeProviderInvocationManifestCanonicalWireJson({
      manifestVersion: 1,
      scopeHash: scopeHash(),
      taskKindSet: [ReviewTaskKind.FindingDiscovery],
      providerKind: ReviewProviderKind.Codex,
      providerCapabilityHash: sha("capability"),
      requestedModel: "gpt-test",
      providerPolicyVersion: "codex-provider-policy.v2-t0",
      producerReleaseId: authorization.producerReleaseId,
      selectedProtocolVersion: authorization.selectedProtocolVersion,
      providerRequestEnvelopeHash: trustedEnvelopeHash,
      outputSchemaHash: sha("schema"),
      reviewConfigHash: sha("config"),
      runtimeCompatibilityKey: sha("runtime"),
      filePatchManifestHash: sha("patch"),
      contextManifestHash: sha("context"),
      memoryBundleHash: null,
      codeGraphProjectionHash: null,
      lifecycleTargetSetHash: null,
      liveLifecycleStateHash: null,
      toolPolicyHash: sha("tools"),
      executionProfile: ProviderExecutionProfile.InvestigationGatewayV1,
      baseTreeHash: sha("base-tree"),
      environmentContractHash: sha("environment"),
      ...input.manifestOverrides,
    });
  const baseLease = {
    leaseId: "lease-1",
    executionId: "execution-1",
    workSlotId: input.leaseMode === "different-work-slot" ? "slot-2" : "slot-1",
    purpose:
      input.leaseMode === "observation"
        ? ReviewInvocationLeasePurpose.ObservationAdoption
        : ReviewInvocationLeasePurpose.ProviderExecution,
    state: ReviewInvocationLeaseState.Active,
    expiresAt:
      input.leaseMode === "expired"
        ? new Date(now)
        : new Date("2026-08-04T12:30:00.000Z"),
    attemptId: "attempt-1",
    preparedManifestCanonicalJson: manifestCanonicalJson,
    preparedManifestKey:
      input.legacyLeaseBinding?.preparedManifestKey ?? sha("manifest"),
    authorizationId: authorization.authorizationId,
    producerReleaseId: authorization.producerReleaseId,
    reviewRevisionHash: authorization.reviewRevisionHash,
    providerVoteIdentityHash: sha("lane"),
    providerInvocationKey:
      input.legacyLeaseBinding?.providerInvocationKey ??
      sha("provider-invocation"),
  };
  const activeLeases =
    input.leaseMode === "missing"
      ? []
      : input.leaseMode === "multiple"
        ? [baseLease, { ...baseLease, leaseId: "lease-2" }]
        : [baseLease];
  const open = vi.fn().mockResolvedValue(openReadModel());
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
            authorization: activeAuthorization,
          } as never;
        },
      },
      authorizationQueries: {} as never,
      executionQueries: {
        findExecution: vi.fn().mockResolvedValue({
          execution: {
            executionId: "execution-1",
            authorizationId: authorization.authorizationId,
            workspaceId: authorization.workspaceId,
            repositoryConnectionId: authorization.repositoryConnectionId,
            scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
            pullRequestNumber: authorization.pullRequestNumber,
            producerReleaseId: authorization.producerReleaseId,
            revision: {
              reviewRevisionHash: authorization.reviewRevisionHash,
            },
            state: ReviewExecutionState.Running,
            workSlots: [
              {
                workSlotId: "slot-1",
                taskKind: ExecutionTaskKind.FindingDiscovery,
                providerKind: ReviewExecutionProviderKind.Codex,
                providerVoteIdentityHash: sha("lane"),
                shardKey: "unit-1",
                state: ReviewWorkSlotState.Leased,
                activeLeaseId: "lease-1",
              },
            ],
          },
          stream: {
            activeExecutionId: "execution-1",
            currentRevision: {
              reviewRevisionHash: authorization.reviewRevisionHash,
            },
          },
          activeLeases,
        }),
      } as never,
      producerReleases: {
        findProducerReleaseById: vi.fn().mockResolvedValue({
          state: ProducerReleaseState.Registered,
          contextGatewayPolicyVersion:
            reviewInvestigationCoverageProfileV4.gatewayPolicyVersion,
          reviewInvestigationProfile: {
            capability: "review_investigation_v1",
            coverageProfileHash: sha(
              canonicalJson(reviewInvestigationCoverageProfileV4),
            ),
            policyHash: sha(canonicalJson(policy)),
          },
        }),
      } as never,
      investigations: {
        open: { execute: open },
      } as never,
      capabilities: {} as never,
      digest,
      now: () => now,
      rollout: { assertAllowed: vi.fn().mockResolvedValue(undefined) },
      terminalShadowEvidence: { execute: vi.fn() } as never,
      crossRevisionReplayEnabled: false,
      replayPreparation: vi.fn() as never,
    },
  });
  return { routes, open };
}

async function openRequest(
  seedEnvelope: Readonly<Record<string, unknown>>,
  manifestOverrides?: Readonly<Record<string, unknown>>,
  manifestSeedEnvelope: Readonly<Record<string, unknown>> = seedEnvelope,
): Promise<ReviewInvestigationOpenV2Request> {
  const seedObligationsCanonicalJson = canonicalJson(seedEnvelope as never);
  const manifestSeedCanonicalJson = canonicalJson(
    manifestSeedEnvelope as never,
  );
  const manifest = {
    manifestVersion: 1 as const,
    scopeHash: scopeHash(),
    taskKindSet: [ReviewTaskKind.FindingDiscovery],
    providerKind: ReviewProviderKind.Codex,
    providerCapabilityHash: sha("capability"),
    requestedModel: "gpt-test",
    providerPolicyVersion: "codex-provider-policy.v2-t0",
    producerReleaseId: authorization.producerReleaseId,
    selectedProtocolVersion: authorization.selectedProtocolVersion,
    providerRequestEnvelopeHash: sha(manifestSeedCanonicalJson),
    outputSchemaHash: sha("schema"),
    reviewConfigHash: sha("config"),
    runtimeCompatibilityKey: sha("runtime"),
    filePatchManifestHash: sha("patch"),
    contextManifestHash: sha("context"),
    memoryBundleHash: null,
    codeGraphProjectionHash: null,
    lifecycleTargetSetHash: null,
    liveLifecycleStateHash: null,
    toolPolicyHash: sha("tools"),
    executionProfile: ProviderExecutionProfile.InvestigationGatewayV1,
    baseTreeHash: sha("base-tree"),
    environmentContractHash: sha("environment"),
    ...manifestOverrides,
  };
  const investigationManifestCanonicalJson =
    serializeProviderInvocationManifestCanonicalWireJson(manifest);
  const identity = await buildProviderInvocationIdentity(digest, {
    manifest,
    providerVoteIdentityHash: sha("lane"),
  });
  const contract = {
    ...reviewInvestigationCoverageProfileV4,
    producerReleaseId: authorization.producerReleaseId,
  };
  return withBodyHash(ReviewActionV2OperationId.ReviewInvestigationOpenV2, {
    protocolVersion: reviewActionV2PublishedProtocolVersion,
    schemaDigest: reviewActionV2PublishedSchemaDigest,
    requestId: "open-seed-binding",
    authorizationToken: "authorization-token",
    idempotencyKey: "open-seed-binding-1",
    requestBodyHash: sha("placeholder"),
    authorizationId: authorization.authorizationId,
    executionId: "execution-1",
    workSlotId: "slot-1",
    reviewRevisionHash: authorization.reviewRevisionHash,
    stableReviewUnitKey: "unit-1",
    providerVoteLaneId: sha("lane"),
    providerStrategyId: identity.providerInvocationKey,
    investigationManifestCanonicalJson,
    investigationManifestHash: identity.manifestKey,
    runtimeProfile:
      ReviewInvestigationPublishedRuntimeProfile.GatewayAttestedAgentV1,
    coverageContractCanonicalJson: canonicalJson(contract),
    coverageContractHash: sha(canonicalJson(contract)),
    investigationPolicyCanonicalJson: canonicalJson(policy),
    investigationPolicyHash: sha(canonicalJson(policy)),
    seedObligationsCanonicalJson,
    seedObligationsHash: sha(seedObligationsCanonicalJson),
    initialReceiptsCanonicalJson: "[]",
    initialReceiptsHash: sha("[]"),
  });
}

function envelope(obligations: readonly unknown[]) {
  return Object.freeze({
    contract: "review_investigation_seed_envelope.v1",
    obligations,
    probePlanHash: sha("probe-plan"),
    requestedModel: "gpt-test",
    reviewPromptHash: sha("review-prompt"),
  });
}

function obligation(kind: string, subject: string) {
  return Object.freeze({
    kind,
    canonicalSubject: canonicalJson({ kind, subject }),
    canonicalRequirement: canonicalJson({ kind, subject }),
    riskPriority: 500_000,
  });
}

function inventoryObligation(aggregateHash: string) {
  const identity = {
    aggregateHash,
    aggregateItemCount: 1,
    aggregatePathCount: 1,
    aggregatePathSetHash: sha("inventory-path-set"),
    reviewRevisionHash: authorization.reviewRevisionHash,
    treeOid: "4".repeat(40),
  };
  return Object.freeze({
    kind: "inventory_witness",
    canonicalSubject: canonicalJson({
      ...identity,
      kind: "canonical_inventory",
      subjectVersion: 2,
    }),
    canonicalRequirement: canonicalJson({
      ...identity,
      kind: "complete_inventory",
      requirementVersion: 2,
    }),
    riskPriority: 1_000_000,
  });
}

function openReadModel() {
  return {
    investigationId: "investigation-1",
    version: 1,
    state: ReviewInvestigationState.AwaitingTurn,
    dossierDigest: sha("dossier"),
    openObligationCount: baseObligations.length,
    satisfiedObligationCount: 0,
    unresolvableObligationCount: 0,
    findingCount: 0,
    semanticTurns: 0,
    operationalAttempts: 0,
    criticCycles: 0,
    nextEligibleAt: null,
    nextAction: ReviewInvestigationNextActionKind.RunTurn,
    turn: null,
    certificateId: null,
    certificateHash: null,
    terminalProviderKind: null,
    terminalActualModel: null,
    terminalObservationCanonicalJson: null,
    terminalOutcomeHash: null,
    conclusion: null,
  };
}

function scopeHash(): string {
  return sha(
    canonicalJson({
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
    }),
  );
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
