import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReviewPublicationEffectStrategy,
  ReviewPublicationClaimState,
  ReviewPublicationExternalEffectKind,
  ReviewPublicationKind,
  ReviewPublicationOperationRole,
  ReviewPublicationOperationState,
  ReviewPublicationReceiptStatus,
} from "@reviewrouter/features-review-publishing/v2";
import {
  CapabilityAudience,
  CapabilityKind,
  ConfiguredCapabilityKeyRing,
  JoseRotatingCapabilityCodec,
} from "@reviewrouter/platform-signed-capabilities";
import {
  ProviderNeutralReviewV2ScmCredentialRouter,
  RotatingReviewV2OperationCapabilityIssuer,
  SignedReviewV2OperationCapabilityVerifier,
  GitHubReviewV2PublicationClient,
  readGitHubReviewV2LiveRevision,
  type GitHubInstallationClient,
  type ReviewV2ProviderCredentialPort,
  type ReviewV2ProviderPublicationClientPort,
} from "./review-v2-publication-gateways";
import {
  ReviewV2PublicationPayloadKind,
  type ReviewV2PublicationPayload,
} from "./review-v2-publication-payloads";
import {
  ReviewV2ScmCredentialPurpose,
  ReviewV2ScmProvider,
} from "./review-v2-publication-ports";

describe("protocol v2 provider-neutral SCM gateways", () => {
  it.each([ReviewV2ScmProvider.GitHub, ReviewV2ScmProvider.GitLab])(
    "routes %s through an adapter-bound credential session without exposing a token",
    async (provider) => {
      const acquired: unknown[] = [];
      const client = fakeClient();
      const credentials: ReviewV2ProviderCredentialPort = {
        provider,
        async acquireClient(input) {
          acquired.push(input);
          return { client, async close() {} };
        },
      };
      const router = new ProviderNeutralReviewV2ScmCredentialRouter(
        [credentials],
        allowingCapabilityVerifier,
      );

      const session = await router.acquire({
        provider,
        purpose: ReviewV2ScmCredentialPurpose.ReconcileOnly,
        permit: permit(),
        operation: operation(),
        capability: capability(),
        claim: claim(),
        signedCapability: signedCapability(),
      });
      expect(session.purpose).toBe(ReviewV2ScmCredentialPurpose.ReconcileOnly);
      expect("applyOperation" in session.gateway).toBe(false);
      expect(acquired).toEqual([
        {
          purpose: ReviewV2ScmCredentialPurpose.ReconcileOnly,
          permit: permit(),
          capability: capability(),
        },
      ]);
      expect(collectKeys(acquired)).not.toContainEqual(
        expect.stringMatching(/^(?:token|secret|credential)$/i),
      );
    },
  );

  it("fails closed for missing and duplicate provider credential adapters", async () => {
    expect(
      () =>
        new ProviderNeutralReviewV2ScmCredentialRouter(
          [
            credentialProvider(ReviewV2ScmProvider.GitHub),
            credentialProvider(ReviewV2ScmProvider.GitHub),
          ],
          allowingCapabilityVerifier,
        ),
    ).toThrow("review_v2_scm_credential_provider_duplicate");

    const router = new ProviderNeutralReviewV2ScmCredentialRouter(
      [],
      allowingCapabilityVerifier,
    );
    await expect(
      router.acquire({
        provider: ReviewV2ScmProvider.GitLab,
        purpose: ReviewV2ScmCredentialPurpose.Mutate,
        permit: permit(),
        operation: operation(),
        capability: capability(),
        claim: claim(),
        signedCapability: signedCapability(),
      }),
    ).rejects.toThrow("review_v2_scm_credential_provider_missing");
  });

  it("verifies an issued operation capability before credential acquisition", async () => {
    const boundary = capabilityBoundary();
    const signed = await boundary.issuer.issue(capabilityInput());
    const providerCalls: unknown[] = [];
    const provider: ReviewV2ProviderCredentialPort = {
      provider: ReviewV2ScmProvider.GitHub,
      async acquireClient(input) {
        providerCalls.push(input);
        return { client: fakeClient(), async close() {} };
      },
    };
    const router = new ProviderNeutralReviewV2ScmCredentialRouter(
      [provider],
      boundary.verifier,
    );

    await expect(
      router.acquire({
        ...capabilityInput(),
        provider: ReviewV2ScmProvider.GitHub,
        purpose: ReviewV2ScmCredentialPurpose.Mutate,
        signedCapability: signed,
      }),
    ).resolves.toMatchObject({
      purpose: ReviewV2ScmCredentialPurpose.Mutate,
    });
    expect(providerCalls).toHaveLength(1);
    expect(collectKeys(providerCalls)).not.toContain("signedCapability");
    expect(collectKeys(providerCalls)).not.toContain("token");
  });

  it("rejects a tampered operation capability before provider credentials are acquired", async () => {
    const boundary = capabilityBoundary();
    const signed = await boundary.issuer.issue(capabilityInput());
    const providerCalls: unknown[] = [];
    const router = new ProviderNeutralReviewV2ScmCredentialRouter(
      [
        {
          provider: ReviewV2ScmProvider.GitHub,
          async acquireClient() {
            providerCalls.push(true);
            return { client: fakeClient(), async close() {} };
          },
        },
      ],
      boundary.verifier,
    );

    await expect(
      router.acquire({
        ...capabilityInput(),
        provider: ReviewV2ScmProvider.GitHub,
        purpose: ReviewV2ScmCredentialPurpose.Mutate,
        signedCapability: {
          ...signed,
          token: tamperSignature(signed.token),
        },
      }),
    ).rejects.toThrow();
    expect(providerCalls).toEqual([]);
  });

  it("rejects a moved permit head before credential acquisition or SCM queries", async () => {
    const boundary = capabilityBoundary();
    const signed = await boundary.issuer.issue(capabilityInput());
    const providerCalls: unknown[] = [];
    const router = new ProviderNeutralReviewV2ScmCredentialRouter(
      [
        {
          provider: ReviewV2ScmProvider.GitHub,
          async acquireClient() {
            providerCalls.push(true);
            return { client: fakeClient(), async close() {} };
          },
        },
      ],
      boundary.verifier,
    );

    await expect(
      router.acquire({
        ...capabilityInput(),
        permit: { ...permit(), reviewedHeadSha: hash("9") },
        provider: ReviewV2ScmProvider.GitHub,
        purpose: ReviewV2ScmCredentialPurpose.Mutate,
        signedCapability: signed,
      }),
    ).rejects.toThrow("review_v2_operation_capability_context_mismatch");
    expect(providerCalls).toEqual([]);
  });

  it.each([
    {
      name: "claim fence",
      expected: () => ({ claim: { ...claim(), fencingToken: 2n } }),
    },
    {
      name: "body",
      expected: () => ({ operation: { ...operation(), bodyHash: hash("9") } }),
    },
    {
      name: "target",
      expected: () => ({
        operation: { ...operation(), targetCommitId: hash("9") },
      }),
    },
  ])(
    "rejects a capability bound to a different $name",
    async ({ expected }) => {
      const boundary = capabilityBoundary();
      const signed = await boundary.issuer.issue(capabilityInput());

      await expect(
        boundary.verifier.verify({
          ...capabilityInput(),
          ...expected(),
          signedCapability: signed,
        }),
      ).rejects.toThrow();
    },
  );

  it("rejects the right claims signed for the wrong audience", async () => {
    const boundary = capabilityBoundary();
    const signed = await boundary.issuer.issue(capabilityInput());
    const claims = await boundary.codec.verify({
      token: signed.token,
      expectedIssuer: capabilityIssuer,
      expectedAudience: CapabilityAudience.ReviewPublicationOperation,
      expectedKind: CapabilityKind.PublicationOperation,
      now: boundary.clock.now(),
    });
    const wrongAudience = await boundary.codec.sign({
      ...claims,
      audience: CapabilityAudience.ReviewPublicationClaim,
    });

    await expect(
      boundary.verifier.verify({
        ...capabilityInput(),
        signedCapability: wrongAudience,
      }),
    ).rejects.toMatchObject({ code: "wrong_audience" });
  });

  it("rejects an expired operation capability", async () => {
    const boundary = capabilityBoundary();
    const signed = await boundary.issuer.issue(capabilityInput());
    boundary.clock.current = new Date("2026-07-23T12:30:01.000Z");

    await expect(
      boundary.verifier.verify({
        ...capabilityInput(),
        signedCapability: signed,
      }),
    ).rejects.toThrow();
  });

  it("accepts a persisted old signing key during its rotation window", async () => {
    const boundary = capabilityBoundary({
      activeKeyId: "key-2",
      oldKeyVerifyUntil: new Date("2026-07-23T13:00:00.000Z"),
    });
    const signed = await boundary.issuer.issue(capabilityInput());

    expect(signed.signingKeyId).toBe("key-1");
    await expect(
      boundary.verifier.verify({
        ...capabilityInput(),
        signedCapability: signed,
      }),
    ).resolves.toBeUndefined();
  });

  it("reads a stable live GitHub base, head, and merge base and rejects movement", async () => {
    const stable = githubRevisionClient([hash("a"), hash("a")]);
    await expect(
      readGitHubReviewV2LiveRevision(stable, githubRepository, permit()),
    ).resolves.toEqual({
      baseSha: hash("0"),
      mergeBaseSha: hash("3"),
      headSha: hash("a"),
      reviewRevisionHash: digest({
        workspaceId: "workspace-1",
        repositoryConnectionId: "repository-1",
        scmRepositoryIdentityId: "identity-1",
        pullRequestNumber: 42,
        baseSha: hash("0"),
        mergeBaseSha: hash("3"),
        headSha: hash("a"),
      }),
    });

    await expect(
      readGitHubReviewV2LiveRevision(
        githubRevisionClient([hash("a"), hash("9")]),
        githubRepository,
        permit(),
      ),
    ).resolves.toBeNull();
  });

  it("fully paginates review comments and hashes observed review facts", async () => {
    const marker = "<!-- review-router:review-1 -->";
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      githubReviewComment(index + 1),
    );
    const secondPage = [githubReviewComment(101)];
    const expectedComments = [...firstPage, ...secondPage].map((comment) => ({
      path: comment.path,
      line: comment.line,
      startLine: null,
      body: comment.body,
    }));
    const requests: Array<Readonly<Record<string, unknown>>> = [];
    const octokit: GitHubInstallationClient = {
      async request(route, parameters = {}) {
        requests.push({ route, ...parameters });
        if (route.endsWith("/reviews")) {
          return {
            data: [
              {
                id: 7,
                body: marker,
                commit_id: hash("9"),
                state: "PENDING",
                user: { login: "review-router[bot]" },
                app: { slug: "review-router" },
              },
            ],
          };
        }
        const page = parameters.page;
        return { data: page === 1 ? firstPage : secondPage };
      },
      async graphql() {
        throw new Error("unexpected_graphql_call");
      },
    };
    const payload = {
      kind: ReviewV2PublicationPayloadKind.PendingReviewCreate,
      marker,
      markerHash: hash("1"),
      bodyHash: digest({
        body: marker,
        commitId: hash("9"),
        comments: expectedComments,
      }),
      bodyByteCount: Buffer.byteLength(marker, "utf8"),
      body: marker,
      comments: expectedComments,
    } as const;
    const client = githubPublicationClient(octokit, payload);
    const result = await client.findAllByMarker({
      operation: reviewOperation(),
      cursor: null,
    });
    expect(requests.filter((request) => request.page === 2)).toHaveLength(1);
    expect(result.objects).toEqual([
      expect.objectContaining({
        externalObjectId: "review:7",
        bodyHash: payload.bodyHash,
        observedObjectHash: digest({
          commitId: hash("9"),
          author: "review-router[bot]",
          app: "review-router",
          state: "PENDING",
          body: marker,
          comments: expectedComments,
        }),
      }),
    ]);
  });

  it("restores canonical line coordinates omitted by pending GitHub reviews", async () => {
    const marker = "<!-- review-router:review-pending -->";
    const expectedComments = [
      {
        path: "src/access-policy.js",
        line: 42,
        startLine: null,
        body: `finding\n${marker}:finding-1`,
      },
    ] as const;
    const payload = {
      kind: ReviewV2PublicationPayloadKind.PendingReviewCreate,
      marker,
      markerHash: hash("1"),
      bodyHash: digest({
        body: marker,
        commitId: hash("9"),
        comments: expectedComments,
      }),
      bodyByteCount: Buffer.byteLength(marker, "utf8"),
      body: marker,
      comments: expectedComments,
    } as const;
    const client = githubPublicationClient(
      pendingReviewClient(marker, {
        path: expectedComments[0].path,
        body: expectedComments[0].body,
        line: null,
        original_line: null,
        start_line: null,
        original_start_line: null,
        position: 4,
        original_position: 4,
      }),
      payload,
    );

    await expect(
      client.findAllByMarker({
        operation: reviewOperation(),
        cursor: null,
      }),
    ).resolves.toEqual({
      objects: [
        expect.objectContaining({
          externalObjectId: "review:7",
          bodyHash: payload.bodyHash,
        }),
      ],
      nextCursor: null,
    });
  });

  it("matches duplicate pending comments as a canonical multiset", async () => {
    const marker = "<!-- review-router:review-duplicates -->";
    const commentBody = `finding\n${marker}:finding-1`;
    const expectedComments = [42, 43].map((line) => ({
      path: "src/access-policy.js",
      line,
      startLine: null,
      body: commentBody,
    }));
    const payload = {
      kind: ReviewV2PublicationPayloadKind.PendingReviewCreate,
      marker,
      markerHash: hash("1"),
      bodyHash: digest({
        body: marker,
        commitId: hash("9"),
        comments: expectedComments,
      }),
      bodyByteCount: Buffer.byteLength(marker, "utf8"),
      body: marker,
      comments: expectedComments,
    } as const;
    const client = githubPublicationClient(
      pendingReviewClient(
        marker,
        expectedComments.map((comment, index) => ({
          path: comment.path,
          body: comment.body,
          line: null,
          original_line: null,
          start_line: null,
          original_start_line: null,
          position: index + 4,
          original_position: index + 4,
        })),
      ),
      payload,
    );

    const result = await client.findAllByMarker({
      operation: reviewOperation(),
      cursor: null,
    });

    expect(result.objects).toEqual([
      expect.objectContaining({ bodyHash: payload.bodyHash }),
    ]);
  });

  it("does not accept a pending review as a submitted review", async () => {
    const marker = "<!-- review-router:review-submitted -->";
    const comments = [
      {
        path: "src/access-policy.js",
        line: 42,
        startLine: null,
        body: `finding\n${marker}:finding-1`,
      },
    ] as const;
    const payload = {
      kind: ReviewV2PublicationPayloadKind.SubmittedReview,
      marker,
      markerHash: hash("1"),
      bodyHash: digest({ body: marker, commitId: hash("9"), comments }),
      bodyByteCount: Buffer.byteLength(marker, "utf8"),
      body: marker,
      comments,
    } as const;
    const client = githubPublicationClient(
      pendingReviewClient(marker, [
        {
          path: comments[0].path,
          body: comments[0].body,
          line: null,
          original_line: null,
          start_line: null,
          original_start_line: null,
        },
      ]),
      payload,
    );

    await expect(
      client.findAllByMarker({
        operation: reviewOperation(),
        cursor: null,
      }),
    ).resolves.toEqual({ objects: [], nextCursor: null });
  });

  it("rejects a pending review whose available line conflicts with the payload", async () => {
    const marker = "<!-- review-router:review-conflict -->";
    const expectedComments = [
      {
        path: "src/access-policy.js",
        line: 42,
        startLine: null,
        body: `finding\n${marker}:finding-1`,
      },
    ] as const;
    const payload = {
      kind: ReviewV2PublicationPayloadKind.PendingReviewCreate,
      marker,
      markerHash: hash("1"),
      bodyHash: digest({
        body: marker,
        commitId: hash("9"),
        comments: expectedComments,
      }),
      bodyByteCount: Buffer.byteLength(marker, "utf8"),
      body: marker,
      comments: expectedComments,
    } as const;
    const client = githubPublicationClient(
      pendingReviewClient(marker, {
        path: expectedComments[0].path,
        body: expectedComments[0].body,
        line: 43,
        original_line: 43,
        start_line: null,
        original_start_line: null,
      }),
      payload,
    );

    await expect(
      client.findAllByMarker({
        operation: reviewOperation(),
        cursor: null,
      }),
    ).rejects.toThrow("github_review_comment_identity_mismatch");
  });

  it("queries managed-check inventory at the operation target commit", async () => {
    const refs: unknown[] = [];
    const payload = {
      kind: ReviewV2PublicationPayloadKind.ManagedCheck,
      marker: "review-router-check-marker",
      markerHash: hash("1"),
      bodyHash: hash("2"),
      bodyByteCount: 26,
      name: "ReviewRouter",
      title: "Review complete",
      summary: "review-router-check-marker",
      conclusion: "success",
    } as const;
    const client = githubPublicationClient(
      {
        async request(route, parameters = {}) {
          expect(route).toBe(
            "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
          );
          refs.push(parameters.ref);
          return { data: { check_runs: [] } };
        },
        async graphql<T = unknown>(): Promise<T> {
          throw new Error("unexpected_graphql_call");
        },
      },
      payload,
    );
    const targetCommitId = hash("9");

    await expect(
      client.findAllByMarker({
        operation: {
          ...operation(),
          publicationKind: ReviewPublicationKind.ManagedCheck,
          targetCommitId,
        },
        cursor: null,
      }),
    ).resolves.toEqual({ objects: [], nextCursor: null });
    expect(refs).toEqual([targetCommitId]);
  });

  it("binds a lifecycle thread to the permitted repository and pull request before mutation", async () => {
    const graphqlCalls: string[] = [];
    const octokit: GitHubInstallationClient = {
      async request() {
        throw new Error("unexpected_request_call");
      },
      async graphql(query) {
        graphqlCalls.push(query);
        return {
          node: {
            id: "thread-1",
            isResolved: false,
            pullRequest: {
              number: 99,
              repository: { nameWithOwner: "owner/repo" },
            },
          },
        } as never;
      },
    };
    const payload = {
      kind: ReviewV2PublicationPayloadKind.ThreadLifecycle,
      marker: "reviewrouter-lifecycle:1:resolved",
      markerHash: hash("1"),
      bodyHash: hash("2"),
      bodyByteCount: 32,
      threadId: "thread-1",
      resolve: true,
    } as const;
    const client = githubPublicationClient(octokit, payload);

    await expect(
      client.applyOperation({
        operation: lifecycleOperation(),
        capability: capability(),
      }),
    ).rejects.toMatchObject({
      safeCode: "github_review_thread_provenance_mismatch",
      outcome: "definitely_no_effect",
    });
    expect(graphqlCalls).toHaveLength(1);
    expect(graphqlCalls[0]).toContain("query ReviewRouterPublicationThread");
  });
});

const capabilityIssuer = "reviewrouter-review-v2-worker";
const githubRepository = {
  githubInstallationId: "1",
  owner: "owner",
  repo: "repo",
} as const;

function pendingReviewClient(
  marker: string,
  comments:
    | Readonly<Record<string, unknown>>
    | readonly Readonly<Record<string, unknown>>[],
): GitHubInstallationClient {
  return {
    async request(route) {
      if (route.endsWith("/reviews")) {
        return {
          data: [
            {
              id: 7,
              body: marker,
              commit_id: hash("9"),
              state: "PENDING",
              user: { login: "review-router[bot]" },
              app: { slug: "review-router" },
            },
          ],
        };
      }
      if (route.endsWith("/comments")) {
        return { data: Array.isArray(comments) ? comments : [comments] };
      }
      throw new Error("unexpected_request_call");
    },
    async graphql<T = unknown>(): Promise<T> {
      throw new Error("unexpected_graphql_call");
    },
  };
}

function githubRevisionClient(
  headSequence: readonly [string, string],
): GitHubInstallationClient {
  let pointerRead = 0;
  return {
    async request(route) {
      if (route.includes("/compare/")) {
        return { data: { merge_base_commit: { sha: hash("3") } } };
      }
      const headSha = headSequence[pointerRead++];
      return {
        data: { base: { sha: hash("0") }, head: { sha: headSha } },
      };
    },
    async graphql<T = unknown>(): Promise<T> {
      throw new Error("unexpected_graphql_call");
    },
  };
}

function githubPublicationClient(
  octokit: GitHubInstallationClient,
  payload: ReviewV2PublicationPayload,
) {
  return new GitHubReviewV2PublicationClient({
    octokit,
    repository: githubRepository,
    permit: permit(),
    capability: capability(),
    payloads: {
      async resolve() {
        return payload;
      },
    },
    botLogin: "review-router[bot]",
  });
}

function githubReviewComment(index: number) {
  return {
    path: `src/file-${index}.ts`,
    line: index,
    body: `finding-${index}`,
  };
}

function reviewOperation() {
  return {
    ...operation(),
    publicationKind: ReviewPublicationKind.PendingReviewCreate,
  };
}

function lifecycleOperation() {
  return {
    ...operation(),
    publicationKind: ReviewPublicationKind.ThreadLifecycle,
  };
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function capabilityInput() {
  return {
    permit: permit(),
    operation: operation(),
    capability: capability(),
    claim: claim(),
  };
}

function capabilityBoundary(
  input: {
    readonly activeKeyId?: "key-1" | "key-2";
    readonly oldKeyVerifyUntil?: Date | null;
  } = {},
) {
  const clock = {
    current: new Date("2026-07-23T12:00:01.000Z"),
    now() {
      return new Date(this.current);
    },
  };
  const keyRing = new ConfiguredCapabilityKeyRing({
    activeKeyId: input.activeKeyId ?? "key-1",
    keys: [
      {
        keyId: "key-1",
        secret: new TextEncoder().encode("a".repeat(32)),
        verifyUntil: input.oldKeyVerifyUntil ?? null,
      },
      {
        keyId: "key-2",
        secret: new TextEncoder().encode("b".repeat(32)),
        verifyUntil: null,
      },
    ],
  });
  const codec = new JoseRotatingCapabilityCodec(keyRing, 0);
  return {
    clock,
    codec,
    issuer: new RotatingReviewV2OperationCapabilityIssuer(keyRing, clock),
    verifier: new SignedReviewV2OperationCapabilityVerifier(
      { verify: (request) => codec.verify(request) },
      clock,
    ),
  };
}

function tamperSignature(token: string): string {
  const parts = token.split(".");
  const signature = parts[2];
  if (!signature) throw new Error("test_token_invalid");
  parts[2] = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
  return parts.join(".");
}

function credentialProvider(
  provider: ReviewV2ScmProvider,
): ReviewV2ProviderCredentialPort {
  return {
    provider,
    async acquireClient() {
      return { client: fakeClient(), async close() {} };
    },
  };
}

function fakeClient(): ReviewV2ProviderPublicationClientPort {
  return {
    async findAllByMarker() {
      return { objects: [], nextCursor: null };
    },
    async applyOperation() {
      return {
        externalObjectId: "object-1",
        effectKind: ReviewPublicationExternalEffectKind.MutationAcknowledged,
        markerHash: hash("1"),
        bodyHash: hash("2"),
        observedObjectHash: hash("3"),
        observedAt: new Date("2026-07-23T12:00:00.000Z"),
      };
    },
    async markStaleOrDelete() {
      return ReviewPublicationReceiptStatus.Succeeded;
    },
  };
}

const allowingCapabilityVerifier = {
  async verify() {},
};

function signedCapability() {
  return {
    token: "opaque-signed-operation-capability",
    capabilityId: "operation-capability-1",
    signingKeyId: "key-1",
    expiresAt: new Date("2026-07-23T12:30:00.000Z"),
  };
}

function claim() {
  return {
    claimId: "claim-1",
    publicationAttemptId: "publication-1",
    ownerIdHash: hash("f"),
    acquireRequestIdHash: hash("1"),
    requestHash: hash("2"),
    claimCapabilityId: "claim-capability-1",
    capabilitySigningKeyId: "key-1",
    fencingToken: 1n,
    state: ReviewPublicationClaimState.Active,
    acquiredAt: new Date("2026-07-23T12:00:00.000Z"),
    renewedAt: new Date("2026-07-23T12:00:00.000Z"),
    expiresAt: new Date("2026-07-23T12:10:00.000Z"),
    retainUntil: new Date("2026-08-23T12:00:00.000Z"),
  };
}

function permit() {
  return {
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-1",
    scmRepositoryIdentityId: "identity-1",
    pullRequestNumber: 42,
    executionId: "execution-1",
    generation: 1n,
    authorizationId: "authorization-1",
    producerReleaseId: "release-1",
    reviewedHeadSha: hash("a"),
    reviewRevisionHash: hash("b"),
    projectionHash: hash("c"),
    lifecycleStateHash: hash("d"),
    commandLedgerWatermark: 2n,
    permitEpoch: 3n,
    publicationSafetyDecisionHash: hash("e"),
    publicationNotAfter: new Date("2026-07-23T12:05:00.000Z"),
  };
}

function operation() {
  return {
    publicationAttemptId: "publication-1",
    publicationOperationId: "operation-1",
    publicationKind: ReviewPublicationKind.Summary,
    chunkIndex: 0,
    effectStrategy: ReviewPublicationEffectStrategy.MutableSingleton,
    role: ReviewPublicationOperationRole.Standalone,
    markerHash: hash("1"),
    bodyHash: hash("2"),
    renderPolicyVersion: 1,
    targetCommitId: hash("a"),
    reviewRevisionHash: hash("b"),
    required: true,
    dependsOnOperationId: null,
    reconcileUntil: new Date("2026-07-23T12:30:00.000Z"),
    state: ReviewPublicationOperationState.InFlight,
  };
}

function capability() {
  return {
    capabilityId: "operation-capability-1",
    capabilitySigningKeyId: "key-1",
    publicationAttemptId: "publication-1",
    publicationOperationId: "operation-1",
    operationAttemptId: "operation-attempt-1",
    effectReportId: "effect-report-1",
    claimId: "claim-1",
    claimFencingToken: 1n,
    reviewRevisionHash: hash("b"),
    mutationEpoch: 3n,
    publicationSafetyDecisionHash: hash("e"),
    bodyHash: hash("2"),
    targetCommitId: hash("a"),
    targetExternalObjectId: null,
    effectReportUntil: new Date("2026-07-23T12:30:00.000Z"),
  };
}

function hash(character: string): string {
  return character.repeat(64);
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...collectKeys(child),
  ]);
}
