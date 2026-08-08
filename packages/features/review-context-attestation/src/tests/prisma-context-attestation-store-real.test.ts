import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { PrismaContextAttestationStore } from "../infrastructure/prisma/prisma-context-attestation-store";
import {
  ContextDependencyKind,
  ContextFileKind,
  contextDependencyManifestVersion,
  createContextDependencyManifest,
} from "../domain/context-dependency-manifest";
import {
  ContextLeaseAuthorityKind,
  ContextProviderKind,
  GatewaySessionState,
  activateGatewaySession,
  openGatewaySession,
  revokeGatewaySession,
  sealGatewaySession,
  type GatewaySession,
} from "../domain/gateway-session";
import { createAcceptedDependencyAttestation } from "../domain/accepted-dependency-attestation";
import { ContextAttestationPersistenceStatus } from "../application/ports/context-attestation-ports";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
let prisma: PrismaClient | undefined;
const sessionIds = new Set<string>();

describeDatabase("PrismaContextAttestationStore PostgreSQL invariants", () => {
  afterAll(async () => {
    if (!prisma) return;
    await prisma.reviewContextTargetReplayProof.deleteMany({
      where: { sourceAttestation: { sessionId: { in: [...sessionIds] } } },
    });
    await prisma.reviewContextReplayMaterial.deleteMany({
      where: { sessionId: { in: [...sessionIds] } },
    });
    await prisma.reviewContextDependencyAttestation.deleteMany({
      where: { sessionId: { in: [...sessionIds] } },
    });
    await prisma.reviewContextGatewaySession.deleteMany({
      where: { sessionId: { in: [...sessionIds] } },
    });
    await prisma.$disconnect();
  });

  it("serializes concurrent semantic seals and replaces expired replay proof", async () => {
    prisma ??= createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 6 });
    const store = new PrismaContextAttestationStore(prisma);
    const nowMs = Date.now();
    const sessionId = `gateway-session-${randomUUID()}`;
    sessionIds.add(sessionId);
    const active = activateGatewaySession(
      openGatewaySession({
        sessionId,
        scope: {
          workspaceId: `workspace-${randomUUID()}`,
          repositoryConnectionId: `connection-${randomUUID()}`,
          scmRepositoryIdentityId: `repository-${randomUUID()}`,
          pullRequestNumber: 42,
        },
        sourceRevision: {
          baseSha: "a".repeat(40),
          mergeBaseSha: "b".repeat(40),
          headSha: "c".repeat(40),
          reviewRevisionHash: digest("revision"),
          checkoutTreeOid: "d".repeat(40),
        },
        sourceExecutionId: `execution-${randomUUID()}`,
        sourceWorkSlotId: "slot-1",
        attemptId: `attempt-${randomUUID()}`,
        openingIntentHash: digest("opening-intent"),
        sourceLeaseAuthorityKind: ContextLeaseAuthorityKind.StandardExecution,
        sourceLeaseId: `lease-${randomUUID()}`,
        sourceFencingToken: "1",
        providerKind: ContextProviderKind.Codex,
        requestedModel: "gpt-test",
        trustedCapabilityProfile: "context-gateway-v2",
        gatewayBinaryHash: digest("gateway"),
        gatewayPolicyVersion: "context-gateway-v2",
        producerReleaseId: "release-1",
        selectedProtocolVersion: "review-action-v2",
        confinementProofHash: digest("confinement"),
        eventChainSeedHash: digest("seed"),
        openedAtMs: nowMs,
        expiresAtMs: nowMs + 120_000,
      }),
      nowMs + 1,
    );
    await expect(store.openSession(active)).resolves.toMatchObject({
      status: ContextAttestationPersistenceStatus.Created,
    });

    const manifest = createContextDependencyManifest({
      manifestVersion: contextDependencyManifestVersion,
      gatewayPolicyVersion: active.gatewayPolicyVersion,
      gatewayBinaryHash: active.gatewayBinaryHash,
      checkoutTreeOid: active.sourceRevision.checkoutTreeOid,
      authenticatedChainHash: digest("event"),
      complete: true,
      dependencies: [
        {
          sequence: 1,
          previousEventHash: active.eventChainSeedHash,
          eventHash: digest("event"),
          operationKey: digest(
            '{"kind":"file_read","maxBytes":100,"path":"src/a.ts","startByte":0}',
          ),
          operation: {
            kind: ContextDependencyKind.FileRead,
            path: "src/a.ts",
            startByte: 0,
            maxBytes: 100,
          },
          result: {
            kind: ContextDependencyKind.FileRead,
            fileKind: ContextFileKind.Regular,
            mode: 0o100644,
            blobOid: "e".repeat(40),
            symlinkTargetHash: null,
            contentHash: digest("content"),
            byteCount: 10,
            eof: true,
            complete: true,
            truncated: false,
          },
        },
      ],
    });
    const sealed = sealGatewaySession(active, {
      eventCount: 1,
      sealedAtMs: nowMs + 2,
    });
    const replayMaterial = {
      sessionId,
      algorithm: "aes-256-gcm-v1" as const,
      keyId: "key-1",
      nonceBase64Url: Buffer.alloc(12, 1).toString("base64url"),
      authTagBase64Url: Buffer.alloc(16, 2).toString("base64url"),
      ciphertextBase64Url: Buffer.from("{}", "utf8").toString("base64url"),
      associatedDataHash: digest("aad"),
      plaintextHash: digest("plaintext"),
      byteCount: 2,
      expiresAtMs: nowMs + 100_000,
    };
    const candidate = (suffix: string) =>
      createAcceptedDependencyAttestation({
        attestationId: `attestation-${suffix}-${randomUUID()}`,
        attestationHash: digest(`attestation-${suffix}`),
        session: sealed,
        manifest,
        actualModel: "gpt-test",
        terminalOutcomeHash: digest("outcome"),
        replayMaterialHash: replayMaterial.plaintextHash,
        acceptedAtMs: nowMs + 3,
        reuseExpiresAtMs: nowMs + 60_000,
      });
    const first = candidate("first");
    const second = candidate("second");

    await expect(
      store.acceptAttestation({
        expectedSession: sealed,
        acceptedSession: first.session,
        attestation: first.attestation,
        replayMaterial: { ...replayMaterial, sessionId: "wrong-session" },
      }),
    ).resolves.toEqual({
      status: ContextAttestationPersistenceStatus.Conflict,
    });
    const results = await Promise.all([
      store.acceptAttestation({
        expectedSession: sealed,
        acceptedSession: first.session,
        attestation: first.attestation,
        replayMaterial,
      }),
      store.acceptAttestation({
        expectedSession: sealed,
        acceptedSession: second.session,
        attestation: second.attestation,
        replayMaterial: {
          ...replayMaterial,
          nonceBase64Url: Buffer.alloc(12, 3).toString("base64url"),
        },
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      ContextAttestationPersistenceStatus.Created,
      ContextAttestationPersistenceStatus.Idempotent,
    ]);
    const accepted = results.find(
      (result) => result.status === ContextAttestationPersistenceStatus.Created,
    );
    const idempotent = results.find(
      (result) =>
        result.status === ContextAttestationPersistenceStatus.Idempotent,
    );
    if (
      !accepted ||
      accepted.status !== ContextAttestationPersistenceStatus.Created ||
      !idempotent ||
      idempotent.status !== ContextAttestationPersistenceStatus.Idempotent
    ) {
      throw new Error("context_attestation_concurrency_result_missing");
    }
    expect(accepted.value.attestationId).toBe(idempotent.value.attestationId);

    const proof = {
      replayProofId: `proof-first-${randomUUID()}`,
      sourceAttestationId: accepted.value.attestationId,
      sourceAttestationHash: accepted.value.attestationHash,
      sourceOperationReceiptIdsHash: null,
      targetExecutionId: `target-execution-${randomUUID()}`,
      targetWorkSlotId: "target-slot",
      targetReviewRevisionHash: digest("target-revision"),
      targetCheckoutTreeOid: "f".repeat(40),
      replayBinaryHash: active.gatewayBinaryHash,
      replayPolicyVersion: active.gatewayPolicyVersion,
      reusePolicyVectorHash: digest("policy"),
      createdAtMs: nowMs + 4,
      expiresAtMs: nowMs + 5,
    };
    await expect(store.saveReplayProof(proof)).resolves.toMatchObject({
      status: ContextAttestationPersistenceStatus.Created,
    });
    const replacement = {
      ...proof,
      replayProofId: `proof-second-${randomUUID()}`,
      createdAtMs: nowMs + 5,
      expiresAtMs: nowMs + 10_000,
    };
    await expect(store.saveReplayProof(replacement)).resolves.toMatchObject({
      status: ContextAttestationPersistenceStatus.Created,
      value: { replayProofId: replacement.replayProofId },
    });
    await expect(
      store.findReplayProof(proof.replayProofId),
    ).resolves.toBeNull();
    await expect(
      store.findReplayProof(replacement.replayProofId),
    ).resolves.toMatchObject(replacement);
  });

  it("serializes accept against abandon with the same session lock", async () => {
    prisma ??= createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 6 });
    const store = new PrismaContextAttestationStore(prisma);
    const nowMs = Date.now();
    const active = createActiveSession(nowMs);
    sessionIds.add(active.sessionId);
    await store.openSession(active);
    const acceptance = acceptanceInput(active, nowMs);
    const terminalSession = revokeGatewaySession(active, nowMs + 4);

    const [acceptResult, abandonResult] = await Promise.all([
      store.acceptAttestation(acceptance),
      store.abandonSession({
        expectedSession: active,
        terminalSession,
      }),
    ]);
    const persisted = await store.findSession(active.sessionId);

    expect(
      [GatewaySessionState.Accepted, GatewaySessionState.Revoked].includes(
        persisted!.state,
      ),
    ).toBe(true);
    if (persisted!.state === GatewaySessionState.Accepted) {
      expect(acceptResult.status).toBe(
        ContextAttestationPersistenceStatus.Created,
      );
      expect(abandonResult).toMatchObject({
        status: ContextAttestationPersistenceStatus.Idempotent,
        value: { state: GatewaySessionState.Accepted },
      });
    } else {
      expect(abandonResult.status).toBe(
        ContextAttestationPersistenceStatus.Created,
      );
      expect(acceptResult.status).toBe(
        ContextAttestationPersistenceStatus.Conflict,
      );
      await expect(
        store.findAcceptedAttestationBySessionId(active.sessionId),
      ).resolves.toBeNull();
    }
  });

  it("makes concurrent abandon commands idempotent", async () => {
    prisma ??= createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 6 });
    const store = new PrismaContextAttestationStore(prisma);
    const nowMs = Date.now();
    const active = createActiveSession(nowMs);
    sessionIds.add(active.sessionId);
    await store.openSession(active);
    const terminalSession = revokeGatewaySession(active, nowMs + 2);

    const results = await Promise.all([
      store.abandonSession({ expectedSession: active, terminalSession }),
      store.abandonSession({ expectedSession: active, terminalSession }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      ContextAttestationPersistenceStatus.Created,
      ContextAttestationPersistenceStatus.Idempotent,
    ]);
    await expect(store.findSession(active.sessionId)).resolves.toMatchObject({
      state: GatewaySessionState.Revoked,
      revokedAtMs: nowMs + 2,
    });
  });
});

function createActiveSession(nowMs: number): GatewaySession {
  return activateGatewaySession(
    openGatewaySession({
      sessionId: `gateway-session-${randomUUID()}`,
      scope: {
        workspaceId: `workspace-${randomUUID()}`,
        repositoryConnectionId: `connection-${randomUUID()}`,
        scmRepositoryIdentityId: `repository-${randomUUID()}`,
        pullRequestNumber: 42,
      },
      sourceRevision: {
        baseSha: "a".repeat(40),
        mergeBaseSha: "b".repeat(40),
        headSha: "c".repeat(40),
        reviewRevisionHash: digest(`revision-${randomUUID()}`),
        checkoutTreeOid: "d".repeat(40),
      },
      sourceExecutionId: `execution-${randomUUID()}`,
      sourceWorkSlotId: "slot-1",
      attemptId: `attempt-${randomUUID()}`,
      openingIntentHash: digest(`opening-${randomUUID()}`),
      sourceLeaseAuthorityKind: ContextLeaseAuthorityKind.InvestigationShadow,
      sourceLeaseId: `lease-${randomUUID()}`,
      sourceFencingToken: "1",
      providerKind: ContextProviderKind.Codex,
      requestedModel: "gpt-test",
      trustedCapabilityProfile: "context-gateway-v2",
      gatewayBinaryHash: digest("gateway"),
      gatewayPolicyVersion: "context-gateway-v2",
      producerReleaseId: "release-1",
      selectedProtocolVersion: "review-action-v2",
      confinementProofHash: digest("confinement"),
      eventChainSeedHash: digest("seed"),
      openedAtMs: nowMs,
      expiresAtMs: nowMs + 120_000,
    }),
    nowMs + 1,
  );
}

function acceptanceInput(active: GatewaySession, nowMs: number) {
  const manifest = createContextDependencyManifest({
    manifestVersion: contextDependencyManifestVersion,
    gatewayPolicyVersion: active.gatewayPolicyVersion,
    gatewayBinaryHash: active.gatewayBinaryHash,
    checkoutTreeOid: active.sourceRevision.checkoutTreeOid,
    authenticatedChainHash: digest(`event-${active.sessionId}`),
    complete: true,
    dependencies: [
      {
        sequence: 1,
        previousEventHash: active.eventChainSeedHash,
        eventHash: digest(`event-${active.sessionId}`),
        operationKey: digest(
          '{"kind":"file_read","maxBytes":100,"path":"src/a.ts","startByte":0}',
        ),
        operation: {
          kind: ContextDependencyKind.FileRead,
          path: "src/a.ts",
          startByte: 0,
          maxBytes: 100,
        },
        result: {
          kind: ContextDependencyKind.FileRead,
          fileKind: ContextFileKind.Regular,
          mode: 0o100644,
          blobOid: "e".repeat(40),
          symlinkTargetHash: null,
          contentHash: digest("content"),
          byteCount: 10,
          eof: true,
          complete: true,
          truncated: false,
        },
      },
    ],
  });
  const sealed = sealGatewaySession(active, {
    eventCount: 1,
    sealedAtMs: nowMs + 2,
  });
  const replayMaterial = {
    sessionId: active.sessionId,
    algorithm: "aes-256-gcm-v1" as const,
    keyId: "key-1",
    nonceBase64Url: Buffer.alloc(12, 1).toString("base64url"),
    authTagBase64Url: Buffer.alloc(16, 2).toString("base64url"),
    ciphertextBase64Url: Buffer.from("{}", "utf8").toString("base64url"),
    associatedDataHash: digest("aad"),
    plaintextHash: digest("plaintext"),
    byteCount: 2,
    expiresAtMs: nowMs + 100_000,
  };
  const accepted = createAcceptedDependencyAttestation({
    attestationId: `attestation-${randomUUID()}`,
    attestationHash: digest(`attestation-${randomUUID()}`),
    session: sealed,
    manifest,
    actualModel: "gpt-test",
    terminalOutcomeHash: digest("outcome"),
    replayMaterialHash: replayMaterial.plaintextHash,
    acceptedAtMs: nowMs + 3,
    reuseExpiresAtMs: nowMs + 60_000,
  });
  return {
    expectedSession: sealed,
    acceptedSession: accepted.session,
    attestation: accepted.attestation,
    replayMaterial,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
