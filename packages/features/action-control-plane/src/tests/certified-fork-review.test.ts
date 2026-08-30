import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { CertifiedForkReviewDependencies } from "../application/use-cases/prepare-certified-fork-review.js";
import { prepareCertifiedForkReview } from "../application/use-cases/prepare-certified-fork-review.js";
import { publishCertifiedForkReview } from "../application/use-cases/publish-certified-fork-review.js";
import type { CertifiedForkReviewTicket } from "../application/ports/certified-fork-review-port.js";
import { registerActionControlPlaneRoutes } from "../interface/http/register-action-control-plane-routes.js";

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
    ["workflow SHA", {}, { workflow_sha: undefined }],
    ["run attempt", {}, { run_attempt: "bad" }],
    ["repository name", {}, { repository: "owner/other" }],
    ["ref", {}, { ref: "refs/pull/42/merge" }],
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

  it("accepts a workflow_dispatch backfill with the same live fork binding", async () => {
    const { dependencies } = fixture({ event_name: "workflow_dispatch" });
    await expect(
      prepareCertifiedForkReview(
        {
          oidcToken: "dispatch",
          audience: "reviewrouter",
          leaseId: "lease-123",
          providerInstanceId: "provider-123",
          workflowSchemaVersion: 5,
          forkReviewBinding: binding,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      protocolVersion: 1,
      promptPacket: { pullRequestNumber: 42 },
    });
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

  it("does not publish when the provider returns no valid output", async () => {
    const { dependencies, published } = fixture();
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
    await expect(
      publishCertifiedForkReview(
        {
          oidcToken: "publish",
          audience: "reviewrouter",
          leaseId: "lease-123",
          providerInstanceId: "provider-123",
          workflowSchemaVersion: 5,
          forkReviewBinding: binding,
          executionId: prepared.executionId,
          contextHash: prepared.contextHash,
          modelOutput: undefined,
        },
        {
          ...dependencies,
          certifiedForkReviewOutput: {
            render: () => {
              throw new Error("certified_fork_model_output_invalid");
            },
          },
        },
      ),
    ).rejects.toThrow("certified_fork_model_output_invalid");
    expect(published).toHaveLength(0);
  });

  it("exposes strict prepare HTTP input and rejects unknown fields", async () => {
    const { dependencies } = fixture();
    const app = Fastify({ logger: false });
    await registerActionControlPlaneRoutes(app, {
      oidcAudience: "reviewrouter",
      certifiedForkReview: {
        ...dependencies,
        certifiedForkReviewOutput: { render: () => ({ body: "safe" }) },
      },
    } as unknown as Parameters<typeof registerActionControlPlaneRoutes>[1]);
    const request = {
      oidcToken: "prepare",
      leaseId: "lease-123",
      providerInstanceId: "provider-123",
      workflowSchemaVersion: 5,
      forkReviewBinding: binding,
    };
    const accepted = await app.inject({
      method: "POST",
      url: "/api/action/v1/certified-fork-review/prepare",
      payload: request,
    });
    expect(accepted.statusCode).toBe(200);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/action/v1/certified-fork-review/prepare",
      payload: { ...request, reviewRequestId: "attacker-controlled" },
    });
    expect(rejected.statusCode).toBe(400);
    const prepared = accepted.json() as {
      executionId: string;
      contextHash: string;
    };
    const missingOutput = await app.inject({
      method: "POST",
      url: "/api/action/v1/certified-fork-review/publish",
      payload: {
        ...request,
        oidcToken: "publish",
        executionId: prepared.executionId,
        contextHash: prepared.contextHash,
      },
    });
    expect(missingOutput.statusCode).toBe(400);
    await app.close();
  });

  it.each([
    ["sourceRepository", { sourceRepository: "other/example" }],
    ["sourceRepositoryId", { sourceRepositoryId: "102" }],
    ["baseRepository", { baseRepository: "owner/other" }],
    ["baseRepositoryId", { baseRepositoryId: "98" }],
    ["pullRequestNumber", { pullRequestNumber: 43 }],
    ["reviewHeadSha", { reviewHeadSha: "d".repeat(40) }],
    ["baseSha", { baseSha: "e".repeat(40) }],
    ["trustDomain", { trustDomain: "fork-other" }],
  ])("rejects publish when ticket %s is mutated", async (_name, mutation) => {
    const { dependencies, published } = fixture();
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
    await expect(
      publishCertifiedForkReview(
        {
          oidcToken: "publish",
          audience: "reviewrouter",
          leaseId: "lease-123",
          providerInstanceId: "provider-123",
          workflowSchemaVersion: 5,
          forkReviewBinding: { ...binding, ...mutation } as typeof binding,
          executionId: prepared.executionId,
          contextHash: prepared.contextHash,
          modelOutput: {},
        },
        {
          ...dependencies,
          certifiedForkReviewOutput: { render: () => ({ body: "x" }) },
        },
      ),
    ).rejects.toThrow(/certified_fork_(context_mismatch|identity_invalid)/);
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
