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
  ContextProviderKind,
  activateGatewaySession,
  openGatewaySession,
  sealGatewaySession,
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
    prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 6 });
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
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
