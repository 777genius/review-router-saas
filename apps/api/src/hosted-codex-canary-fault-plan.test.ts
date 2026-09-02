import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPrismaHostedCodexCanaryFaultPlanPort,
  verifyHostedCodexCanaryFaultPlan,
} from "./hosted-codex-canary-fault-plan";

const now = new Date("2026-08-24T12:00:00.000Z");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

function token(overrides: Record<string, unknown> = {}) {
  const claims = {
    v: 2,
    repository_id: "123456789",
    run_id: "42",
    run_attempt: 2,
    action_ref: `777genius/review-router@${"a".repeat(40)}`,
    binding_id: "binding-canary",
    binding_revision: "7",
    phase: "synthetic_unauthorized",
    request_ordinal: 1,
    attempt_ordinal: 1,
    authority_key_id: "canary-key-1",
    actor_id: "production-operator",
    nonce: "n".repeat(32),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(`rr-canary-fault-v2.${payload}`),
    keys.privateKey,
  ).toString("base64url");
  return `rr-canary-fault-v2.${payload}.${signature}`;
}

describe("hosted Codex production-canary fault plan", () => {
  it("accepts only an exact operator-signed scope expiring within one hour", () => {
    const signed = token();
    const tampered = `${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`;
    expect(
      verifyHostedCodexCanaryFaultPlan({
        token: token(),
        authorityPublicKeyPem: publicKey,
        expectedAuthorityKeyId: "canary-key-1",
        now,
      }),
    ).toMatchObject({ run_id: "42", phase: "synthetic_unauthorized" });
    expect(() =>
      verifyHostedCodexCanaryFaultPlan({
        token: token({
          expires_at: new Date(now.getTime() + 60 * 60_000 + 1).toISOString(),
        }),
        authorityPublicKeyPem: publicKey,
        expectedAuthorityKeyId: "canary-key-1",
        now,
      }),
    ).toThrow("hosted_codex_canary_fault_plan_scope_invalid");
    expect(() =>
      verifyHostedCodexCanaryFaultPlan({
        token: tampered,
        authorityPublicKeyPem: publicKey,
        expectedAuthorityKeyId: "canary-key-1",
        now,
      }),
    ).toThrow("hosted_codex_canary_fault_plan_invalid");
    expect(() =>
      verifyHostedCodexCanaryFaultPlan({
        token: `rr-canary-fault-v2.${"x".repeat(8_193)}.signature`,
        authorityPublicKeyPem: publicKey,
        expectedAuthorityKeyId: "canary-key-1",
        now,
      }),
    ).toThrow("hosted_codex_canary_fault_plan_invalid");
  });

  it("matches every bound ordinal and consumes the nonce through AuditEvent", async () => {
    const stagedToken = token();
    const planIdHash = createHash("sha256").update(stagedToken).digest("hex");
    let consumed = false;
    const create = vi.fn(async () => {
      consumed = true;
      return {};
    });
    const transaction = {
      auditEvent: {
        findFirst: vi.fn(async (query: any) =>
          query.where.action === "hosted_codex_canary_fault_plan_staged"
            ? { id: "staged-1" }
            : consumed
              ? { id: "audit-1" }
              : null,
        ),
        create,
      },
    };
    const prisma = {
      auditEvent: {
        findMany: vi.fn(async () => [
          { targetId: planIdHash, metadata: { token: stagedToken } },
        ]),
        findFirst: vi.fn(async () => (consumed ? { id: "audit-1" } : null)),
      },
      $transaction: vi.fn(
        async (operation: (tx: typeof transaction) => unknown) =>
          operation(transaction),
      ),
    };
    const port = createPrismaHostedCodexCanaryFaultPlanPort({
      prisma: prisma as never,
      authorityPublicKeyPem: publicKey,
      expectedAuthorityKeyId: "canary-key-1",
      now: () => now,
    });
    const scope = {
      workspaceId: "workspace-1",
      githubRepositoryId: 123456789n,
      runId: "42",
      runAttempt: 2,
      actionRef: `777genius/review-router@${"a".repeat(40)}`,
      repositoryBindingId: "binding-canary",
      bindingRevision: 7n,
      requestOrdinal: 1,
      attemptOrdinal: 1,
      injectionPoint: "before_provider_fetch" as const,
    };
    await expect(port.consume(scope)).resolves.toBe("synthetic_unauthorized");
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "hosted_codex_canary_fault_plan_consumed",
        workspaceId: "workspace-1",
        metadata: expect.objectContaining({
          injectionPoint: "before_provider_fetch",
          planIdHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      }),
    });
    await expect(port.consume(scope)).resolves.toBeNull();
  });

  it("cannot be selected by a different run or repository scope", async () => {
    const stagedToken = token();
    const prisma = {
      auditEvent: {
        findMany: vi.fn(async () => [
          {
            targetId: createHash("sha256").update(stagedToken).digest("hex"),
            metadata: { token: stagedToken },
          },
        ]),
        findFirst: vi.fn(async () => null),
      },
      $transaction: vi.fn(),
    };
    const port = createPrismaHostedCodexCanaryFaultPlanPort({
      prisma: prisma as never,
      authorityPublicKeyPem: publicKey,
      expectedAuthorityKeyId: "canary-key-1",
      now: () => now,
    });
    await expect(
      port.consume({
        workspaceId: "workspace-1",
        githubRepositoryId: 999n,
        runId: "42",
        runAttempt: 2,
        actionRef: `777genius/review-router@${"a".repeat(40)}`,
        repositoryBindingId: "binding-canary",
        bindingRevision: 7n,
        requestOrdinal: 1,
        attemptOrdinal: 1,
        injectionPoint: "before_provider_fetch",
      }),
    ).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await expect(
      port.consume({
        workspaceId: "workspace-1",
        githubRepositoryId: 123456789n,
        runId: "43",
        runAttempt: 2,
        actionRef: `777genius/review-router@${"a".repeat(40)}`,
        repositoryBindingId: "binding-canary",
        bindingRevision: 7n,
        requestOrdinal: 1,
        attemptOrdinal: 1,
        injectionPoint: "before_provider_fetch",
      }),
    ).resolves.toBeNull();
  });

  it("loads a short-lived operator-staged plan and closes it atomically", async () => {
    const stagedToken = token({ phase: "synthetic_rate_limited" });
    const planIdHash = createHash("sha256").update(stagedToken).digest("hex");
    const create = vi.fn(async () => ({}));
    const auditEvent = {
      findMany: vi.fn(async () => [
        { targetId: planIdHash, metadata: { token: stagedToken } },
      ]),
      findFirst: vi.fn(async (query: any) =>
        query.where.action === "hosted_codex_canary_fault_plan_staged"
          ? { id: "staged-1" }
          : null,
      ),
      create,
    };
    const prisma = {
      auditEvent,
      $transaction: vi.fn(
        async (operation: (tx: { auditEvent: typeof auditEvent }) => unknown) =>
          operation({ auditEvent }),
      ),
    };
    const port = createPrismaHostedCodexCanaryFaultPlanPort({
      prisma: prisma as never,
      authorityPublicKeyPem: publicKey,
      expectedAuthorityKeyId: "canary-key-1",
      now: () => now,
    });
    await expect(
      port.consume({
        workspaceId: "workspace-1",
        githubRepositoryId: 123456789n,
        runId: "42",
        runAttempt: 2,
        actionRef: `777genius/review-router@${"a".repeat(40)}`,
        repositoryBindingId: "binding-canary",
        bindingRevision: 7n,
        requestOrdinal: 1,
        attemptOrdinal: 1,
        injectionPoint: "before_provider_fetch",
      }),
    ).resolves.toBe("synthetic_rate_limited");
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ targetId: planIdHash }),
    });
    auditEvent.findFirst = vi.fn(async () => ({ id: "consumed-1" }));
    await expect(
      port.consume({
        workspaceId: "workspace-1",
        githubRepositoryId: 123456789n,
        runId: "42",
        runAttempt: 2,
        actionRef: `777genius/review-router@${"a".repeat(40)}`,
        repositoryBindingId: "binding-canary",
        bindingRevision: 7n,
        requestOrdinal: 1,
        attemptOrdinal: 1,
        injectionPoint: "before_provider_fetch",
      }),
    ).resolves.toBeNull();
  });
});
