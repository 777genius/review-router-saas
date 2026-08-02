import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AcceptSealedContextAttestation,
  AcceptSealedContextAttestationStatus,
  AcceptedContextAttestationVerificationReason,
  AcceptedContextAttestationVerificationStatus,
  ContextDependencyKind,
  ContextFileKind,
  ContextGatewayV4OperationKind,
  ContextGatewayV4OutcomeKind,
  ContextProviderKind,
  InMemoryContextAttestationStore,
  OpenContextGatewaySession,
  OpenContextGatewaySessionStatus,
  ReplayContextAttestation,
  ReplayContextAttestationStatus,
  TargetReplayProofVerificationStatus,
  VerifyAcceptedContextAttestation,
  VerifyTargetReplayProof,
  contextDependencyManifestVersion,
  contextGatewayV4ManifestVersion,
  contextGatewayV4PolicyVersion,
  createContextGatewayV4Manifest,
  createContextDependencyManifest,
  type ContextAttestationRevision,
  type ContextDependencyManifest,
  type ContextAttestationIdentityPort,
} from "../index";

const hash = (value: string) => value.repeat(64);
const oid = (value: string) => value.repeat(40);

describe("context attestation application flow", () => {
  it("accepts only trusted sealed context and replays it for a target revision", async () => {
    let nowMs = 1_000;
    const store = new InMemoryContextAttestationStore();
    const identities = sequentialIdentities();
    const sourceRevision = revision("a", "d");
    const sourceManifest = manifest(sourceRevision.checkoutTreeOid, hash("b"));
    const openingFacts = {
      scope: {
        workspaceId: "workspace-1",
        repositoryConnectionId: "connection-1",
        scmRepositoryIdentityId: "repository-1",
        pullRequestNumber: 42,
      },
      sourceRevision,
      sourceExecutionId: "execution-source",
      sourceWorkSlotId: "slot-source",
      attemptId: "attempt-1",
      sourceLeaseId: "lease-1",
      sourceFencingToken: "1",
      providerKind: ContextProviderKind.Codex,
      requestedModel: "gpt-5.3-codex",
      trustedCapabilityProfile: "context-gateway-v2",
      gatewayBinaryHash: hash("c"),
      gatewayPolicyVersion: "context-gateway-v2",
      producerReleaseId: "release-1",
      selectedProtocolVersion: "review-action-v2",
      confinementProofHash: hash("e"),
      eventChainSeedHash: hash("0"),
      sessionLifetimeMs: 60_000,
    };
    const open = new OpenContextGatewaySession({
      openingFacts: {
        resolveOpeningFacts: async () => openingFacts,
      },
      store,
      identities,
      clock: { nowMs: () => nowMs },
    });

    const opened = await open.execute({
      attemptId: "attempt-1",
      leaseCapabilityId: "lease-capability-1",
      confinementEvidenceId: "confinement-1",
    });
    expect(opened.status).toBe(OpenContextGatewaySessionStatus.Opened);
    expect(opened.session).not.toBeNull();

    nowMs = 2_000;
    const accept = new AcceptSealedContextAttestation({
      transcripts: {
        loadSealedTranscript: async ({ sessionId }) => ({
          sessionId,
          confinementProofHash: hash("e"),
          manifest: sourceManifest,
          actualModel: "gpt-5.3-codex",
          terminalOutcomeHash: hash("f"),
          providerSucceeded: true,
          schemaValidated: true,
          fullyConsumed: true,
          replayMaterial: encryptedReplayMaterial(sessionId),
        }),
      },
      store,
      identities,
      digest: {
        digest: async (bytes) =>
          createHash("sha256").update(bytes).digest("hex"),
      },
      clock: { nowMs: () => nowMs },
      reuseTtlMs: 30_000,
    });
    const [accepted, concurrent] = await Promise.all([
      accept.execute({
        sessionId: opened.session!.sessionId,
        sealCapabilityId: "seal-capability-1",
      }),
      accept.execute({
        sessionId: opened.session!.sessionId,
        sealCapabilityId: "seal-capability-1",
      }),
    ]);
    expect([accepted.status, concurrent.status].sort()).toEqual([
      AcceptSealedContextAttestationStatus.Accepted,
      AcceptSealedContextAttestationStatus.Idempotent,
    ]);
    expect(concurrent.attestation?.attestationId).toBe(
      accepted.attestation?.attestationId,
    );
    expect(
      (
        await accept.execute({
          sessionId: opened.session!.sessionId,
          sealCapabilityId: "seal-capability-1",
        })
      ).status,
    ).toBe(AcceptSealedContextAttestationStatus.Idempotent);

    const verify = new VerifyAcceptedContextAttestation({
      store,
      clock: { nowMs: () => nowMs },
    });
    await expect(
      verify.execute({
        attestationId: accepted.attestation!.attestationId,
        attestationHash: accepted.attestation!.attestationHash,
        sourceExecutionId: "execution-source",
        sourceWorkSlotId: "slot-source",
        attemptId: "attempt-1",
        sourceLeaseId: "lease-1",
        sourceFencingToken: "1",
        sourceReviewRevisionHash: sourceRevision.reviewRevisionHash,
        trustedCapabilityProfile: "context-gateway-v2",
        actualModel: "gpt-5.3-codex",
        terminalOutcomeHash: hash("f"),
      }),
    ).resolves.toMatchObject({
      status: AcceptedContextAttestationVerificationStatus.Accepted,
    });
    await expect(
      verify.execute({
        attestationId: accepted.attestation!.attestationId,
        attestationHash: accepted.attestation!.attestationHash,
        sourceExecutionId: "execution-source",
        sourceWorkSlotId: "slot-source",
        attemptId: "attempt-1",
        sourceLeaseId: "lease-1",
        sourceFencingToken: "1",
        sourceReviewRevisionHash: sourceRevision.reviewRevisionHash,
        trustedCapabilityProfile: "context-gateway-v2",
        actualModel: "gpt-5.3-codex",
        terminalOutcomeHash: hash("0"),
      }),
    ).resolves.toMatchObject({
      status: AcceptedContextAttestationVerificationStatus.Denied,
      reason:
        AcceptedContextAttestationVerificationReason.TerminalOutcomeMismatch,
    });

    const targetRevision = revision("b", "e");
    const replay = new ReplayContextAttestation({
      store,
      targetFacts: {
        resolveTargetReplayFacts: async () => ({
          targetExecutionId: "execution-target",
          targetWorkSlotId: "slot-target",
          targetRevision,
          replayBinaryHash: hash("c"),
          replayPolicyVersion: "context-gateway-v2",
          reusePolicyVectorHash: hash("a"),
          proofLifetimeMs: 60_000,
        }),
      },
      identities,
      clock: { nowMs: () => nowMs },
    });
    const replayed = await replay.execute({
      sourceAttestationId: accepted.attestation!.attestationId,
      sourceAttestationHash: accepted.attestation!.attestationHash,
      targetExecutionId: "execution-target",
      targetWorkSlotId: "slot-target",
      replayCapabilityId: "replay-capability",
      replayedManifest: manifest(targetRevision.checkoutTreeOid, hash("b")),
    });
    expect(replayed.status).toBe(ReplayContextAttestationStatus.Accepted);
    expect(replayed.proof).toMatchObject({
      targetReviewRevisionHash: targetRevision.reviewRevisionHash,
      sourceAttestationHash: accepted.attestation!.attestationHash,
      reusePolicyVectorHash: hash("a"),
      expiresAtMs: 32_000,
    });
    await expect(
      replay.execute({
        sourceAttestationId: accepted.attestation!.attestationId,
        sourceAttestationHash: accepted.attestation!.attestationHash,
        targetExecutionId: "execution-target",
        targetWorkSlotId: "slot-target",
        replayCapabilityId: "replay-capability",
        replayedManifest: manifest(targetRevision.checkoutTreeOid, hash("b")),
      }),
    ).resolves.toMatchObject({
      status: ReplayContextAttestationStatus.Idempotent,
      proof: {
        replayProofId: replayed.proof!.replayProofId,
      },
    });
    const proofVerifier = new VerifyTargetReplayProof({
      store,
      clock: { nowMs: () => nowMs },
    });
    nowMs = 32_000;
    await expect(
      proofVerifier.execute({
        replayProofId: replayed.proof!.replayProofId,
        sourceAttestationId: accepted.attestation!.attestationId,
        sourceAttestationHash: accepted.attestation!.attestationHash,
        targetExecutionId: "execution-target",
        targetWorkSlotId: "slot-target",
        targetReviewRevisionHash: targetRevision.reviewRevisionHash,
        targetCheckoutTreeOid: targetRevision.checkoutTreeOid,
        replayBinaryHash: hash("c"),
        replayPolicyVersion: "context-gateway-v2",
        reusePolicyVectorHash: hash("a"),
      }),
    ).resolves.toMatchObject({
      status: TargetReplayProofVerificationStatus.Denied,
    });
  });

  it("accepts a complete v4 event manifest and keeps v4 replay disabled", async () => {
    let nowMs = 1_000;
    const store = new InMemoryContextAttestationStore();
    const identities = sequentialIdentities();
    const sourceRevision = revision("a", "d");
    const openingFacts = {
      scope: {
        workspaceId: "workspace-v4",
        repositoryConnectionId: "connection-v4",
        scmRepositoryIdentityId: "repository-v4",
        pullRequestNumber: 43,
      },
      sourceRevision,
      sourceExecutionId: "execution-v4",
      sourceWorkSlotId: "slot-v4",
      attemptId: "attempt-v4",
      sourceLeaseId: "lease-v4",
      sourceFencingToken: "2",
      providerKind: ContextProviderKind.Codex,
      requestedModel: "gpt-5.3-codex",
      trustedCapabilityProfile: "investigation-gateway-v4",
      gatewayBinaryHash: hash("c"),
      gatewayPolicyVersion: contextGatewayV4PolicyVersion,
      producerReleaseId: "release-v4",
      selectedProtocolVersion: "review-action-v2",
      confinementProofHash: hash("e"),
      eventChainSeedHash: hash("0"),
      sessionLifetimeMs: 60_000,
    };
    const open = new OpenContextGatewaySession({
      openingFacts: { resolveOpeningFacts: async () => openingFacts },
      store,
      identities,
      clock: { nowMs: () => nowMs },
    });
    const opened = await open.execute({
      attemptId: openingFacts.attemptId,
      leaseCapabilityId: "lease-capability-v4",
      confinementEvidenceId: "confinement-v4",
    });
    expect(opened.status).toBe(OpenContextGatewaySessionStatus.Opened);
    const eventHash = hash("7");
    const v4Manifest = createContextGatewayV4Manifest({
      manifestVersion: contextGatewayV4ManifestVersion,
      gatewayPolicyVersion: contextGatewayV4PolicyVersion,
      gatewayBinaryHash: openingFacts.gatewayBinaryHash,
      checkoutTreeOid: sourceRevision.checkoutTreeOid,
      eventChainSeedHash: openingFacts.eventChainSeedHash,
      authenticatedChainHash: eventHash,
      complete: true,
      confinementTainted: false,
      terminalFailureClass: null,
      events: [
        {
          sequence: 1,
          previousEventHash: openingFacts.eventChainSeedHash,
          eventHash,
          operationKey: hash("8"),
          operationKind: ContextGatewayV4OperationKind.GitFact,
          outcome: ContextGatewayV4OutcomeKind.Succeeded,
          failureClass: null,
          operation: {
            kind: ContextGatewayV4OperationKind.GitFact,
            fact: "merge_base",
          },
          result: {
            complete: true,
            fact: "merge_base",
            itemCount: 1,
            resultHash: hash("9"),
          },
          operationReceiptId: hash("a"),
          sanitizedReason: null,
        },
      ],
    });
    nowMs = 2_000;
    const accept = new AcceptSealedContextAttestation({
      transcripts: {
        loadSealedTranscript: async ({ sessionId }) => ({
          sessionId,
          confinementProofHash: openingFacts.confinementProofHash,
          manifest: v4Manifest,
          actualModel: "gpt-5.3-codex",
          terminalOutcomeHash: hash("f"),
          providerSucceeded: true,
          schemaValidated: true,
          fullyConsumed: true,
          replayMaterial: encryptedReplayMaterial(sessionId),
        }),
      },
      store,
      identities,
      digest: {
        digest: async (bytes) =>
          createHash("sha256").update(bytes).digest("hex"),
      },
      clock: { nowMs: () => nowMs },
      reuseTtlMs: 30_000,
    });
    const accepted = await accept.execute({
      sessionId: opened.session!.sessionId,
      sealCapabilityId: "seal-v4",
    });
    expect(accepted.status).toBe(AcceptSealedContextAttestationStatus.Accepted);
    expect(accepted.attestation?.manifest.manifestVersion).toBe(3);

    const replay = new ReplayContextAttestation({
      store,
      targetFacts: {
        resolveTargetReplayFacts: async () => ({
          targetExecutionId: "execution-target-v4",
          targetWorkSlotId: "slot-target-v4",
          targetRevision: revision("b", "e"),
          replayBinaryHash: hash("c"),
          replayPolicyVersion: contextGatewayV4PolicyVersion,
          reusePolicyVectorHash: hash("b"),
          proofLifetimeMs: 60_000,
        }),
      },
      identities,
      clock: { nowMs: () => nowMs },
    });
    const replayed = await replay.execute({
      sourceAttestationId: accepted.attestation!.attestationId,
      sourceAttestationHash: accepted.attestation!.attestationHash,
      targetExecutionId: "execution-target-v4",
      targetWorkSlotId: "slot-target-v4",
      replayCapabilityId: "replay-v4",
      replayedManifest: manifest(revision("b", "e").checkoutTreeOid, hash("b")),
    });
    expect(replayed.status).toBe(ReplayContextAttestationStatus.Denied);
  });

  it("denies replay when a dependency result changed", async () => {
    const store = new InMemoryContextAttestationStore();
    const identities = sequentialIdentities();
    const sourceRevision = revision("a", "d");
    let nowMs = 1_000;
    const open = new OpenContextGatewaySession({
      openingFacts: {
        resolveOpeningFacts: async () => ({
          scope: {
            workspaceId: "workspace-1",
            repositoryConnectionId: "connection-1",
            scmRepositoryIdentityId: "repository-1",
            pullRequestNumber: 42,
          },
          sourceRevision,
          sourceExecutionId: "execution-source",
          sourceWorkSlotId: "slot-source",
          attemptId: "attempt-1",
          sourceLeaseId: "lease-1",
          sourceFencingToken: "1",
          providerKind: ContextProviderKind.Codex,
          requestedModel: "gpt-5.3-codex",
          trustedCapabilityProfile: "context-gateway-v2",
          gatewayBinaryHash: hash("c"),
          gatewayPolicyVersion: "context-gateway-v2",
          producerReleaseId: "release-1",
          selectedProtocolVersion: "review-action-v2",
          confinementProofHash: hash("e"),
          eventChainSeedHash: hash("0"),
          sessionLifetimeMs: 60_000,
        }),
      },
      store,
      identities,
      clock: { nowMs: () => nowMs },
    });
    const opened = await open.execute({
      attemptId: "attempt-1",
      leaseCapabilityId: "lease-capability-1",
      confinementEvidenceId: "confinement-1",
    });
    nowMs = 2_000;
    const accept = new AcceptSealedContextAttestation({
      transcripts: {
        loadSealedTranscript: async ({ sessionId }) => ({
          sessionId,
          confinementProofHash: hash("e"),
          manifest: manifest(sourceRevision.checkoutTreeOid, hash("b")),
          actualModel: "gpt-5.3-codex",
          terminalOutcomeHash: hash("f"),
          providerSucceeded: true,
          schemaValidated: true,
          fullyConsumed: true,
          replayMaterial: encryptedReplayMaterial(sessionId),
        }),
      },
      store,
      identities,
      digest: {
        digest: async (bytes) =>
          createHash("sha256").update(bytes).digest("hex"),
      },
      clock: { nowMs: () => nowMs },
      reuseTtlMs: 30_000,
    });
    const accepted = await accept.execute({
      sessionId: opened.session!.sessionId,
      sealCapabilityId: "seal-capability-1",
    });
    const targetRevision = revision("b", "e");
    const replay = new ReplayContextAttestation({
      store,
      targetFacts: {
        resolveTargetReplayFacts: async () => ({
          targetExecutionId: "execution-target",
          targetWorkSlotId: "slot-target",
          targetRevision,
          replayBinaryHash: hash("c"),
          replayPolicyVersion: "context-gateway-v2",
          reusePolicyVectorHash: hash("a"),
          proofLifetimeMs: 10_000,
        }),
      },
      identities,
      clock: { nowMs: () => nowMs },
    });

    expect(
      (
        await replay.execute({
          sourceAttestationId: accepted.attestation!.attestationId,
          sourceAttestationHash: accepted.attestation!.attestationHash,
          targetExecutionId: "execution-target",
          targetWorkSlotId: "slot-target",
          replayCapabilityId: "replay-capability",
          replayedManifest: manifest(targetRevision.checkoutTreeOid, hash("9")),
        })
      ).status,
    ).toBe(ReplayContextAttestationStatus.Denied);
  });

  it("replaces an expired replay proof for the same target identity", async () => {
    const store = new InMemoryContextAttestationStore();
    const original = {
      replayProofId: "replay-proof-1",
      sourceAttestationId: "attestation-1",
      sourceAttestationHash: hash("a"),
      targetExecutionId: "execution-target",
      targetWorkSlotId: "slot-target",
      targetReviewRevisionHash: hash("b"),
      targetCheckoutTreeOid: oid("c"),
      replayBinaryHash: hash("d"),
      replayPolicyVersion: "context-gateway-v2",
      reusePolicyVectorHash: hash("e"),
      createdAtMs: 1_000,
      expiresAtMs: 2_000,
    };
    await expect(store.saveReplayProof(original)).resolves.toMatchObject({
      status: "created",
    });
    const replacement = {
      ...original,
      replayProofId: "replay-proof-2",
      createdAtMs: 2_000,
      expiresAtMs: 3_000,
    };

    await expect(store.saveReplayProof(replacement)).resolves.toMatchObject({
      status: "created",
      value: { replayProofId: "replay-proof-2" },
    });
    await expect(store.findReplayProof("replay-proof-1")).resolves.toBeNull();
    await expect(store.findReplayProof("replay-proof-2")).resolves.toEqual(
      replacement,
    );
  });
});

function revision(
  revisionHashCharacter: string,
  treeCharacter: string,
): ContextAttestationRevision {
  return {
    baseSha: oid("a"),
    mergeBaseSha: oid("b"),
    headSha: oid("c"),
    reviewRevisionHash: hash(revisionHashCharacter),
    checkoutTreeOid: oid(treeCharacter),
  };
}

function manifest(
  checkoutTreeOid: string,
  contentHash: string,
): ContextDependencyManifest {
  return createContextDependencyManifest({
    manifestVersion: contextDependencyManifestVersion,
    gatewayPolicyVersion: "context-gateway-v2",
    gatewayBinaryHash: hash("c"),
    checkoutTreeOid,
    authenticatedChainHash: hash("d"),
    complete: true,
    dependencies: [
      {
        sequence: 1,
        previousEventHash: hash("0"),
        eventHash: hash("1"),
        operationKey: hash("a"),
        operation: {
          kind: ContextDependencyKind.FileRead,
          path: "src/a.ts",
          startByte: 0,
          maxBytes: 64_000,
        },
        result: {
          kind: ContextDependencyKind.FileRead,
          fileKind: ContextFileKind.Regular,
          mode: 0o100644,
          blobOid: oid("b"),
          symlinkTargetHash: null,
          contentHash,
          byteCount: 120,
          eof: true,
          complete: true,
          truncated: false,
        },
      },
    ],
  });
}

function sequentialIdentities(): ContextAttestationIdentityPort {
  let session = 0;
  let attestation = 0;
  let replay = 0;
  return {
    nextGatewaySessionId: () => `gateway-session-${++session}`,
    nextAttestationId: () => `attestation-${++attestation}`,
    nextReplayProofId: () => `replay-proof-${++replay}`,
  };
}

function encryptedReplayMaterial(sessionId: string) {
  const plaintext = Buffer.from('{"entries":[]}', "utf8");
  return {
    sessionId,
    algorithm: "aes-256-gcm-v1" as const,
    keyId: "key-1",
    nonceBase64Url: Buffer.alloc(12, 1).toString("base64url"),
    authTagBase64Url: Buffer.alloc(16, 2).toString("base64url"),
    ciphertextBase64Url: plaintext.toString("base64url"),
    associatedDataHash: hash("a"),
    plaintextHash: createHash("sha256").update(plaintext).digest("hex"),
    byteCount: plaintext.byteLength,
    expiresAtMs: 60_000,
  };
}
