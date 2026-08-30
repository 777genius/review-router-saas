import { describe, expect, it, vi } from "vitest";
import { certifiedForkReviewBindingHash } from "@reviewrouter/features-action-control-plane";
import {
  HmacCertifiedForkReviewTickets,
  PrismaCertifiedForkReviewLease,
  PrismaCertifiedForkReviewClaims,
  PrismaCertifiedForkReviewPublishLock,
  StaticCertifiedForkReviewAdmission,
  StrictCertifiedForkReviewOutput,
} from "./certified-fork-review-composition.js";
const binding = {
  sourceRepository: "contributor/example",
  sourceRepositoryId: "101",
  baseRepository: "owner/example",
  baseRepositoryId: "99",
  pullRequestNumber: 42,
  reviewHeadSha: "b".repeat(40),
  baseSha: "a".repeat(40),
  trustDomain: "fork" as const,
};
const promptPacket = {
  protocolVersion: 1 as const,
  contextHash: "c".repeat(64),
  repository: {
    base: binding.baseRepository,
    source: binding.sourceRepository,
  },
  pullRequestNumber: 42,
  baseSha: binding.baseSha,
  headSha: binding.reviewHeadSha,
  files: [
    {
      path: "src/a.ts",
      status: "modified" as const,
      additions: 1,
      deletions: 1,
      patch: "@@",
    },
  ],
};
describe("certified fork composition", () => {
  it("uses the lock transaction delegate for claim mutations without a second pool checkout", async () => {
    const transactionDelegate = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => {
        throw new Error("P2010 UnsupportedNativeDataType type=void");
      }),
      certifiedForkReviewClaim: {
        findUnique: vi.fn(async () => null),
      },
    };
    const topLevelClaim = {
      findUnique: vi.fn(() => Promise.reject(new Error("pool_exhausted"))),
    };
    const prisma = {
      certifiedForkReviewClaim: topLevelClaim,
      $transaction: vi.fn(async (run) => await run(transactionDelegate)),
    };
    const lock = new PrismaCertifiedForkReviewPublishLock(prisma as never);
    await expect(
      lock.withLock("scope", async (claims) => {
        await expect(
          claims.beginPublish({
            scope: {
              baseRepositoryId: "99",
              pullRequestNumber: 42,
              reviewHeadSha: binding.reviewHeadSha,
              baseSha: binding.baseSha,
              contextHash: "c".repeat(64),
              promptPolicyVersion: 1,
            },
            executionId: "execution",
            outputDigest: "d".repeat(64),
          }),
        ).rejects.toThrow("certified_fork_claim_conflict");
        return "done";
      }),
    ).resolves.toBe("done");
    expect(topLevelClaim.findUnique).not.toHaveBeenCalled();
    expect(transactionDelegate.$executeRaw).toHaveBeenCalledOnce();
    expect(transactionDelegate.$queryRaw).not.toHaveBeenCalled();
    expect(
      transactionDelegate.certifiedForkReviewClaim.findUnique,
    ).toHaveBeenCalledOnce();
  });

  it("atomically admits one pre-provider claim and fences publish execution/digest", async () => {
    let row: Record<string, unknown> | null = null;
    const delegate = {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        await Promise.resolve();
        if (row) throw { code: "P2002" };
        row = {
          id: "claim-1",
          status: "pending",
          executionId: null,
          outputDigest: null,
          commentId: null,
          commentUrl: null,
          recoveryState: "reserved",
          ...data,
        };
        return row;
      }),
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (!row || row.status !== where.status) return { count: 0 };
          if (where.executionId && row.executionId !== where.executionId)
            return { count: 0 };
          if (where.outputDigest && row.outputDigest !== where.outputDigest)
            return { count: 0 };
          row = { ...row, ...data };
          return { count: 1 };
        },
      ),
      deleteMany: vi.fn(async () => {
        row = null;
        return { count: 1 };
      }),
    };
    const claims = new PrismaCertifiedForkReviewClaims({
      certifiedForkReviewClaim: delegate,
    } as never);
    const scope = {
      baseRepositoryId: "99",
      pullRequestNumber: 42,
      reviewHeadSha: binding.reviewHeadSha,
      baseSha: binding.baseSha,
      contextHash: "c".repeat(64),
      promptPolicyVersion: 1,
    };
    await expect(
      claims.recoverAmbiguousPrelease({
        scope,
        reservationOwner: "owner-1",
        noProviderEffectEvidenceHash: "bad",
      }),
    ).rejects.toThrow("certified_fork_publish_digest_invalid");
    const [first, duplicate] = await Promise.all([
      claims.claimPrelease({ scope, reservationOwner: "owner-1" }),
      claims.claimPrelease({ scope, reservationOwner: "owner-2" }),
    ]);
    expect([first.status, duplicate.status].sort()).toEqual([
      "in_progress",
      "ready",
    ]);
    await expect(
      claims.claimPrelease({
        scope: { ...scope, contextHash: "f".repeat(64) },
        reservationOwner: "owner-3",
      }),
    ).rejects.toThrow("certified_fork_claim_conflict");
    const winningOwner = first.status === "ready" ? "owner-1" : "owner-2";
    const losingOwner = first.status === "ready" ? "owner-2" : "owner-1";
    await expect(
      claims.claimPrelease({ scope, reservationOwner: winningOwner }),
    ).resolves.toEqual({ status: "resume" });
    await expect(
      claims.claimPrepare({
        scope,
        reservationOwner: losingOwner,
        executionId: "losing-execution",
      }),
    ).rejects.toThrow("certified_fork_claim_reservation_mismatch");
    await expect(
      claims.claimPrepare({
        scope,
        reservationOwner: winningOwner,
        executionId: "execution-1",
      }),
    ).resolves.toEqual({ status: "ready" });
    await expect(
      claims.claimPrepare({
        scope,
        reservationOwner: winningOwner,
        executionId: "execution-1",
      }),
    ).resolves.toEqual({ status: "resume" });
    await expect(
      claims.beginPublish({
        scope,
        executionId: "losing-execution",
        outputDigest: "d".repeat(64),
      }),
    ).rejects.toThrow("certified_fork_claim_execution_mismatch");
    await expect(
      claims.beginPublish({
        scope,
        executionId: "execution-1",
        outputDigest: "d".repeat(64),
      }),
    ).resolves.toEqual({ status: "ready" });
    await expect(
      claims.beginPublish({
        scope,
        executionId: "execution-1",
        outputDigest: "e".repeat(64),
      }),
    ).rejects.toThrow("certified_fork_publish_digest_conflict");
    await claims.completePublished({
      scope,
      executionId: "execution-1",
      outputDigest: "d".repeat(64),
      commentId: "10",
    });
    await expect(
      claims.claimPrepare({
        scope,
        reservationOwner: "owner-3",
        executionId: "execution-3",
      }),
    ).resolves.toEqual({ status: "already_published", commentId: "10" });
  });
  it.each([
    ["feature off", false, ["owner/example"]],
    ["empty cohort", true, []],
    ["wrong cohort", true, ["owner/other"]],
  ])("fails closed when %s", (_name, enabled, repositories) => {
    const admission = new StaticCertifiedForkReviewAdmission(
      enabled,
      new Set(repositories),
    );
    expect(() => admission.assertEnabled(binding)).toThrow(
      "certified_fork_v5_not_enabled",
    );
  });

  it("admits only the canonical base repository in the enabled cohort", () => {
    const admission = new StaticCertifiedForkReviewAdmission(
      true,
      new Set(["owner/example"]),
    );
    expect(() => admission.assertEnabled(binding)).not.toThrow();
  });
  it("accepts only a completed recent lease with its finalized V5 provider binding", async () => {
    const findProviderBinding = vi.fn(async () => ({
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
    }));
    const lease = new PrismaCertifiedForkReviewLease(
      {
        codexOAuthLease: {
          findUnique: async () => ({
            providerInstanceId: "provider-123",
            githubRunId: "8",
            githubRunAttempt: "1",
            pullRequestNumber: 42,
            leaseKey: `provider-123:8:1:fork:${certifiedForkReviewBindingHash(
              binding,
            )}`,
            status: "completed",
            finalizedAt: new Date("2026-08-30T09:30:00.000Z"),
            completedAt: new Date("2026-08-30T09:30:00.000Z"),
            repository: {
              githubRepositoryId: 99n,
              fullName: "owner/example",
              selected: true,
              archived: false,
              visibility: "public",
              installation: {
                status: "active",
                githubInstallationId: 7n,
              },
            },
          }),
        },
      } as never,
      {
        findSelectedRepositoryByGithubId: async () => ({ id: "repo" }),
      } as never,
      { findProviderBinding } as never,
      { now: () => new Date("2026-08-30T10:00:00.000Z") },
    );
    await expect(
      lease.assertFinalizedV5ForkLease({
        leaseId: "lease-123",
        providerInstanceId: "provider-123",
        claims: {
          run_id: "8",
          run_attempt: "1",
          workflow_sha: "a".repeat(40),
        } as never,
        binding,
      }),
    ).resolves.toEqual({ githubInstallationId: "7" });
    expect(findProviderBinding).toHaveBeenCalledWith(
      expect.objectContaining({ workflowSchemaVersion: 5 }),
    );
  });
  it("signs opaque execution tickets and rejects tampering", async () => {
    const tickets = new HmacCertifiedForkReviewTickets("s".repeat(32));
    const issued = await tickets.issue({
      contextHash: promptPacket.contextHash,
      leaseId: "lease-123",
      providerInstanceId: "provider-123",
      githubInstallationId: "7",
      githubRunId: "8",
      githubRunAttempt: "1",
      workflowRef:
        "owner/example/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
      workflowSha: "a".repeat(40),
      binding,
    });
    await expect(tickets.verify(issued.executionId)).resolves.toMatchObject({
      contextHash: promptPacket.contextHash,
      binding,
    });
    await expect(tickets.verify(`${issued.executionId}x`)).rejects.toThrow(
      "certified_fork_context_mismatch",
    );
    await expect(
      tickets.signPublication({
        executionDigest: "d".repeat(64),
        outputDigest: "e".repeat(64),
      }),
    ).resolves.toMatch(/^[a-f0-9]{64}$/);
  });
  it("strictly parses output, strips model markers, and rejects non-diff paths", () => {
    const output = new StrictCertifiedForkReviewOutput();
    const rendered = output.render({
      generatedAt: new Date("2026-08-30T10:00:00.000Z"),
      binding,
      promptPacket,
      modelOutput: {
        protocolVersion: 1,
        summaryMarkdown: "<!-- attacker -->ok",
        findings: [
          {
            severity: "major",
            title: "bug",
            body: "body",
            path: "src/a.ts",
            startLine: 1,
          },
        ],
      },
    });
    expect(rendered.body).not.toContain("attacker");
    expect(() =>
      output.render({
        generatedAt: new Date(),
        binding,
        promptPacket,
        modelOutput: {
          protocolVersion: 1,
          summaryMarkdown: "ok",
          findings: [
            {
              severity: "major",
              title: "bug",
              body: "body",
              path: "../secret",
              startLine: 1,
            },
          ],
        },
      }),
    ).toThrow(/review_model_output|certified_fork_model_output/);
  });

  it("HTML-escapes exact diff paths and rejects Markdown/control path injection", () => {
    const output = new StrictCertifiedForkReviewOutput();
    const htmlPath = "src/<img src=x>.ts";
    const packet = {
      ...promptPacket,
      files: [{ ...promptPacket.files[0]!, path: htmlPath }],
    };
    const rendered = output.render({
      generatedAt: new Date(),
      binding,
      promptPacket: packet,
      modelOutput: {
        protocolVersion: 1,
        summaryMarkdown: "@maintainer <!-- marker --> <script>x</script>",
        findings: [
          {
            severity: "major",
            title: "bug",
            body: "body",
            path: htmlPath,
            startLine: 1,
          },
        ],
      },
    });
    expect(rendered.body).toContain("src/&lt;img src=x&gt;.ts");
    expect(rendered.body).not.toContain("<img");
    expect(rendered.body).not.toContain("<script>");
    expect(rendered.body).toContain("@\u200bmaintainer");
    for (const path of [
      "src/`escape`.ts",
      "src/a.ts\nattack",
      "src/safe\u2066evil.ts",
    ]) {
      expect(() =>
        output.render({
          generatedAt: new Date(),
          binding,
          promptPacket: {
            ...promptPacket,
            files: [{ ...promptPacket.files[0]!, path }],
          },
          modelOutput: {
            protocolVersion: 1,
            summaryMarkdown: "ok",
            findings: [
              {
                severity: "major",
                title: "bug",
                body: "body",
                path,
                startLine: 1,
              },
            ],
          },
        }),
      ).toThrow("certified_fork_model_output_invalid");
    }
  });

  it("deterministically truncates multibyte output to the GitHub comment budget", () => {
    const output = new StrictCertifiedForkReviewOutput();
    const input = {
      generatedAt: new Date("2026-08-30T10:00:00.000Z"),
      binding,
      promptPacket,
      modelOutput: {
        protocolVersion: 1,
        summaryMarkdown: "é".repeat(30_000),
        findings: [
          {
            severity: "major",
            title: "bug",
            body: "é".repeat(4_000),
            path: "src/a.ts",
            startLine: 1,
          },
        ],
      },
    } as const;
    const first = output.render(input);
    const second = output.render(input);
    expect(first).toEqual(second);
    expect(Buffer.byteLength(first.body, "utf8")).toBeLessThanOrEqual(59_500);
    expect(first.body).toContain("Output truncated to GitHub comment budget");
    expect(first.body).not.toContain("�");
  });

  it.each(["startLine", "endLine"] as const)(
    "rejects %s beyond the shared line budget",
    (key) => {
      const output = new StrictCertifiedForkReviewOutput();
      expect(() =>
        output.render({
          generatedAt: new Date("2026-08-30T10:00:00.000Z"),
          binding,
          promptPacket,
          modelOutput: {
            protocolVersion: 1,
            summaryMarkdown: "ok",
            findings: [
              {
                severity: "major",
                title: "bug",
                body: "body",
                path: "src/a.ts",
                startLine: 1,
                [key]: 1_000_001,
              },
            ],
          },
        }),
      ).toThrow("certified_fork_model_output_invalid");
    },
  );
});
