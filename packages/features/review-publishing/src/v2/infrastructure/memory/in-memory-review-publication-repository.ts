import {
  ReviewPublicationAttemptState,
  ReviewPublicationClaimState,
  ReviewPublicationOperationAttemptState,
  ReviewPublicationOperationRole,
  ReviewPublicationOperationState,
  ReviewPublicationCorrectionReason,
  ReviewPublicationReceiptStatus,
  ReviewPublicationTerminalOutcome,
  assertOperationCapabilityMatches,
  assertReviewPublicationAttemptCandidate,
  claimCapabilityFacts,
  hasEveryRequiredCanonicalReceipt,
  hasPublicationExternalEffectRisk,
  isActiveReviewPublicationOperation,
  isAttemptLevelNoEffectOutcome,
  isExactPublicationSiblingTerminalizationPlan,
  operationCapabilityFacts,
  publicationOperationsWithExternalEffectRisk,
  publicationAttemptNaturalKey,
  reviewPublicationV2SchemaVersion,
  selectCanonicalExternalEffect,
  type ReviewPublicationAttempt,
  type ReviewPublicationAuditTombstone,
  type ReviewPublicationClaimTerm,
  type ReviewPublicationExternalEffect,
  type ReviewPublicationOperation,
  type ReviewPublicationOperationAttempt,
  type ReviewPublicationOutcomeCorrection,
  type ReviewPublicationReceipt,
} from "../../domain/review-publication-attempt";
import { reviewPublicationNoEffectProofHash } from "../review-publication-no-effect-proof";
import {
  AdjudicateReviewPublicationOutcomeStatus,
  BeginReviewPublicationOperationStatus,
  ClaimReviewPublicationStatus,
  CompleteReviewPublicationOperationStatus,
  ProveReviewPublicationNoEffectStatus,
  RecordReviewExternalEffectStatus,
  RenewReviewPublicationClaimStatus,
  RequestReviewPublicationStatus,
  TerminalizeUnknownReviewPublicationStatus,
  type AdjudicateReviewPublicationOutcomeCommand,
  type AdjudicateReviewPublicationOutcomeCommandPort,
  type AdjudicateReviewPublicationOutcomeResult,
  type BeginReviewPublicationOperationCommand,
  type BeginReviewPublicationOperationCommandPort,
  type BeginReviewPublicationOperationResult,
  type ClaimReviewPublicationCommand,
  type ClaimReviewPublicationCommandPort,
  type ClaimReviewPublicationResult,
  type CompleteReviewPublicationOperationCommand,
  type CompleteReviewPublicationOperationCommandPort,
  type CompleteReviewPublicationOperationResult,
  type ProveReviewPublicationNoEffectCommand,
  type ProveReviewPublicationNoEffectCommandPort,
  type ProveReviewPublicationNoEffectResult,
  type RecordReviewExternalEffectCommand,
  type RecordReviewExternalEffectCommandPort,
  type RecordReviewExternalEffectResult,
  type RenewReviewPublicationClaimCommand,
  type RenewReviewPublicationClaimCommandPort,
  type RenewReviewPublicationClaimResult,
  type RequestReviewPublicationCommand,
  type RequestReviewPublicationCommandPort,
  type RequestReviewPublicationResult,
  type ReviewPublicationAttemptQueryPort,
  type ReviewPublicationAttemptView,
  type ReviewPublicationIdempotencyQueryPort,
  type TerminalizeUnknownReviewPublicationCommand,
  type TerminalizeUnknownReviewPublicationCommandPort,
  type TerminalizeUnknownReviewPublicationResult,
} from "../../application/ports/review-publication-ports";

type StoredAttempt = {
  attempt: ReviewPublicationAttempt;
  readonly claims: Map<string, ReviewPublicationClaimTerm>;
  readonly claimReportUntil: Map<string, Date>;
  readonly operationAttempts: Map<string, ReviewPublicationOperationAttempt>;
  readonly effects: Map<string, ReviewPublicationExternalEffect>;
  readonly receipts: Map<string, ReviewPublicationReceipt>;
  readonly tombstones: Map<string, ReviewPublicationAuditTombstone>;
  readonly corrections: Map<string, ReviewPublicationOutcomeCorrection>;
};

type RequestReceipt = {
  readonly publicationAttemptId: string;
  readonly requestHash: string;
  readonly candidateFingerprint: string;
};

type ClaimReceipt = {
  readonly claimId: string;
  readonly requestHash: string;
  readonly commandFingerprint: string;
};

type BeginReceipt = {
  readonly operationAttemptId: string;
  readonly requestHash: string;
  readonly commandFingerprint: string;
};

type CompletionReceipt = {
  readonly receiptId: string;
  readonly requestHash: string;
  readonly commandFingerprint: string;
};

export class InMemoryReviewPublicationRepository
  implements
    ReviewPublicationAttemptQueryPort,
    ReviewPublicationIdempotencyQueryPort,
    RequestReviewPublicationCommandPort,
    ClaimReviewPublicationCommandPort,
    RenewReviewPublicationClaimCommandPort,
    BeginReviewPublicationOperationCommandPort,
    RecordReviewExternalEffectCommandPort,
    ProveReviewPublicationNoEffectCommandPort,
    CompleteReviewPublicationOperationCommandPort,
    TerminalizeUnknownReviewPublicationCommandPort,
    AdjudicateReviewPublicationOutcomeCommandPort
{
  readonly #attempts = new Map<string, StoredAttempt>();
  readonly #attemptByNaturalKey = new Map<string, string>();
  readonly #requestReceipts = new Map<string, RequestReceipt>();
  readonly #claimReceipts = new Map<string, ClaimReceipt>();
  readonly #beginReceipts = new Map<string, BeginReceipt>();
  readonly #completionReceipts = new Map<string, CompletionReceipt>();
  #nextClaimFencingToken = 0n;

  async findById(
    publicationAttemptId: string,
  ): Promise<ReviewPublicationAttemptView | null> {
    const stored = this.#attempts.get(publicationAttemptId);
    return stored ? viewOf(stored) : null;
  }

  async findByPermitIdentity(
    permit: ReviewPublicationAttempt["permit"],
  ): Promise<ReviewPublicationAttemptView | null> {
    const attemptId = this.#attemptByNaturalKey.get(
      publicationAttemptNaturalKey(permit),
    );
    return attemptId ? this.findById(attemptId) : null;
  }

  async findClaimByRequest(input: {
    readonly publicationAttemptId: string;
    readonly acquireRequestIdHash: string;
  }) {
    const stored = this.#attempts.get(input.publicationAttemptId);
    const receipt = this.#claimReceipts.get(
      `${input.publicationAttemptId}:${input.acquireRequestIdHash}`,
    );
    if (!stored || !receipt) return null;
    const claim = stored.claims.get(receipt.claimId);
    const reportUntil = stored.claimReportUntil.get(receipt.claimId);
    if (!claim || !reportUntil) return null;
    return {
      requestHash: receipt.requestHash,
      attempt: copyAttempt(stored.attempt),
      claim: copyClaim(claim),
      capability: claimCapabilityFacts(stored.attempt, claim, reportUntil),
    };
  }

  async findOperationBeginByRequest(input: {
    readonly publicationAttemptId: string;
    readonly publicationOperationId: string;
    readonly claimId: string;
    readonly acquireRequestIdHash: string;
  }) {
    const stored = this.#attempts.get(input.publicationAttemptId);
    const receipt = this.#beginReceipts.get(
      [
        input.publicationOperationId,
        input.claimId,
        input.acquireRequestIdHash,
      ].join(":"),
    );
    if (!stored || !receipt) return null;
    const operation = findOperation(stored, input.publicationOperationId);
    const operationAttempt = stored.operationAttempts.get(
      receipt.operationAttemptId,
    );
    if (!operation || !operationAttempt) return null;
    return {
      requestHash: receipt.requestHash,
      attempt: copyAttempt(stored.attempt),
      operation: copyOperation(operation),
      operationAttempt: copyOperationAttempt(operationAttempt),
      capability: operationCapabilityFacts({
        attempt: stored.attempt,
        operation,
        operationAttempt,
        targetExternalObjectId: dependencyExternalObjectId(stored, operation),
      }),
    };
  }

  async request(
    command: RequestReviewPublicationCommand,
  ): Promise<RequestReviewPublicationResult> {
    assertReviewPublicationAttemptCandidate(command);
    const candidateFingerprint = fingerprint({
      publicationAttemptId: command.publicationAttemptId,
      permit: command.permit,
      operations: command.operations,
      createdAt: command.createdAt,
      retainUntil: command.retainUntil,
    });
    const requestReceipt = this.#requestReceipts.get(command.requestIdHash);
    if (requestReceipt) {
      if (
        requestReceipt.publicationAttemptId !== command.publicationAttemptId ||
        requestReceipt.requestHash !== command.requestHash ||
        requestReceipt.candidateFingerprint !== candidateFingerprint
      ) {
        return { status: RequestReviewPublicationStatus.RequestConflict };
      }
      const restored = this.#attempts.get(requestReceipt.publicationAttemptId);
      return restored
        ? {
            status: RequestReviewPublicationStatus.Restored,
            attempt: copyAttempt(restored.attempt),
          }
        : { status: RequestReviewPublicationStatus.IdentityConflict };
    }

    const naturalKey = publicationAttemptNaturalKey(command.permit);
    const existingId = this.#attemptByNaturalKey.get(naturalKey);
    if (existingId) {
      const existing = this.#attempts.get(existingId);
      if (
        !existing ||
        existing.attempt.requestHash !== command.requestHash ||
        attemptFingerprint(existing.attempt) !== candidateFingerprint
      ) {
        return { status: RequestReviewPublicationStatus.IdentityConflict };
      }
      this.#requestReceipts.set(command.requestIdHash, {
        publicationAttemptId: existingId,
        requestHash: command.requestHash,
        candidateFingerprint,
      });
      return {
        status: RequestReviewPublicationStatus.Restored,
        attempt: copyAttempt(existing.attempt),
      };
    }

    if (this.#attempts.has(command.publicationAttemptId)) {
      return { status: RequestReviewPublicationStatus.IdentityConflict };
    }

    const attempt: ReviewPublicationAttempt = {
      schemaVersion: reviewPublicationV2SchemaVersion,
      publicationAttemptId: command.publicationAttemptId,
      permit: copyPermit(command.permit),
      requestHash: command.requestHash,
      version: 1n,
      activeClaimId: null,
      state: ReviewPublicationAttemptState.Pending,
      terminalOutcome: null,
      operations: command.operations.map((operation) => ({
        ...copyOperationPlan(operation),
        publicationAttemptId: command.publicationAttemptId,
        state: ReviewPublicationOperationState.Planned,
      })),
      createdAt: new Date(command.createdAt),
      retainUntil: new Date(command.retainUntil),
    };
    this.#attempts.set(command.publicationAttemptId, storedAttempt(attempt));
    this.#attemptByNaturalKey.set(naturalKey, command.publicationAttemptId);
    this.#requestReceipts.set(command.requestIdHash, {
      publicationAttemptId: command.publicationAttemptId,
      requestHash: command.requestHash,
      candidateFingerprint,
    });
    return {
      status: RequestReviewPublicationStatus.Applied,
      attempt: copyAttempt(attempt),
    };
  }

  async claim(
    command: ClaimReviewPublicationCommand,
  ): Promise<ClaimReviewPublicationResult> {
    const stored = this.#attempts.get(command.publicationAttemptId);
    if (!stored) {
      return { status: ClaimReviewPublicationStatus.Missing };
    }
    const receiptKey = `${command.publicationAttemptId}:${command.acquireRequestIdHash}`;
    const commandFingerprint = fingerprint(withoutKey(command, "acquiredAt"));
    const existingReceipt = this.#claimReceipts.get(receiptKey);
    if (existingReceipt) {
      if (
        existingReceipt.requestHash !== command.requestHash ||
        existingReceipt.commandFingerprint !== commandFingerprint
      ) {
        return { status: ClaimReviewPublicationStatus.RequestConflict };
      }
      const claim = stored.claims.get(existingReceipt.claimId);
      const reportUntil = stored.claimReportUntil.get(existingReceipt.claimId);
      if (!claim || !reportUntil) {
        return { status: ClaimReviewPublicationStatus.RequestConflict };
      }
      return {
        status: ClaimReviewPublicationStatus.Restored,
        attempt: copyAttempt(stored.attempt),
        claim: copyClaim(claim),
        capability: claimCapabilityFacts(stored.attempt, claim, reportUntil),
      };
    }
    if (stored.attempt.state === ReviewPublicationAttemptState.Terminal) {
      return { status: ClaimReviewPublicationStatus.Terminal };
    }
    if (stored.attempt.version !== command.expectedAttemptVersion) {
      return {
        status: ClaimReviewPublicationStatus.VersionConflict,
        currentVersion: stored.attempt.version,
      };
    }

    const active = activeClaim(stored);
    if (active && active.expiresAt > command.acquiredAt) {
      return { status: ClaimReviewPublicationStatus.AlreadyClaimed };
    }
    if (
      command.expiresAt <= command.acquiredAt ||
      command.reportUntil < command.expiresAt ||
      command.retainUntil < command.reportUntil
    ) {
      throw new Error("publication_claim_window_invalid");
    }
    if (
      [...stored.claims.values()].some(
        (claim) => claim.claimId === command.claimId,
      )
    ) {
      return { status: ClaimReviewPublicationStatus.RequestConflict };
    }

    if (active) {
      stored.claims.set(active.claimId, {
        ...active,
        state: ReviewPublicationClaimState.Expired,
      });
      markOperationAttemptsStale(stored, active.claimId);
    }
    const claim: ReviewPublicationClaimTerm = {
      claimId: command.claimId,
      publicationAttemptId: command.publicationAttemptId,
      ownerIdHash: command.ownerIdHash,
      acquireRequestIdHash: command.acquireRequestIdHash,
      requestHash: command.requestHash,
      claimCapabilityId: command.claimCapabilityId,
      capabilitySigningKeyId: command.capabilitySigningKeyId,
      fencingToken: ++this.#nextClaimFencingToken,
      state: ReviewPublicationClaimState.Active,
      acquiredAt: new Date(command.acquiredAt),
      renewedAt: new Date(command.acquiredAt),
      expiresAt: new Date(command.expiresAt),
      retainUntil: new Date(command.retainUntil),
    };
    stored.claims.set(claim.claimId, claim);
    stored.claimReportUntil.set(claim.claimId, new Date(command.reportUntil));
    stored.attempt = {
      ...stored.attempt,
      version: stored.attempt.version + 1n,
      activeClaimId: claim.claimId,
      state: ReviewPublicationAttemptState.Publishing,
    };
    this.#claimReceipts.set(receiptKey, {
      claimId: claim.claimId,
      requestHash: command.requestHash,
      commandFingerprint,
    });
    return {
      status: ClaimReviewPublicationStatus.Acquired,
      attempt: copyAttempt(stored.attempt),
      claim: copyClaim(claim),
      capability: claimCapabilityFacts(
        stored.attempt,
        claim,
        command.reportUntil,
      ),
    };
  }

  async renewClaim(
    command: RenewReviewPublicationClaimCommand,
  ): Promise<RenewReviewPublicationClaimResult> {
    const stored = this.#attempts.get(command.publicationAttemptId);
    if (!stored) return { status: RenewReviewPublicationClaimStatus.Missing };
    if (stored.attempt.state === ReviewPublicationAttemptState.Terminal) {
      return { status: RenewReviewPublicationClaimStatus.Terminal };
    }
    const claim = currentClaim(
      stored,
      command.claimId,
      command.claimFencingToken,
    );
    if (
      !claim ||
      claim.ownerIdHash !== command.ownerIdHash ||
      claim.expiresAt <= command.requestedAt
    ) {
      return { status: RenewReviewPublicationClaimStatus.StaleClaim };
    }
    const expiresAt = new Date(
      Math.min(
        claim.retainUntil.getTime(),
        Math.max(
          claim.expiresAt.getTime(),
          command.requestedAt.getTime() + command.extendByMs,
        ),
      ),
    );
    if (
      expiresAt.getTime() - command.requestedAt.getTime() <
      command.minimumRemainingMs
    ) {
      return { status: RenewReviewPublicationClaimStatus.InsufficientWindow };
    }
    const renewed = {
      ...claim,
      renewedAt: new Date(command.requestedAt),
      expiresAt,
    };
    stored.claims.set(claim.claimId, renewed);
    return {
      status: RenewReviewPublicationClaimStatus.Renewed,
      claim: copyClaim(renewed),
    };
  }

  async begin(
    command: BeginReviewPublicationOperationCommand,
  ): Promise<BeginReviewPublicationOperationResult> {
    const stored = this.#attempts.get(command.publicationAttemptId);
    if (!stored) {
      return { status: BeginReviewPublicationOperationStatus.Missing };
    }
    const receiptKey = [
      command.publicationOperationId,
      command.claimId,
      command.acquireRequestIdHash,
    ].join(":");
    const commandFingerprint = fingerprint(withoutKey(command, "startedAt"));
    const existingReceipt = this.#beginReceipts.get(receiptKey);
    if (existingReceipt) {
      if (
        existingReceipt.requestHash !== command.requestHash ||
        existingReceipt.commandFingerprint !== commandFingerprint
      ) {
        return {
          status: BeginReviewPublicationOperationStatus.RequestConflict,
        };
      }
      const operationAttempt = stored.operationAttempts.get(
        existingReceipt.operationAttemptId,
      );
      const operation = findOperation(stored, command.publicationOperationId);
      if (!operationAttempt || !operation) {
        return {
          status: BeginReviewPublicationOperationStatus.RequestConflict,
        };
      }
      const targetExternalObjectId = dependencyExternalObjectId(
        stored,
        operation,
      );
      return {
        status: BeginReviewPublicationOperationStatus.Restored,
        attempt: copyAttempt(stored.attempt),
        operation: copyOperation(operation),
        operationAttempt: copyOperationAttempt(operationAttempt),
        capability: operationCapabilityFacts({
          attempt: stored.attempt,
          operation,
          operationAttempt,
          targetExternalObjectId,
        }),
      };
    }
    if (stored.attempt.state === ReviewPublicationAttemptState.Terminal) {
      return { status: BeginReviewPublicationOperationStatus.Terminal };
    }
    if (stored.attempt.version !== command.expectedAttemptVersion) {
      return {
        status: BeginReviewPublicationOperationStatus.VersionConflict,
        currentVersion: stored.attempt.version,
      };
    }
    const claim = currentClaim(
      stored,
      command.claimId,
      command.claimFencingToken,
    );
    if (!claim || claim.expiresAt <= command.startedAt) {
      return { status: BeginReviewPublicationOperationStatus.StaleClaim };
    }
    const operation = findOperation(stored, command.publicationOperationId);
    if (!operation) {
      return { status: BeginReviewPublicationOperationStatus.Missing };
    }
    if (operation.state === ReviewPublicationOperationState.Completed) {
      return {
        status: BeginReviewPublicationOperationStatus.OperationCompleted,
      };
    }
    if (
      operation.state === ReviewPublicationOperationState.InFlight &&
      [...stored.operationAttempts.values()].some(
        (attempt) =>
          attempt.publicationOperationId === operation.publicationOperationId &&
          (attempt.state ===
            ReviewPublicationOperationAttemptState.NoEffectProven ||
            (attempt.claimId === claim.claimId &&
              attempt.state !== ReviewPublicationOperationAttemptState.Stale)),
      )
    ) {
      return {
        status: BeginReviewPublicationOperationStatus.OperationInFlight,
      };
    }
    const targetExternalObjectId = dependencyExternalObjectId(
      stored,
      operation,
    );
    if (
      operation.role === ReviewPublicationOperationRole.PendingReviewSubmit &&
      targetExternalObjectId === null
    ) {
      return {
        status: BeginReviewPublicationOperationStatus.DependencyNotCompleted,
      };
    }
    if (
      command.effectReportUntil <= command.startedAt ||
      command.retainUntil < command.effectReportUntil
    ) {
      throw new Error("publication_operation_window_invalid");
    }
    if (
      stored.operationAttempts.has(command.operationAttemptId) ||
      [...stored.operationAttempts.values()].some(
        (attempt) =>
          attempt.operationCapabilityId === command.operationCapabilityId ||
          attempt.effectReportId === command.effectReportId,
      )
    ) {
      return { status: BeginReviewPublicationOperationStatus.RequestConflict };
    }

    const operationAttempt: ReviewPublicationOperationAttempt = {
      operationAttemptId: command.operationAttemptId,
      publicationAttemptId: command.publicationAttemptId,
      publicationOperationId: command.publicationOperationId,
      claimId: command.claimId,
      acquireRequestIdHash: command.acquireRequestIdHash,
      requestHash: command.requestHash,
      operationCapabilityId: command.operationCapabilityId,
      capabilitySigningKeyId: command.capabilitySigningKeyId,
      effectReportId: command.effectReportId,
      claimFencingToken: command.claimFencingToken,
      state: ReviewPublicationOperationAttemptState.Active,
      noEffectProofId: null,
      noEffectProofHash: null,
      noEffectReason: null,
      noEffectProvenAt: null,
      startedAt: new Date(command.startedAt),
      effectReportUntil: new Date(command.effectReportUntil),
      retainUntil: new Date(command.retainUntil),
    };
    stored.operationAttempts.set(
      operationAttempt.operationAttemptId,
      operationAttempt,
    );
    replaceOperation(stored, {
      ...operation,
      state: ReviewPublicationOperationState.InFlight,
    });
    stored.attempt = {
      ...stored.attempt,
      version: stored.attempt.version + 1n,
    };
    this.#beginReceipts.set(receiptKey, {
      operationAttemptId: operationAttempt.operationAttemptId,
      requestHash: command.requestHash,
      commandFingerprint,
    });
    return {
      status: BeginReviewPublicationOperationStatus.Begun,
      attempt: copyAttempt(stored.attempt),
      operation: copyOperation(
        findOperation(stored, command.publicationOperationId) ?? operation,
      ),
      operationAttempt: copyOperationAttempt(operationAttempt),
      capability: operationCapabilityFacts({
        attempt: stored.attempt,
        operation,
        operationAttempt,
        targetExternalObjectId,
      }),
    };
  }

  async proveNoEffect(
    command: ProveReviewPublicationNoEffectCommand,
  ): Promise<ProveReviewPublicationNoEffectResult> {
    const stored = this.#attempts.get(command.capability.publicationAttemptId);
    const operation = stored
      ? findOperation(stored, command.capability.publicationOperationId)
      : null;
    const operationAttempt = stored?.operationAttempts.get(
      command.capability.operationAttemptId,
    );
    if (!stored || !operation || !operationAttempt) {
      return { status: ProveReviewPublicationNoEffectStatus.Missing };
    }
    if (
      command.noEffectProofHash !== reviewPublicationNoEffectProofHash(command)
    ) {
      return { status: ProveReviewPublicationNoEffectStatus.RequestConflict };
    }
    try {
      assertOperationCapabilityMatches(
        command.capability,
        stored.attempt,
        operation,
        operationAttempt,
      );
      if (
        command.capability.targetExternalObjectId !==
        dependencyExternalObjectId(stored, operation)
      ) {
        throw new Error("publication_operation_capability_mismatch");
      }
    } catch {
      return {
        status: ProveReviewPublicationNoEffectStatus.CapabilityMismatch,
      };
    }
    if (
      operationAttempt.state ===
      ReviewPublicationOperationAttemptState.NoEffectProven
    ) {
      return sameNoEffectProof(operationAttempt, command)
        ? {
            status: ProveReviewPublicationNoEffectStatus.Restored,
            attempt: copyAttempt(stored.attempt),
            operation: copyOperation(operation),
            operationAttempt: copyOperationAttempt(operationAttempt),
          }
        : { status: ProveReviewPublicationNoEffectStatus.RequestConflict };
    }
    if (
      [...this.#attempts.values()].some((candidate) =>
        [...candidate.operationAttempts.values()].some(
          (attempt) => attempt.noEffectProofId === command.noEffectProofId,
        ),
      )
    ) {
      return { status: ProveReviewPublicationNoEffectStatus.RequestConflict };
    }
    if (stored.attempt.state === ReviewPublicationAttemptState.Terminal) {
      return { status: ProveReviewPublicationNoEffectStatus.Terminal };
    }
    const claim = currentClaim(
      stored,
      command.capability.claimId,
      command.capability.claimFencingToken,
    );
    if (!claim || claim.expiresAt <= command.provenAt) {
      return { status: ProveReviewPublicationNoEffectStatus.StaleClaim };
    }
    if (
      operationAttempt.state !==
        ReviewPublicationOperationAttemptState.Active ||
      [...stored.effects.values()].some(
        (effect) =>
          effect.operationAttemptId === operationAttempt.operationAttemptId,
      )
    ) {
      return {
        status: ProveReviewPublicationNoEffectStatus.ExternalEffectExists,
      };
    }
    const provenAttempt: ReviewPublicationOperationAttempt = {
      ...operationAttempt,
      state: ReviewPublicationOperationAttemptState.NoEffectProven,
      noEffectProofId: command.noEffectProofId,
      noEffectProofHash: command.noEffectProofHash,
      noEffectReason: command.noEffectReason,
      noEffectProvenAt: new Date(command.provenAt),
    };
    stored.operationAttempts.set(
      provenAttempt.operationAttemptId,
      provenAttempt,
    );
    return {
      status: ProveReviewPublicationNoEffectStatus.Proven,
      attempt: copyAttempt(stored.attempt),
      operation: copyOperation(operation),
      operationAttempt: copyOperationAttempt(provenAttempt),
    };
  }

  async record(
    command: RecordReviewExternalEffectCommand,
  ): Promise<RecordReviewExternalEffectResult> {
    const stored = this.#attempts.get(command.capability.publicationAttemptId);
    const operation = stored
      ? findOperation(stored, command.capability.publicationOperationId)
      : null;
    const operationAttempt = stored?.operationAttempts.get(
      command.capability.operationAttemptId,
    );
    if (!stored || !operation || !operationAttempt) {
      return { status: RecordReviewExternalEffectStatus.Missing };
    }
    try {
      assertOperationCapabilityMatches(
        command.capability,
        stored.attempt,
        operation,
        operationAttempt,
      );
      if (
        command.capability.targetExternalObjectId !==
        dependencyExternalObjectId(stored, operation)
      ) {
        throw new Error("publication_operation_capability_mismatch");
      }
    } catch {
      return { status: RecordReviewExternalEffectStatus.CapabilityMismatch };
    }
    if (
      operationAttempt.state ===
      ReviewPublicationOperationAttemptState.NoEffectProven
    ) {
      return { status: RecordReviewExternalEffectStatus.RequestConflict };
    }
    if (command.observedAt > operationAttempt.effectReportUntil) {
      return { status: RecordReviewExternalEffectStatus.ReportExpired };
    }
    if (
      command.capability.targetExternalObjectId !== null &&
      command.externalObjectId !== command.capability.targetExternalObjectId
    ) {
      return { status: RecordReviewExternalEffectStatus.CapabilityMismatch };
    }
    const reportKey = `${operationAttempt.operationAttemptId}:${operationAttempt.effectReportId}`;
    const existing = stored.effects.get(reportKey);
    if (existing) {
      return sameEffect(existing, command)
        ? {
            status: RecordReviewExternalEffectStatus.Restored,
            effect: copyEffect(existing),
          }
        : { status: RecordReviewExternalEffectStatus.RequestConflict };
    }
    const duplicateObject = [...stored.effects.values()].find(
      (effect) =>
        effect.publicationOperationId === operation.publicationOperationId &&
        effect.effectKind === command.effectKind &&
        effect.externalObjectId === command.externalObjectId,
    );
    if (duplicateObject) {
      return {
        status: RecordReviewExternalEffectStatus.ExternalObjectConflict,
      };
    }
    if (
      [...stored.effects.values()].some(
        (effect) => effect.effectId === command.effectId,
      )
    ) {
      return { status: RecordReviewExternalEffectStatus.RequestConflict };
    }
    const effect: ReviewPublicationExternalEffect = {
      effectId: command.effectId,
      publicationAttemptId: stored.attempt.publicationAttemptId,
      publicationOperationId: operation.publicationOperationId,
      operationAttemptId: operationAttempt.operationAttemptId,
      effectReportId: operationAttempt.effectReportId,
      reportRequestHash: command.reportRequestHash,
      externalObjectId: command.externalObjectId,
      observedObjectHash: command.observedObjectHash,
      effectKind: command.effectKind,
      observedAt: new Date(command.observedAt),
    };
    stored.effects.set(reportKey, effect);
    return {
      status: RecordReviewExternalEffectStatus.Recorded,
      effect: copyEffect(effect),
    };
  }

  async complete(
    command: CompleteReviewPublicationOperationCommand,
  ): Promise<CompleteReviewPublicationOperationResult> {
    const stored = this.#attempts.get(command.publicationAttemptId);
    if (!stored) {
      return { status: CompleteReviewPublicationOperationStatus.Missing };
    }
    const receiptKey = `${command.publicationAttemptId}:${command.completionRequestIdHash}`;
    const commandFingerprint = fingerprint(withoutKey(command, "completedAt"));
    const existingCompletion = this.#completionReceipts.get(receiptKey);
    if (existingCompletion) {
      if (
        existingCompletion.requestHash !== command.requestHash ||
        existingCompletion.commandFingerprint !== commandFingerprint
      ) {
        return {
          status: CompleteReviewPublicationOperationStatus.RequestConflict,
        };
      }
      const receipt = [...stored.receipts.values()].find(
        (candidate) => candidate.receiptId === existingCompletion.receiptId,
      );
      return receipt
        ? {
            status: CompleteReviewPublicationOperationStatus.Restored,
            attempt: copyAttempt(stored.attempt),
            receipt: copyReceipt(receipt),
          }
        : { status: CompleteReviewPublicationOperationStatus.RequestConflict };
    }
    if (stored.attempt.state === ReviewPublicationAttemptState.Terminal) {
      return { status: CompleteReviewPublicationOperationStatus.Terminal };
    }
    if (stored.attempt.version !== command.expectedAttemptVersion) {
      return {
        status: CompleteReviewPublicationOperationStatus.VersionConflict,
        currentVersion: stored.attempt.version,
      };
    }
    const claim = currentClaim(
      stored,
      command.claimId,
      command.claimFencingToken,
    );
    if (!claim || claim.expiresAt <= command.completedAt) {
      return { status: CompleteReviewPublicationOperationStatus.StaleClaim };
    }
    const operation = findOperation(stored, command.publicationOperationId);
    if (!operation) {
      return { status: CompleteReviewPublicationOperationStatus.Missing };
    }
    const effects = effectsForOperation(
      stored,
      operation.publicationOperationId,
    );
    const canonical = selectCanonicalExternalEffect(effects);
    if (!canonical || canonical.effectId !== command.canonicalEffectId) {
      return {
        status:
          CompleteReviewPublicationOperationStatus.CanonicalEffectConflict,
      };
    }
    const expectedTarget = dependencyExternalObjectId(stored, operation);
    if (
      expectedTarget !== null &&
      canonical.externalObjectId !== expectedTarget
    ) {
      return {
        status:
          CompleteReviewPublicationOperationStatus.CanonicalEffectConflict,
      };
    }
    const existingReceipt = stored.receipts.get(
      operation.publicationOperationId,
    );
    if (existingReceipt) {
      return {
        status: CompleteReviewPublicationOperationStatus.RequestConflict,
      };
    }
    const receipt: ReviewPublicationReceipt = {
      receiptId: command.receiptId,
      publicationAttemptId: command.publicationAttemptId,
      publicationOperationId: command.publicationOperationId,
      canonicalEffectId: canonical.effectId,
      canonicalExternalObjectId: canonical.externalObjectId,
      status: ReviewPublicationReceiptStatus.Succeeded,
      receiptHash: command.receiptHash,
      updatedAt: new Date(command.completedAt),
    };
    stored.receipts.set(operation.publicationOperationId, receipt);
    replaceOperation(stored, {
      ...operation,
      state: ReviewPublicationOperationState.Completed,
    });
    for (const attempt of stored.operationAttempts.values()) {
      if (attempt.publicationOperationId !== operation.publicationOperationId) {
        continue;
      }
      if (
        attempt.state === ReviewPublicationOperationAttemptState.NoEffectProven
      ) {
        continue;
      }
      stored.operationAttempts.set(attempt.operationAttemptId, {
        ...attempt,
        state:
          attempt.claimId === claim.claimId
            ? ReviewPublicationOperationAttemptState.Completed
            : ReviewPublicationOperationAttemptState.Stale,
      });
    }
    const allReceipts = hasEveryRequiredCanonicalReceipt({
      operations: stored.attempt.operations,
      receipts: [...stored.receipts.values()],
    });
    stored.attempt = {
      ...stored.attempt,
      version: stored.attempt.version + 1n,
      state: allReceipts
        ? ReviewPublicationAttemptState.Terminal
        : ReviewPublicationAttemptState.Publishing,
      terminalOutcome: allReceipts
        ? ReviewPublicationTerminalOutcome.Succeeded
        : null,
      activeClaimId: allReceipts ? null : stored.attempt.activeClaimId,
    };
    if (allReceipts) {
      stored.claims.set(claim.claimId, {
        ...claim,
        state: ReviewPublicationClaimState.Released,
      });
    }
    this.#completionReceipts.set(receiptKey, {
      receiptId: receipt.receiptId,
      requestHash: command.requestHash,
      commandFingerprint,
    });
    return {
      status: CompleteReviewPublicationOperationStatus.Completed,
      attempt: copyAttempt(stored.attempt),
      receipt: copyReceipt(receipt),
    };
  }

  async terminalizeUnknown(
    command: TerminalizeUnknownReviewPublicationCommand,
  ): Promise<TerminalizeUnknownReviewPublicationResult> {
    const stored = this.#attempts.get(command.publicationAttemptId);
    if (!stored) {
      return { status: TerminalizeUnknownReviewPublicationStatus.Missing };
    }
    const existing = stored.tombstones.get(command.publicationOperationId);
    if (existing) {
      return sameTerminalizationTombstonePlan(stored, command)
        ? {
            status: TerminalizeUnknownReviewPublicationStatus.Restored,
            attempt: copyAttempt(stored.attempt),
            tombstone: copyTombstone(existing),
          }
        : { status: TerminalizeUnknownReviewPublicationStatus.Conflict };
    }
    if (stored.attempt.version !== command.expectedAttemptVersion) {
      return {
        status: TerminalizeUnknownReviewPublicationStatus.VersionConflict,
        currentVersion: stored.attempt.version,
      };
    }
    const finalOutcome =
      command.finalOutcome ?? ReviewPublicationTerminalOutcome.TerminalUnknown;
    const claim =
      command.claimId === null || command.claimFencingToken === null
        ? null
        : currentClaim(stored, command.claimId, command.claimFencingToken);
    const unclaimedNoEffect =
      command.claimId === null &&
      command.claimFencingToken === null &&
      stored.attempt.activeClaimId === null &&
      (finalOutcome === ReviewPublicationTerminalOutcome.SupersededNoEffect ||
        finalOutcome === ReviewPublicationTerminalOutcome.FailedNoEffect);
    if (
      !unclaimedNoEffect &&
      (!claim || claim.expiresAt <= command.terminalizedAt)
    ) {
      return { status: TerminalizeUnknownReviewPublicationStatus.StaleClaim };
    }
    const operation = findOperation(stored, command.publicationOperationId);
    if (!operation) {
      return { status: TerminalizeUnknownReviewPublicationStatus.Missing };
    }
    const operationAttempts = [...stored.operationAttempts.values()];
    const effects = [...stored.effects.values()];
    const receipts = [...stored.receipts.values()];
    const riskOperations = publicationOperationsWithExternalEffectRisk({
      operations: stored.attempt.operations,
      operationAttempts,
      effects,
      receipts,
    });
    if (
      finalOutcome === ReviewPublicationTerminalOutcome.TerminalUnknown &&
      [operation, ...riskOperations].some(
        (candidate) => command.terminalizedAt < candidate.reconcileUntil,
      )
    ) {
      return { status: TerminalizeUnknownReviewPublicationStatus.TooEarly };
    }
    if (
      isAttemptLevelNoEffectOutcome(finalOutcome) &&
      hasPublicationExternalEffectRisk({
        operations: stored.attempt.operations,
        operationAttempts,
        effects,
        receipts,
      })
    ) {
      return {
        status: TerminalizeUnknownReviewPublicationStatus.ExternalEffectRisk,
      };
    }
    if (
      !isExactPublicationSiblingTerminalizationPlan({
        publicationOperationId: operation.publicationOperationId,
        attemptOutcome: finalOutcome,
        operations: stored.attempt.operations,
        operationAttempts,
        effects,
        receipts,
        supplied: command.siblingTombstones,
      })
    ) {
      return { status: TerminalizeUnknownReviewPublicationStatus.Conflict };
    }
    const terminalOutcomeByOperation = new Map([
      [operation.publicationOperationId, finalOutcome],
      ...command.siblingTombstones.map(
        (sibling) =>
          [sibling.publicationOperationId, sibling.finalOutcome] as const,
      ),
    ]);
    const operationsToTerminalize = stored.attempt.operations.filter(
      (candidate) =>
        terminalOutcomeByOperation.has(candidate.publicationOperationId),
    );
    const tombstoneIdByOperation = new Map([
      [operation.publicationOperationId, command.tombstoneId],
      ...command.siblingTombstones.map(
        (sibling) =>
          [sibling.publicationOperationId, sibling.tombstoneId] as const,
      ),
    ]);
    if (
      tombstoneIdByOperation.size !== operationsToTerminalize.length ||
      operationsToTerminalize.some(
        (candidate) =>
          !tombstoneIdByOperation.has(candidate.publicationOperationId),
      ) ||
      [...tombstoneIdByOperation.keys()].some(
        (operationId) =>
          !operationsToTerminalize.some(
            (candidate) => candidate.publicationOperationId === operationId,
          ),
      ) ||
      stored.attempt.operations.some(
        (candidate) =>
          isActiveReviewPublicationOperation(candidate) &&
          !tombstoneIdByOperation.has(candidate.publicationOperationId),
      )
    ) {
      return { status: TerminalizeUnknownReviewPublicationStatus.Conflict };
    }
    const plannedTombstones = operationsToTerminalize.map((candidate) =>
      terminalizationTombstone(
        stored,
        candidate,
        tombstoneIdByOperation.get(candidate.publicationOperationId)!,
        terminalOutcomeByOperation.get(candidate.publicationOperationId)!,
        command,
      ),
    );
    const tombstoneIds = new Set(
      plannedTombstones.map((candidate) => candidate.tombstoneId),
    );
    if (
      tombstoneIds.size !== plannedTombstones.length ||
      [...this.#attempts.values()].some((candidateAttempt) =>
        [...candidateAttempt.tombstones.values()].some((candidate) =>
          tombstoneIds.has(candidate.tombstoneId),
        ),
      )
    ) {
      return { status: TerminalizeUnknownReviewPublicationStatus.Conflict };
    }
    for (const plannedTombstone of plannedTombstones) {
      stored.tombstones.set(
        plannedTombstone.publicationOperationId,
        plannedTombstone,
      );
    }
    const tombstone = plannedTombstones.find(
      (candidate) =>
        candidate.publicationOperationId === operation.publicationOperationId,
    )!;
    replaceOperation(stored, {
      ...operation,
      state: operationStateFor(finalOutcome),
    });
    for (const sibling of command.siblingTombstones) {
      const siblingOperation = findOperation(
        stored,
        sibling.publicationOperationId,
      );
      if (!siblingOperation) {
        throw new Error("publication_terminal_tombstone_plan_invalid");
      }
      replaceOperation(stored, {
        ...siblingOperation,
        state: operationStateFor(sibling.finalOutcome),
      });
    }
    for (const [operationId, outcome] of terminalOutcomeByOperation) {
      for (const operationAttempt of stored.operationAttempts.values()) {
        if (
          operationAttempt.publicationOperationId !== operationId ||
          operationAttempt.state ===
            ReviewPublicationOperationAttemptState.Completed ||
          operationAttempt.state ===
            ReviewPublicationOperationAttemptState.NoEffectProven
        ) {
          continue;
        }
        stored.operationAttempts.set(operationAttempt.operationAttemptId, {
          ...operationAttempt,
          state:
            outcome === ReviewPublicationTerminalOutcome.TerminalUnknown
              ? ReviewPublicationOperationAttemptState.TerminalUnknown
              : ReviewPublicationOperationAttemptState.Stale,
        });
      }
    }
    if (claim) {
      stored.claims.set(claim.claimId, {
        ...claim,
        state: ReviewPublicationClaimState.Released,
      });
    }
    stored.attempt = {
      ...stored.attempt,
      version: stored.attempt.version + 1n,
      activeClaimId: null,
      state: ReviewPublicationAttemptState.Terminal,
      terminalOutcome: finalOutcome,
    };
    return {
      status: TerminalizeUnknownReviewPublicationStatus.Terminalized,
      attempt: copyAttempt(stored.attempt),
      tombstone: copyTombstone(tombstone),
    };
  }

  async adjudicate(
    command: AdjudicateReviewPublicationOutcomeCommand,
  ): Promise<AdjudicateReviewPublicationOutcomeResult> {
    const stored = this.#attempts.get(command.publicationAttemptId);
    if (!stored) {
      return { status: AdjudicateReviewPublicationOutcomeStatus.Missing };
    }
    const existingById = stored.corrections.get(command.correctionId);
    const existingByOrdinal = [...stored.corrections.values()].find(
      (correction) =>
        correction.correctionOrdinal === command.correctionOrdinal,
    );
    const existing = existingById ?? existingByOrdinal;
    if (existing) {
      return sameCorrection(existing, command) &&
        provenReceiptsMatch(stored, command)
        ? {
            status: AdjudicateReviewPublicationOutcomeStatus.Restored,
            attempt: copyAttempt(stored.attempt),
            correction: copyCorrection(existing),
          }
        : { status: AdjudicateReviewPublicationOutcomeStatus.Conflict };
    }
    if (
      stored.attempt.terminalOutcome !==
      ReviewPublicationTerminalOutcome.TerminalUnknown
    ) {
      return {
        status: AdjudicateReviewPublicationOutcomeStatus.NotTerminalUnknown,
      };
    }
    if (stored.attempt.version !== command.expectedAttemptVersion) {
      return {
        status: AdjudicateReviewPublicationOutcomeStatus.VersionConflict,
        currentVersion: stored.attempt.version,
      };
    }
    const expectedOrdinal = stored.corrections.size + 1;
    if (command.correctionOrdinal !== expectedOrdinal) {
      return { status: AdjudicateReviewPublicationOutcomeStatus.Conflict };
    }
    if (
      command.safeReason !== expectedCorrectionReason(command.correctedOutcome)
    ) {
      return { status: AdjudicateReviewPublicationOutcomeStatus.Conflict };
    }
    if (
      command.correctedOutcome === ReviewPublicationTerminalOutcome.Succeeded &&
      command.provenReceipts.length === 0
    ) {
      return {
        status:
          AdjudicateReviewPublicationOutcomeStatus.MissingCanonicalReceipts,
      };
    }
    const nextReceipts = new Map(stored.receipts);
    const newlyProvenOperationIds = new Set<string>();
    if (
      command.correctedOutcome === ReviewPublicationTerminalOutcome.Succeeded
    ) {
      for (const proof of command.provenReceipts) {
        const operation = findOperation(stored, proof.publicationOperationId);
        if (
          !operation ||
          newlyProvenOperationIds.has(proof.publicationOperationId)
        ) {
          return { status: AdjudicateReviewPublicationOutcomeStatus.Conflict };
        }
        newlyProvenOperationIds.add(proof.publicationOperationId);
        const existingReceipt = nextReceipts.get(proof.publicationOperationId);
        if (existingReceipt) {
          if (
            existingReceipt.receiptId !== proof.receiptId ||
            existingReceipt.canonicalEffectId !== proof.canonicalEffectId ||
            existingReceipt.canonicalExternalObjectId !==
              proof.canonicalExternalObjectId ||
            existingReceipt.receiptHash !== proof.receiptHash
          ) {
            return {
              status: AdjudicateReviewPublicationOutcomeStatus.Conflict,
            };
          }
          continue;
        }
        nextReceipts.set(proof.publicationOperationId, {
          receiptId: proof.receiptId,
          publicationAttemptId: command.publicationAttemptId,
          publicationOperationId: proof.publicationOperationId,
          canonicalEffectId: proof.canonicalEffectId,
          canonicalExternalObjectId: proof.canonicalExternalObjectId,
          status: ReviewPublicationReceiptStatus.Succeeded,
          receiptHash: proof.receiptHash,
          updatedAt: new Date(proof.provenAt),
        });
      }
      if (
        !hasEveryRequiredCanonicalReceipt({
          operations: stored.attempt.operations,
          receipts: [...nextReceipts.values()],
        })
      ) {
        return {
          status:
            AdjudicateReviewPublicationOutcomeStatus.MissingCanonicalReceipts,
        };
      }
    } else if (command.provenReceipts.length > 0) {
      return { status: AdjudicateReviewPublicationOutcomeStatus.Conflict };
    }
    if (
      command.correctedOutcome === ReviewPublicationTerminalOutcome.Succeeded
    ) {
      for (const [operationId, receipt] of nextReceipts) {
        stored.receipts.set(operationId, receipt);
      }
    }
    const correction: ReviewPublicationOutcomeCorrection = {
      correctionId: command.correctionId,
      publicationAttemptId: command.publicationAttemptId,
      correctionOrdinal: command.correctionOrdinal,
      priorOutcome: ReviewPublicationTerminalOutcome.TerminalUnknown,
      correctedOutcome: command.correctedOutcome,
      evidenceHash: command.evidenceHash,
      safeReason: command.safeReason,
      correctedBy: command.correctedBy,
      correctedAt: new Date(command.correctedAt),
      retainUntil: new Date(command.retainUntil),
    };
    stored.corrections.set(correction.correctionId, correction);
    stored.attempt = {
      ...stored.attempt,
      version: stored.attempt.version + 1n,
    };
    return {
      status: AdjudicateReviewPublicationOutcomeStatus.Corrected,
      attempt: copyAttempt(stored.attempt),
      correction: copyCorrection(correction),
    };
  }
}

function storedAttempt(attempt: ReviewPublicationAttempt): StoredAttempt {
  return {
    attempt,
    claims: new Map(),
    claimReportUntil: new Map(),
    operationAttempts: new Map(),
    effects: new Map(),
    receipts: new Map(),
    tombstones: new Map(),
    corrections: new Map(),
  };
}

function viewOf(stored: StoredAttempt): ReviewPublicationAttemptView {
  const active = activeClaim(stored);
  return {
    attempt: copyAttempt(stored.attempt),
    activeClaim: active ? copyClaim(active) : null,
    operationAttempts: [...stored.operationAttempts.values()].map(
      copyOperationAttempt,
    ),
    effects: [...stored.effects.values()].map(copyEffect),
    receipts: [...stored.receipts.values()].map(copyReceipt),
    tombstones: [...stored.tombstones.values()].map(copyTombstone),
    corrections: [...stored.corrections.values()].map(copyCorrection),
  };
}

function activeClaim(stored: StoredAttempt): ReviewPublicationClaimTerm | null {
  if (!stored.attempt.activeClaimId) {
    return null;
  }
  const claim = stored.claims.get(stored.attempt.activeClaimId);
  return claim?.state === ReviewPublicationClaimState.Active ? claim : null;
}

function currentClaim(
  stored: StoredAttempt,
  claimId: string,
  fencingToken: bigint,
): ReviewPublicationClaimTerm | null {
  const claim = activeClaim(stored);
  return claim?.claimId === claimId && claim.fencingToken === fencingToken
    ? claim
    : null;
}

function markOperationAttemptsStale(
  stored: StoredAttempt,
  claimId: string,
): void {
  for (const attempt of stored.operationAttempts.values()) {
    if (
      attempt.claimId === claimId &&
      attempt.state !== ReviewPublicationOperationAttemptState.Completed &&
      attempt.state !== ReviewPublicationOperationAttemptState.NoEffectProven
    ) {
      stored.operationAttempts.set(attempt.operationAttemptId, {
        ...attempt,
        state: ReviewPublicationOperationAttemptState.Stale,
      });
      const operation = findOperation(stored, attempt.publicationOperationId);
      if (operation?.state === ReviewPublicationOperationState.InFlight) {
        replaceOperation(stored, {
          ...operation,
          state: ReviewPublicationOperationState.Reconciling,
        });
      }
    }
  }
}

function findOperation(
  stored: StoredAttempt,
  operationId: string,
): ReviewPublicationOperation | null {
  return (
    stored.attempt.operations.find(
      (operation) => operation.publicationOperationId === operationId,
    ) ?? null
  );
}

function replaceOperation(
  stored: StoredAttempt,
  replacement: ReviewPublicationOperation,
): void {
  stored.attempt = {
    ...stored.attempt,
    operations: stored.attempt.operations.map((operation) =>
      operation.publicationOperationId === replacement.publicationOperationId
        ? replacement
        : operation,
    ),
  };
}

function effectsForOperation(
  stored: StoredAttempt,
  operationId: string,
): readonly ReviewPublicationExternalEffect[] {
  return [...stored.effects.values()].filter(
    (effect) => effect.publicationOperationId === operationId,
  );
}

function dependencyExternalObjectId(
  stored: StoredAttempt,
  operation: ReviewPublicationOperation,
): string | null {
  if (operation.dependsOnOperationId === null) {
    return null;
  }
  return (
    stored.receipts.get(operation.dependsOnOperationId)
      ?.canonicalExternalObjectId ?? null
  );
}

function attemptFingerprint(attempt: ReviewPublicationAttempt): string {
  return fingerprint({
    publicationAttemptId: attempt.publicationAttemptId,
    permit: attempt.permit,
    operations: attempt.operations.map((operation) =>
      withoutKey(withoutKey(operation, "publicationAttemptId"), "state"),
    ),
    createdAt: attempt.createdAt,
    retainUntil: attempt.retainUntil,
  });
}

function sameEffect(
  effect: ReviewPublicationExternalEffect,
  command: RecordReviewExternalEffectCommand,
): boolean {
  return (
    effect.effectId === command.effectId &&
    effect.reportRequestHash === command.reportRequestHash &&
    effect.externalObjectId === command.externalObjectId &&
    effect.observedObjectHash === command.observedObjectHash &&
    effect.effectKind === command.effectKind
  );
}

function sameNoEffectProof(
  operationAttempt: ReviewPublicationOperationAttempt,
  command: ProveReviewPublicationNoEffectCommand,
): boolean {
  return (
    operationAttempt.noEffectProofId === command.noEffectProofId &&
    operationAttempt.noEffectProofHash === command.noEffectProofHash &&
    operationAttempt.noEffectReason === command.noEffectReason
  );
}

function sameTombstone(
  tombstone: ReviewPublicationAuditTombstone,
  command: TerminalizeUnknownReviewPublicationCommand,
  expected: {
    readonly publicationOperationId: string;
    readonly tombstoneId: string;
    readonly finalOutcome?: Exclude<
      ReviewPublicationTerminalOutcome,
      ReviewPublicationTerminalOutcome.Succeeded
    >;
  } = command,
): boolean {
  return (
    tombstone.tombstoneId === expected.tombstoneId &&
    tombstone.publicationAttemptId === command.publicationAttemptId &&
    tombstone.publicationOperationId === expected.publicationOperationId &&
    tombstone.finalOutcome ===
      (expected.finalOutcome ??
        command.finalOutcome ??
        ReviewPublicationTerminalOutcome.TerminalUnknown) &&
    tombstone.finalReason === command.finalReason &&
    tombstone.lastErrorCode === command.lastErrorCode &&
    tombstone.terminalizedBy === command.terminalizedBy &&
    tombstone.retainUntil.getTime() === command.retainUntil.getTime()
  );
}

function sameTerminalizationTombstonePlan(
  stored: StoredAttempt,
  command: TerminalizeUnknownReviewPublicationCommand,
): boolean {
  const expectedTombstones = [
    {
      publicationOperationId: command.publicationOperationId,
      tombstoneId: command.tombstoneId,
      finalOutcome:
        command.finalOutcome ??
        ReviewPublicationTerminalOutcome.TerminalUnknown,
    },
    ...command.siblingTombstones,
  ];
  return (
    stored.tombstones.size === expectedTombstones.length &&
    expectedTombstones.every((expected) => {
      const tombstone = stored.tombstones.get(expected.publicationOperationId);
      return (
        tombstone !== undefined && sameTombstone(tombstone, command, expected)
      );
    })
  );
}

function terminalizationTombstone(
  stored: StoredAttempt,
  operation: ReviewPublicationOperation,
  tombstoneId: string,
  finalOutcome: Exclude<
    ReviewPublicationTerminalOutcome,
    ReviewPublicationTerminalOutcome.Succeeded
  >,
  command: TerminalizeUnknownReviewPublicationCommand,
): ReviewPublicationAuditTombstone {
  return {
    tombstoneId,
    publicationAttemptId: command.publicationAttemptId,
    publicationOperationId: operation.publicationOperationId,
    reviewRevisionHash: operation.reviewRevisionHash,
    markerHash: operation.markerHash,
    bodyHash: operation.bodyHash,
    knownExternalObjectIds: [
      ...new Set(
        effectsForOperation(stored, operation.publicationOperationId).map(
          (effect) => effect.externalObjectId,
        ),
      ),
    ].sort(),
    finalOutcome,
    finalReason: command.finalReason,
    lastErrorCode: command.lastErrorCode,
    terminalizedBy: command.terminalizedBy,
    terminalizedAt: new Date(command.terminalizedAt),
    retainUntil: new Date(command.retainUntil),
  };
}

function operationStateFor(
  outcome: Exclude<
    ReviewPublicationTerminalOutcome,
    ReviewPublicationTerminalOutcome.Succeeded
  >,
): ReviewPublicationOperationState {
  switch (outcome) {
    case ReviewPublicationTerminalOutcome.SupersededNoEffect:
      return ReviewPublicationOperationState.SupersededNoEffect;
    case ReviewPublicationTerminalOutcome.FailedNoEffect:
      return ReviewPublicationOperationState.FailedNoEffect;
    case ReviewPublicationTerminalOutcome.StaleCompensated:
      return ReviewPublicationOperationState.StaleCompensated;
    case ReviewPublicationTerminalOutcome.StaleVisible:
      return ReviewPublicationOperationState.StaleVisible;
    case ReviewPublicationTerminalOutcome.TerminalUnknown:
      return ReviewPublicationOperationState.TerminalUnknown;
  }
}

function sameCorrection(
  correction: ReviewPublicationOutcomeCorrection,
  command: AdjudicateReviewPublicationOutcomeCommand,
): boolean {
  return (
    correction.correctionId === command.correctionId &&
    correction.correctionOrdinal === command.correctionOrdinal &&
    correction.correctedOutcome === command.correctedOutcome &&
    correction.evidenceHash === command.evidenceHash &&
    correction.safeReason === command.safeReason &&
    correction.correctedBy === command.correctedBy &&
    correction.retainUntil.getTime() === command.retainUntil.getTime()
  );
}

function provenReceiptsMatch(
  stored: StoredAttempt,
  command: AdjudicateReviewPublicationOutcomeCommand,
): boolean {
  return command.provenReceipts.every((proof) => {
    const receipt = stored.receipts.get(proof.publicationOperationId);
    return (
      receipt?.receiptId === proof.receiptId &&
      receipt.canonicalEffectId === proof.canonicalEffectId &&
      receipt.canonicalExternalObjectId === proof.canonicalExternalObjectId &&
      receipt.receiptHash === proof.receiptHash &&
      receipt.updatedAt.getTime() === proof.provenAt.getTime()
    );
  });
}

function expectedCorrectionReason(
  outcome:
    | ReviewPublicationTerminalOutcome.Succeeded
    | ReviewPublicationTerminalOutcome.StaleCompensated
    | ReviewPublicationTerminalOutcome.StaleVisible,
): ReviewPublicationCorrectionReason {
  switch (outcome) {
    case ReviewPublicationTerminalOutcome.Succeeded:
      return ReviewPublicationCorrectionReason.CanonicalEffectsProven;
    case ReviewPublicationTerminalOutcome.StaleCompensated:
      return ReviewPublicationCorrectionReason.StaleEffectCompensated;
    case ReviewPublicationTerminalOutcome.StaleVisible:
      return ReviewPublicationCorrectionReason.StaleEffectVisible;
  }
}

function fingerprint(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function withoutKey<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
}

function copyAttempt(
  attempt: ReviewPublicationAttempt,
): ReviewPublicationAttempt {
  return {
    ...attempt,
    permit: copyPermit(attempt.permit),
    operations: attempt.operations.map(copyOperation),
    createdAt: new Date(attempt.createdAt),
    retainUntil: new Date(attempt.retainUntil),
  };
}

function copyPermit(permit: ReviewPublicationAttempt["permit"]) {
  return {
    ...permit,
    publicationNotAfter: new Date(permit.publicationNotAfter),
  };
}

function copyOperationPlan(
  operation: RequestReviewPublicationCommand["operations"][number],
) {
  return {
    ...operation,
    reconcileUntil: new Date(operation.reconcileUntil),
  };
}

function copyOperation(
  operation: ReviewPublicationOperation,
): ReviewPublicationOperation {
  return {
    ...operation,
    reconcileUntil: new Date(operation.reconcileUntil),
  };
}

function copyClaim(
  claim: ReviewPublicationClaimTerm,
): ReviewPublicationClaimTerm {
  return {
    ...claim,
    acquiredAt: new Date(claim.acquiredAt),
    renewedAt: new Date(claim.renewedAt),
    expiresAt: new Date(claim.expiresAt),
    retainUntil: new Date(claim.retainUntil),
  };
}

function copyOperationAttempt(
  attempt: ReviewPublicationOperationAttempt,
): ReviewPublicationOperationAttempt {
  return {
    ...attempt,
    noEffectProvenAt:
      attempt.noEffectProvenAt === null
        ? null
        : new Date(attempt.noEffectProvenAt),
    startedAt: new Date(attempt.startedAt),
    effectReportUntil: new Date(attempt.effectReportUntil),
    retainUntil: new Date(attempt.retainUntil),
  };
}

function copyEffect(
  effect: ReviewPublicationExternalEffect,
): ReviewPublicationExternalEffect {
  return { ...effect, observedAt: new Date(effect.observedAt) };
}

function copyReceipt(
  receipt: ReviewPublicationReceipt,
): ReviewPublicationReceipt {
  return { ...receipt, updatedAt: new Date(receipt.updatedAt) };
}

function copyTombstone(
  tombstone: ReviewPublicationAuditTombstone,
): ReviewPublicationAuditTombstone {
  return {
    ...tombstone,
    knownExternalObjectIds: [...tombstone.knownExternalObjectIds],
    terminalizedAt: new Date(tombstone.terminalizedAt),
    retainUntil: new Date(tombstone.retainUntil),
  };
}

function copyCorrection(
  correction: ReviewPublicationOutcomeCorrection,
): ReviewPublicationOutcomeCorrection {
  return {
    ...correction,
    correctedAt: new Date(correction.correctedAt),
    retainUntil: new Date(correction.retainUntil),
  };
}
