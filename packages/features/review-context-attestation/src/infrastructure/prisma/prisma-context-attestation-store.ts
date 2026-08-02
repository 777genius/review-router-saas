import {
  Prisma,
  ProviderExecutionProfileV2 as PrismaExecutionProfile,
  ReviewContextGatewaySessionStateV1 as PrismaGatewaySessionState,
  ReviewProviderKindV2 as PrismaProviderKind,
  type PrismaClient,
} from "@prisma/client";
import {
  ContextAttestationPersistenceStatus,
  type ContextAttestationPersistenceResult,
  type ContextAttestationStorePort,
} from "../../application/ports/context-attestation-ports";
import {
  createAcceptedDependencyAttestation,
  type AcceptedDependencyAttestation,
} from "../../domain/accepted-dependency-attestation";
import {
  canonicalContextAttestationManifest,
  contextAttestationManifestEventCount,
  createContextAttestationManifest,
  type ContextAttestationManifest,
} from "../../domain/context-attestation-manifest";
import {
  contextReplayMaterialEncryptionAlgorithm,
  createEncryptedContextReplayMaterial,
  type EncryptedContextReplayMaterial,
} from "../../domain/encrypted-context-replay-material";
import {
  ContextProviderKind,
  GatewaySessionState,
  openGatewaySession,
  type GatewaySession,
} from "../../domain/gateway-session";
import {
  createTargetReplayProof,
  type TargetReplayProof,
} from "../../domain/target-replay-proof";
import {
  ContextDependencyReplayDenialReason,
  ContextDependencyReplayStatus,
} from "../../domain/context-replay-decision";

type AttestationWithSession =
  Prisma.ReviewContextDependencyAttestationGetPayload<{
    include: { session: true; replayMaterial: true };
  }>;

export class PrismaContextAttestationStore implements ContextAttestationStorePort {
  constructor(private readonly prisma: PrismaClient) {}

  async openSession(
    session: GatewaySession,
  ): Promise<ContextAttestationPersistenceResult<GatewaySession>> {
    try {
      const record = await this.prisma.reviewContextGatewaySession.create({
        data: toSessionCreateInput(session),
      });
      return persisted(
        ContextAttestationPersistenceStatus.Created,
        toGatewaySession(record),
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.prisma.reviewContextGatewaySession.findFirst({
        where: {
          OR: [
            { sessionId: session.sessionId },
            { attemptId: session.attemptId },
          ],
        },
        orderBy: { sessionId: "asc" },
      });
      if (!existing) {
        throw new Error("gateway_session_unique_conflict_missing", {
          cause: error,
        });
      }
      const domain = toGatewaySession(existing);
      return sameOpening(domain, session)
        ? persisted(ContextAttestationPersistenceStatus.Idempotent, domain)
        : conflict();
    }
  }

  async findSession(sessionId: string): Promise<GatewaySession | null> {
    const record = await this.prisma.reviewContextGatewaySession.findUnique({
      where: { sessionId },
    });
    return record ? toGatewaySession(record) : null;
  }

  async acceptAttestation(input: {
    readonly expectedSession: GatewaySession;
    readonly acceptedSession: GatewaySession;
    readonly attestation: AcceptedDependencyAttestation;
    readonly replayMaterial: EncryptedContextReplayMaterial;
  }): Promise<
    ContextAttestationPersistenceResult<AcceptedDependencyAttestation>
  > {
    if (!validAcceptanceAggregate(input)) return conflict();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            await lockContextAttestationSession(
              transaction,
              input.expectedSession.sessionId,
            );
            const existing =
              await transaction.reviewContextDependencyAttestation.findUnique({
                where: { sessionId: input.expectedSession.sessionId },
                include: { session: true, replayMaterial: true },
              });
            if (existing) {
              const domain = toAcceptedAttestation(existing);
              return sameAttestationIntent(domain, input.attestation)
                ? persisted(
                    ContextAttestationPersistenceStatus.Idempotent,
                    domain,
                  )
                : conflict();
            }
            const updated =
              await transaction.reviewContextGatewaySession.updateMany({
                where: {
                  sessionId: input.expectedSession.sessionId,
                  attemptId: input.expectedSession.attemptId,
                  sourceLeaseId: input.expectedSession.sourceLeaseId,
                  sourceFencingToken: BigInt(
                    input.expectedSession.sourceFencingToken,
                  ),
                  state: PrismaGatewaySessionState.active,
                  expiresAt: { gt: new Date(input.attestation.acceptedAtMs) },
                },
                data: {
                  state: PrismaGatewaySessionState.accepted,
                  eventCount: input.expectedSession.eventCount,
                  sealedAt:
                    input.expectedSession.sealedAtMs === null
                      ? null
                      : new Date(input.expectedSession.sealedAtMs),
                },
              });
            if (updated.count !== 1) {
              throw new ContextAttestationWriteRaceError();
            }
            const created =
              await transaction.reviewContextDependencyAttestation.create({
                data: toAttestationCreateInput(input.attestation),
                select: { attestationId: true },
              });
            await transaction.reviewContextReplayMaterial.create({
              data: toReplayMaterialCreateInput(
                input.attestation.attestationId,
                input.replayMaterial,
              ),
            });
            const completed =
              await transaction.reviewContextDependencyAttestation.findUniqueOrThrow(
                {
                  where: { attestationId: created.attestationId },
                  include: { session: true, replayMaterial: true },
                },
              );
            return persisted(
              ContextAttestationPersistenceStatus.Created,
              toAcceptedAttestation(completed),
            );
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        );
      } catch (error) {
        if (!isRetryableWriteConflict(error)) throw error;
      }
      const existing = await this.findAcceptedAttestationBySessionId(
        input.expectedSession.sessionId,
      );
      if (existing) {
        return sameAttestationIntent(existing, input.attestation)
          ? persisted(ContextAttestationPersistenceStatus.Idempotent, existing)
          : conflict();
      }
      if (attempt === 2) return conflict();
    }
    return conflict();
  }

  async findAcceptedAttestation(
    attestationId: string,
  ): Promise<AcceptedDependencyAttestation | null> {
    const record =
      await this.prisma.reviewContextDependencyAttestation.findUnique({
        where: { attestationId },
        include: { session: true, replayMaterial: true },
      });
    return record ? toAcceptedAttestation(record) : null;
  }

  async findAcceptedAttestationBySessionId(
    sessionId: string,
  ): Promise<AcceptedDependencyAttestation | null> {
    const record =
      await this.prisma.reviewContextDependencyAttestation.findUnique({
        where: { sessionId },
        include: { session: true, replayMaterial: true },
      });
    return record ? toAcceptedAttestation(record) : null;
  }

  async findReplayMaterialByAttestationId(
    attestationId: string,
  ): Promise<EncryptedContextReplayMaterial | null> {
    const record = await this.prisma.reviewContextReplayMaterial.findUnique({
      where: { attestationId },
    });
    return record ? toReplayMaterial(record) : null;
  }

  async saveReplayProof(
    proof: TargetReplayProof,
  ): Promise<ContextAttestationPersistenceResult<TargetReplayProof>> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await lockContextReplayTarget(transaction, proof);
          const existing =
            await transaction.reviewContextTargetReplayProof.findFirst({
              where: replayProofTargetWhere(proof),
            });
          if (existing) {
            const domain = toReplayProof(existing);
            if (existing.expiresAt.getTime() > proof.createdAtMs) {
              return sameReplayProof(domain, proof)
                ? persisted(
                    ContextAttestationPersistenceStatus.Idempotent,
                    domain,
                  )
                : conflict();
            }
            await transaction.reviewContextTargetReplayProof.delete({
              where: { replayProofId: existing.replayProofId },
            });
          }
          const record =
            await transaction.reviewContextTargetReplayProof.create({
              data: toReplayProofCreateInput(proof),
            });
          return persisted(
            ContextAttestationPersistenceStatus.Created,
            toReplayProof(record),
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (!isRetryableWriteConflict(error)) throw error;
      const existing =
        await this.prisma.reviewContextTargetReplayProof.findFirst({
          where: {
            OR: [
              { replayProofId: proof.replayProofId },
              {
                sourceAttestationId: proof.sourceAttestationId,
                targetExecutionId: proof.targetExecutionId,
                targetWorkSlotId: proof.targetWorkSlotId,
                targetReviewRevisionHash: proof.targetReviewRevisionHash,
                reusePolicyVectorHash: proof.reusePolicyVectorHash,
              },
            ],
          },
          orderBy: { replayProofId: "asc" },
        });
      if (!existing) {
        throw new Error("target_replay_unique_conflict_missing", {
          cause: error,
        });
      }
      const domain = toReplayProof(existing);
      if (existing.expiresAt.getTime() <= proof.createdAtMs) {
        return conflict();
      }
      return sameReplayProof(domain, proof)
        ? persisted(ContextAttestationPersistenceStatus.Idempotent, domain)
        : conflict();
    }
  }

  async findReplayProof(
    replayProofId: string,
  ): Promise<TargetReplayProof | null> {
    const record = await this.prisma.reviewContextTargetReplayProof.findUnique({
      where: { replayProofId },
    });
    return record ? toReplayProof(record) : null;
  }
}

function sameReplayProof(
  left: TargetReplayProof,
  right: TargetReplayProof,
): boolean {
  return (
    left.sourceAttestationId === right.sourceAttestationId &&
    left.sourceAttestationHash === right.sourceAttestationHash &&
    left.targetExecutionId === right.targetExecutionId &&
    left.targetWorkSlotId === right.targetWorkSlotId &&
    left.targetReviewRevisionHash === right.targetReviewRevisionHash &&
    left.targetCheckoutTreeOid === right.targetCheckoutTreeOid &&
    left.replayBinaryHash === right.replayBinaryHash &&
    left.replayPolicyVersion === right.replayPolicyVersion &&
    left.reusePolicyVectorHash === right.reusePolicyVectorHash
  );
}

function toSessionCreateInput(
  session: GatewaySession,
): Prisma.ReviewContextGatewaySessionUncheckedCreateInput {
  return {
    sessionId: session.sessionId,
    workspaceId: session.scope.workspaceId,
    repositoryConnectionId: session.scope.repositoryConnectionId,
    scmRepositoryIdentityId: session.scope.scmRepositoryIdentityId,
    pullRequestNumber: session.scope.pullRequestNumber,
    sourceBaseSha: session.sourceRevision.baseSha,
    sourceMergeBaseSha: session.sourceRevision.mergeBaseSha,
    sourceHeadSha: session.sourceRevision.headSha,
    sourceReviewRevisionHash: session.sourceRevision.reviewRevisionHash,
    checkoutTreeOid: session.sourceRevision.checkoutTreeOid,
    sourceExecutionId: session.sourceExecutionId,
    sourceWorkSlotId: session.sourceWorkSlotId,
    attemptId: session.attemptId,
    sourceLeaseId: session.sourceLeaseId,
    sourceFencingToken: BigInt(session.sourceFencingToken),
    providerKind: toPrismaProviderKind(session.providerKind),
    requestedModel: session.requestedModel,
    trustedCapabilityProfile: session.trustedCapabilityProfile,
    executionProfile: PrismaExecutionProfile.context_gateway_v1,
    gatewayBinaryHash: session.gatewayBinaryHash,
    gatewayPolicyVersion: session.gatewayPolicyVersion,
    producerReleaseId: session.producerReleaseId,
    selectedProtocolVersion: session.selectedProtocolVersion,
    confinementProofHash: session.confinementProofHash,
    eventChainSeedHash: session.eventChainSeedHash,
    state: toPrismaSessionState(session.state),
    eventCount: session.eventCount,
    openedAt: new Date(session.openedAtMs),
    expiresAt: new Date(session.expiresAtMs),
    sealedAt: session.sealedAtMs === null ? null : new Date(session.sealedAtMs),
    revokedAt:
      session.revokedAtMs === null ? null : new Date(session.revokedAtMs),
  };
}

function toAttestationCreateInput(
  attestation: AcceptedDependencyAttestation,
): Prisma.ReviewContextDependencyAttestationUncheckedCreateInput {
  return {
    attestationId: attestation.attestationId,
    sessionId: attestation.sessionId,
    attestationHash: attestation.attestationHash,
    manifestVersion: attestation.manifest.manifestVersion,
    authenticatedChainHash: attestation.manifest.authenticatedChainHash,
    dependencyCount: contextAttestationManifestEventCount(attestation.manifest),
    operationManifestJson: toJson(attestation.manifest),
    actualModel: attestation.actualModel,
    terminalOutcomeHash: attestation.terminalOutcomeHash,
    replayMaterialHash: attestation.replayMaterialHash,
    acceptedAt: new Date(attestation.acceptedAtMs),
    reuseExpiresAt: new Date(attestation.reuseExpiresAtMs),
  };
}

function toReplayMaterialCreateInput(
  attestationId: string,
  material: EncryptedContextReplayMaterial,
): Prisma.ReviewContextReplayMaterialUncheckedCreateInput {
  const normalized = createEncryptedContextReplayMaterial(material);
  return {
    replayMaterialId: `context-replay:${attestationId}`,
    sessionId: normalized.sessionId,
    attestationId,
    encryptionAlgorithm: normalized.algorithm,
    encryptionKeyId: normalized.keyId,
    nonce: Buffer.from(normalized.nonceBase64Url, "base64url"),
    authTag: Buffer.from(normalized.authTagBase64Url, "base64url"),
    ciphertext: Buffer.from(normalized.ciphertextBase64Url, "base64url"),
    associatedDataHash: normalized.associatedDataHash,
    plaintextHash: normalized.plaintextHash,
    byteCount: normalized.byteCount,
    expiresAt: new Date(normalized.expiresAtMs),
  };
}

function toReplayProofCreateInput(
  proof: TargetReplayProof,
): Prisma.ReviewContextTargetReplayProofUncheckedCreateInput {
  return {
    replayProofId: proof.replayProofId,
    sourceAttestationId: proof.sourceAttestationId,
    sourceAttestationHash: proof.sourceAttestationHash,
    targetExecutionId: proof.targetExecutionId,
    targetWorkSlotId: proof.targetWorkSlotId,
    targetReviewRevisionHash: proof.targetReviewRevisionHash,
    targetCheckoutTreeOid: proof.targetCheckoutTreeOid,
    replayBinaryHash: proof.replayBinaryHash,
    replayPolicyVersion: proof.replayPolicyVersion,
    reusePolicyVectorHash: proof.reusePolicyVectorHash,
    createdAt: new Date(proof.createdAtMs),
    expiresAt: new Date(proof.expiresAtMs),
  };
}

function replayProofTargetWhere(
  proof: TargetReplayProof,
): Prisma.ReviewContextTargetReplayProofWhereInput {
  return {
    sourceAttestationId: proof.sourceAttestationId,
    targetExecutionId: proof.targetExecutionId,
    targetWorkSlotId: proof.targetWorkSlotId,
    targetReviewRevisionHash: proof.targetReviewRevisionHash,
    reusePolicyVectorHash: proof.reusePolicyVectorHash,
  };
}

async function lockContextAttestationSession(
  transaction: Prisma.TransactionClient,
  sessionId: string,
): Promise<void> {
  await transaction.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`review-context-session:${sessionId}`}, 0))`,
  );
}

async function lockContextReplayTarget(
  transaction: Prisma.TransactionClient,
  proof: TargetReplayProof,
): Promise<void> {
  const identity = JSON.stringify([
    proof.sourceAttestationId,
    proof.targetExecutionId,
    proof.targetWorkSlotId,
    proof.targetReviewRevisionHash,
    proof.reusePolicyVectorHash,
  ]);
  await transaction.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`review-context-replay:${identity}`}, 0))`,
  );
}

function toGatewaySession(
  record: Prisma.ReviewContextGatewaySessionGetPayload<object>,
): GatewaySession {
  const opened = openGatewaySession({
    sessionId: record.sessionId,
    scope: {
      workspaceId: record.workspaceId,
      repositoryConnectionId: record.repositoryConnectionId,
      scmRepositoryIdentityId: record.scmRepositoryIdentityId,
      pullRequestNumber: record.pullRequestNumber,
    },
    sourceRevision: {
      baseSha: record.sourceBaseSha,
      mergeBaseSha: record.sourceMergeBaseSha,
      headSha: record.sourceHeadSha,
      reviewRevisionHash: record.sourceReviewRevisionHash,
      checkoutTreeOid: record.checkoutTreeOid,
    },
    sourceExecutionId: record.sourceExecutionId,
    sourceWorkSlotId: record.sourceWorkSlotId,
    attemptId: record.attemptId,
    sourceLeaseId: record.sourceLeaseId,
    sourceFencingToken: record.sourceFencingToken.toString(),
    providerKind: fromPrismaProviderKind(record.providerKind),
    requestedModel: record.requestedModel,
    trustedCapabilityProfile: record.trustedCapabilityProfile,
    gatewayBinaryHash: record.gatewayBinaryHash,
    gatewayPolicyVersion: record.gatewayPolicyVersion,
    producerReleaseId: record.producerReleaseId,
    selectedProtocolVersion: record.selectedProtocolVersion,
    confinementProofHash: record.confinementProofHash,
    eventChainSeedHash: record.eventChainSeedHash,
    openedAtMs: record.openedAt.getTime(),
    expiresAtMs: record.expiresAt.getTime(),
  });
  return Object.freeze({
    ...opened,
    state: fromPrismaSessionState(record.state),
    eventCount: record.eventCount,
    sealedAtMs: record.sealedAt?.getTime() ?? null,
    revokedAtMs: record.revokedAt?.getTime() ?? null,
  });
}

function toAcceptedAttestation(
  record: AttestationWithSession,
): AcceptedDependencyAttestation {
  const session = toGatewaySession(record.session);
  const manifest = decodeManifest(record.operationManifestJson);
  const accepted = createAcceptedDependencyAttestation({
    attestationId: record.attestationId,
    attestationHash: record.attestationHash,
    session: Object.freeze({
      ...session,
      state: GatewaySessionState.Sealed,
      eventCount: record.dependencyCount,
      sealedAtMs: session.sealedAtMs ?? record.acceptedAt.getTime(),
    }),
    manifest,
    actualModel: record.actualModel,
    terminalOutcomeHash: record.terminalOutcomeHash,
    replayMaterialHash: record.replayMaterialHash,
    acceptedAtMs: record.acceptedAt.getTime(),
    reuseExpiresAtMs: record.reuseExpiresAt.getTime(),
  });
  return accepted.attestation;
}

function toReplayMaterial(
  record: Prisma.ReviewContextReplayMaterialGetPayload<object>,
): EncryptedContextReplayMaterial {
  if (record.encryptionAlgorithm !== contextReplayMaterialEncryptionAlgorithm) {
    throw new Error("context_replay_encryption_algorithm_unsupported");
  }
  return createEncryptedContextReplayMaterial({
    sessionId: record.sessionId,
    algorithm: contextReplayMaterialEncryptionAlgorithm,
    keyId: record.encryptionKeyId,
    nonceBase64Url: Buffer.from(record.nonce).toString("base64url"),
    authTagBase64Url: Buffer.from(record.authTag).toString("base64url"),
    ciphertextBase64Url: Buffer.from(record.ciphertext).toString("base64url"),
    associatedDataHash: record.associatedDataHash,
    plaintextHash: record.plaintextHash,
    byteCount: record.byteCount,
    expiresAtMs: record.expiresAt.getTime(),
  });
}

function toReplayProof(
  record: Prisma.ReviewContextTargetReplayProofGetPayload<object>,
): TargetReplayProof {
  return createTargetReplayProof(
    {
      replayProofId: record.replayProofId,
      sourceAttestationId: record.sourceAttestationId,
      sourceAttestationHash: record.sourceAttestationHash,
      targetExecutionId: record.targetExecutionId,
      targetWorkSlotId: record.targetWorkSlotId,
      targetReviewRevisionHash: record.targetReviewRevisionHash,
      targetCheckoutTreeOid: record.targetCheckoutTreeOid,
      replayBinaryHash: record.replayBinaryHash,
      replayPolicyVersion: record.replayPolicyVersion,
      reusePolicyVectorHash: record.reusePolicyVectorHash,
      createdAtMs: record.createdAt.getTime(),
      expiresAtMs: record.expiresAt.getTime(),
    },
    {
      status: ContextDependencyReplayStatus.Matched,
      reason: ContextDependencyReplayDenialReason.None,
      mismatchedOperationKey: null,
    },
  );
}

function decodeManifest(value: Prisma.JsonValue): ContextAttestationManifest {
  return createContextAttestationManifest(
    value as unknown as ContextAttestationManifest,
  );
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toPrismaProviderKind(value: ContextProviderKind): PrismaProviderKind {
  switch (value) {
    case ContextProviderKind.Codex:
      return PrismaProviderKind.codex;
    case ContextProviderKind.ClaudeCode:
      return PrismaProviderKind.claude_code;
    case ContextProviderKind.OpenRouter:
      return PrismaProviderKind.openrouter;
  }
}

function fromPrismaProviderKind(
  value: PrismaProviderKind,
): ContextProviderKind {
  switch (value) {
    case PrismaProviderKind.codex:
      return ContextProviderKind.Codex;
    case PrismaProviderKind.claude_code:
      return ContextProviderKind.ClaudeCode;
    case PrismaProviderKind.openrouter:
      return ContextProviderKind.OpenRouter;
  }
}

function toPrismaSessionState(
  value: GatewaySessionState,
): PrismaGatewaySessionState {
  switch (value) {
    case GatewaySessionState.Opened:
      return PrismaGatewaySessionState.opened;
    case GatewaySessionState.Active:
      return PrismaGatewaySessionState.active;
    case GatewaySessionState.Sealed:
      return PrismaGatewaySessionState.sealed;
    case GatewaySessionState.Accepted:
      return PrismaGatewaySessionState.accepted;
    case GatewaySessionState.Rejected:
      return PrismaGatewaySessionState.rejected;
    case GatewaySessionState.Revoked:
      return PrismaGatewaySessionState.revoked;
    case GatewaySessionState.Expired:
      return PrismaGatewaySessionState.expired;
  }
}

function fromPrismaSessionState(
  value: PrismaGatewaySessionState,
): GatewaySessionState {
  switch (value) {
    case PrismaGatewaySessionState.opened:
      return GatewaySessionState.Opened;
    case PrismaGatewaySessionState.active:
      return GatewaySessionState.Active;
    case PrismaGatewaySessionState.sealed:
      return GatewaySessionState.Sealed;
    case PrismaGatewaySessionState.accepted:
      return GatewaySessionState.Accepted;
    case PrismaGatewaySessionState.rejected:
      return GatewaySessionState.Rejected;
    case PrismaGatewaySessionState.revoked:
      return GatewaySessionState.Revoked;
    case PrismaGatewaySessionState.expired:
      return GatewaySessionState.Expired;
  }
}

function sameOpening(left: GatewaySession, right: GatewaySession): boolean {
  return (
    JSON.stringify({
      ...left,
      sessionId: null,
      state: null,
      eventCount: null,
      openedAtMs: null,
      expiresAtMs: left.expiresAtMs - left.openedAtMs,
      sealedAtMs: null,
      revokedAtMs: null,
    }) ===
    JSON.stringify({
      ...right,
      sessionId: null,
      state: null,
      eventCount: null,
      openedAtMs: null,
      expiresAtMs: right.expiresAtMs - right.openedAtMs,
      sealedAtMs: null,
      revokedAtMs: null,
    })
  );
}

function sameAttestationIntent(
  left: AcceptedDependencyAttestation,
  right: AcceptedDependencyAttestation,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sourceExecutionId === right.sourceExecutionId &&
    left.sourceWorkSlotId === right.sourceWorkSlotId &&
    left.attemptId === right.attemptId &&
    left.sourceLeaseId === right.sourceLeaseId &&
    left.sourceFencingToken === right.sourceFencingToken &&
    left.sourceReviewRevisionHash === right.sourceReviewRevisionHash &&
    left.trustedCapabilityProfile === right.trustedCapabilityProfile &&
    canonicalContextAttestationManifest(left.manifest) ===
      canonicalContextAttestationManifest(right.manifest) &&
    left.actualModel === right.actualModel &&
    left.terminalOutcomeHash === right.terminalOutcomeHash
  );
}

function validAcceptanceAggregate(input: {
  readonly expectedSession: GatewaySession;
  readonly acceptedSession: GatewaySession;
  readonly attestation: AcceptedDependencyAttestation;
  readonly replayMaterial: EncryptedContextReplayMaterial;
}): boolean {
  const sessionId = input.expectedSession.sessionId;
  return (
    input.expectedSession.state === GatewaySessionState.Sealed &&
    input.acceptedSession.state === GatewaySessionState.Accepted &&
    input.acceptedSession.sessionId === sessionId &&
    sameOpening(input.expectedSession, input.acceptedSession) &&
    input.expectedSession.eventCount ===
      contextAttestationManifestEventCount(input.attestation.manifest) &&
    input.acceptedSession.eventCount === input.expectedSession.eventCount &&
    input.acceptedSession.sealedAtMs === input.expectedSession.sealedAtMs &&
    input.attestation.sessionId === sessionId &&
    input.replayMaterial.sessionId === sessionId &&
    input.replayMaterial.plaintextHash ===
      input.attestation.replayMaterialHash &&
    input.attestation.sourceExecutionId ===
      input.expectedSession.sourceExecutionId &&
    input.attestation.sourceWorkSlotId ===
      input.expectedSession.sourceWorkSlotId &&
    input.attestation.attemptId === input.expectedSession.attemptId &&
    input.attestation.sourceLeaseId === input.expectedSession.sourceLeaseId &&
    input.attestation.sourceFencingToken ===
      input.expectedSession.sourceFencingToken &&
    input.attestation.sourceReviewRevisionHash ===
      input.expectedSession.sourceRevision.reviewRevisionHash
  );
}

function persisted<T>(
  status:
    | ContextAttestationPersistenceStatus.Created
    | ContextAttestationPersistenceStatus.Idempotent,
  value: T,
): ContextAttestationPersistenceResult<T> {
  return Object.freeze({ status, value });
}

function conflict<T>(): ContextAttestationPersistenceResult<T> {
  return Object.freeze({
    status: ContextAttestationPersistenceStatus.Conflict,
  });
}

function isUniqueConstraintError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function isRetryableWriteConflict(error: unknown): boolean {
  return (
    error instanceof ContextAttestationWriteRaceError ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2034"))
  );
}

class ContextAttestationWriteRaceError extends Error {
  constructor() {
    super("context_attestation_write_race");
    this.name = "ContextAttestationWriteRaceError";
  }
}
