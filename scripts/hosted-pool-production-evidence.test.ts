import { createHash } from "node:crypto";
import {
  renderCanonicalReviewPublication,
  currentReviewProjectionPolicyVersion,
  CanonicalReviewPublicationRenderPolicyVersion,
  ReviewPublicationOccurrenceState,
} from "../packages/features/review-publishing/src/v2/domain/canonical-review-publication-renderer";
import {
  planReviewPublicationOperations,
  ReviewPublicationOperationIdentityVersion,
  ReviewPublicationProjectionCoverage,
} from "../packages/features/review-publishing/src/v2/domain/review-publication-operation-planning";
import { canonicalReviewPublicationJson as canonicalJson } from "../packages/features/review-publishing/src/v2/domain/canonical-review-publication-json";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
import { describe, expect, it, vi } from "vitest";
import {
  captureHostedPoolPublicationSnapshot,
  collectExactHostedPoolPublicationEvidence,
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
function renderingFixture(inline = false, partial = false, lifecycle = false) {
  const source = {
    summary: {
      marker: "reviewrouter:summary:test",
      body: inline ? "Two findings" : "No findings",
      allClear: !inline,
      occurrenceCounts: {
        new: inline ? 2 : 0,
        reconfirmed: 0,
        changed: 0,
        carried_unverified: 0,
        resolved: 0,
        uncertain: 0,
        suppressed_by_human: 0,
      },
    },
    check: {
      marker: "reviewrouter:check:test",
      name: "ReviewRouter",
      title: "Review complete",
      summary: "Review completed",
      conclusion: "success" as const,
    },
    inlineReviewChunks: inline
      ? [
          {
            chunkIndex: 0,
            marker: "reviewrouter:inline:test",
            comments: [
              {
                marker: "review-router-finding:one",
                path: "a.ts",
                line: 9,
                body: "Fix the error",
              },
              {
                marker: "review-router-finding:two",
                path: "b.ts",
                line: 8,
                startLine: 6,
                body: "Validate input",
              },
            ],
          },
        ]
      : [],
    lifecycle: lifecycle
      ? [
          {
            targetId: "target-1",
            threadId: "PRRT_one",
            verdict: "resolved",
            mutationEligible: true,
          },
        ]
      : [],
  };
  const projection = {
    envelopeVersion: "review_projection.v1",
    publishing: source,
    occurrences: inline
      ? [1, 2].map((id) => ({
          lineageId: `lineage-${id}`,
          state: ReviewPublicationOccurrenceState.New,
          observationIds: ["observation-1"],
          providerVoteKeys: [grant.providerInvocationKey],
          placement: { kind: "inline" },
        }))
      : [],
  };
  const json = canonicalJson(projection);
  const rendered = renderCanonicalReviewPublication(
    {
      source,
      targetCommitId: sourceHeadSha,
      coverage: partial
        ? ReviewPublicationProjectionCoverage.Partial
        : ReviewPublicationProjectionCoverage.Completed,
      occurrenceStates: projection.occurrences.map((entry) => entry.state),
      renderPolicyVersion:
        CanonicalReviewPublicationRenderPolicyVersion.PreliminaryFindingsV4,
    },
    { digestUtf8: digest, utf8ByteLength: Buffer.byteLength },
  );
  const artifact = {
    executionId: "execution-1",
    generation: 1n,
    reviewedHeadSha: sourceHeadSha,
    reviewRevisionHash: "a".repeat(64),
    projectionHash: digest(json),
    projectionEnvelopeCanonicalJson: json,
    projectionPolicyVersion: currentReviewProjectionPolicyVersion,
    coverageState: partial ? "partial" : "completed",
  };
  return { rendered, artifact };
}
const partialFixture = renderingFixture(false, true);
const publication = {
  appBotPublicationCount: 1,
  nonAppBotPublicationCount: 0,
  publicationObjects: [
    {
      kind: "issue_comment" as const,
      externalObjectId: "101",
      bodyHash: partialFixture.rendered.summary.bodyHash,
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
    finalizedReviewProjectionArtifactV2: {
      findUnique: async () => partialFixture.artifact,
    },
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
      findMany: async () => [
        {
          observationId: "observation-1",
          sourceExecutionId: "execution-1",
          providerInvocationKey: grant.providerInvocationKey,
          sourceHeadSha,
          sourceRunId: "42",
          sourceRunAttempt: "2",
        },
      ],
    },
    reviewExecutionObservationRefV2: {
      findMany: async () => [
        {
          observationRefId: "observation-ref-1",
          executionId: "execution-1",
          observationId: "observation-1",
          providerInvocationKey: grant.providerInvocationKey,
        },
      ],
    },
    reviewPublicationAttemptV2: {
      findMany: async () => [
        {
          publicationAttemptId: "publication-attempt-1",
          executionId: "execution-1",
          reviewedHeadSha: sourceHeadSha,
          state: "terminal",
          terminalOutcome: "succeeded",
          generation: 1n,
          projectionHash: partialFixture.artifact.projectionHash,
          reviewRevisionHash: partialFixture.artifact.reviewRevisionHash,
        },
      ],
    },
    reviewPublicationOperationV2: {
      findMany: async () => [
        {
          publicationOperationId: "publication-operation-1",
          publicationAttemptId: "publication-attempt-1",
          publicationKind: "summary",
          chunkIndex: 0,
          dependsOnOperationId: null,
          markerHash: partialFixture.rendered.summary.markerHash,
          renderPolicyVersion: 4,
          targetCommitId: sourceHeadSha,
          required: true,
          bodyHash: partialFixture.rendered.summary.bodyHash,
          state: "completed",
        },
      ],
    },
    reviewPublicationReceiptV2: {
      findMany: async () => [
        {
          publicationOperationId: "publication-operation-1",
          receiptId: "receipt-1",
          publicationAttemptId: "publication-attempt-1",
          status: "succeeded",
          canonicalEffectId: "publication-effect-1",
          canonicalExternalObjectId: "issue-comment:101",
        },
      ],
    },
    reviewPublicationExternalEffectV2: {
      findMany: async () => [
        {
          effectId: "publication-effect-1",
          publicationAttemptId: "publication-attempt-1",
          effectKind: "mutation_acknowledged",
          publicationOperationId: "publication-operation-1",
          externalObjectId: "issue-comment:101",
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

  it("times out Render deploy evidence and aborts every in-flight request", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) return;
          signals.push(init.signal);
          init.signal.addEventListener(
            "abort",
            () => reject(new Error("secret")),
            {
              once: true,
            },
          );
        }),
    );
    const port = createRenderHostedPoolDeploymentEvidencePort({
      apiKey: "render-token",
      serviceIds: ["srv-api", "srv-web"],
      fetchImpl,
      renderTimeoutMs: 5,
    });
    await expect(port.readExactRevision("a".repeat(40))).rejects.toThrow(
      "hosted_pool_render_evidence_timeout",
    );
    await vi.waitFor(() => {
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    });
  });

  it("caps Render deploy evidence bodies and cancels overflow", async () => {
    const cancellations: string[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1025));
            },
            cancel() {
              cancellations.push("cancelled");
            },
          }),
        ),
    );
    const port = createRenderHostedPoolDeploymentEvidencePort({
      apiKey: "render-token",
      serviceIds: ["srv-api", "srv-web"],
      fetchImpl,
      renderMaxResponseBytes: 1024,
    });
    await expect(port.readExactRevision("a".repeat(40))).rejects.toThrow(
      "hosted_pool_render_evidence_response_too_large",
    );
    await vi.waitFor(() => expect(cancellations).toHaveLength(2));
  });

  it("clears Render evidence deadlines after successful bounded reads", async () => {
    const releaseSha = "a".repeat(40);
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return new Response(
          JSON.stringify([
            {
              deploy: {
                id: "dep-live",
                status: "live",
                commit: { id: releaseSha },
              },
            },
          ]),
        );
      },
    );
    const port = createRenderHostedPoolDeploymentEvidencePort({
      apiKey: "render-token",
      serviceIds: ["srv-api", "srv-web"],
      fetchImpl,
      renderTimeoutMs: 5,
    });
    await expect(port.readExactRevision(releaseSha)).resolves.toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
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
        receiptId: "receipt-1",
        publicationAttemptId: "publication-attempt-1",
        status: "succeeded",
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

const scope = {
  repository: "owner/disposable",
  pullRequestNumber: 7,
  sourceHeadSha,
  now: () => new Date("2026-08-23T23:59:00Z"),
};
const comment = (overrides: Record<string, unknown> = {}) => ({
  id: 101,
  commit_id: sourceHeadSha,
  pull_request_review_id: 101,
  path: "a.ts",
  line: 1,
  side: "RIGHT",
  state: "COMMENTED",
  body: "<!-- reviewrouter:summary --> old",
  user: { login: "reviewrouter-app[bot]" },
  created_at: "2026-08-23T00:00:00Z",
  updated_at: "2026-08-23T00:00:00Z",
  ...overrides,
});
function fakeGitHub(
  pages: unknown[][],
  threads: { id: string; isResolved: boolean }[] = [],
  jobs: unknown[] = [],
) {
  return {
    request: vi.fn(async (_method: "GET" | "POST", path: string) => {
      if (path.includes("/attempts/2/jobs?"))
        return { total_count: jobs.length, jobs };
      if (path === "/graphql")
        return {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: threads,
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        };
      if (path.includes("/check-runs?")) return { check_runs: pages[3] ?? [] };
      return pages[
        path.includes("/issues/") ? 0 : path.includes("/reviews?") ? 2 : 1
      ];
    }),
  };
}
const window = {
  exactRunId: 42,
  ...scope,
  now: () => new Date("2026-08-24T00:01:30Z"),
  dispatchedAt: new Date("2026-08-24T00:00:00Z"),
  expectedAppBot: "reviewrouter-app[bot]",
  startedAt: new Date("2026-08-24T00:00:00Z"),
  finishedAt: new Date("2026-08-24T00:01:00Z"),
};

describe("bounded publication snapshots", () => {
  it("captures identities, hashes, authors and markers without bodies", async () => {
    const baseline = await captureHostedPoolPublicationSnapshot(
      fakeGitHub([[comment()], [], []]),
      scope,
    );
    expect(baseline).toEqual({
      repository: scope.repository,
      pullRequestNumber: 7,
      sourceHeadSha,
      capturedAt: "2026-08-23T23:59:00.000Z",
      captureCompletedAt: "2026-08-23T23:59:00.000Z",
      lifecycleThreads: [],
      artifacts: [
        {
          kind: "issue_comment",
          externalObjectId: "101",
          bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          authorLogin: "reviewrouter-app[bot]",
          hasMarker: true,
          publishedAt: "2026-08-23T00:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(baseline)).not.toContain("<!--");
    await expect(
      collectExactHostedPoolPublicationEvidence(
        fakeGitHub([[comment()], [], []]),
        { ...window, baseline },
      ),
    ).resolves.toMatchObject({ publicationObjects: [] });
  });

  it("collects an edited old comment and a late publication after run completion", async () => {
    const baseline = await captureHostedPoolPublicationSnapshot(
      fakeGitHub([[comment()], [], []]),
      scope,
    );
    const result = await collectExactHostedPoolPublicationEvidence(
      fakeGitHub([
        [
          comment({
            body: "<!-- reviewrouter:summary --> edited",
            updated_at: "2026-08-24T00:00:30Z",
          }),
          comment({
            id: 102,
            created_at: "2026-08-24T00:01:10Z",
            updated_at: "2026-08-24T00:01:10Z",
          }),
        ],
        [],
        [],
      ]),
      { ...window, baseline },
    );
    expect(result.appBotPublicationCount).toBe(2);
    expect(
      result.publicationObjects.map((object) => object.externalObjectId),
    ).toEqual(["101", "102"]);
    expect(result.publicationObjects[0]!.bodyHash).not.toBe(
      baseline.artifacts[0]!.bodyHash,
    );
    expect(result.publicationObjects[0]!.publishedAt).toBe(
      "2026-08-24T00:00:30.000Z",
    );
  });

  it.each(["marker removal", "deletion", "outside observation"])(
    "fails closed on %s",
    async (scenario) => {
      const baseline = await captureHostedPoolPublicationSnapshot(
        fakeGitHub([[comment()], [], []]),
        scope,
      );
      const current =
        scenario === "deletion"
          ? []
          : [
              comment(
                scenario === "marker removal"
                  ? { body: "marker gone", updated_at: "2026-08-24T00:00:30Z" }
                  : { updated_at: "2026-08-24T00:02:00Z" },
              ),
            ];
      await expect(
        collectExactHostedPoolPublicationEvidence(
          fakeGitHub([current, [], []]),
          { ...window, baseline },
        ),
      ).rejects.toThrow("hosted_pool_canary_publication_");
    },
  );

  it("reports unexpected bot authors and unmarked bot additions", async () => {
    const baseline = await captureHostedPoolPublicationSnapshot(
      fakeGitHub([[comment()], [], []]),
      scope,
    );
    const result = await collectExactHostedPoolPublicationEvidence(
      fakeGitHub([
        [
          comment({ user: { login: "other-app[bot]" } }),
          comment({
            id: 102,
            body: "unmarked",
            user: { login: "github-actions[bot]" },
          }),
        ],
        [],
        [],
      ]),
      { ...window, baseline },
    );
    expect(result.nonAppBotPublicationCount).toBe(2);
  });

  it("preserves colliding numeric IDs across semantic kinds", async () => {
    const baseline = await captureHostedPoolPublicationSnapshot(
      fakeGitHub([[], [], []]),
      scope,
    );
    const result = await collectExactHostedPoolPublicationEvidence(
      fakeGitHub([[comment()], [comment()], [comment()]]),
      { ...window, baseline },
    );
    expect(result.publicationObjects.map((object) => object.kind)).toEqual([
      "issue_comment",
      "review_comment",
      "review",
    ]);
    expect(result.appBotPublicationCount).toBe(3);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    "01",
    "1e3",
    "foreign",
  ])("rejects malformed ID %s", async (id) => {
    await expect(
      captureHostedPoolPublicationSnapshot(
        fakeGitHub([[comment({ id })], [], []]),
        scope,
      ),
    ).rejects.toThrow("publication_identity_invalid");
  });

  it.each([
    "duplicate",
    "full page",
    "non-array",
    "bad timestamp",
    "missing author",
    "missing body",
  ])("rejects %s", async (scenario) => {
    const items =
      scenario === "duplicate"
        ? [comment(), comment()]
        : scenario === "full page"
          ? Array(100).fill(comment())
          : scenario === "non-array"
            ? {}
            : [
                comment(
                  scenario === "bad timestamp"
                    ? { updated_at: "invalid" }
                    : scenario === "missing author"
                      ? { user: null }
                      : { body: null },
                ),
              ];
    await expect(
      captureHostedPoolPublicationSnapshot(
        fakeGitHub([items as unknown[], [], []]),
        scope,
      ),
    ).rejects.toThrow("hosted_pool_canary_publication_");
  });

  it.each([
    "repository",
    "PR",
    "wrong head",
    "duplicate baseline",
    "missing baseline",
    "invalid window",
  ])("rejects %s before reading current artifacts", async (scenario) => {
    const baseline = await captureHostedPoolPublicationSnapshot(
      fakeGitHub([[comment()], [], []]),
      scope,
    );
    const github = fakeGitHub([[], [], []]);
    const input = { ...window, baseline };
    if (scenario === "repository")
      input.baseline = { ...baseline, repository: "other/repo" };
    if (scenario === "PR")
      input.baseline = { ...baseline, pullRequestNumber: 8 };
    if (scenario === "wrong head")
      input.baseline = { ...baseline, sourceHeadSha: "f".repeat(40) };
    if (scenario === "duplicate baseline")
      input.baseline = {
        ...baseline,
        artifacts: [...baseline.artifacts, ...baseline.artifacts],
      };
    if (scenario === "missing baseline") input.baseline = undefined as never;
    if (scenario === "invalid window") input.finishedAt = new Date("invalid");
    await expect(
      collectExactHostedPoolPublicationEvidence(github, input),
    ).rejects.toThrow("hosted_pool_canary_publication_");
    expect(github.request).not.toHaveBeenCalled();
  });
});

const read = (prisma: ReturnType<typeof prismaFor>, evidence = publication) =>
  readExactHostedPoolRunEvidence({
    prisma: prisma as never,
    runId: 42,
    runAttempt: 2,
    repositoryBindingId: "binding-1",
    bindingRevision: 7n,
    sourceHeadSha,
    publication: evidence,
  });

describe("complete publication ledger joins", () => {
  it.each(["operation", "receipt", "effect"] as const)(
    "rejects extra, missing, orphan and duplicate %s rows",
    async (kind) => {
      for (const mutation of ["extra", "missing", "orphan", "duplicate"]) {
        const prisma = prismaFor([grant]);
        const table =
          kind === "operation"
            ? prisma.reviewPublicationOperationV2
            : kind === "receipt"
              ? prisma.reviewPublicationReceiptV2
              : prisma.reviewPublicationExternalEffectV2;
        const rows = await table.findMany();
        const extra = {
          ...rows[0],
          publicationOperationId: "orphan-operation",
          effectId: "orphan-effect",
          receiptId: "orphan-receipt",
        };
        table.findMany = (async () =>
          mutation === "missing"
            ? []
            : mutation === "orphan"
              ? [extra]
              : [
                  ...rows,
                  mutation === "duplicate" ? rows[0] : extra,
                ]) as typeof table.findMany;
        await expect(read(prisma)).rejects.toThrow(
          "hosted_pool_canary_publication_",
        );
      }
    },
  );

  it.each([
    "body",
    "head",
    "operation attempt",
    "receipt attempt",
    "effect attempt",
    "effect link",
    "receipt status",
    "unknown state",
  ])("rejects incorrect %s", async (field) => {
    const prisma = prismaFor([grant]);
    const operations = await prisma.reviewPublicationOperationV2.findMany();
    const receipts = await prisma.reviewPublicationReceiptV2.findMany();
    const effects = await prisma.reviewPublicationExternalEffectV2.findMany();
    if (field === "body") operations[0]!.bodyHash = "f".repeat(64);
    if (field === "head") operations[0]!.targetCommitId = "f".repeat(40);
    if (field === "operation attempt")
      operations[0]!.publicationAttemptId = "foreign";
    if (field === "receipt attempt")
      receipts[0]!.publicationAttemptId = "foreign";
    if (field === "effect attempt")
      effects[0]!.publicationAttemptId = "foreign";
    if (field === "effect link") receipts[0]!.canonicalEffectId = "foreign";
    if (field === "receipt status") receipts[0]!.status = "stale_visible";
    if (field === "unknown state") operations[0]!.state = "terminal_unknown";
    prisma.reviewPublicationOperationV2.findMany = async () => operations;
    prisma.reviewPublicationReceiptV2.findMany = async () => receipts;
    prisma.reviewPublicationExternalEffectV2.findMany = async () => effects;
    await expect(read(prisma)).rejects.toThrow(
      "hosted_pool_canary_publication_",
    );
  });

  it.each(["execution", "head", "provider", "reference"])(
    "rejects incorrect %s linkage",
    async (field) => {
      const prisma = prismaFor([grant]);
      const attempts = await prisma.reviewPublicationAttemptV2.findMany();
      const observations = await prisma.reviewEvidenceObservation.findMany();
      const references =
        await prisma.reviewExecutionObservationRefV2.findMany();
      if (field === "execution") attempts[0]!.executionId = "foreign";
      if (field === "head") attempts[0]!.reviewedHeadSha = "f".repeat(40);
      if (field === "provider")
        observations[0]!.providerInvocationKey = "f".repeat(64);
      if (field === "reference") references[0]!.observationId = "foreign";
      prisma.reviewPublicationAttemptV2.findMany = async () => attempts;
      prisma.reviewEvidenceObservation.findMany = async () => observations;
      prisma.reviewExecutionObservationRefV2.findMany = async () => references;
      await expect(read(prisma)).rejects.toThrow("hosted_pool_canary_");
    },
  );

  it("rejects duplicate gathered objects", async () => {
    await expect(
      read(prismaFor([grant]), {
        ...publication,
        appBotPublicationCount: 2,
        publicationObjects: [
          ...publication.publicationObjects,
          ...publication.publicationObjects,
        ],
      }),
    ).rejects.toThrow("publication_cardinality_invalid");
  });
});

describe("publication scope completeness guards", () => {
  it("queries the whole execution and follows cross-attempt operation links", async () => {
    const prisma = prismaFor([grant]);
    const attemptRead = vi.spyOn(prisma.reviewPublicationAttemptV2, "findMany");
    const observationRead = vi.spyOn(
      prisma.reviewEvidenceObservation,
      "findMany",
    );
    const referenceRead = vi.spyOn(
      prisma.reviewExecutionObservationRefV2,
      "findMany",
    );
    const receiptRead = vi.spyOn(prisma.reviewPublicationReceiptV2, "findMany");
    const effectRead = vi.spyOn(
      prisma.reviewPublicationExternalEffectV2,
      "findMany",
    );
    await read(prisma);
    expect(attemptRead).toHaveBeenCalledWith(
      expect.objectContaining({ where: { executionId: "execution-1" } }),
    );
    expect(observationRead).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sourceExecutionId: "execution-1" } }),
    );
    expect(referenceRead).toHaveBeenCalledWith(
      expect.objectContaining({ where: { executionId: "execution-1" } }),
    );
    for (const spy of [receiptRead, effectRead])
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { publicationAttemptId: "publication-attempt-1" },
              { publicationOperationId: { in: ["publication-operation-1"] } },
            ],
          },
        }),
      );
  });

  it.each([
    "managed_check",
    "pending_review_create",
    "pending_review_submit",
    "thread_lifecycle",
  ])(
    "rejects a %s substituted for a renderer-planned summary",
    async (publicationKind) => {
      const prisma = prismaFor([grant]);
      const operations = await prisma.reviewPublicationOperationV2.findMany();
      prisma.reviewPublicationOperationV2.findMany = async () => [
        { ...operations[0]!, publicationKind },
      ];
      await expect(read(prisma)).rejects.toThrow(
        "hosted_pool_canary_publication_",
      );
    },
  );

  it("does not hide additional publication attempts or provider observations", async () => {
    for (const tableName of [
      "reviewPublicationAttemptV2",
      "reviewEvidenceObservation",
      "reviewExecutionObservationRefV2",
    ] as const) {
      const prisma = prismaFor([grant]);
      const table = prisma[tableName];
      const rows = await table.findMany();
      table.findMany = (async () => [
        ...rows,
        ...rows,
      ]) as typeof table.findMany;
      await expect(read(prisma)).rejects.toThrow("hosted_pool_canary_");
    }
  });

  it("rejects an orphan ledger effect even for an optional no-effect operation", async () => {
    const prisma = prismaFor([grant]);
    const operations = await prisma.reviewPublicationOperationV2.findMany();
    const effects = await prisma.reviewPublicationExternalEffectV2.findMany();
    prisma.reviewPublicationOperationV2.findMany = async () => [
      ...operations,
      {
        ...operations[0]!,
        publicationOperationId: "optional",
        required: false,
        state: "failed_no_effect",
      },
    ];
    prisma.reviewPublicationExternalEffectV2.findMany = async () => [
      ...effects,
      { ...effects[0]!, effectId: "extra", publicationOperationId: "optional" },
    ];
    await expect(read(prisma)).rejects.toThrow(
      "hosted_pool_canary_publication_",
    );
  });
});

async function pipelineFixture(inline = false, lifecycle = false) {
  const f = renderingFixture(inline, false, lifecycle);
  const { rendered, artifact } = f;
  const plans = planReviewPublicationOperations({
    identity: {
      publicationAttemptId: "publication-attempt-1",
      version: ReviewPublicationOperationIdentityVersion.AttemptScopedV2,
    },
    envelope: {
      envelopeVersion: 1,
      producerReleaseId: "release-1",
      protocolLimitsProfileId: "limits-1",
      limitsDigest: "8".repeat(64),
      projectionHash: artifact.projectionHash,
      coverage: ReviewPublicationProjectionCoverage.Completed,
      targetCommitId: sourceHeadSha,
      reviewRevisionHash: artifact.reviewRevisionHash,
      renderPolicyVersion: 4,
      publicationNotAfter: new Date("2026-08-24T01:00:00Z"),
      summary: rendered.summary,
      managedCheck: rendered.managedCheck,
      inlineReviews: rendered.inlineReviews,
      lifecycle: rendered.lifecycle,
    },
    limits: {
      producerReleaseId: "release-1",
      protocolLimitsProfileId: "limits-1",
      limitsDigest: "8".repeat(64),
      maxPublicationOperations: 20,
      maxPublicationChunks: 20,
      maxPublicationBodyBytes: 1_000_000,
      maxReconciliationDurationMs: 60_000,
    },
  });
  const prisma = prismaFor([grant]);
  const attempts = await prisma.reviewPublicationAttemptV2.findMany();
  Object.assign(attempts[0]!, artifact);
  prisma.reviewPublicationAttemptV2.findMany = async () => attempts;
  prisma.finalizedReviewProjectionArtifactV2.findUnique = async () => artifact;
  const operations = plans.map((plan) => ({
    ...plan,
    publicationAttemptId: "publication-attempt-1",
    state: "completed",
  }));
  const receipts = operations.map((operation, index) => ({
    publicationAttemptId: "publication-attempt-1",
    publicationOperationId: operation.publicationOperationId,
    receiptId: `receipt-${index}`,
    status: "succeeded",
    canonicalEffectId: `effect-${index}`,
    canonicalExternalObjectId:
      operation.publicationKind === "summary"
        ? "issue-comment:101"
        : operation.publicationKind === "managed_check"
          ? "check-run:101"
          : operation.publicationKind === "thread_lifecycle"
            ? "thread:PRRT_one"
            : "review:101",
  }));
  const effects = receipts.map((receipt) => ({
    publicationAttemptId: receipt.publicationAttemptId,
    publicationOperationId: receipt.publicationOperationId,
    effectId: receipt.canonicalEffectId,
    externalObjectId: receipt.canonicalExternalObjectId,
    effectKind: "mutation_acknowledged",
  }));
  prisma.reviewPublicationOperationV2.findMany = async () =>
    operations as never;
  prisma.reviewPublicationReceiptV2.findMany = async () => receipts;
  prisma.reviewPublicationExternalEffectV2.findMany = async () => effects;
  const chunk = rendered.inlineReviews[0];
  const pages = [
    [comment({ body: rendered.summary.body })],
    chunk
      ? chunk.create.comments.map((item, index) =>
          comment({
            id: 101 + index,
            body: item.body,
            path: item.path,
            line: item.line,
            start_line: item.startLine,
            start_side: item.startLine ? "RIGHT" : null,
          }),
        )
      : [],
    chunk ? [comment({ body: chunk.submit.reviewBody })] : [],
    [
      {
        id: 101,
        name: rendered.managedCheck!.name,
        conclusion: rendered.managedCheck!.conclusion,
        output: {
          title: rendered.managedCheck!.title,
          summary: rendered.managedCheck!.summary,
        },
        head_sha: sourceHeadSha,
        status: "completed",
        app: { slug: "reviewrouter-app" },
        completed_at: "2026-08-24T00:00:30Z",
      },
    ],
  ];
  const baseline = await captureHostedPoolPublicationSnapshot(
    fakeGitHub(
      [[], [], []],
      lifecycle ? [{ id: "PRRT_one", isResolved: false }] : [],
    ),
    scope,
  );
  const collect = () =>
    collectExactHostedPoolPublicationEvidence(
      fakeGitHub(
        pages,
        lifecycle ? [{ id: "PRRT_one", isResolved: true }] : [],
      ),
      { ...window, baseline },
    );
  return {
    ...f,
    prisma,
    operations,
    receipts,
    effects,
    pages,
    baseline,
    collect,
  };
}

describe("real renderer and planner publication evidence", () => {
  it.each([false, true])(
    "accepts full coverage with inline=%s and canonical cross-kind ID collisions",
    async (inline) => {
      const f = await pipelineFixture(inline);
      const publication = await f.collect();
      expect(f.operations.map((op) => op.publicationKind)).toEqual(
        inline
          ? [
              "summary",
              "managed_check",
              "pending_review_create",
              "pending_review_submit",
            ]
          : ["summary", "managed_check"],
      );
      expect(publication.publicationObjects).toHaveLength(inline ? 5 : 2);
      await expect(read(f.prisma, publication as never)).resolves.toMatchObject(
        { publicationAttemptId: "publication-attempt-1" },
      );
      if (inline) {
        expect(f.rendered.inlineReviews[0]!.create.bodyHash).not.toBe(
          digest(f.rendered.inlineReviews[0]!.create.reviewBody),
        );
        expect(f.rendered.inlineReviews[0]!.submit.bodyHash).not.toBe(
          digest(f.rendered.inlineReviews[0]!.submit.reviewBody),
        );
      }
    },
  );

  it.each([
    "check title",
    "check head",
    "review body",
    "review head",
    "review state",
    "comment body",
    "comment placement",
    "comment parent",
    "comment head",
    "missing child",
    "extra child",
    "dependency",
    "namespace",
    "raw id",
    "shared identity",
    "required superseded",
    "extra effect",
    "rendering facts",
    "create hash",
  ])("rejects %s in the normal pipeline", async (mutation) => {
    const f = await pipelineFixture(true);
    const checks = f.pages[3]! as any[];
    const reviews = f.pages[2]! as any[];
    const comments = f.pages[1]! as any[];
    if (mutation === "check title") checks[0].output.title += " altered";
    if (mutation === "check head") checks[0].head_sha = "f".repeat(40);
    if (mutation === "review body") reviews[0].body += " altered";
    if (mutation === "review head") reviews[0].commit_id = "f".repeat(40);
    if (mutation === "review state") reviews[0].state = "PENDING";
    if (mutation === "comment body") comments[0].body += " altered";
    if (mutation === "comment placement") comments[0].line += 1;
    if (mutation === "comment parent") comments[0].pull_request_review_id = 999;
    if (mutation === "comment head") comments[0].commit_id = "f".repeat(40);
    if (mutation === "missing child") comments.pop();
    if (mutation === "extra child") comments.push({ ...comments[0], id: 999 });
    if (mutation === "dependency")
      (f.operations[3] as any).dependsOnOperationId =
        f.operations[0]!.publicationOperationId;
    if (mutation === "namespace" || mutation === "raw id") {
      f.receipts[0]!.canonicalExternalObjectId =
        mutation === "namespace" ? "review:101" : "101";
      f.effects[0]!.externalObjectId = f.receipts[0]!.canonicalExternalObjectId;
    }
    if (mutation === "shared identity")
      f.receipts[3]!.canonicalExternalObjectId =
        f.effects[3]!.externalObjectId = "review:999";
    if (mutation === "required superseded") {
      f.operations[1]!.state = "superseded_no_effect";
      f.receipts.splice(1, 1);
      f.effects.splice(1, 1);
    }
    if (mutation === "extra effect")
      f.effects.push({
        ...f.effects[0]!,
        effectId: "extra",
        effectKind: "marker_reconciled",
      });
    if (mutation === "rendering facts") f.artifact.generation = 2n;
    if (mutation === "create hash")
      (f.operations[2] as any).bodyHash = digest(
        f.rendered.inlineReviews[0]!.create.reviewBody,
      );
    await expect(read(f.prisma, (await f.collect()) as never)).rejects.toThrow(
      "hosted_pool_canary_publication_",
    );
  });

  it.each(["superseded_no_effect", "failed_no_effect"])(
    "rejects a canonical managed-check downgrade to %s",
    async (state) => {
      const f = await pipelineFixture();
      (f.operations[1] as any).required = false;
      f.operations[1]!.state = state;
      f.receipts.pop();
      f.effects.pop();
      f.pages[3] = [];
      await expect(
        read(f.prisma, (await f.collect()) as never),
      ).rejects.toThrow("publication_graph_invalid");
    },
  );

  it("names unsupported richer effect histories without dropping reports", async () => {
    const f = await pipelineFixture();
    f.effects.push({
      ...f.effects[0]!,
      effectId: "extra",
      effectKind: "marker_reconciled",
    });
    await expect(read(f.prisma, (await f.collect()) as never)).rejects.toThrow(
      "publication_effect_history_unsupported:42",
    );
  });

  it.each(["terminal_unknown", "lifecycle_compensated"])(
    "rejects %s effects without correction proofs",
    async (effectKind) => {
      const f = await pipelineFixture(false, true);
      f.effects[2]!.effectKind = effectKind;
      await expect(
        read(f.prisma, (await f.collect()) as never),
      ).rejects.toThrow("publication_graph_invalid");
    },
  );

  it("binds lifecycle state to its structured payload and canonical thread identity", async () => {
    const f = await pipelineFixture(false, true);
    const evidence = await f.collect();
    await expect(read(f.prisma, evidence as never)).resolves.toMatchObject({
      publicationAttemptId: "publication-attempt-1",
    });
    await expect(
      read(f.prisma, { ...evidence, lifecycleThreads: [] } as never),
    ).rejects.toThrow("publication_graph_invalid");
    await expect(
      read(f.prisma, {
        ...evidence,
        lifecycleThreads: [
          { threadId: "PRRT_one", resolve: false, changed: true },
        ],
      } as never),
    ).rejects.toThrow("publication_graph_invalid");
    await expect(
      read(f.prisma, {
        ...evidence,
        lifecycleThreads: [
          ...evidence.lifecycleThreads!,
          { threadId: "PRRT_extra", resolve: true, changed: true },
        ],
      } as never),
    ).rejects.toThrow("publication_graph_invalid");
  });

  it("rejects a baseline completed after dispatch even if it hides an unchanged Actions bot comment", async () => {
    const baseline = await captureHostedPoolPublicationSnapshot(
      fakeGitHub([
        [
          comment({
            user: { login: "github-actions[bot]" },
            updated_at: "2026-08-24T00:00:10Z",
          }),
        ],
        [],
        [],
      ]),
      { ...scope, now: () => new Date("2026-08-24T00:00:20Z") },
    );
    await expect(
      collectExactHostedPoolPublicationEvidence(fakeGitHub([[], [], []]), {
        ...window,
        baseline,
      }),
    ).rejects.toThrow("publication_scope_invalid");
  });

  it("requires stable re-observation after the requested quiescence cutoff", async () => {
    const baseline = await captureHostedPoolPublicationSnapshot(
      fakeGitHub([[], [], []]),
      scope,
    );
    const github = fakeGitHub([[], [], []]);
    const original = github.request.getMockImplementation()!;
    let reads = 0;
    github.request.mockImplementation(async (method, path) => {
      if (path.includes("/issues/") && ++reads > 1) return [comment()];
      return original(method, path);
    });
    await expect(
      collectExactHostedPoolPublicationEvidence(github, {
        ...window,
        baseline,
      }),
    ).rejects.toThrow("publication_observation_incomplete");
    await expect(
      collectExactHostedPoolPublicationEvidence(fakeGitHub([[], [], []]), {
        ...window,
        baseline,
        now: scope.now,
      }),
    ).rejects.toThrow("publication_observation_incomplete");
  });
});

describe("attempt-attributed Actions job checks", () => {
  const job = {
    id: 8001,
    run_id: 42,
    run_attempt: 2,
    head_sha: sourceHeadSha,
    check_run_url: `https://api.github.com/repos/${scope.repository}/check-runs/901`,
    status: "completed",
    conclusion: "success",
  };
  const check = {
    id: 901,
    head_sha: sourceHeadSha,
    app: { slug: "github-actions" },
    name: "Review",
    status: "completed",
    conclusion: "success",
    output: { title: null, summary: null, text: null },
    started_at: "2026-08-24T00:00:00Z",
    completed_at: "2026-08-24T00:01:00Z",
  };
  it.each([true, false])(
    "excludes only a proven job check (null output=%s)",
    async (nullable) => {
      const f = await pipelineFixture();
      f.pages[3]!.push(
        nullable
          ? check
          : { ...check, output: { title: "Review", summary: "Complete" } },
      );
      const github = fakeGitHub(f.pages, [], [job]);
      const evidence = await collectExactHostedPoolPublicationEvidence(github, {
        ...window,
        baseline: f.baseline,
      });
      expect(evidence.nonAppBotPublicationCount).toBe(0);
      await expect(read(f.prisma, evidence as never)).resolves.toMatchObject({
        publicationAttemptId: "publication-attempt-1",
      });
      expect(github.request).toHaveBeenCalledWith(
        "GET",
        `/repos/${scope.repository}/actions/runs/42/attempts/2/jobs?per_page=100`,
      );
    },
  );

  it.each([
    "run",
    "attempt",
    "head",
    "repo",
    "host",
    "suffix",
    "leading zero",
    "job id",
    "duplicate job",
    "duplicate check",
    "truncated",
  ])("fails closed on invalid job attribution: %s", async (mutation) => {
    const altered = { ...job };
    if (mutation === "run") altered.run_id++;
    if (mutation === "attempt") altered.run_attempt = 1;
    if (mutation === "head") altered.head_sha = "f".repeat(40);
    if (mutation === "repo")
      altered.check_run_url =
        "https://api.github.com/repos/other/repo/check-runs/901";
    if (mutation === "host")
      altered.check_run_url = altered.check_run_url.replace(
        "api.github.com",
        "example.com",
      );
    if (mutation === "suffix") altered.check_run_url += "?x=1";
    if (mutation === "leading zero")
      altered.check_run_url = altered.check_run_url.replace("/901", "/0901");
    if (mutation === "job id") altered.id = 0;
    const jobs = [altered];
    if (mutation === "duplicate job")
      jobs.push({
        ...job,
        check_run_url: job.check_run_url.replace("/901", "/902"),
      });
    if (mutation === "duplicate check") jobs.push({ ...job, id: 8002 });
    const github = fakeGitHub([[], [], [], [check]], [], jobs);
    if (mutation === "truncated") {
      const original = github.request.getMockImplementation()!;
      github.request.mockImplementation(async (method, path) =>
        path.includes("/jobs?")
          ? { jobs, total_count: 101 }
          : original(method, path),
      );
    }
    const baseline = await captureHostedPoolPublicationSnapshot(
      fakeGitHub([[], [], []]),
      scope,
    );
    await expect(
      collectExactHostedPoolPublicationEvidence(github, {
        ...window,
        baseline,
      }),
    ).rejects.toThrow("publication_jobs_invalid");
  });

  it.each([
    "unrelated check",
    "wrong check head",
    "wrong check status",
    "wrong conclusion",
    "unexpected app",
    "marker",
    "text marker",
  ])("retains an unexpected or RR check: %s", async (mutation) => {
    const f = await pipelineFixture();
    const altered = {
      ...check,
      output: { title: "Review", summary: "Complete", text: "" },
    };
    if (mutation === "unrelated check") altered.id = 902;
    if (mutation === "wrong check head") altered.head_sha = "f".repeat(40);
    if (mutation === "wrong check status") altered.status = "queued";
    if (mutation === "wrong conclusion") altered.conclusion = "failure";
    if (mutation === "unexpected app")
      altered.app = { slug: "reviewrouter-app" };
    if (mutation === "marker")
      altered.output.summary = "<!-- reviewrouter:summary -->";
    if (mutation === "text marker")
      altered.output.text = "<!-- reviewrouter:summary -->";
    f.pages[3]!.push(altered);
    const evidence = await collectExactHostedPoolPublicationEvidence(
      fakeGitHub(f.pages, [], [job]),
      { ...window, baseline: f.baseline },
    );
    expect(
      evidence.publicationObjects.some(
        (item) => item.externalObjectId === String(altered.id),
      ),
    ).toBe(true);
    await expect(read(f.prisma, evidence as never)).rejects.toThrow(
      "publication_",
    );
  });

  it("keeps genuine RR nullable check output invalid", async () => {
    await expect(
      captureHostedPoolPublicationSnapshot(
        fakeGitHub([
          [],
          [],
          [],
          [
            {
              ...check,
              output: { title: "reviewrouter:summary", summary: null },
            },
          ],
        ]),
        scope,
      ),
    ).rejects.toThrow("publication_identity_invalid");
  });
});

describe("canonical requiredness and publication clock precision", () => {
  it.each(["superseded_no_effect", "failed_no_effect"])(
    "rejects inline downgrade to %s with all effects removed",
    async (state) => {
      const f = await pipelineFixture(true);
      for (const op of f.operations.slice(2)) {
        (op as any).required = false;
        op.state = state;
      }
      f.receipts.splice(2);
      f.effects.splice(2);
      f.pages[1] = [];
      f.pages[2] = [];
      await expect(
        read(f.prisma, (await f.collect()) as never),
      ).rejects.toThrow("publication_graph_invalid");
    },
  );

  it.each([0, 500, 5000, 5001, Number.NaN])(
    "applies exactly the bounded dispatch skew %s ms",
    async (skew) => {
      const baseline = await captureHostedPoolPublicationSnapshot(
        fakeGitHub([[], [], []]),
        scope,
      );
      const pending = collectExactHostedPoolPublicationEvidence(
        fakeGitHub([[], [], []]),
        {
          ...window,
          baseline,
          dispatchedAt: new Date(window.startedAt.getTime() + skew),
        },
      );
      if (Number.isFinite(skew) && skew <= 5000)
        await expect(pending).resolves.toMatchObject({
          nonAppBotPublicationCount: 0,
        });
      else await expect(pending).rejects.toThrow("publication_scope_invalid");
    },
  );

  it.each(["startedAt", "finishedAt"] as const)(
    "rejects invalid %s",
    async (field) => {
      const baseline = await captureHostedPoolPublicationSnapshot(
        fakeGitHub([[], [], []]),
        scope,
      );
      await expect(
        collectExactHostedPoolPublicationEvidence(fakeGitHub([[], [], []]), {
          ...window,
          baseline,
          [field]: new Date(Number.NaN),
        }),
      ).rejects.toThrow("publication_scope_invalid");
    },
  );

  it("does not apply clock tolerance to local baseline completion", async () => {
    const baseline = await captureHostedPoolPublicationSnapshot(
      fakeGitHub([[], [], []]),
      scope,
    );
    await expect(
      collectExactHostedPoolPublicationEvidence(fakeGitHub([[], [], []]), {
        ...window,
        baseline: {
          ...baseline,
          captureCompletedAt: new Date(
            window.dispatchedAt.getTime() + 1,
          ).toISOString(),
        },
      }),
    ).rejects.toThrow("publication_scope_invalid");
  });
});
