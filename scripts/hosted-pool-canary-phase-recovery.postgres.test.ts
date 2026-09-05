import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../packages/platform/db/src/index";
import { enrollHostedPoolAccount } from "../packages/features/hosted-account-pool/src/domain/account-pool";
import { issueInvocationGrant } from "../packages/features/hosted-account-pool/src/domain/invocation-grant";
import {
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  invocationGrantId,
  invocationId,
  repositoryId,
  workspaceId,
} from "../packages/features/hosted-account-pool/src/domain/identifiers";
import { PrismaInvocationGrantRepository } from "../packages/features/hosted-account-pool/src/infrastructure/prisma/prisma-invocation-grant-repository";
import {
  FetchHostedCodexStreamingRelay,
  PrismaHostedCodexRelayAuthorization,
} from "../packages/features/hosted-account-pool/src/infrastructure/http/prisma-hosted-codex-relay";
import { createPrismaHostedCodexCanaryFaultPlanPort } from "../apps/api/src/hosted-codex-canary-fault-plan";
import {
  createPrismaCanaryPhaseRecovery,
  type CanaryPhaseScope,
} from "./hosted-pool-canary-phase-recovery";
import { createRenderHostedPoolControlPort } from "./hosted-pool-production-control";
import type { CanaryRunEvidence } from "./hosted-pool-production-ports";
import {
  seedCanaryPgSourceCatalog,
  seedCanaryPgSourceExecution,
} from "./hosted-pool-canary-phase-recovery.postgres.fixture";

// The fault-plan implementation only needs these constants from the feature
// barrel. Avoid loading unrelated session SDKs; signature verification and the
// consumed-plan transaction below are the actual production implementation.
vi.mock(
  "../packages/features/hosted-account-pool/src/index",
  async () =>
    import("../packages/features/hosted-account-pool/src/application/ports/hosted-codex-canary-fault-plan-port"),
);

const url = process.env.REVIEW_ROUTER_CANARY_PHASE_PG17_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !/^\/reviewrouter_canary_phase_[a-z0-9_]+$/u.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("canary_phase_pg17_disposable_loopback_database_required");
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const actionSha = "a".repeat(40);
const headSha = "c".repeat(40);

describe.skipIf(!url)(
  "canary recovery on migrated disposable PostgreSQL 17",
  () => {
    const prisma = createPrismaClient({
      databaseUrl: url ?? "postgresql://unused@127.0.0.1:1/unused",
      poolMax: 4,
    });
    const ledger = new PrismaInvocationGrantRepository(prisma);
    const renderFetch = vi.fn(async () => {
      throw new Error("provider_control_forbidden_in_pg_test");
    });
    const control = createRenderHostedPoolControlPort({
      apiKey: "disposable-not-a-key",
      serviceIds: ["unused-api", "unused-web"],
      databaseUrl: url ?? "postgresql://unused@127.0.0.1:1/unused",
      fetchImpl: renderFetch,
    });
    const keys = generateKeyPairSync("ed25519");
    const faultPlans = createPrismaHostedCodexCanaryFaultPlanPort({
      prisma,
      authorityPublicKeyPem: keys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      expectedAuthorityKeyId: "fixture-key",
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response('data: {"type":"response.completed"}\n\n', {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "disposable-response",
          },
        }),
    );
    let runtimeEpoch = 0n;

    beforeAll(async () => {
      const version = await prisma.$queryRaw<
        Array<{ server_version_num: string }>
      >`SHOW server_version_num`;
      expect(Number(version[0]!.server_version_num)).toBeGreaterThanOrEqual(
        170000,
      );
      expect(Number(version[0]!.server_version_num)).toBeLessThan(180000);
      // Require the supported migrations and their real health/effect guards.
      const guards = await prisma.$queryRaw<
        Array<{ tgname: string }>
      >`SELECT tgname FROM pg_trigger WHERE tgname = 'HostedCodexAccount_generation_guard'`;
      expect(guards).toHaveLength(1);
      expect(await prisma.workspace.count()).toBe(0); // Fresh database only.
      // Same empty-database migration bootstrap as the existing PG fixture. This
      // transaction ends before any account/grant/effect exists; all guards are
      // active for the actual canary transitions and recovery tests.
      const closed = await prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
        where: { id: "global" },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = 'replica'`;
        await tx.hostedCodexRuntimeClosure.upsert({
          where: { gateRevision: closed.revision },
          create: {
            id: `runtime-closure-${closed.revision}`,
            gateRevision: closed.revision,
            closedAuthzEpoch: closed.authzEpoch,
            actorHash: sha("fixture"),
            reasonHash: sha("fixture"),
            state: "complete",
            completedAt: new Date(),
            legacyBarrier: false,
            legacyUnsafeUntil: new Date(0),
          },
          update: {
            state: "complete",
            completedAt: new Date(),
            legacyBarrier: false,
            legacyUnsafeUntil: new Date(0),
            revision: { increment: 1 },
          },
        });
      });
      const gate = await prisma.hostedCodexRuntimeGate.update({
        where: { id: "global" },
        data: {
          status: "active",
          authzEpoch: { increment: 1 },
          revision: { increment: 1 },
          changedAt: new Date(),
          changedByHash: sha("fixture"),
          reasonCode: "disposable_canary_test",
        },
      });
      runtimeEpoch = gate.authzEpoch;
      await prisma.workspace.create({
        data: {
          id: "phase-workspace",
          slug: "phase-workspace",
          name: "Disposable canary phase",
        },
      });
      await prisma.gitHubInstallation.create({
        data: {
          id: "phase-installation",
          workspaceId: "phase-workspace",
          githubInstallationId: 987654321n,
          accountLogin: "disposable",
          accountType: "Organization",
          repositorySelection: "selected",
          status: "active",
        },
      });
      await prisma.repositoryConnection.create({
        data: {
          id: "phase-repository",
          workspaceId: "phase-workspace",
          provider: "github",
          externalRepositoryId: "123456789",
          githubRepositoryId: 123456789n,
          installationId: "phase-installation",
          owner: "disposable",
          name: "fixture",
          fullName: "disposable/fixture",
          defaultBranch: "main",
          visibility: "private",
          selected: true,
          archived: false,
        },
      });
      await seedCanaryPgSourceCatalog(prisma);
      await prisma.hostedCodexPool.create({
        data: {
          id: "phase-pool",
          workspaceId: "phase-workspace",
          name: "Disposable",
          isDefault: true,
        },
      });
      for (const [priority, id] of ["phase-a", "phase-b"].entries()) {
        await prisma.hostedCodexAccount.create({
          data: {
            id,
            workspaceId: "phase-workspace",
            poolId: "phase-pool",
            label: id,
            priority,
            accountFingerprint: sha(id),
          },
        });
        await prisma.hostedCodexCredentialVersion.create({
          data: {
            id: `credential-${id}`,
            workspaceId: "phase-workspace",
            poolId: "phase-pool",
            accountId: id,
            generation: 1n,
            databaseIncarnation: "disposable-phase-incarnation",
            envelopeVersion: 1,
            encryptionAlgorithm: "aes-256-gcm",
            keyId: "disposable",
            aadHash: sha(id),
            generationHash: sha(id),
            ciphertextHash: sha(id),
            encryptedCiphertext: "not-a-provider-credential",
            envelopeMetadata: {},
            credentialExpiresAt: new Date(Date.now() + 3_600_000),
          },
        });
        await prisma.hostedCodexAccount.update({
          where: { id },
          data: {
            state: "healthy",
            activeGeneration: 1n,
            healthVersion: { increment: 1 },
          },
        });
      }
      await prisma.hostedCodexRepositoryBinding.create({
        data: {
          id: "phase-binding",
          workspaceId: "phase-workspace",
          poolId: "phase-pool",
          repositoryConnectionId: "phase-repository",
          status: "active",
          revision: 1n,
          stateVersion: 1n,
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowActionRef: `777genius/review-router@${actionSha}`,
          workflowSourceCommitSha: headSha,
          workflowSourceBlobSha: headSha,
          workflowSourceSha256: sha("workflow"),
          workflowSemanticSha256: sha("semantic"),
          workflowSourceTrust: "trusted_default_branch_revision",
          attestedGithubRepositoryId: 123456789n,
          attestedBindingRevision: 1n,
          activatedAt: new Date(),
        },
      });
    }, 30_000);
    afterAll(async () => {
      await Promise.all([prisma.$disconnect(), control.disconnect()]);
    });

    async function executePhase(
      phase: CanaryPhaseScope["phase"],
      runId: number,
    ) {
      const started = new Date();
      const expires = new Date(started.getTime() + 600_000);
      const claims = {
        v: 2,
        repository_id: "123456789",
        run_id: String(runId),
        run_attempt: 2,
        action_ref: `777genius/review-router@${actionSha}`,
        binding_id: "phase-binding",
        binding_revision: "1",
        phase: {
          unauthorized: "synthetic_unauthorized",
          rate_limited: "synthetic_rate_limited",
          dropped_response: "drop_after_response_started",
        }[phase],
        request_ordinal: 1,
        attempt_ordinal: 1,
        authority_key_id: "fixture-key",
        actor_id: "fixture-operator",
        nonce: sha(String(runId)),
        issued_at: started.toISOString(),
        expires_at: expires.toISOString(),
      };
      const payload = `rr-canary-fault-v2.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
      const token = `${payload}.${sign(null, Buffer.from(payload), keys.privateKey).toString("base64url")}`;
      const scope: CanaryPhaseScope = {
        phase,
        runId,
        planIdHash: sha(token),
        repositoryId: 123456789,
        repositoryBindingId: "phase-binding",
        bindingRevision: "1",
        actionSha,
        poolId: "phase-pool",
        accountIds: ["phase-a", "phase-b"],
      };
      await control.prepareCanaryPhase!(scope);
      await control.setFaultPlan!(token);
      const issued = new Date();
      const accounts = await prisma.hostedCodexAccount.findMany({
        where: { poolId: "phase-pool" },
        select: { id: true, state: true, healthVersion: true, priority: true },
      });
      expect(accounts.every((a) => a.state === "healthy")).toBe(true);
      const id = invocationGrantId(`phase-grant-${runId}`);
      const invocation = invocationId(`phase-invocation-${runId}`);
      const opaqueGrant = `disposable-phase-token-${runId}`;
      const grant = issueInvocationGrant({
        id,
        invocationId: invocation,
        repositoryId: repositoryId("phase-repository"),
        workspaceId: workspaceId("phase-workspace"),
        poolId: hostedPoolId("phase-pool"),
        accounts: accounts.map((a) => ({
          ...enrollHostedPoolAccount({
            id: hostedAccountId(a.id),
            poolId: hostedPoolId("phase-pool"),
            label: a.id,
            priority: a.priority,
            credential: {
              credentialRef: "fixture-metadata-only",
              subjectFingerprint: a.id,
              authGeneration: 1,
              validatedAt: issued,
              expiresAt: expires,
            },
            now: issued,
          }),
          healthVersion: Number(a.healthVersion),
        })),
        authority: {
          repositoryBindingId: hostedBindingId("phase-binding"),
          reviewRequestId: `phase-review-${runId}`,
          providerInvocationKey: sha(`invocation-${runId}`),
          runId: String(runId),
          runAttempt: 2,
          model: "gpt-5.6",
          policyFingerprint: sha("policy"),
          runtimeConfigVersion: 1,
          bindingRevision: 1,
          authzEpoch: 1n,
        },
        runtimeAuthzEpoch: runtimeEpoch,
        capabilityTokenHash: sha(opaqueGrant),
        commentTokenRefreshCapability: {
          tokenHash: sha(`refresh-${runId}`),
          grantId: id,
          invocationId: invocation,
          repositoryBindingId: hostedBindingId("phase-binding"),
          expiresAt: expires,
          maxUses: 1,
          useCount: 0,
          revokedAt: null,
        },
        budget: {
          expiresAt: expires,
          maxRequests: 1,
          maxConcurrentRequests: 1,
          maxRequestBytes: 1024,
          maxResponseBytes: 4096,
          maxOutputTokens: 1024,
        },
        now: issued,
      });
      await ledger.insert(grant);
      await seedCanaryPgSourceExecution(prisma, runId, issued, expires);
      const body = Buffer.from('{"input":"disposable review"}');
      const authorization = await new PrismaHostedCodexRelayAuthorization(
        prisma,
      ).authorize({
        opaqueGrant,
        requestOrdinal: 1,
        idempotencyKey: `disposable-request-${runId}`,
        requestBytes: body.length,
      });
      const runtime = {
        ensureFreshSession: async () => ({
          accessToken: "disposable-token",
          chatgptAccountId: "disposable-account",
          credentialGeneration: 1,
        }),
        classifyFailure: () => ({ code: "unknown" }),
      };
      const relay = new FetchHostedCodexStreamingRelay(
        runtime as never,
        ledger,
        fetchImpl,
        { failoverEnabled: true, faultPlans },
      );
      const open = relay.open({
        authorization,
        body: Readable.from([body]),
        contentType: "application/json",
        accept: "text/event-stream",
        abortSignal: new AbortController().signal,
      });
      if (phase === "dropped_response")
        await expect(open).rejects.toThrow(
          "hosted_codex_canary_dropped_response",
        );
      else {
        const response = await open;
        for await (const chunk of response.body) void chunk;
      }
      await control.setFaultPlan!(null);
      const stored = await prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id },
        include: {
          relayRequests: {
            include: {
              upstreamAttempts: { orderBy: { attemptOrdinal: "asc" } },
            },
          },
        },
      });
      // The operator adapter re-reads the complete state graph itself. These are
      // the immutable observation identities used to bind the controller result.
      const observed = {
        runId,
        sourceRunAttempt: 2,
        sourceHeadSha: headSha,
        sourceExecutionId: `execution-${runId}`,
        grantId: id,
        workspaceId: "phase-workspace",
        githubRepositoryId: "123456789",
        repositoryBindingId: "phase-binding",
        bindingRevision: "1",
        actionRef: claims.action_ref,
        requestId: authorization.requestId,
        attempts: stored.relayRequests[0]!.upstreamAttempts.map((a) => ({
          attemptId: a.id,
          credentialGeneration: a.credentialGeneration!.toString(),
        })),
      } as CanaryRunEvidence;
      return { scope, observed, stored };
    }

    it("runs actual authenticated 401 -> 429 -> dropped relay persistence, recovers a lost commit, and preserves a newer real failure", async () => {
      for (const [index, phase] of [
        "unauthorized",
        "rate_limited",
        "dropped_response",
      ].entries()) {
        const { scope, observed, stored } = await executePhase(
          phase as CanaryPhaseScope["phase"],
          101 + index,
        );
        expect(stored.failoverCount).toBe(phase === "dropped_response" ? 0 : 1);
        const before = await prisma.hostedCodexAccount.findUniqueOrThrow({
          where: { id: "phase-a" },
          select: { state: true, healthVersion: true },
        });
        expect(before.state).toBe(
          {
            unauthorized: "quarantined",
            rate_limited: "cooldown",
            dropped_response: "healthy",
          }[phase]!,
        );
        let lost = false;
        const wrapped = new Proxy(prisma, {
          get(target, key) {
            if (key !== "$transaction") return Reflect.get(target, key);
            return async (...args: any[]) => {
              const result = await (target.$transaction as any)(...args);
              if (!lost) {
                lost = true;
                throw new Error("committed_response_lost");
              }
              return result;
            };
          },
        });
        const recovery = createPrismaCanaryPhaseRecovery(wrapped);
        const receipt = await recovery.reconcileCanaryPhase(scope, observed);
        expect(await recovery.reconcileCanaryPhase(scope, observed)).toEqual(
          receipt,
        );
        const after = await prisma.hostedCodexAccount.findUniqueOrThrow({
          where: { id: "phase-a" },
          select: { state: true, healthVersion: true },
        });
        expect(after).toEqual({
          state: "healthy",
          healthVersion:
            before.healthVersion + (phase === "dropped_response" ? 0n : 1n),
        });
        if (phase === "dropped_response") {
          await prisma.hostedCodexAccount.update({
            where: { id: "phase-a" },
            data: { state: "quarantined", healthVersion: { increment: 1 } },
          });
          await expect(
            recovery.reconcileCanaryPhase(scope, observed),
          ).rejects.toThrow("recovery_hold");
          expect(
            await prisma.hostedCodexAccount.findUnique({
              where: { id: "phase-a" },
              select: { state: true },
            }),
          ).toEqual({ state: "quarantined" });
        }
      }
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(renderFetch).not.toHaveBeenCalled();
      expect(
        await prisma.auditEvent.count({
          where: { action: "hosted_codex_canary_phase_reconciled" },
        }),
      ).toBe(3);
    }, 30_000);
  },
);
