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
  renderCanonicalHostedPoolWorkflowV5,
} from "@reviewrouter/features-workflow-provisioning";
import {
  HostedCodexGrantIssuer,
  type HostedCodexGrantAdmission,
} from "./hosted-codex-grant-composition.js";

const now = new Date("2026-08-15T10:00:00.000Z");
const commitSha = "a".repeat(40);
const workflowPath = ".github/workflows/reviewrouter-hosted.yml";
const workflowSource = `acme/private-repo/${workflowPath}@refs/heads/main`;
const workflowJobSource = `777genius/review-router/.github/workflows/reviewrouter-execution-reusable.yml@${commitSha}`;
const workflow = renderCanonicalHostedPoolWorkflowV5({
  actionRef: `777genius/review-router@${commitSha}`,
  apiUrl: "https://api.reviewrouter.dev",
  providerInstanceId: "hosted-pool:repository:123",
  bindingId: "binding-1",
  bindingRevision: 7,
});

describe("HostedCodexGrantIssuer", () => {
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

  it("rejects public repositories before consuming replay state or issuing grants", async () => {
    const fixture = createFixture({ visibility: "public" as never });
    await expect(fixture.issuer.issue(request())).rejects.toThrow(
      "hosted_repository_visibility_ineligible",
    );
    expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
    expect(fixture.grantCapabilities.issue).not.toHaveBeenCalled();
  });

  it("rejects stale client binding revisions before consuming OIDC", async () => {
    const fixture = createFixture();
    await expect(
      fixture.issuer.issue({ ...request(), bindingVersion: 6 }),
    ).rejects.toThrow("hosted_grant_binding_mismatch");
    expect(fixture.replayNonces.tryConsumeNonce).not.toHaveBeenCalled();
  });

  it.each([
    `777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@${commitSha}`,
    `evil/review-router/.github/workflows/reviewrouter-execution-reusable.yml@${commitSha}`,
    "777genius/review-router/.github/workflows/reviewrouter-execution-reusable.yml@refs/heads/main",
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

  it("recovers a response-loss retry without storing or rotating plaintext capabilities", async () => {
    const fixture = createFixture();
    const first = await fixture.issuer.issue(request());
    const retry = await fixture.issuer.issue(request());

    expect(retry.grant).toBe(first.grant);
    expect(retry.commentTokenRefreshCapability).toBe(
      first.commentTokenRefreshCapability,
    );
    expect(retry.invocationLeaseId).toBe(first.invocationLeaseId);
    expect(fixture.insert).toHaveBeenCalledOnce();
    expect(fixture.commentTokens.issueCommentToken).toHaveBeenCalledTimes(2);
  });
});

function createFixture(
  overrides: Partial<HostedCodexGrantAdmission> = {},
  claimOverrides: {
    [K in keyof ReturnType<typeof claims>]?:
      | ReturnType<typeof claims>[K]
      | undefined;
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
    workflowSchemaVersion: 5,
    workflowSource,
    workflowJobSource,
    workflowJobSha: commitSha,
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
    workflowSourceCommitSha: commitSha,
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
    issueCommentToken: vi.fn().mockResolvedValue({
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
    workflowSchemaVersion: 5,
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
    event_name: "pull_request_target" as const,
    run_id: "9001",
    run_attempt: "2",
    workflow_ref: workflowSource,
    workflow_sha: commitSha,
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
