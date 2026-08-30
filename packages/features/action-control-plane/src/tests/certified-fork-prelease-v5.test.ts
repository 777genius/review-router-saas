import { describe, expect, it, vi } from "vitest";
import { preleaseCodexRotatingOAuth } from "../application/use-cases/prelease-codex-rotating-oauth";

const now = new Date("2026-08-30T12:00:00.000Z");
const workflowSha = "a".repeat(40);
const headSha = "b".repeat(40);
const baseSha = "c".repeat(40);
const repository = {
  workspaceId: "workspace_1",
  repositoryId: "repo_1",
  githubRepositoryId: "123456",
  githubInstallationId: "789",
  fullName: "base/repository",
  owner: "base",
  selected: true,
  installationStatus: "active",
} as const;
const forkReviewBinding = {
  sourceRepository: "contributor/repository",
  sourceRepositoryId: "654321",
  baseRepository: repository.fullName,
  baseRepositoryId: repository.githubRepositoryId,
  pullRequestNumber: 42,
  reviewHeadSha: headSha,
  baseSha,
  trustDomain: "fork" as const,
};

function dependencies(
  liveOverrides: Partial<{
    sourceRepository: string;
    sourceRepositoryId: string;
    sourceVisibility: "public" | "private" | "internal";
    reviewHeadSha: string;
    draft: boolean;
    authorType: string;
  }> = {},
) {
  const binding = {
    providerInstanceId: "codex-rotating:123456",
    repositoryFullName: repository.fullName,
    githubRepositoryId: repository.githubRepositoryId,
    actionRef: `777genius/review-router@${workflowSha}`,
    workflowPath: ".github/workflows/reviewrouter-codex.yml",
    workflowSchemaVersion: 5,
  } as const;
  const livePullRequest = {
    baseRepository: repository.fullName,
    baseRepositoryId: repository.githubRepositoryId,
    sourceRepository: forkReviewBinding.sourceRepository,
    sourceRepositoryId: forkReviewBinding.sourceRepositoryId,
    sourceVisibility: "public",
    pullRequestNumber: 42,
    reviewHeadSha: headSha,
    baseSha,
    draft: false,
    authorType: "User",
    ...liveOverrides,
  };
  const resolveWorkflowRunPullRequestBinding = vi
    .fn()
    .mockResolvedValue(livePullRequest);
  const resolveWorkflowRunPullRequest = vi
    .fn()
    .mockResolvedValue(livePullRequest.pullRequestNumber);
  const acquirePrelease = vi.fn().mockResolvedValue({
    status: "preleased",
    leaseId: "lease:certified-fork-v5",
    providerInstanceId: binding.providerInstanceId,
    runId: "9001",
    runAttempt: "1",
    expiresAt: new Date(now.getTime() + 60_000),
    repository,
    generationHashSalt: "generation-salt",
    accountFingerprintSalt: "account-salt",
    currentGeneration: 1,
    mutationEpoch: 1n,
  });
  const promptPacket = {
    protocolVersion: 1 as const,
    contextHash: "d".repeat(64),
    repository: {
      base: repository.fullName,
      source: forkReviewBinding.sourceRepository,
    },
    pullRequestNumber: 42,
    baseSha,
    headSha,
    files: [
      {
        path: "src/a.ts",
        status: "modified" as const,
        additions: 1,
        deletions: 0,
        patch: "@@",
      },
    ],
  };
  return {
    oidcVerifier: {
      verify: vi.fn().mockResolvedValue({
        iss: "https://token.actions.githubusercontent.com",
        aud: "reviewrouter",
        repository: repository.fullName,
        repository_id: repository.githubRepositoryId,
        repository_visibility: "public",
        event_name: "pull_request_target",
        ref: "refs/heads/main",
        run_id: "9001",
        run_attempt: "1",
        workflow_ref: `${repository.fullName}/.github/workflows/reviewrouter-codex.yml@refs/heads/main`,
        workflow_sha: workflowSha,
        actor: "contributor",
        runner_environment: "github-hosted",
        iat: Math.floor(now.getTime() / 1000) - 10,
        nbf: Math.floor(now.getTime() / 1000) - 20,
        exp: Math.floor(now.getTime() / 1000) + 120,
        jti: "fork-jti-123456",
      }),
    },
    repositories: {
      findSelectedRepositoryByGithubId: vi.fn().mockResolvedValue(repository),
      findRuntimeReviewConfiguration: vi.fn(),
      recordHealthReport: vi.fn(),
    },
    codexRotatingOAuth: {
      findProviderBinding: vi.fn().mockResolvedValue(binding),
      ensureVerifiedProviderBinding: vi.fn(),
      acquirePrelease,
      finalizeLease: vi.fn(),
      abandonLease: vi.fn(),
      preflightWriteback: vi.fn(),
      findCompletedLeaseWriteTarget: vi.fn(),
    },
    codexRotatingWorkflowSourceVerifier: {
      verifyWorkflowSource: vi.fn().mockResolvedValue({ binding }),
      resolveWorkflowRunPullRequestBinding,
      resolveWorkflowRunPullRequest,
    },
    replayNonces: { tryConsumeNonce: vi.fn().mockResolvedValue(true) },
    certifiedForkReviewAdmission: { assertEnabled: vi.fn() },
    certifiedForkReviewPreleaseGateway: {
      prepareContext: vi.fn().mockImplementation(async ({ binding }) => {
        if (
          livePullRequest.baseRepository !== binding.baseRepository ||
          livePullRequest.baseRepositoryId !== binding.baseRepositoryId ||
          livePullRequest.sourceRepository !== binding.sourceRepository ||
          livePullRequest.sourceRepositoryId !== binding.sourceRepositoryId ||
          livePullRequest.sourceVisibility !== "public" ||
          livePullRequest.pullRequestNumber !== binding.pullRequestNumber ||
          livePullRequest.reviewHeadSha !== binding.reviewHeadSha ||
          livePullRequest.baseSha !== binding.baseSha ||
          livePullRequest.draft ||
          livePullRequest.authorType === "Bot"
        )
          throw new Error("codex_rotating_fork_pull_request_identity_mismatch");
        return {
          contextHash: promptPacket.contextHash,
          promptPacket,
        };
      }),
    },
    certifiedForkReviewClaims: {
      claimPrelease: vi.fn().mockResolvedValue({ status: "ready" }),
      abandonPrelease: vi.fn(),
      markPreleaseAmbiguous: vi.fn(),
      recoverAmbiguousPrelease: vi.fn(),
      claimPrepare: vi.fn(),
      beginPublish: vi.fn(),
      completePublished: vi.fn(),
    },
    codexRotatingNewWorkAdmission: { assertAdmitted: vi.fn() },
    clock: { now: () => now },
    resolveWorkflowRunPullRequestBinding,
    resolveWorkflowRunPullRequest,
    acquirePrelease,
  };
}

async function prelease(deps: ReturnType<typeof dependencies>) {
  return preleaseCodexRotatingOAuth(
    {
      oidcToken: "jwt",
      audience: "reviewrouter",
      providerInstanceId: "codex-rotating:123456",
      workflowSchemaVersion: 5,
      forkReviewBinding,
    },
    deps,
  );
}

describe("certified fork V5 prelease", () => {
  it("leases only after independently resolving the exact live fork tuple", async () => {
    const deps = dependencies();
    await expect(prelease(deps)).resolves.toMatchObject({
      leaseId: "lease:certified-fork-v5",
      repository: repository.fullName,
    });
    expect(deps.resolveWorkflowRunPullRequest).toHaveBeenCalledWith({
      repository,
      githubRunId: "9001",
      githubRunAttempt: "1",
      eventName: "pull_request_target",
    });
    expect(deps.acquirePrelease).toHaveBeenCalledWith(
      expect.objectContaining({ pullRequestNumber: 42 }),
    );
  });

  it("admits a V5 same-repository lane only after live source identity verification", async () => {
    const deps = dependencies({
      sourceRepository: repository.fullName,
      sourceRepositoryId: repository.githubRepositoryId,
    });
    await expect(
      preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 5,
        },
        deps,
      ),
    ).resolves.toMatchObject({ leaseId: "lease:certified-fork-v5" });
    expect(deps.resolveWorkflowRunPullRequestBinding).toHaveBeenCalledOnce();
  });

  it("rejects a V5 fork lane when its binding is missing", async () => {
    const deps = dependencies();
    await expect(
      preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 5,
        },
        deps,
      ),
    ).rejects.toThrow("codex_rotating_v5_fork_binding_required");
    expect(deps.acquirePrelease).not.toHaveBeenCalled();
  });

  it("rejects a partial V5 fork binding", async () => {
    const deps = dependencies();
    const partial = {
      ...forkReviewBinding,
      sourceRepositoryId: undefined,
    } as unknown as typeof forkReviewBinding;
    await expect(
      preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 5,
          forkReviewBinding: partial,
        },
        deps,
      ),
    ).rejects.toThrow("codex_rotating_fork_pull_request_identity_mismatch");
    expect(deps.acquirePrelease).not.toHaveBeenCalled();
  });

  it("rejects a spoofed V5 fork binding even when the live PR is valid", async () => {
    const deps = dependencies();
    await expect(
      preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 5,
          forkReviewBinding: {
            ...forkReviewBinding,
            sourceRepository: "attacker/spoof",
          },
        },
        deps,
      ),
    ).rejects.toThrow("codex_rotating_fork_pull_request_identity_mismatch");
    expect(deps.acquirePrelease).not.toHaveBeenCalled();
  });

  it.each([
    ["source repository spoof", { sourceRepository: "attacker/spoof" }],
    ["source id mismatch", { sourceRepositoryId: "999" }],
    ["stale head", { reviewHeadSha: "d".repeat(40) }],
    ["private fork", { sourceVisibility: "private" as const }],
    ["draft", { draft: true }],
    ["bot", { authorType: "Bot" }],
  ])("fails closed for %s", async (_name, liveOverrides) => {
    const deps = dependencies(liveOverrides);
    await expect(prelease(deps)).rejects.toThrow(/pull_request/);
    expect(deps.acquirePrelease).not.toHaveBeenCalled();
  });

  it("does not accept a V5 fork tuple on an older workflow schema", async () => {
    const deps = dependencies();
    await expect(
      preleaseCodexRotatingOAuth(
        {
          oidcToken: "jwt",
          audience: "reviewrouter",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 4,
          forkReviewBinding,
        },
        deps,
      ),
    ).rejects.toThrow("fork_review_binding_schema_invalid");
    expect(deps.resolveWorkflowRunPullRequestBinding).not.toHaveBeenCalled();
  });
});
