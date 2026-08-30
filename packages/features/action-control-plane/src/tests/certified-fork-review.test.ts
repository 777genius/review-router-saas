import { describe, expect, it } from "vitest";
import type { CertifiedForkReviewDependencies } from "../application/use-cases/prepare-certified-fork-review.js";
import { prepareCertifiedForkReview } from "../application/use-cases/prepare-certified-fork-review.js";
import { publishCertifiedForkReview } from "../application/use-cases/publish-certified-fork-review.js";
import type { CertifiedForkReviewTicket } from "../application/ports/certified-fork-review-port.js";

const sha = "a".repeat(40);
const head = "b".repeat(40);
const binding = {
  sourceRepository: "contributor/example",
  sourceRepositoryId: "101",
  baseRepository: "owner/example",
  baseRepositoryId: "99",
  pullRequestNumber: 42,
  reviewHeadSha: head,
  baseSha: sha,
  trustDomain: "fork" as const,
};
const claims = {
  iss: "https://token.actions.githubusercontent.com" as const,
  aud: "reviewrouter",
  sub: "repo:owner/example",
  repository: "owner/example",
  repository_id: "99",
  repository_owner: "owner",
  repository_visibility: "public",
  event_name: "pull_request_target" as const,
  ref: "refs/heads/main",
  run_id: "500",
  run_attempt: "1",
  workflow_ref:
    "owner/example/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
  workflow_sha: sha,
  actor: "dev",
  jti: "fresh",
};

describe("certified fork review use cases", () => {
  it("binds prepare and publish to fresh OIDC, lease, workflow, context and tuple", async () => {
    const { dependencies, consumed, published } = fixture();
    const prepared = await prepareCertifiedForkReview(
      {
        oidcToken: "prepare",
        audience: "reviewrouter",
        leaseId: "lease-123",
        providerInstanceId: "provider-123",
        workflowSchemaVersion: 5,
        forkReviewBinding: binding,
      },
      dependencies,
    );
    expect(prepared).toMatchObject({
      protocolVersion: 1,
      contextHash: "c".repeat(64),
      model: "gpt-5.6-sol",
      maxOutputTokens: 12000,
    });
    await publishCertifiedForkReview(
      {
        oidcToken: "publish",
        audience: "reviewrouter",
        leaseId: "lease-123",
        providerInstanceId: "provider-123",
        workflowSchemaVersion: 5,
        forkReviewBinding: binding,
        executionId: prepared.executionId,
        contextHash: prepared.contextHash,
        modelOutput: {
          protocolVersion: 1,
          summaryMarkdown: "ok",
          findings: [],
        },
      },
      {
        ...dependencies,
        certifiedForkReviewOutput: { render: () => ({ body: "safe" }) },
      },
    );
    expect(consumed).toEqual(["fresh", "publish"]);
    expect(published).toHaveLength(1);
  });

  it.each([
    ["schema", { workflowSchemaVersion: 4 }, {}],
    ["event", {}, { event_name: "pull_request" }],
    ["repository", {}, { repository_id: "98" }],
    ["run", {}, { run_id: "bad" }],
    [
      "workflow",
      {},
      { workflow_ref: `owner/example/.github/workflows/other.yml@${sha}` },
    ],
  ])("rejects mutated %s identity", async (_name, change, claimChange) => {
    const { dependencies } = fixture(
      (claimChange ?? {}) as Record<string, unknown>,
    );
    await expect(
      prepareCertifiedForkReview(
        {
          oidcToken: "x",
          audience: "reviewrouter",
          leaseId: "lease-123",
          providerInstanceId: "provider-123",
          workflowSchemaVersion: 5,
          forkReviewBinding: binding,
          ...change,
        },
        dependencies,
      ),
    ).rejects.toThrow(/certified_fork_(schema|identity)_invalid/);
  });

  it("rejects context replay before publication", async () => {
    const { dependencies, published } = fixture();
    const prepared = await prepareCertifiedForkReview(
      {
        oidcToken: "x",
        audience: "reviewrouter",
        leaseId: "lease-123",
        providerInstanceId: "provider-123",
        workflowSchemaVersion: 5,
        forkReviewBinding: binding,
      },
      dependencies,
    );
    await expect(
      publishCertifiedForkReview(
        {
          oidcToken: "publish",
          audience: "reviewrouter",
          leaseId: "lease-123",
          providerInstanceId: "provider-123",
          workflowSchemaVersion: 5,
          forkReviewBinding: { ...binding, reviewHeadSha: "d".repeat(40) },
          executionId: prepared.executionId,
          contextHash: prepared.contextHash,
          modelOutput: {},
        },
        {
          ...dependencies,
          certifiedForkReviewOutput: { render: () => ({ body: "x" }) },
        },
      ),
    ).rejects.toThrow("certified_fork_context_mismatch");
    expect(published).toHaveLength(0);
  });
});

function fixture(claimChange: Record<string, unknown> = {}) {
  const consumed: string[] = [];
  const published: unknown[] = [];
  let ticket: CertifiedForkReviewTicket | null = null;
  const dependencies: CertifiedForkReviewDependencies = {
    oidcVerifier: {
      verify: async ({ token }) =>
        ({
          ...claims,
          ...claimChange,
          jti: token === "publish" ? "publish" : "fresh",
        }) as any,
    },
    replayNonces: {
      tryConsumeNonce: async ({ key }) => {
        consumed.push(key.split(":").at(-1)!);
        return true;
      },
    },
    clock: { now: () => new Date("2026-08-30T10:00:00.000Z") },
    certifiedForkReviewLeases: {
      assertFinalizedV5ForkLease: async () => ({ githubInstallationId: "7" }),
    },
    certifiedForkReviewGateway: {
      prepareContext: async () => ({
        contextHash: "c".repeat(64),
        promptPacket: {
          protocolVersion: 1,
          contextHash: "c".repeat(64),
          repository: {
            base: binding.baseRepository,
            source: binding.sourceRepository,
          },
          pullRequestNumber: 42,
          baseSha: sha,
          headSha: head,
          files: [],
        },
      }),
      assertContextCurrent: async () => ({
        promptPacket: {
          protocolVersion: 1,
          contextHash: "c".repeat(64),
          repository: {
            base: binding.baseRepository,
            source: binding.sourceRepository,
          },
          pullRequestNumber: 42,
          baseSha: sha,
          headSha: head,
          files: [],
        },
      }),
      upsertOwnedComment: async (value) => {
        published.push(value);
        return { status: "created", commentId: "1" };
      },
    },
    certifiedForkReviewTickets: {
      issue: async (value) => (ticket = { ...value, executionId: "execution" }),
      verify: async () => ticket!,
    },
  };
  return { dependencies, consumed, published };
}
