import { describe, expect, it, vi } from "vitest";
import {
  createRenderHostedPoolDeploymentEvidencePort,
  readExactHostedPoolRunEvidence,
} from "./hosted-pool-production-evidence";

const attempt = {
  id: "attempt-1",
  relayRequestId: "request-1",
  grantId: "grant-1",
  attemptOrdinal: 1,
  state: "succeeded",
  errorCode: null,
  accountId: "account-a",
  credentialGeneration: 1n,
  dispatchStartedAt: new Date("2026-08-24T00:00:02Z"),
  responseStartedAt: new Date("2026-08-24T00:00:03Z"),
  providerResponseIdHash: "d".repeat(64),
  completedAt: new Date("2026-08-24T00:00:04Z"),
  createdAt: new Date("2026-08-24T00:00:01.500Z"),
};
const grant = {
  id: "grant-1",
  invocationId: "invocation-1",
  reviewRequestId: "review-request-1",
  providerInvocationKey: "e".repeat(64),
  workspaceId: "workspace-1",
  activeAccountId: "account-a",
  primaryAccountId: "account-a",
  backupAccountId: "account-b",
  failoverCount: 0,
  status: "exhausted",
  revokedAt: null,
  commentRefreshCapability: { revokedAt: null },
  repositoryBindingId: "binding-1",
  bindingRevision: 7n,
  issuedAt: new Date("2026-08-24T00:00:00Z"),
  binding: {
    workflowActionRef: `777genius/review-router@${"a".repeat(40)}`,
    attestedGithubRepositoryId: 123456789n,
  },
  relayRequests: [
    {
      id: "request-1",
      ordinal: 1,
      status: "succeeded",
      errorCode: null,
      receivedAt: new Date("2026-08-24T00:00:00Z"),
      startedAt: new Date("2026-08-24T00:00:00.500Z"),
      successfulResponseStartedAt: new Date("2026-08-24T00:00:03Z"),
      completedAt: new Date("2026-08-24T00:00:04Z"),
      upstreamAttempts: [attempt],
    },
  ],
};

const sourceHeadSha = "c".repeat(40);
const publication = {
  appBotPublicationCount: 1,
  nonAppBotPublicationCount: 0,
  publicationObjects: [
    {
      kind: "issue_comment" as const,
      externalObjectId: "101",
      bodyHash: "b".repeat(64),
      authorLogin: "reviewrouter-app[bot]",
      publishedAt: "2026-08-24T00:00:03.500Z",
    },
  ],
};

function prismaFor(
  grants: readonly unknown[],
  auditEvents: readonly unknown[] = [],
) {
  return {
    hostedCodexInvocationGrant: { findMany: async () => grants },
    auditEvent: { findMany: async () => auditEvents },
    reviewRequestedIntent: {
      findUnique: async () => ({
        executionId: "execution-1",
        headSha: sourceHeadSha,
        sourceRunId: "42",
        sourceRunAttempt: "2",
      }),
    },
    reviewEvidenceObservation: {
      findMany: async () => [{ observationId: "observation-1" }],
    },
    reviewExecutionObservationRefV2: {
      findMany: async () => [{ observationRefId: "observation-ref-1" }],
    },
    reviewPublicationAttemptV2: {
      findMany: async () => [{ publicationAttemptId: "publication-attempt-1" }],
    },
    reviewPublicationOperationV2: {
      findMany: async () => [
        {
          publicationOperationId: "publication-operation-1",
          bodyHash: "b".repeat(64),
          state: "completed",
        },
      ],
    },
    reviewPublicationReceiptV2: {
      findMany: async () => [
        {
          publicationOperationId: "publication-operation-1",
          canonicalEffectId: "publication-effect-1",
          canonicalExternalObjectId: "101",
        },
      ],
    },
    reviewPublicationExternalEffectV2: {
      findMany: async () => [
        {
          effectId: "publication-effect-1",
          publicationOperationId: "publication-operation-1",
          externalObjectId: "101",
        },
      ],
    },
  };
}

describe("hosted pool exact production evidence graph", () => {
  it("requires both live Render deploys at the exact release revision", async () => {
    const releaseSha = "a".repeat(40);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify([
            {
              deploy: {
                id: `dep-${String(url).includes("srv-api") ? "api" : "web"}`,
                status: "live",
                commit: { id: releaseSha },
              },
            },
          ]),
          { status: 200 },
        ),
    );
    try {
      const port = createRenderHostedPoolDeploymentEvidencePort({
        apiKey: "render-token",
        serviceIds: ["srv-api", "srv-web"],
        now: () => new Date("2026-08-25T00:00:00.000Z"),
      });
      await expect(port.readExactRevision(releaseSha)).resolves.toEqual([
        expect.objectContaining({
          serviceId: "srv-api",
          deployId: "dep-api",
          commitSha: releaseSha,
        }),
        expect.objectContaining({
          serviceId: "srv-web",
          deployId: "dep-web",
          commitSha: releaseSha,
        }),
      ]);
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              deploy: {
                id: "dep-api-next",
                status: "live",
                commit: { id: "b".repeat(40) },
              },
            },
          ]),
          { status: 200 },
        ),
      );
      await expect(port.readExactRevision(releaseSha)).rejects.toThrow(
        "hosted_pool_render_revision_mismatch:srv-api",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("requires one grant, one request, and contiguous effects", async () => {
    const prisma = prismaFor([grant]);
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        sourceHeadSha,
        publication,
      }),
    ).resolves.toMatchObject({
      runId: 42,
      repositoryBindingId: "binding-1",
      requestStatuses: ["succeeded"],
      attempts: [{ ordinal: 1, state: "succeeded", credentialGeneration: "1" }],
    });
  });

  it("rejects an extra effect instead of accepting plausible evidence", async () => {
    const prisma = prismaFor([
      {
        ...grant,
        relayRequests: [
          {
            ...grant.relayRequests[0],
            upstreamAttempts: [attempt, { ...attempt, attemptOrdinal: 3 }],
          },
        ],
      },
    ]);
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        sourceHeadSha,
        publication,
      }),
    ).rejects.toThrow("hosted_pool_canary_evidence_graph_invalid:42");
  });

  it("rejects provider evidence without an immutable credential generation", async () => {
    const prisma = prismaFor([
      {
        ...grant,
        relayRequests: [
          {
            ...grant.relayRequests[0],
            upstreamAttempts: [{ ...attempt, credentialGeneration: null }],
          },
        ],
      },
    ]);
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        sourceHeadSha,
        publication,
      }),
    ).rejects.toThrow("hosted_pool_canary_evidence_graph_invalid:42");
  });

  it("requires a provider response identity for every successful effect", async () => {
    const prisma = prismaFor([
      {
        ...grant,
        relayRequests: [
          {
            ...grant.relayRequests[0],
            upstreamAttempts: [{ ...attempt, providerResponseIdHash: null }],
          },
        ],
      },
    ]);
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        sourceHeadSha,
        publication,
      }),
    ).rejects.toThrow("hosted_pool_canary_provider_response_id_missing:42");
  });

  it("rejects publication evidence borrowed from another external object", async () => {
    const prisma = prismaFor([grant]);
    prisma.reviewPublicationReceiptV2.findMany = async () => [
      {
        publicationOperationId: "publication-operation-1",
        canonicalEffectId: "publication-effect-1",
        canonicalExternalObjectId: "foreign-comment",
      },
    ];
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        sourceHeadSha,
        publication,
      }),
    ).rejects.toThrow("hosted_pool_canary_publication_graph_invalid:42");
  });

  it("does not require a completed observation after a dropped response", async () => {
    const prisma = prismaFor([
      {
        ...grant,
        relayRequests: [
          {
            ...grant.relayRequests[0],
            status: "terminal_unknown",
            upstreamAttempts: [
              {
                ...attempt,
                state: "terminal_unknown",
                errorCode: "ambiguous_dropped_response",
              },
            ],
          },
        ],
      },
    ]);
    prisma.reviewPublicationAttemptV2.findMany = async () => [];
    prisma.reviewEvidenceObservation.findMany = async () => {
      throw new Error("observation_must_not_be_read");
    };
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        sourceHeadSha,
        publication: {
          appBotPublicationCount: 0,
          nonAppBotPublicationCount: 0,
          publicationObjects: [],
        },
      }),
    ).resolves.toMatchObject({ publicationAttemptId: null });
  });

  it("binds a consumed fault to the same repository, run, request, and effect", async () => {
    const planIdHash = "f".repeat(64);
    const prisma = prismaFor(
      [grant],
      [
        {
          targetId: planIdHash,
          createdAt: new Date("2026-08-24T00:00:01.750Z"),
          metadata: {
            planIdHash,
            repositoryId: "123456789",
            runId: "42",
            runAttempt: 2,
            actionRef: `777genius/review-router@${"a".repeat(40)}`,
            bindingId: "binding-1",
            bindingRevision: "7",
            phase: "synthetic_unauthorized",
            requestOrdinal: 1,
            attemptOrdinal: 1,
            injectionPoint: "before_provider_fetch",
          },
        },
      ],
    );
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        sourceHeadSha,
        publication,
      }),
    ).resolves.toMatchObject({
      faultPlanConsumptionCount: 1,
      faultPlanConsumptions: [
        { phase: "synthetic_unauthorized", requestOrdinal: 1 },
      ],
    });
    prisma.auditEvent.findMany = async () => [
      {
        targetId: planIdHash,
        createdAt: new Date("2026-08-24T00:00:01.750Z"),
        metadata: {
          planIdHash,
          repositoryId: "123456789",
          runId: "42",
          runAttempt: 2,
          actionRef: `777genius/review-router@${"a".repeat(40)}`,
          bindingId: "binding-1",
          bindingRevision: "7",
          phase: "synthetic_unauthorized",
          requestOrdinal: 2,
          attemptOrdinal: 1,
          injectionPoint: "before_provider_fetch",
        },
      },
    ];
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        sourceHeadSha,
        publication,
      }),
    ).rejects.toThrow("hosted_pool_canary_fault_evidence_graph_invalid:42");

    prisma.auditEvent.findMany = async () => [
      {
        targetId: planIdHash,
        createdAt: new Date("2026-08-24T00:00:01Z"),
        metadata: {
          planIdHash,
          repositoryId: "123456789",
          runId: "42",
          runAttempt: 2,
          actionRef: `777genius/review-router@${"a".repeat(40)}`,
          bindingId: "binding-1",
          bindingRevision: "7",
          phase: "synthetic_unauthorized",
          requestOrdinal: 1,
          attemptOrdinal: 1,
          injectionPoint: "before_provider_fetch",
        },
      },
    ];
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        sourceHeadSha,
        publication,
      }),
    ).rejects.toThrow("hosted_pool_canary_fault_evidence_timestamps_invalid");
  });
});
