import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { CertifiedForkReviewDependencies } from "../application/use-cases/prepare-certified-fork-review.js";
import { prepareCertifiedForkReview } from "../application/use-cases/prepare-certified-fork-review.js";
import { publishCertifiedForkReview } from "../application/use-cases/publish-certified-fork-review.js";
import type {
  CertifiedForkReviewPublishLockPort,
  CertifiedForkReviewTicket,
} from "../application/ports/certified-fork-review-port.js";
import { registerActionControlPlaneRoutes } from "../interface/http/register-action-control-plane-routes.js";
import {
  assertCertifiedForkReviewPromptPacketSize,
  certifiedForkReviewMaxPromptPacketBytes,
} from "../application/use-cases/certified-fork-review-binding.js";

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
  it("enforces the prompt packet limit in UTF-8 bytes", () => {
    const wrapperBytes = Buffer.byteLength(
      JSON.stringify({ value: "" }),
      "utf8",
    );
    expect(() =>
      assertCertifiedForkReviewPromptPacketSize({
        value: "x".repeat(
          certifiedForkReviewMaxPromptPacketBytes - wrapperBytes,
        ),
      }),
    ).not.toThrow();
    expect(() =>
      assertCertifiedForkReviewPromptPacketSize({
        value: "x".repeat(
          certifiedForkReviewMaxPromptPacketBytes - wrapperBytes + 1,
        ),
      }),
    ).toThrow("certified_fork_prompt_packet_too_large");
    expect(() =>
      assertCertifiedForkReviewPromptPacketSize({
        value: "é".repeat(
          Math.floor(
            (certifiedForkReviewMaxPromptPacketBytes - wrapperBytes) / 2,
          ) + 1,
        ),
      }),
    ).toThrow("certified_fork_prompt_packet_too_large");
  });

  it("binds prepare and publish to fresh OIDC, lease, workflow, context and tuple", async () => {
    const { dependencies, consumed, published } = fixture();
    const prepared = requireReady(
      await prepareCertifiedForkReview(
        {
          oidcToken: "prepare",
          audience: "reviewrouter",
          leaseId: "lease-123",
          providerInstanceId: "provider-123",
          workflowSchemaVersion: 5,
          forkReviewBinding: binding,
        },
        dependencies,
      ),
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

  it("serializes concurrent same-ticket publishes into one external comment", async () => {
    const { dependencies } = fixture();
    const prepared = requireReady(
      await prepareCertifiedForkReview(
        {
          oidcToken: "prepare",
          audience: "reviewrouter",
          leaseId: "lease-123",
          providerInstanceId: "provider-123",
          workflowSchemaVersion: 5,
          forkReviewBinding: binding,
        },
        dependencies,
      ),
    );
    let tail = Promise.resolve();
    dependencies.certifiedForkReviewPublishLock = {
      withLock: async (_key, run) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => (release = resolve));
        await previous;
        try {
          return await run();
        } finally {
          release();
        }
      },
    };
    let commentCreated = false;
    let creates = 0;
    let publishedDigest: string | null = null;
    dependencies.certifiedForkReviewClaims.beginPublish = async ({
      outputDigest,
    }) =>
      publishedDigest === outputDigest
        ? { status: "already_published", commentId: "10" }
        : { status: "ready" };
    dependencies.certifiedForkReviewClaims.completePublished = async ({
      outputDigest,
    }) => {
      publishedDigest = outputDigest;
    };
    dependencies.certifiedForkReviewGateway.upsertOwnedComment = async () => {
      if (!commentCreated) {
        await Promise.resolve();
        commentCreated = true;
        creates += 1;
      }
      return { status: "created", commentId: "10" };
    };
    const publish = (oidcToken: string) =>
      publishCertifiedForkReview(
        {
          oidcToken,
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
    await expect(
      Promise.all([publish("publish-1"), publish("publish-2")]),
    ).resolves.toHaveLength(2);
    expect(creates).toBe(1);
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

  it.each([
    ["in_progress", { status: "in_progress" as const }],
    [
      "already_published",
      {
        status: "already_published" as const,
        commentId: "10",
        commentUrl: "https://example.test/comment/10",
      },
    ],
  ])("returns provider-free %s duplicate prepare", async (status, claim) => {
    const { dependencies } = fixture();
    dependencies.certifiedForkReviewClaims.claimPrepare = async () => claim;
    const result = await prepareCertifiedForkReview(
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
    expect(result).toMatchObject({ protocolVersion: 1, status });
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("promptPacket");
  });

  it("rejects context replay before publication", async () => {
    const { dependencies, published } = fixture();
    const prepared = requireReady(
      await prepareCertifiedForkReview(
        {
          oidcToken: "x",
          audience: "reviewrouter",
          leaseId: "lease-123",
          providerInstanceId: "provider-123",
          workflowSchemaVersion: 5,
          forkReviewBinding: binding,
        },
        dependencies,
      ),
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
    const prepared = requireReady(
      await prepareCertifiedForkReview(
        {
          oidcToken: "prepare",
          audience: "reviewrouter",
          leaseId: "lease-123",
          providerInstanceId: "provider-123",
          workflowSchemaVersion: 5,
          forkReviewBinding: binding,
        },
        dependencies,
      ),
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

  it("honors the global emergency disable for prepare and publish", async () => {
    const { dependencies, consumed } = fixture();
    const app = Fastify({ logger: false });
    await registerActionControlPlaneRoutes(app, {
      controlPlaneEnabled: false,
      certifiedForkReview: {
        ...dependencies,
        certifiedForkReviewOutput: { render: () => ({ body: "safe" }) },
      },
    } as unknown as Parameters<typeof registerActionControlPlaneRoutes>[1]);
    for (const operation of ["prepare", "publish"] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/action/v1/certified-fork-review/${operation}`,
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: "action_control_plane_disabled" },
      });
    }
    expect(consumed).toHaveLength(0);
    await app.close();
  });

  it("fails closed before issuing a ticket when the prompt packet exceeds 300000 chars", async () => {
    const { dependencies } = fixture();
    dependencies.certifiedForkReviewGateway.prepareContext = async () => ({
      contextHash: "c".repeat(64),
      promptPacket: {
        protocolVersion: 1,
        contextHash: "c".repeat(64),
        repository: {
          base: binding.baseRepository,
          source: binding.sourceRepository,
        },
        pullRequestNumber: binding.pullRequestNumber,
        baseSha: binding.baseSha,
        headSha: binding.reviewHeadSha,
        files: [
          {
            path: "src/a.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "x".repeat(certifiedForkReviewMaxPromptPacketBytes),
          },
        ],
      },
    });
    await expect(
      prepareCertifiedForkReview(
        {
          oidcToken: "prepare",
          audience: "reviewrouter",
          leaseId: "lease-123",
          providerInstanceId: "provider-123",
          workflowSchemaVersion: 5,
          forkReviewBinding: binding,
        },
        dependencies,
      ),
    ).rejects.toThrow("certified_fork_prompt_packet_too_large");
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
    const prepared = requireReady(
      await prepareCertifiedForkReview(
        {
          oidcToken: "prepare",
          audience: "reviewrouter",
          leaseId: "lease-123",
          providerInstanceId: "provider-123",
          workflowSchemaVersion: 5,
          forkReviewBinding: binding,
        },
        dependencies,
      ),
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
  let claimedOutputDigest: string | null = null;
  const dependencies: CertifiedForkReviewDependencies & {
    certifiedForkReviewPublishLock: CertifiedForkReviewPublishLockPort;
  } = {
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
      assertBindingCurrent: async () => undefined,
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
      signPublication: async () => "9".repeat(64),
    },
    certifiedForkReviewClaims: {
      claimPrelease: async () => ({ status: "ready" }),
      abandonPrelease: async () => undefined,
      claimPrepare: async () => ({ status: "ready" }),
      beginPublish: async ({ outputDigest }) => {
        if (claimedOutputDigest && claimedOutputDigest !== outputDigest)
          throw new Error("certified_fork_publish_digest_conflict");
        claimedOutputDigest = outputDigest;
        return { status: "ready" };
      },
      completePublished: async () => undefined,
    },
    certifiedForkReviewAdmission: { assertEnabled: () => undefined },
    certifiedForkReviewPublishLock: {
      withLock: async (_key, run) => await run(),
    },
  };
  return { dependencies, consumed, published };
}

function requireReady(
  result: Awaited<ReturnType<typeof prepareCertifiedForkReview>>,
): Extract<
  Awaited<ReturnType<typeof prepareCertifiedForkReview>>,
  { status: "ready" }
> {
  if (result.status !== "ready") throw new Error("expected_ready_prepare");
  return result;
}
