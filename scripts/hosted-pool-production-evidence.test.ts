import { describe, expect, it } from "vitest";
import { readExactHostedPoolRunEvidence } from "./hosted-pool-production-evidence";

const attempt = {
  id: "attempt-1",
  relayRequestId: "request-1",
  grantId: "grant-1",
  attemptOrdinal: 1,
  state: "succeeded",
  errorCode: null,
  accountId: "account-a",
  dispatchStartedAt: new Date("2026-08-24T00:00:02Z"),
  responseStartedAt: new Date("2026-08-24T00:00:03Z"),
  completedAt: new Date("2026-08-24T00:00:04Z"),
  createdAt: new Date("2026-08-24T00:00:01.500Z"),
};
const grant = {
  id: "grant-1",
  invocationId: "invocation-1",
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

describe("hosted pool exact production evidence graph", () => {
  it("requires one grant, one request, and contiguous effects", async () => {
    const prisma = {
      hostedCodexInvocationGrant: { findMany: async () => [grant] },
      auditEvent: { findMany: async () => [] },
    };
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        publication: {
          appBotPublicationCount: 1,
          nonAppBotPublicationCount: 0,
        },
      }),
    ).resolves.toMatchObject({
      runId: 42,
      repositoryBindingId: "binding-1",
      requestStatuses: ["succeeded"],
      attempts: [{ ordinal: 1, state: "succeeded" }],
    });
  });

  it("rejects an extra effect instead of accepting plausible evidence", async () => {
    const prisma = {
      hostedCodexInvocationGrant: {
        findMany: async () => [
          {
            ...grant,
            relayRequests: [
              {
                ...grant.relayRequests[0],
                upstreamAttempts: [attempt, { ...attempt, attemptOrdinal: 3 }],
              },
            ],
          },
        ],
      },
      auditEvent: { findMany: async () => [] },
    };
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        publication: {
          appBotPublicationCount: 1,
          nonAppBotPublicationCount: 0,
        },
      }),
    ).rejects.toThrow("hosted_pool_canary_evidence_graph_invalid:42");
  });

  it("binds a consumed fault to the same repository, run, request, and effect", async () => {
    const planIdHash = "f".repeat(64);
    const prisma = {
      hostedCodexInvocationGrant: { findMany: async () => [grant] },
      auditEvent: {
        findMany: async () => [
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
        ],
      },
    };
    await expect(
      readExactHostedPoolRunEvidence({
        prisma: prisma as never,
        runId: 42,
        runAttempt: 2,
        repositoryBindingId: "binding-1",
        bindingRevision: 7n,
        publication: {
          appBotPublicationCount: 1,
          nonAppBotPublicationCount: 0,
        },
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
        publication: {
          appBotPublicationCount: 1,
          nonAppBotPublicationCount: 0,
        },
      }),
    ).rejects.toThrow("hosted_pool_canary_fault_evidence_graph_invalid:42");

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
        publication: {
          appBotPublicationCount: 1,
          nonAppBotPublicationCount: 0,
        },
      }),
    ).rejects.toThrow("hosted_pool_canary_fault_evidence_timestamps_invalid");
  });
});
