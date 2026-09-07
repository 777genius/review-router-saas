import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { GitHubActionsOidcClaims } from "@reviewrouter/features-action-control-plane";
import { PrismaActionControlPlaneRepository } from "@reviewrouter/features-action-control-plane";
import { safeDefaultReviewConfiguration } from "@reviewrouter/features-review-config";
import { canonicalJson } from "@reviewrouter/features-review-run-control";
import { hostedPoolWorkflowSchemaVersion } from "@reviewrouter/features-workflow-provisioning";
import { PrismaHostedCodexGrantAdmission } from "./prisma-hosted-codex-grant-admission.js";

const headSha = "a".repeat(40);
const review = {
  workspaceId: "workspace",
  repositoryConnectionId: "repository",
  scmRepositoryIdentityId: "scm",
  pullRequestNumber: 42,
  baseSha: "b".repeat(40),
  mergeBaseSha: "c".repeat(40),
  headSha,
};
const request = {
  claims: {
    repository_id: "123",
    run_id: "10",
    run_attempt: "1",
    workflow_sha: headSha,
  } as GitHubActionsOidcClaims,
  bindingId: "binding",
  bindingVersion: 1,
  providerInstanceId: "hosted-pool:repository:123",
  workflowSchemaVersion: hostedPoolWorkflowSchemaVersion,
  now: new Date(),
};
afterEach(() => vi.restoreAllMocks());

function fixture(visibility: string, observed: Record<string, unknown> = {}) {
  vi.spyOn(
    PrismaActionControlPlaneRepository.prototype,
    "findRuntimeReviewConfiguration",
  ).mockResolvedValue({
    version: 1,
    config: {
      ...safeDefaultReviewConfiguration,
      providers: [
        {
          ...safeDefaultReviewConfiguration.providers[0]!,
          kind: "codex",
          authMode: "codex_subscription_oauth_hosted_pool",
          model: "gpt-5.5",
        },
      ],
    },
    source: "repository",
  });
  const repository = {
    id: "repository",
    workspaceId: "workspace",
    githubRepositoryId: 123n,
    owner: "owner",
    name: "repo",
    fullName: "owner/repo",
    visibility,
    selected: true,
    archived: false,
    installation: { githubInstallationId: 456n, status: "active" },
    hostedCodexBindings: [
      {
        id: "binding",
        status: "active",
        revision: 1n,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowActionRef: `777genius/review-router@${"d".repeat(40)}`,
        workflowSourceCommitSha: "e".repeat(40),
        workflowSourceBlobSha: "f".repeat(40),
        workflowSourceSha256: "1".repeat(64),
        workflowSemanticSha256: "2".repeat(64),
        workflowSourceTrust: "trusted_default_branch_revision",
        attestedGithubRepositoryId: 123n,
        attestedBindingRevision: 1n,
        pool: { status: "active", authzEpoch: 1n },
      },
    ],
  };
  const prisma = {
    repositoryConnection: { findFirst: vi.fn(async () => repository) },
    hostedCodexRuntimeGate: {
      findUnique: vi.fn(async () => ({ status: "active", authzEpoch: 1n })),
    },
    reviewRequestedIntent: {
      findFirst: vi.fn(async () => ({
        ...review,
        requestId: "request",
        reviewRevisionHash: createHash("sha256")
          .update(canonicalJson(review))
          .digest("hex"),
      })),
    },
  };
  const reader = {
    readPullRequestAuthority: vi.fn(async () => ({
      number: 42,
      state: "open",
      baseRepositoryId: "123",
      headRepositoryId: "123",
      headSha,
      ...observed,
    })),
    readWorkflowAtRevision: vi.fn(async () => ({
      commitSha: headSha,
      blobSha: "3".repeat(40),
      contents: "fixture source",
    })),
  };
  return {
    reader,
    repository,
    prisma,
    resolver: new PrismaHostedCodexGrantAdmission(
      prisma as unknown as PrismaClient,
      reader,
      hostedPoolWorkflowSchemaVersion,
    ),
  };
}

describe("main integration: authoritative public admission", () => {
  it.each(["public", "private", "internal"])(
    "resolves %s using a server GitHub observation",
    async (visibility) => {
      const f = fixture(visibility);
      await expect(f.resolver.resolve(request)).resolves.toMatchObject({
        visibility,
        workspaceId: "workspace",
        reviewHeadSha: headSha,
      });
      expect(f.reader.readPullRequestAuthority).toHaveBeenCalledWith({
        githubInstallationId: "456",
        owner: "owner",
        repository: "repo",
        pullRequestNumber: 42,
      });
      expect(f.prisma.reviewRequestedIntent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: "workspace",
            repositoryConnectionId: "repository",
            sourceRunId: "10",
            sourceRunAttempt: "1",
            admissionState: "admitted",
          }),
        }),
      );
    },
  );
  it.each([
    { headRepositoryId: "999" },
    { headRepositoryId: null },
    { baseRepositoryId: "999" },
    { number: 43 },
    { state: "closed" },
    { headSha: "9".repeat(40) },
  ])(
    "denies forged fork/client checks against actual server facts: %j",
    async (observed) => {
      const f = fixture("public", observed);
      const forgedClient = { ...request, sameRepository: true, fork: false };
      await expect(f.resolver.resolve(forgedClient)).rejects.toThrow(
        "hosted_pull_request_authority_mismatch",
      );
      expect(f.reader.readWorkflowAtRevision).not.toHaveBeenCalled();
    },
  );
  it("fails closed when the server cannot fetch PR authority", async () => {
    const f = fixture("public");
    f.reader.readPullRequestAuthority.mockRejectedValue(
      new Error("hosted_pull_request_authority_unavailable"),
    );
    await expect(f.resolver.resolve(request)).rejects.toThrow(
      "hosted_pull_request_authority_unavailable",
    );
    expect(f.reader.readWorkflowAtRevision).not.toHaveBeenCalled();
  });
  it("rejects archived repository state before the authority fetch", async () => {
    const f = fixture("public");
    f.repository.archived = true;
    await expect(f.resolver.resolve(request)).rejects.toThrow(
      "hosted_repository_not_eligible",
    );
    expect(f.reader.readPullRequestAuthority).not.toHaveBeenCalled();
  });
  it("rejects stale binding revision before the authority fetch", async () => {
    const f = fixture("public");
    await expect(
      f.resolver.resolve({ ...request, bindingVersion: 2 }),
    ).rejects.toThrow("hosted_grant_binding_mismatch");
    expect(f.reader.readPullRequestAuthority).not.toHaveBeenCalled();
  });
});
