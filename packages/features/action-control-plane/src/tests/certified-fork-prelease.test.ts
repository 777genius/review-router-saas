import { describe, expect, it, vi } from "vitest";
import {
  certifiedForkReviewBindingHash,
  CodexRotatingPreleaseNotAcquiredError,
  InMemoryCodexRotatingOAuthRepository,
  preleaseCodexRotatingOAuth,
  type CertifiedForkReviewBinding,
  type PreleaseCodexRotatingOAuthDependencies,
} from "../index.js";

const now = new Date("2026-08-30T10:00:00.000Z");
const workflowSha = "a".repeat(40);
const repository = {
  workspaceId: "workspace-1",
  repositoryId: "repository-1",
  githubRepositoryId: "99",
  githubInstallationId: "7",
  fullName: "owner/example",
  owner: "owner",
  selected: true,
  installationStatus: "active" as const,
};
const binding: CertifiedForkReviewBinding = {
  sourceRepository: "contributor/example",
  sourceRepositoryId: "101",
  baseRepository: "owner/example",
  baseRepositoryId: "99",
  pullRequestNumber: 42,
  reviewHeadSha: "b".repeat(40),
  baseSha: "c".repeat(40),
  trustDomain: "fork",
};
const claims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: "reviewrouter",
  repository: "owner/example",
  repository_id: "99",
  repository_visibility: "public",
  event_name: "workflow_dispatch" as const,
  ref: "refs/heads/main",
  run_id: "500",
  run_attempt: "1",
  workflow_ref:
    "owner/example/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
  workflow_sha: workflowSha,
  actor: "maintainer",
  runner_environment: "github-hosted",
  iat: Math.floor(now.getTime() / 1_000) - 10,
  nbf: Math.floor(now.getTime() / 1_000) - 20,
  exp: Math.floor(now.getTime() / 1_000) + 120,
  jti: "prelease-jti",
};

describe("certified fork V5 prelease", () => {
  it("rejects rebinding an existing run-attempt lease to another fork tuple", async () => {
    const repositoryStore = new InMemoryCodexRotatingOAuthRepository();
    const acquire = (hash: string) =>
      repositoryStore.acquirePrelease({
        repository,
        providerInstanceId: "codex-rotating:99",
        githubRunId: "500",
        githubRunAttempt: "1",
        pullRequestNumber: 42,
        certifiedForkReviewBindingHash: hash,
        now,
        newWorkAdmissionBarrier: { assertAdmitted: () => undefined },
      });
    await expect(acquire("a".repeat(64))).resolves.toMatchObject({
      status: "preleased",
    });
    await expect(acquire("b".repeat(64))).rejects.toThrow(
      "codex_rotating_lease_binding_mismatch",
    );
  });
  it("resolves workflow_dispatch live, persists the immutable binding hash and skips intent lookup", async () => {
    const fixture = preleaseFixture();
    await expect(run(fixture.dependencies)).resolves.toMatchObject({
      protocolVersion: 1,
      leaseId: "lease-1",
    });
    expect(fixture.assertBindingCurrent).toHaveBeenCalledWith({
      githubInstallationId: "7",
      binding,
    });
    expect(fixture.acquirePrelease).toHaveBeenCalledWith(
      expect.objectContaining({
        pullRequestNumber: 42,
        certifiedForkReviewBindingHash: certifiedForkReviewBindingHash(binding),
      }),
    );
    expect(fixture.intentGate).not.toHaveBeenCalled();
    expect(fixture.admission).toHaveBeenCalledWith(binding);
  });

  it("resumes the exact owner's lost prelease response and returns the same durable lease", async () => {
    const fixture = preleaseFixture();
    fixture.claimPrelease.mockResolvedValueOnce({ status: "resume" });
    await expect(run(fixture.dependencies)).resolves.toMatchObject({
      status: "ready",
      leaseId: "lease-1",
    });
    expect(fixture.acquirePrelease).toHaveBeenCalledOnce();
  });

  it.each(["feature off", "cohort miss"])(
    "blocks V5 prelease before any provider/auth effect when %s",
    async () => {
      const fixture = preleaseFixture();
      fixture.admission.mockImplementation(() => {
        throw new Error("certified_fork_v5_not_enabled");
      });
      await expect(run(fixture.dependencies)).rejects.toThrow(
        "certified_fork_v5_not_enabled",
      );
      expect(fixture.findProviderBinding).not.toHaveBeenCalled();
      expect(fixture.verifyWorkflowSource).not.toHaveBeenCalled();
      expect(fixture.acquirePrelease).not.toHaveBeenCalled();
      expect(fixture.replayNonce).not.toHaveBeenCalled();
      expect(fixture.assertBindingCurrent).not.toHaveBeenCalled();
    },
  );

  it("binds pull_request_target to the PR reported by the signed workflow run", async () => {
    const fixture = preleaseFixture({ event_name: "pull_request_target" });
    fixture.resolveWorkflowRunPullRequest.mockResolvedValue(42);
    await expect(run(fixture.dependencies)).resolves.toMatchObject({
      leaseId: "lease-1",
    });
    expect(fixture.resolveWorkflowRunPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRunId: "500",
        githubRunAttempt: "1",
        eventName: "pull_request_target",
      }),
    );
  });

  it.each([
    ["in_progress", { status: "in_progress" as const }],
    [
      "already_published",
      { status: "already_published" as const, commentId: "10" },
    ],
  ])(
    "returns %s before auth lease/refresh for a duplicate exact tuple",
    async (status, disposition) => {
      const fixture = preleaseFixture();
      fixture.claimPrelease.mockResolvedValue(disposition);
      await expect(run(fixture.dependencies)).resolves.toMatchObject({
        protocolVersion: 1,
        status,
      });
      expect(fixture.acquirePrelease).not.toHaveBeenCalled();
    },
  );

  it("releases only a reservation whose prelease definitively was not acquired", async () => {
    const fixture = preleaseFixture();
    fixture.acquirePrelease.mockRejectedValueOnce(
      new CodexRotatingPreleaseNotAcquiredError("pre_dispatch_failure"),
    );
    await expect(run(fixture.dependencies)).rejects.toThrow(
      "pre_dispatch_failure",
    );
    expect(fixture.abandonPrelease).toHaveBeenCalledOnce();
  });

  it("retains the reservation after an ambiguous prelease failure", async () => {
    const fixture = preleaseFixture();
    fixture.acquirePrelease.mockRejectedValueOnce(new Error("response_lost"));
    await expect(run(fixture.dependencies)).rejects.toThrow("response_lost");
    expect(fixture.abandonPrelease).not.toHaveBeenCalled();
    expect(fixture.markPreleaseAmbiguous).toHaveBeenCalledOnce();
  });

  it("releases the reservation when lease acquisition definitively conflicts", async () => {
    const fixture = preleaseFixture();
    fixture.acquirePrelease.mockResolvedValueOnce({
      status: "conflict",
    } as never);
    await expect(run(fixture.dependencies)).rejects.toThrow(
      "codex_rotating_lease_conflict",
    );
    expect(fixture.abandonPrelease).toHaveBeenCalledOnce();
  });

  it("makes no OAuth lease when an existing tuple has a different context hash", async () => {
    const fixture = preleaseFixture();
    fixture.claimPrelease.mockRejectedValueOnce(
      new Error("certified_fork_claim_conflict"),
    );
    await expect(run(fixture.dependencies)).rejects.toThrow(
      "certified_fork_claim_conflict",
    );
    expect(fixture.acquirePrelease).not.toHaveBeenCalled();
  });

  it("does not create a claim or OAuth lease when context preparation rejects a file patch budget", async () => {
    const fixture = preleaseFixture();
    fixture.assertBindingCurrent.mockRejectedValueOnce(
      new Error("certified_fork_diff_budget_exceeded"),
    );
    await expect(run(fixture.dependencies)).rejects.toThrow(
      "certified_fork_diff_budget_exceeded",
    );
    expect(fixture.claimPrelease).not.toHaveBeenCalled();
    expect(fixture.acquirePrelease).not.toHaveBeenCalled();
  });

  it("rejects a pull_request_target tuple for a different workflow-run PR", async () => {
    const fixture = preleaseFixture({ event_name: "pull_request_target" });
    fixture.resolveWorkflowRunPullRequest.mockResolvedValue(43);
    await expect(run(fixture.dependencies)).rejects.toThrow(
      "certified_fork_prelease_identity_mismatch",
    );
    expect(fixture.acquirePrelease).not.toHaveBeenCalled();
  });

  it.each([
    ["sourceRepository", { sourceRepository: "attacker/example" }],
    ["sourceRepositoryId", { sourceRepositoryId: "102" }],
    ["baseRepository", { baseRepository: "owner/other" }],
    ["baseRepositoryId", { baseRepositoryId: "98" }],
    ["pullRequestNumber", { pullRequestNumber: 43 }],
    ["reviewHeadSha", { reviewHeadSha: "d".repeat(40) }],
    ["baseSha", { baseSha: "e".repeat(40) }],
    ["trustDomain", { trustDomain: "other" }],
  ])("fails closed for spoofed or stale %s", async (_name, mutation) => {
    const mutated = { ...binding, ...mutation } as CertifiedForkReviewBinding;
    const fixture = preleaseFixture();
    await expect(run(fixture.dependencies, mutated)).rejects.toThrow(
      /certified_fork_(prelease_identity|tuple)_mismatch/,
    );
    expect(fixture.acquirePrelease).not.toHaveBeenCalled();
    expect(fixture.intentGate).not.toHaveBeenCalled();
  });

  it("does not bypass intent admission for an ordinary workflow_dispatch", async () => {
    const fixture = preleaseFixture();
    await expect(run(fixture.dependencies, null)).resolves.toMatchObject({
      leaseId: "lease-1",
    });
    expect(fixture.intentGate).toHaveBeenCalledOnce();
  });
});

function run(
  dependencies: PreleaseCodexRotatingOAuthDependencies,
  forkReviewBinding: CertifiedForkReviewBinding | null = binding,
) {
  return preleaseCodexRotatingOAuth(
    {
      oidcToken: "oidc",
      audience: "reviewrouter",
      providerInstanceId: "codex-rotating:99",
      workflowSchemaVersion: 5,
      ...(forkReviewBinding ? { forkReviewBinding } : {}),
    },
    dependencies,
  );
}

function preleaseFixture(claimMutation: Record<string, unknown> = {}) {
  const providerBinding = {
    providerInstanceId: "codex-rotating:99",
    repositoryFullName: "owner/example",
    githubRepositoryId: "99",
    actionRef: `777genius/review-router@${workflowSha}`,
    workflowPath: ".github/workflows/reviewrouter-codex.yml",
    workflowSchemaVersion: 5,
  };
  const acquirePrelease = vi.fn(async () => ({
    leaseId: "lease-1",
    providerInstanceId: "codex-rotating:99",
    runId: "500",
    runAttempt: "1",
    status: "preleased" as const,
    expiresAt: new Date(now.getTime() + 60_000),
    repository,
    generationHashSalt: "generation-salt",
    accountFingerprintSalt: "account-salt",
    currentGeneration: 1,
    mutationEpoch: 1n,
  }));
  const resolveWorkflowRunPullRequest = vi.fn(async () => 42);
  const findProviderBinding = vi.fn(async () => providerBinding);
  const verifyWorkflowSource = vi.fn(async () => ({
    binding: providerBinding,
  }));
  const replayNonce = vi.fn(async () => true);
  const admission = vi.fn(() => undefined);
  const claimPrelease = vi.fn<
    () => Promise<
      | { status: "ready" }
      | { status: "resume" }
      | { status: "in_progress" }
      | { status: "already_published"; commentId: string; commentUrl?: string }
    >
  >(async () => ({ status: "ready" }));
  const abandonPrelease = vi.fn(async () => undefined);
  const markPreleaseAmbiguous = vi.fn(async () => undefined);
  const assertBindingCurrent = vi.fn(async (input) => {
    if (JSON.stringify(input.binding) !== JSON.stringify(binding))
      throw new Error("certified_fork_tuple_mismatch");
    return {
      contextHash: "f".repeat(64),
      promptPacket: {
        protocolVersion: 1 as const,
        contextHash: "f".repeat(64),
        repository: {
          base: binding.baseRepository,
          source: binding.sourceRepository,
        },
        pullRequestNumber: binding.pullRequestNumber,
        baseSha: binding.baseSha,
        headSha: binding.reviewHeadSha,
        files: [],
      },
    };
  });
  const intentGate = vi.fn(async () => ({ status: "not_applicable" as const }));
  const dependencies = {
    oidcVerifier: {
      verify: vi.fn(async () => ({ ...claims, ...claimMutation })),
    },
    repositories: {
      findSelectedRepositoryByGithubId: vi.fn(async () => repository),
    },
    codexRotatingOAuth: {
      findProviderBinding,
      ensureVerifiedProviderBinding: vi.fn(async () => undefined),
      acquirePrelease,
    },
    codexRotatingWorkflowSourceVerifier: {
      verifyWorkflowSource,
      resolveWorkflowRunPullRequest,
    },
    certifiedForkReviewPreleaseGateway: {
      prepareContext: assertBindingCurrent,
    },
    certifiedForkReviewAdmission: { assertEnabled: admission },
    certifiedForkReviewClaims: {
      claimPrelease,
      abandonPrelease,
      markPreleaseAmbiguous,
      recoverAmbiguousPrelease: vi.fn(async () => undefined),
    },
    replayNonces: { tryConsumeNonce: replayNonce },
    hostedReviewPreleaseGate: { evaluate: intentGate },
    reviewIntentAdmissionRequired: true,
    codexRotatingNewWorkAdmission: { assertAdmitted: () => undefined },
    clock: { now: () => now },
  } as unknown as PreleaseCodexRotatingOAuthDependencies;
  return {
    dependencies,
    acquirePrelease,
    resolveWorkflowRunPullRequest,
    assertBindingCurrent,
    intentGate,
    admission,
    findProviderBinding,
    verifyWorkflowSource,
    replayNonce,
    claimPrelease,
    abandonPrelease,
    markPreleaseAmbiguous,
  };
}
