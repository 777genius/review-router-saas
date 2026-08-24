import { createHash, createPublicKey, verify } from "node:crypto";
import {
  hostedCodexCanaryFaultPlanMaxLifetimeMs,
  hostedCodexCanaryFaultPlanTokenMaxBytes,
  type HostedCodexCanaryFault,
  type HostedCodexCanaryFaultPlanPort,
  type HostedCodexCanaryFaultScope,
} from "@reviewrouter/features-hosted-account-pool";
import type { PrismaClient } from "@reviewrouter/platform-db";

type FaultPlanClaims = Readonly<{
  v: 2;
  repository_id: string;
  run_id: string;
  run_attempt: number;
  action_ref: string;
  binding_id: string;
  binding_revision: string;
  phase: HostedCodexCanaryFault;
  request_ordinal: number;
  attempt_ordinal: number;
  authority_key_id: string;
  actor_id: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
}>;

const exactClaimKeys = [
  "action_ref",
  "actor_id",
  "attempt_ordinal",
  "authority_key_id",
  "binding_id",
  "binding_revision",
  "expires_at",
  "issued_at",
  "nonce",
  "phase",
  "repository_id",
  "request_ordinal",
  "run_attempt",
  "run_id",
  "v",
] as const;

/** Verifies the operator witness without possessing its Ed25519 private key. */
export function verifyHostedCodexCanaryFaultPlan(input: {
  token: string;
  authorityPublicKeyPem: string;
  expectedAuthorityKeyId: string;
  now?: Date;
}): FaultPlanClaims {
  if (
    Buffer.byteLength(input.token, "utf8") >
    hostedCodexCanaryFaultPlanTokenMaxBytes
  )
    invalid();
  const parts = input.token.split(".");
  if (parts.length !== 3 || parts[0] !== "rr-canary-fault-v2") invalid();
  const payload = parts[1]!;
  const signature = decodeBase64Url(parts[2]!);
  try {
    if (
      signature.byteLength !== 64 ||
      !verify(
        null,
        Buffer.from(`rr-canary-fault-v2.${payload}`, "utf8"),
        createPublicKey(input.authorityPublicKeyPem),
        signature,
      )
    )
      invalid();
  } catch {
    invalid();
  } finally {
    signature.fill(0);
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeBase64Url(payload).toString("utf8"));
  } catch {
    invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const claims = value as Record<string, unknown>;
  if (
    Object.keys(claims).sort().join("\0") !== exactClaimKeys.join("\0") ||
    claims.v !== 2 ||
    claims.authority_key_id !== input.expectedAuthorityKeyId ||
    ![
      "synthetic_unauthorized",
      "synthetic_rate_limited",
      "drop_after_response_started",
    ].includes(String(claims.phase)) ||
    !positiveInteger(claims.run_attempt) ||
    !positiveInteger(claims.request_ordinal) ||
    !positiveInteger(claims.attempt_ordinal)
  )
    invalidScope();
  for (const key of [
    "repository_id",
    "run_id",
    "action_ref",
    "binding_id",
    "binding_revision",
    "actor_id",
    "nonce",
    "issued_at",
    "expires_at",
  ] as const) {
    if (
      typeof claims[key] !== "string" ||
      claims[key].length === 0 ||
      claims[key].length > 256
    )
      invalidScope();
  }
  if (
    !/^[1-9]\d*$/u.test(claims.repository_id as string) ||
    !/^[1-9]\d*$/u.test(claims.binding_revision as string) ||
    !/^\d+$/u.test(claims.run_id as string) ||
    !/^777genius\/review-router@[a-f0-9]{40}$/u.test(
      claims.action_ref as string,
    ) ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(claims.nonce as string) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{2,127}$/u.test(claims.actor_id as string) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u.test(
      claims.authority_key_id as string,
    ) ||
    (claims.binding_id as string).length > 191
  )
    invalidScope();
  const now = input.now ?? new Date();
  const issuedAt = new Date(claims.issued_at as string);
  const expiresAt = new Date(claims.expires_at as string);
  if (
    !Number.isFinite(issuedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    issuedAt.toISOString() !== claims.issued_at ||
    expiresAt.toISOString() !== claims.expires_at ||
    expiresAt <= now ||
    issuedAt.getTime() > now.getTime() + 30_000 ||
    expiresAt <= issuedAt ||
    expiresAt.getTime() - issuedAt.getTime() >
      hostedCodexCanaryFaultPlanMaxLifetimeMs
  )
    invalidScope();
  return claims as FaultPlanClaims;
}

/** Atomically consumes a matching plan through the existing AuditEvent ledger. */
export function createPrismaHostedCodexCanaryFaultPlanPort(input: {
  prisma: PrismaClient;
  authorityPublicKeyPem: string;
  expectedAuthorityKeyId: string;
  now?: () => Date;
}): HostedCodexCanaryFaultPlanPort {
  const now = input.now ?? (() => new Date());
  return {
    async consume(scope) {
      const plan = await resolvePlan(input, scope, now());
      if (!plan) return null;
      const { claims, planIdHash } = plan;
      await input.prisma.$transaction(
        async (transaction) => {
          const closed = await transaction.auditEvent.findFirst({
            where: {
              action: {
                in: [
                  "hosted_codex_canary_fault_plan_consumed",
                  "hosted_codex_canary_fault_plan_canceled",
                ],
              },
              targetType: "hosted_codex_canary_fault_plan",
              targetId: planIdHash,
            },
            select: { id: true },
          });
          if (closed)
            throw new Error("hosted_codex_canary_fault_plan_replayed");
          const stagedEvent = await transaction.auditEvent.findFirst({
            where: {
              workspaceId: scope.workspaceId,
              action: "hosted_codex_canary_fault_plan_staged",
              targetType: "hosted_codex_canary_fault_plan",
              targetId: planIdHash,
            },
            select: { id: true },
          });
          if (!stagedEvent)
            throw new Error("hosted_codex_canary_fault_plan_not_staged");
          await transaction.auditEvent.create({
            data: {
              workspaceId: scope.workspaceId,
              actor: `operator:${claims.actor_id}`,
              action: "hosted_codex_canary_fault_plan_consumed",
              targetType: "hosted_codex_canary_fault_plan",
              targetId: planIdHash,
              metadata: {
                planIdHash,
                authorityKeyId: claims.authority_key_id,
                repositoryId: claims.repository_id,
                runId: claims.run_id,
                runAttempt: claims.run_attempt,
                actionRef: claims.action_ref,
                bindingId: claims.binding_id,
                bindingRevision: claims.binding_revision,
                phase: claims.phase,
                requestOrdinal: claims.request_ordinal,
                attemptOrdinal: claims.attempt_ordinal,
                injectionPoint: scope.injectionPoint,
                expiresAt: claims.expires_at,
              },
            },
          });
        },
        { isolationLevel: "Serializable" },
      );
      return claims.phase;
    },
  };
}

async function resolvePlan(
  input: {
    prisma: PrismaClient;
    authorityPublicKeyPem: string;
    expectedAuthorityKeyId: string;
  },
  scope: HostedCodexCanaryFaultScope,
  now: Date,
): Promise<{
  claims: FaultPlanClaims;
  planIdHash: string;
} | null> {
  const events = await input.prisma.auditEvent.findMany({
    where: {
      workspaceId: scope.workspaceId,
      action: "hosted_codex_canary_fault_plan_staged",
      targetType: "hosted_codex_canary_fault_plan",
      createdAt: {
        gte: new Date(
          now.getTime() - hostedCodexCanaryFaultPlanMaxLifetimeMs - 30_000,
        ),
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { targetId: true, metadata: true },
  });
  if (events.length >= 100)
    throw new Error("hosted_codex_canary_fault_plan_scan_limit_exceeded");
  for (const event of events) {
    const closed = await input.prisma.auditEvent.findFirst({
      where: {
        action: {
          in: [
            "hosted_codex_canary_fault_plan_consumed",
            "hosted_codex_canary_fault_plan_canceled",
          ],
        },
        targetType: "hosted_codex_canary_fault_plan",
        targetId: event.targetId,
      },
      select: { id: true },
    });
    if (closed) continue;
    const token = (event.metadata as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || sha256(token) !== event.targetId) continue;
    try {
      const claims = verifyHostedCodexCanaryFaultPlan({
        token,
        authorityPublicKeyPem: input.authorityPublicKeyPem,
        expectedAuthorityKeyId: input.expectedAuthorityKeyId,
        now,
      });
      if (matches(claims, scope)) return { claims, planIdHash: event.targetId };
    } catch {
      // Invalid or expired staged records have no authority and are ignored.
    }
  }
  return null;
}

function matches(claims: FaultPlanClaims, scope: HostedCodexCanaryFaultScope) {
  const expectedPoint =
    claims.phase === "drop_after_response_started"
      ? "after_response_started"
      : "before_provider_fetch";
  return (
    claims.repository_id === scope.githubRepositoryId.toString() &&
    claims.run_id === scope.runId &&
    claims.run_attempt === scope.runAttempt &&
    claims.action_ref === scope.actionRef &&
    claims.binding_id === scope.repositoryBindingId &&
    claims.binding_revision === scope.bindingRevision.toString() &&
    claims.request_ordinal === scope.requestOrdinal &&
    claims.attempt_ordinal === scope.attemptOrdinal &&
    scope.injectionPoint === expectedPoint
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) invalid();
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value) {
    result.fill(0);
    invalid();
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(): never {
  throw new Error("hosted_codex_canary_fault_plan_invalid");
}

function invalidScope(): never {
  throw new Error("hosted_codex_canary_fault_plan_scope_invalid");
}
