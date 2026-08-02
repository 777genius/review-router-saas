import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  InvestigationObligationKind,
  InvestigationObligationOrigin,
  InvestigationObligationState,
  ReviewInvestigationNextActionKind,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
  type ReviewInvestigation,
  type ReviewInvestigationReadModel,
} from "@reviewrouter/features-review-investigations";
import {
  ReviewInvestigationMutationResultStatus,
  ReviewActionV2OperationId,
  canonicalizeReviewActionV2Request,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  type ReviewActionV2RequestMap,
  type ReviewInvestigationTurnPlanRequest,
} from "@reviewrouter/protocol-review-action-v2";
import {
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenResolutionStatus,
  canonicalJson,
  type ReviewRunAuthorization,
} from "@reviewrouter/features-review-run-control";
import { composeReviewActionV2InvestigationRoutes } from "./review-action-v2-investigation-composition.js";

describe("Review Action v2 investigation composition", () => {
  it("returns a canonical turn brief bound to the restored active turn", async () => {
    const aggregate = activeInvestigation();
    const readModel = activeReadModel();
    const routes = composeReviewActionV2InvestigationRoutes({
      enabled: true,
      runtime: {
        readServerTime: async () => now,
        createRequestId: () => "request-generated",
      },
      handlers: {
        authorizations: {
          async resolveReviewRunAuthorizationToken() {
            return {
              status: ReviewRunAuthorizationTokenResolutionStatus.Valid,
              authorization: authorization as unknown as ReviewRunAuthorization,
            };
          },
        },
        authorizationQueries: {} as never,
        executionQueries: {} as never,
        investigations: {
          open: {} as never,
          restore: {
            snapshot: vi.fn().mockResolvedValue(aggregate),
            execute: vi.fn().mockResolvedValue(readModel),
          } as never,
          planTurn: { execute: vi.fn() } as never,
          commitTurn: {} as never,
          abortTurn: {} as never,
          conclude: {} as never,
        },
        capabilities: {
          issueInvestigationTurn: vi
            .fn()
            .mockResolvedValue("turn.capability.value"),
        } as never,
        digest,
        now: () => now,
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
      obligations: [
        {
          obligationId: sha("obligation"),
          kind: InvestigationObligationKind.ChangedContent,
          canonicalSubject: "src/review.ts",
          canonicalRequirement: "inspect complete changed content",
          riskPriority: 100,
          origin: InvestigationObligationOrigin.CoverageContract,
        },
      ],
    });
  });
});

const now = new Date("2026-08-02T10:00:00.000Z");
const revisionHash = sha("revision");
const authorization = {
  authorizationId: "authorization-1",
  state: ReviewRunAuthorizationState.Active,
  expiresAt: new Date("2026-08-02T11:00:00.000Z"),
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-1",
  scmRepositoryIdentityId: "scm-1",
  pullRequestNumber: 42,
  trustDomain: "trusted-local",
  baseSha: "1".repeat(40),
  mergeBaseSha: "2".repeat(40),
  headSha: "3".repeat(40),
  reviewRevisionHash: revisionHash,
} as const;

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
