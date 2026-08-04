import { createHash } from "node:crypto";
import {
  BeginReviewPublicationOperationStatus,
  ClaimReviewPublicationStatus,
  CompleteReviewPublicationOperationStatus,
  RecordReviewExternalEffectStatus,
  RenewReviewPublicationClaimStatus,
  ReviewPublicationAttemptState,
  ReviewPublicationExternalEffectKind,
  ReviewPublicationOperationState,
  ReviewPublicationReceiptStatus,
  ReviewPublicationTerminalOutcome,
  TerminalizeUnknownReviewPublicationStatus,
  operationCapabilityFacts,
  selectCanonicalExternalEffect,
  type ReviewPublicationAttemptView,
  type ReviewPublicationClaimTerm,
  type ReviewPublicationExternalEffect,
  type ReviewPublicationGatewayObject,
  type ReviewPublicationOperation,
  type ReviewPublicationOperationCapabilityFacts,
  type ReviewPublicationPermitIdentity,
} from "@reviewrouter/features-review-publishing/v2";
import {
  ReviewV2PublicationCompensationDecision,
  ReviewV2PublicationExecutionStatus,
  ReviewV2PublicationEffectGateDecision,
  ReviewV2PublicationFreshnessReadStatus,
  ReviewV2ScmCredentialPurpose,
  ReviewV2ScmProvider,
  ReviewV2ScmMutationError,
  ReviewV2ScmMutationFailureOutcome,
  type ReviewV2PublicationExecutionCommand,
  type ReviewV2PublicationExecutionResult,
  type ReviewV2PublicationExecutorDependencies,
  type ReviewV2PublicationExecutorPolicy,
  type ReviewV2PublicationFreshnessRead,
  type ReviewV2PublicationFreshnessSnapshot,
  type ReviewV2ScmGatewaySession,
  type ReviewV2ScmReconciliationGateway,
} from "./review-v2-publication-ports";

const hashPattern = /^[a-f0-9]{64}$/;

type AcquiredClaim = {
  readonly claim: ReviewPublicationClaimTerm;
};

type FreshnessAssessment =
  | {
      readonly status: "current";
      readonly snapshot: ReviewV2PublicationFreshnessSnapshot;
    }
  | {
      readonly status: "changed";
      readonly snapshot: ReviewV2PublicationFreshnessSnapshot | null;
      readonly safeReason: string;
    }
  | {
      readonly status: "unavailable";
      readonly safeReason: string;
    };

type ReconciliationResult =
  | { readonly settled: false }
  | {
      readonly settled: true;
      readonly result: ReviewV2PublicationExecutionResult;
    };

export class ExecuteReviewV2PublicationOperation {
  constructor(
    private readonly dependencies: ReviewV2PublicationExecutorDependencies,
    private readonly policy: ReviewV2PublicationExecutorPolicy,
  ) {
    assertPolicy(policy);
  }

  async execute(
    command: ReviewV2PublicationExecutionCommand,
  ): Promise<ReviewV2PublicationExecutionResult> {
    assertCommand(command);
    let view = await this.dependencies.attempts.findById(
      command.publicationAttemptId,
    );
    if (!view) return manual("publication_attempt_missing");
    const initial = inspectTerminal(view, command.publicationOperationId);
    if (initial) return initial;
    let operation = requireOperation(view, command.publicationOperationId);
    const potentialEffect = mayHaveExternalEffect(view, operation);
    const claimResult = await this.acquireClaim({
      command,
      view,
      operation,
      reconciliationOnly: potentialEffect,
    });
    if ("result" in claimResult) return claimResult.result;
    let claim = claimResult.claim;

    view = await this.dependencies.attempts.findById(
      command.publicationAttemptId,
    );
    if (!view) return manual("publication_attempt_disappeared");
    const afterClaim = inspectTerminal(view, command.publicationOperationId);
    if (afterClaim) return afterClaim;
    operation = requireOperation(view, command.publicationOperationId);
    const persistedClaim = currentClaim(view, claim);
    if (!persistedClaim) {
      return retryable("publication_claim_changed_after_acquire");
    }
    claim = persistedClaim;

    const priorCapability = reconstructLatestOperationCapability(
      view,
      operation,
    );
    if (priorCapability) {
      const reconciled = await this.reconcileBeforeRetry({
        command,
        view,
        operation,
        claim,
        capability: priorCapability,
      });
      if (reconciled.settled) return reconciled.result;
      view = await this.dependencies.attempts.findById(
        command.publicationAttemptId,
      );
      if (!view) return manual("publication_attempt_disappeared");
      operation = requireOperation(view, command.publicationOperationId);
    }

    const beforeBegin = await this.readFreshness(
      command.provider,
      view.attempt.permit,
    );
    if (beforeBegin.status !== "current") {
      if (potentialEffect) {
        return this.terminalizeOrRetry({
          command,
          view,
          operation,
          claim,
          finalReason: "freshness_changed_after_possible_effect",
          lastErrorCode: beforeBegin.safeReason,
        });
      }
      return beforeBegin.status === "unavailable"
        ? retryable(beforeBegin.safeReason)
        : this.terminalizeKnownOutcome({
            command,
            operation,
            claim,
            finalOutcome: ReviewPublicationTerminalOutcome.SupersededNoEffect,
            finalReason: "publication_live_facts_superseded",
            lastErrorCode: beforeBegin.safeReason,
          });
    }
    if (this.dependencies.clock.now() >= operation.reconcileUntil) {
      return potentialEffect
        ? this.terminalizeOrRetry({
            command,
            view,
            operation,
            claim,
            finalReason: "reconciliation_window_exhausted",
            lastErrorCode: "publication_retry_window_exhausted",
          })
        : this.terminalizeKnownOutcome({
            command,
            operation,
            claim,
            finalOutcome: ReviewPublicationTerminalOutcome.FailedNoEffect,
            finalReason: "publication_operation_window_exhausted",
            lastErrorCode: "publication_operation_window_exhausted",
          });
    }

    const signingKeyId =
      await this.dependencies.capabilityIdentity.activeSigningKeyId();
    assertIdentifier(signingKeyId, "publication_capability_key_invalid");
    const beginCommand = buildBeginCommand({
      view,
      operation,
      claim,
      signingKeyId,
    });
    let begun;
    try {
      begun = await this.dependencies.application.beginOperation(beginCommand);
    } catch {
      return this.terminalizeKnownOutcome({
        command,
        operation,
        claim,
        finalOutcome: ReviewPublicationTerminalOutcome.SupersededNoEffect,
        finalReason: "publication_begin_gate_rejected",
        lastErrorCode: "publication_begin_gate_rejected",
      });
    }
    if (
      begun.status !== BeginReviewPublicationOperationStatus.Begun &&
      begun.status !== BeginReviewPublicationOperationStatus.Restored
    ) {
      return mapBeginFailure(begun.status);
    }

    const capability = begun.capability;
    const credentialLease = await this.renewForMutation(command, claim);
    if ("result" in credentialLease) return credentialLease.result;
    claim = credentialLease.claim;
    const credentialFreshness = await this.readFreshness(
      command.provider,
      begun.attempt.permit,
    );
    if (credentialFreshness.status !== "current") {
      return credentialFreshness.status === "unavailable"
        ? retryable(credentialFreshness.safeReason)
        : this.terminalizeKnownOutcome({
            command,
            operation: begun.operation,
            claim,
            finalOutcome: ReviewPublicationTerminalOutcome.SupersededNoEffect,
            finalReason: "publication_live_facts_superseded",
            lastErrorCode: credentialFreshness.safeReason,
          });
    }
    let signedCapability;
    try {
      signedCapability = await this.dependencies.operationCapabilities.issue({
        permit: begun.attempt.permit,
        operation: begun.operation,
        capability,
        claim,
      });
    } catch {
      return retryable("publication_operation_capability_unavailable");
    }
    let mutationSession: ReviewV2ScmGatewaySession;
    try {
      mutationSession = await this.dependencies.credentials.acquire({
        provider: command.provider,
        purpose: ReviewV2ScmCredentialPurpose.Mutate,
        permit: begun.attempt.permit,
        operation: begun.operation,
        capability,
        claim,
        signedCapability,
      });
    } catch {
      return retryable("publication_mutation_credential_unavailable");
    }
    try {
      if (mutationSession.purpose !== ReviewV2ScmCredentialPurpose.Mutate) {
        return manual("publication_mutation_credential_scope_invalid");
      }
      let inventory: readonly ReviewPublicationGatewayObject[];
      try {
        inventory = await this.loadInventory(
          mutationSession.gateway,
          begun.operation,
        );
      } catch {
        return manual("publication_marker_inventory_invalid");
      }
      if (hasCurrentOperationObject(inventory, begun.operation)) {
        return this.settleInventory({
          command,
          operation: begun.operation,
          claim,
          capability,
          gateway: mutationSession.gateway,
          inventory,
          effectKind: ReviewPublicationExternalEffectKind.MarkerReconciled,
        });
      }

      let applied: ReviewPublicationGatewayObject;
      const mutationLease = await this.renewForMutation(command, claim);
      if ("result" in mutationLease) return mutationLease.result;
      claim = mutationLease.claim;
      const immediatelyBeforeMutation = await this.readFreshness(
        command.provider,
        begun.attempt.permit,
      );
      if (immediatelyBeforeMutation.status !== "current") {
        return immediatelyBeforeMutation.status === "unavailable"
          ? retryable(immediatelyBeforeMutation.safeReason)
          : this.terminalizeKnownOutcome({
              command,
              operation: begun.operation,
              claim,
              finalOutcome: ReviewPublicationTerminalOutcome.SupersededNoEffect,
              finalReason: "publication_live_facts_superseded",
              lastErrorCode: immediatelyBeforeMutation.safeReason,
            });
      }
      const finalMutationLease = await this.renewForMutation(command, claim);
      if ("result" in finalMutationLease) return finalMutationLease.result;
      claim = finalMutationLease.claim;
      const effectDecision = await this.authorizeEffect(
        command.provider,
        begun.attempt.permit,
        begun.operation,
      );
      if (
        effectDecision === ReviewV2PublicationEffectGateDecision.Unavailable
      ) {
        return retryable("publication_effect_gate_unavailable");
      }
      if (effectDecision === ReviewV2PublicationEffectGateDecision.Disabled) {
        return this.terminalizeKnownOutcome({
          command,
          operation: begun.operation,
          claim,
          finalOutcome: ReviewPublicationTerminalOutcome.FailedNoEffect,
          finalReason: "publication_effect_gate_disabled",
          lastErrorCode: "publication_effect_gate_disabled",
        });
      }
      try {
        applied = await mutationSession.gateway.applyOperation({
          operation: begun.operation,
          capability,
        });
      } catch (error) {
        return this.reconcileAfterMutationFailure({
          command,
          operation: begun.operation,
          claim,
          capability,
          gateway: mutationSession.gateway,
          error,
        });
      }
      validateGatewayObject(applied, begun.operation);

      const effect = await this.recordOrRestoreEffect({
        operation: begun.operation,
        capability,
        object: applied,
        effectKind: ReviewPublicationExternalEffectKind.MutationAcknowledged,
      });
      if (!effect) {
        return this.terminalizeKnownAmbiguity({
          command,
          operation: begun.operation,
          claim,
          finalReason: "acknowledged_effect_record_failed",
          lastErrorCode: "effect_record_failed",
        });
      }

      const afterMutation = await this.readFreshness(
        command.provider,
        begun.attempt.permit,
      );
      let observed: readonly ReviewPublicationGatewayObject[];
      try {
        observed = await this.loadInventory(
          mutationSession.gateway,
          begun.operation,
        );
      } catch {
        return this.terminalizeKnownAmbiguity({
          command,
          operation: begun.operation,
          claim,
          finalReason: "post_mutation_inventory_invalid",
          lastErrorCode: "marker_inventory_invalid",
        });
      }
      const inventoryAfterMutation = mergeGatewayObjects(observed, [applied]);
      if (afterMutation.status !== "current") {
        return this.handleStaleKnownEffect({
          command,
          operation: begun.operation,
          claim,
          permit: begun.attempt.permit,
          gateway: mutationSession.gateway,
          inventory: inventoryAfterMutation,
          freshness: afterMutation,
          lastErrorCode: "post_mutation_freshness_changed",
        });
      }
      return this.settleInventory({
        command,
        operation: begun.operation,
        claim,
        capability,
        gateway: mutationSession.gateway,
        inventory: inventoryAfterMutation,
        effectKind: ReviewPublicationExternalEffectKind.MutationAcknowledged,
      });
    } finally {
      await closeSession(mutationSession);
    }
  }

  private async acquireClaim(input: {
    readonly command: ReviewV2PublicationExecutionCommand;
    readonly view: ReviewPublicationAttemptView;
    readonly operation: ReviewPublicationOperation;
    readonly reconciliationOnly: boolean;
  }): Promise<
    AcquiredClaim | { readonly result: ReviewV2PublicationExecutionResult }
  > {
    const now = this.dependencies.clock.now();
    const active = input.view.activeClaim;
    if (active && active.expiresAt > now) {
      if (active.ownerIdHash !== input.command.ownerIdHash) {
        return { result: busy("publication_claim_owned_elsewhere") };
      }
      return {
        claim: active,
      };
    }

    const signingKeyId =
      await this.dependencies.capabilityIdentity.activeSigningKeyId();
    assertIdentifier(signingKeyId, "publication_capability_key_invalid");
    const claimCommand = buildClaimCommand({
      view: input.view,
      operation: input.operation,
      ownerIdHash: input.command.ownerIdHash,
      signingKeyId,
      now,
      claimDurationMs: this.policy.claimDurationMs,
    });
    let claimed;
    try {
      claimed = input.reconciliationOnly
        ? await this.dependencies.application.claimForReconciliation(
            claimCommand,
          )
        : await this.dependencies.application.claim(claimCommand);
    } catch {
      return {
        result: input.reconciliationOnly
          ? manual("publication_reconciliation_claim_rejected")
          : await this.terminalizeUnclaimedNoEffect({
              command: input.command,
              view: input.view,
              operation: input.operation,
              finalReason: "publication_claim_gate_rejected",
              lastErrorCode: "publication_claim_gate_rejected",
            }),
      };
    }
    if (
      claimed.status === ClaimReviewPublicationStatus.Acquired ||
      claimed.status === ClaimReviewPublicationStatus.Restored
    ) {
      return {
        claim: claimed.claim,
      };
    }
    switch (claimed.status) {
      case ClaimReviewPublicationStatus.AlreadyClaimed:
        return { result: busy("publication_claim_owned_elsewhere") };
      case ClaimReviewPublicationStatus.VersionConflict:
        return { result: retryable("publication_claim_version_conflict") };
      case ClaimReviewPublicationStatus.Terminal:
        return {
          result: manual("publication_attempt_terminal_without_receipt"),
        };
      case ClaimReviewPublicationStatus.Missing:
        return { result: manual("publication_attempt_missing") };
      case ClaimReviewPublicationStatus.RequestConflict:
        return { result: manual("publication_claim_request_conflict") };
    }
  }

  private async reconcileBeforeRetry(input: {
    readonly command: ReviewV2PublicationExecutionCommand;
    readonly view: ReviewPublicationAttemptView;
    readonly operation: ReviewPublicationOperation;
    readonly claim: ReviewPublicationClaimTerm;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
  }): Promise<ReconciliationResult> {
    if (this.dependencies.clock.now() >= input.operation.reconcileUntil) {
      return {
        settled: true,
        result: await this.terminalizeOrRetry({
          command: input.command,
          view: input.view,
          operation: input.operation,
          claim: input.claim,
          finalReason: "reconciliation_window_exhausted",
          lastErrorCode: "publication_retry_window_exhausted",
        }),
      };
    }
    const renewed = await this.renewForMutation(input.command, input.claim);
    if ("result" in renewed) {
      return { settled: true, result: renewed.result };
    }
    const claim = renewed.claim;
    const credentialFreshness = await this.readFreshness(
      input.command.provider,
      input.view.attempt.permit,
    );
    if (credentialFreshness.status === "unavailable") {
      return {
        settled: true,
        result: retryable(credentialFreshness.safeReason),
      };
    }
    let signedCapability;
    try {
      signedCapability = await this.dependencies.operationCapabilities.issue({
        permit: input.view.attempt.permit,
        operation: input.operation,
        capability: input.capability,
        claim,
      });
    } catch {
      return {
        settled: true,
        result: retryable("publication_operation_capability_unavailable"),
      };
    }
    let session: ReviewV2ScmGatewaySession;
    try {
      session = await this.dependencies.credentials.acquire({
        provider: input.command.provider,
        purpose: ReviewV2ScmCredentialPurpose.ReconcileOnly,
        permit: input.view.attempt.permit,
        operation: input.operation,
        capability: input.capability,
        claim,
        signedCapability,
      });
    } catch {
      return {
        settled: true,
        result: await this.terminalizeOrRetry({
          command: input.command,
          view: input.view,
          operation: input.operation,
          claim,
          finalReason: "reconciliation_credential_unavailable",
          lastErrorCode: "scm_credential_unavailable",
        }),
      };
    }
    try {
      let inventory: readonly ReviewPublicationGatewayObject[];
      try {
        inventory = await this.loadInventory(session.gateway, input.operation);
      } catch {
        return {
          settled: true,
          result: await this.terminalizeOrRetry({
            command: input.command,
            view: input.view,
            operation: input.operation,
            claim,
            finalReason: "reconciliation_inventory_invalid",
            lastErrorCode: "marker_inventory_invalid",
          }),
        };
      }
      if (!hasCurrentOperationObject(inventory, input.operation)) {
        const freshness = await this.readFreshness(
          input.command.provider,
          input.view.attempt.permit,
        );
        if (
          freshness.status === "current" &&
          this.dependencies.clock.now() < input.operation.reconcileUntil
        ) {
          return { settled: false };
        }
        return {
          settled: true,
          result: await this.terminalizeOrRetry({
            command: input.command,
            view: input.view,
            operation: input.operation,
            claim,
            finalReason: "reconciliation_inventory_empty",
            lastErrorCode:
              freshness.status === "current"
                ? "publication_retry_window_exhausted"
                : freshness.safeReason,
          }),
        };
      }
      return {
        settled: true,
        result: await this.settleInventory({
          command: input.command,
          operation: input.operation,
          claim,
          capability: input.capability,
          gateway: session.gateway,
          inventory,
          effectKind: ReviewPublicationExternalEffectKind.MarkerReconciled,
        }),
      };
    } finally {
      await closeSession(session);
    }
  }

  private async reconcileAfterMutationFailure(input: {
    readonly command: ReviewV2PublicationExecutionCommand;
    readonly operation: ReviewPublicationOperation;
    readonly claim: ReviewPublicationClaimTerm;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
    readonly gateway: ReviewV2ScmReconciliationGateway;
    readonly error: unknown;
  }): Promise<ReviewV2PublicationExecutionResult> {
    if (
      input.error instanceof ReviewV2ScmMutationError &&
      input.error.outcome ===
        ReviewV2ScmMutationFailureOutcome.DefinitelyNoEffect
    ) {
      return input.error.retryable
        ? retryable(input.error.safeCode)
        : this.terminalizeKnownOutcome({
            command: input.command,
            operation: input.operation,
            claim: input.claim,
            finalOutcome: ReviewPublicationTerminalOutcome.FailedNoEffect,
            finalReason: "scm_mutation_rejected_no_effect",
            lastErrorCode: input.error.safeCode,
          });
    }
    const errorCode =
      input.error instanceof ReviewV2ScmMutationError
        ? input.error.safeCode
        : "scm_mutation_outcome_unknown";
    let inventory: readonly ReviewPublicationGatewayObject[];
    try {
      inventory = await this.loadInventory(input.gateway, input.operation);
    } catch {
      return this.terminalizeKnownAmbiguity({
        command: input.command,
        operation: input.operation,
        claim: input.claim,
        finalReason: "mutation_reconciliation_inventory_invalid",
        lastErrorCode: errorCode,
      });
    }
    if (hasCurrentOperationObject(inventory, input.operation)) {
      return this.settleInventory({
        command: input.command,
        operation: input.operation,
        claim: input.claim,
        capability: input.capability,
        gateway: input.gateway,
        inventory,
        effectKind: ReviewPublicationExternalEffectKind.MarkerReconciled,
      });
    }
    return this.terminalizeKnownAmbiguity({
      command: input.command,
      operation: input.operation,
      claim: input.claim,
      finalReason: "scm_mutation_outcome_unknown",
      lastErrorCode: errorCode,
    });
  }

  private async settleInventory(input: {
    readonly command: ReviewV2PublicationExecutionCommand;
    readonly operation: ReviewPublicationOperation;
    readonly claim: ReviewPublicationClaimTerm;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
    readonly gateway: ReviewV2ScmReconciliationGateway;
    readonly inventory: readonly ReviewPublicationGatewayObject[];
    readonly effectKind: ReviewPublicationExternalEffectKind;
  }): Promise<ReviewV2PublicationExecutionResult> {
    const objects = normalizeInventory(input.inventory, input.operation);
    if (objects.length === 0) {
      return retryable("publication_marker_inventory_empty");
    }
    const currentObjects = currentOperationObjects(objects, input.operation);
    if (currentObjects.length === 0) {
      return retryable("publication_current_marker_not_visible");
    }
    if (
      input.capability.targetExternalObjectId !== null &&
      objects.some(
        (object) =>
          object.externalObjectId !== input.capability.targetExternalObjectId,
      )
    ) {
      return this.terminalizeKnownAmbiguity({
        command: input.command,
        operation: input.operation,
        claim: input.claim,
        finalReason: "publication_dependency_target_conflict",
        lastErrorCode: "marker_target_conflict",
      });
    }

    let view = await this.dependencies.attempts.findById(
      input.command.publicationAttemptId,
    );
    if (!view) return manual("publication_attempt_disappeared");
    let effect = canonicalVisibleEffect(view, input.operation, currentObjects);
    if (!effect) {
      const preferred = currentObjects[0];
      if (!preferred) return retryable("publication_marker_inventory_empty");
      await this.recordOrRestoreEffect({
        operation: input.operation,
        capability: input.capability,
        object: preferred,
        effectKind: input.effectKind,
      });
      view = await this.dependencies.attempts.findById(
        input.command.publicationAttemptId,
      );
      if (!view) return manual("publication_attempt_disappeared");
      effect = canonicalVisibleEffect(view, input.operation, currentObjects);
    }
    if (!effect) {
      return this.terminalizeKnownAmbiguity({
        command: input.command,
        operation: input.operation,
        claim: input.claim,
        finalReason: "marker_effect_not_recordable",
        lastErrorCode: "effect_record_failed",
      });
    }
    const canonicalObject = objects.find(
      (object) => object.externalObjectId === effect.externalObjectId,
    );
    if (!canonicalObject) {
      return this.terminalizeKnownAmbiguity({
        command: input.command,
        operation: input.operation,
        claim: input.claim,
        finalReason: "canonical_effect_not_in_inventory",
        lastErrorCode: "marker_inventory_drift",
      });
    }
    const duplicates = objects.filter(
      (object) => object.externalObjectId !== canonicalObject.externalObjectId,
    );
    const freshness = await this.readFreshness(
      input.command.provider,
      view.attempt.permit,
    );
    if (freshness.status !== "current") {
      return this.handleStaleKnownEffect({
        command: input.command,
        operation: input.operation,
        claim: input.claim,
        permit: view.attempt.permit,
        gateway: input.gateway,
        inventory: objects,
        freshness,
        lastErrorCode: "publication_freshness_changed",
      });
    }

    if (duplicates.length > 0) {
      let cleanupStatus: ReviewPublicationReceiptStatus;
      let cleanupClaim = input.claim;
      try {
        const cleanupLease = await this.renewForMutation(
          input.command,
          input.claim,
        );
        if ("result" in cleanupLease) return cleanupLease.result;
        cleanupClaim = cleanupLease.claim;
        const immediatelyBeforeCleanup = await this.readFreshness(
          input.command.provider,
          view.attempt.permit,
        );
        if (
          immediatelyBeforeCleanup.status !== "current" ||
          !sameFreshness(freshness.snapshot, immediatelyBeforeCleanup.snapshot)
        ) {
          return this.handleStaleKnownEffect({
            command: input.command,
            operation: input.operation,
            claim: cleanupClaim,
            permit: view.attempt.permit,
            gateway: input.gateway,
            inventory: objects,
            freshness:
              immediatelyBeforeCleanup.status === "current"
                ? {
                    status: "changed",
                    snapshot: immediatelyBeforeCleanup.snapshot,
                    safeReason: "publication_live_facts_changed",
                  }
                : immediatelyBeforeCleanup,
            lastErrorCode: "pre_cleanup_freshness_changed",
          });
        }
        const finalCleanupLease = await this.renewForMutation(
          input.command,
          cleanupClaim,
        );
        if ("result" in finalCleanupLease) return finalCleanupLease.result;
        cleanupClaim = finalCleanupLease.claim;
        const cleanupDecision = await this.authorizeEffect(
          input.command.provider,
          view.attempt.permit,
          input.operation,
        );
        if (cleanupDecision !== ReviewV2PublicationEffectGateDecision.Allowed) {
          return cleanupDecision ===
            ReviewV2PublicationEffectGateDecision.Unavailable
            ? retryable("publication_effect_gate_unavailable")
            : manual("publication_effect_gate_disabled");
        }
        cleanupStatus = await input.gateway.markStaleOrDelete({
          operation: input.operation,
          canonicalExternalObjectId: canonicalObject.externalObjectId,
          duplicateExternalObjectIds: duplicates.map(
            (object) => object.externalObjectId,
          ),
          compensateCanonical: false,
        });
      } catch {
        return this.terminalizeKnownAmbiguity({
          command: input.command,
          operation: input.operation,
          claim: cleanupClaim,
          finalReason: "duplicate_cleanup_outcome_unknown",
          lastErrorCode: "duplicate_cleanup_request_failed",
        });
      }
      const afterCleanup = await this.readFreshness(
        input.command.provider,
        view.attempt.permit,
      );
      if (
        cleanupStatus !== ReviewPublicationReceiptStatus.Succeeded ||
        afterCleanup.status !== "current" ||
        !sameFreshness(freshness.snapshot, afterCleanup.snapshot)
      ) {
        return this.terminalizeKnownAmbiguity({
          command: input.command,
          operation: input.operation,
          claim: cleanupClaim,
          finalReason: "duplicate_cleanup_not_converged",
          lastErrorCode: "duplicate_cleanup_uncertain",
        });
      }
    }

    const finalFreshness = await this.readFreshness(
      input.command.provider,
      view.attempt.permit,
    );
    if (finalFreshness.status !== "current") {
      return this.handleStaleKnownEffect({
        command: input.command,
        operation: input.operation,
        claim: input.claim,
        permit: view.attempt.permit,
        gateway: input.gateway,
        inventory: objects,
        freshness: finalFreshness,
        lastErrorCode: "pre_completion_freshness_changed",
      });
    }
    view = await this.dependencies.attempts.findById(
      input.command.publicationAttemptId,
    );
    if (!view) return manual("publication_attempt_disappeared");
    const completion = buildCompletionCommand({
      view,
      operation: input.operation,
      claim: input.claim,
      effect,
    });
    let completed;
    try {
      completed =
        await this.dependencies.application.completeOperation(completion);
    } catch {
      return retryable("publication_completion_ack_unknown");
    }
    switch (completed.status) {
      case CompleteReviewPublicationOperationStatus.Completed:
      case CompleteReviewPublicationOperationStatus.Restored:
        return {
          status: ReviewV2PublicationExecutionStatus.Completed,
          safeReason: "publication_operation_completed",
          receiptStatus: completed.receipt.status,
        };
      case CompleteReviewPublicationOperationStatus.VersionConflict:
      case CompleteReviewPublicationOperationStatus.StaleClaim:
        return retryable(`publication_completion_${completed.status}`);
      case CompleteReviewPublicationOperationStatus.Terminal:
        return manual("publication_attempt_terminal_without_receipt");
      case CompleteReviewPublicationOperationStatus.Missing:
      case CompleteReviewPublicationOperationStatus.RequestConflict:
      case CompleteReviewPublicationOperationStatus.CanonicalEffectConflict:
        return manual(`publication_completion_${completed.status}`);
    }
  }

  private async handleStaleKnownEffect(input: {
    readonly command: ReviewV2PublicationExecutionCommand;
    readonly operation: ReviewPublicationOperation;
    readonly claim: ReviewPublicationClaimTerm;
    readonly permit: ReviewPublicationPermitIdentity;
    readonly gateway: ReviewV2ScmReconciliationGateway;
    readonly inventory: readonly ReviewPublicationGatewayObject[];
    readonly freshness: Exclude<
      FreshnessAssessment,
      { readonly status: "current" }
    >;
    readonly lastErrorCode: string;
  }): Promise<ReviewV2PublicationExecutionResult> {
    const objects = normalizeInventory(input.inventory, input.operation);
    const currentObjects = currentOperationObjects(objects, input.operation);
    if (input.freshness.status === "changed" && input.freshness.snapshot) {
      const canonicalObject = currentObjects[0];
      if (canonicalObject) {
        const duplicates = objects.filter(
          (object) =>
            object.externalObjectId !== canonicalObject.externalObjectId,
        );
        const decision = await this.dependencies.compensation.decide({
          operation: input.operation,
          canonicalObject,
          duplicateObjects: duplicates,
          liveFacts: input.freshness.snapshot,
        });
        if (decision === ReviewV2PublicationCompensationDecision.Allowed) {
          let compensationClaim = input.claim;
          try {
            const compensationLease = await this.renewForMutation(
              input.command,
              input.claim,
            );
            if ("result" in compensationLease) {
              return compensationLease.result;
            }
            compensationClaim = compensationLease.claim;
            const immediatelyBeforeCompensation = await this.readFreshness(
              input.command.provider,
              input.permit,
            );
            if (
              immediatelyBeforeCompensation.status !== "changed" ||
              immediatelyBeforeCompensation.snapshot === null ||
              !sameFreshness(
                input.freshness.snapshot,
                immediatelyBeforeCompensation.snapshot,
              )
            ) {
              return this.terminalizeKnownAmbiguity({
                command: input.command,
                operation: input.operation,
                claim: compensationClaim,
                finalReason: "compensation_precheck_changed",
                lastErrorCode: "compensation_freshness_changed",
              });
            }
            const finalCompensationLease = await this.renewForMutation(
              input.command,
              compensationClaim,
            );
            if ("result" in finalCompensationLease) {
              return finalCompensationLease.result;
            }
            compensationClaim = finalCompensationLease.claim;
            const compensationEffectDecision = await this.authorizeEffect(
              input.command.provider,
              input.permit,
              input.operation,
            );
            if (
              compensationEffectDecision !==
              ReviewV2PublicationEffectGateDecision.Allowed
            ) {
              return compensationEffectDecision ===
                ReviewV2PublicationEffectGateDecision.Unavailable
                ? retryable("publication_effect_gate_unavailable")
                : manual("publication_effect_gate_disabled");
            }
            const compensationStatus = await input.gateway.markStaleOrDelete({
              operation: input.operation,
              canonicalExternalObjectId: canonicalObject.externalObjectId,
              duplicateExternalObjectIds: duplicates.map(
                (object) => object.externalObjectId,
              ),
              compensateCanonical: true,
            });
            if (
              compensationStatus === ReviewPublicationReceiptStatus.StaleVisible
            ) {
              return this.terminalizeKnownOutcome({
                command: input.command,
                operation: input.operation,
                claim: compensationClaim,
                finalOutcome: ReviewPublicationTerminalOutcome.StaleVisible,
                finalReason: "stale_effect_remains_visible",
                lastErrorCode: input.lastErrorCode,
              });
            }
          } catch {
            return this.terminalizeKnownAmbiguity({
              command: input.command,
              operation: input.operation,
              claim: compensationClaim,
              finalReason: "compensation_outcome_unknown",
              lastErrorCode: "compensation_request_failed",
            });
          }
          try {
            const remaining = await this.loadInventory(
              input.gateway,
              input.operation,
            );
            if (
              remaining.some(
                (object) =>
                  object.externalObjectId === canonicalObject.externalObjectId,
              )
            ) {
              return this.terminalizeKnownOutcome({
                command: input.command,
                operation: input.operation,
                claim: compensationClaim,
                finalOutcome: ReviewPublicationTerminalOutcome.StaleVisible,
                finalReason: "stale_effect_remains_visible",
                lastErrorCode: input.lastErrorCode,
              });
            }
          } catch {
            return this.terminalizeKnownAmbiguity({
              command: input.command,
              operation: input.operation,
              claim: compensationClaim,
              finalReason: "compensation_inventory_unavailable",
              lastErrorCode: "compensation_inventory_unavailable",
            });
          }
          let afterCompensation: ReviewV2PublicationFreshnessRead;
          try {
            afterCompensation = await this.dependencies.freshness.read(
              input.command.provider,
              input.permit,
            );
          } catch {
            return this.terminalizeKnownAmbiguity({
              command: input.command,
              operation: input.operation,
              claim: compensationClaim,
              finalReason: "compensation_postcheck_unavailable",
              lastErrorCode: "freshness_read_failed",
            });
          }
          if (
            afterCompensation.status !==
              ReviewV2PublicationFreshnessReadStatus.Available ||
            !sameFreshness(input.freshness.snapshot, afterCompensation.snapshot)
          ) {
            return this.terminalizeKnownAmbiguity({
              command: input.command,
              operation: input.operation,
              claim: compensationClaim,
              finalReason: "compensation_postcheck_changed",
              lastErrorCode: "compensation_outcome_uncertain",
            });
          }
          return this.terminalizeKnownOutcome({
            command: input.command,
            operation: input.operation,
            claim: compensationClaim,
            finalOutcome: ReviewPublicationTerminalOutcome.StaleCompensated,
            finalReason: "stale_effect_compensated",
            lastErrorCode: input.lastErrorCode,
          });
        }
      }
    }
    return this.terminalizeKnownAmbiguity({
      command: input.command,
      operation: input.operation,
      claim: input.claim,
      finalReason: "stale_effect_requires_manual_reconciliation",
      lastErrorCode: input.lastErrorCode,
    });
  }

  private async authorizeEffect(
    provider: ReviewV2ScmProvider,
    permit: ReviewPublicationPermitIdentity,
    operation: ReviewPublicationOperation,
  ): Promise<ReviewV2PublicationEffectGateDecision> {
    try {
      return await this.dependencies.effectGate.authorize({
        provider,
        permit,
        operation,
      });
    } catch {
      return ReviewV2PublicationEffectGateDecision.Unavailable;
    }
  }

  private async terminalizeKnownAmbiguity(input: {
    readonly command: ReviewV2PublicationExecutionCommand;
    readonly operation: ReviewPublicationOperation;
    readonly claim: ReviewPublicationClaimTerm;
    readonly finalReason: string;
    readonly lastErrorCode: string;
  }): Promise<ReviewV2PublicationExecutionResult> {
    const view = await this.dependencies.attempts.findById(
      input.command.publicationAttemptId,
    );
    if (!view) return manual("publication_attempt_disappeared");
    return this.terminalizeOrRetry({ ...input, view });
  }

  private async terminalizeKnownOutcome(input: {
    readonly command: ReviewV2PublicationExecutionCommand;
    readonly operation: ReviewPublicationOperation;
    readonly claim: ReviewPublicationClaimTerm;
    readonly finalOutcome:
      | ReviewPublicationTerminalOutcome.SupersededNoEffect
      | ReviewPublicationTerminalOutcome.FailedNoEffect
      | ReviewPublicationTerminalOutcome.StaleCompensated
      | ReviewPublicationTerminalOutcome.StaleVisible;
    readonly finalReason: string;
    readonly lastErrorCode: string;
  }): Promise<ReviewV2PublicationExecutionResult> {
    const view = await this.dependencies.attempts.findById(
      input.command.publicationAttemptId,
    );
    if (!view) return manual("publication_attempt_disappeared");
    let terminalized;
    try {
      terminalized = await this.dependencies.application.terminalizeUnknown({
        publicationAttemptId: input.command.publicationAttemptId,
        publicationOperationId: input.operation.publicationOperationId,
        expectedAttemptVersion: view.attempt.version,
        claimId: input.claim.claimId,
        claimFencingToken: input.claim.fencingToken,
        tombstoneId: deterministicId(
          "tombstone",
          `${input.command.publicationAttemptId}\0${input.operation.publicationOperationId}`,
        ),
        finalOutcome: input.finalOutcome,
        finalReason: safeIdentifier(
          input.finalReason,
          "publication_terminal_outcome",
        ),
        lastErrorCode: safeIdentifier(input.lastErrorCode, "unknown_error"),
        terminalizedBy: `worker:${input.command.ownerIdHash}`,
        retainUntil: view.attempt.retainUntil,
      });
    } catch {
      return retryable("publication_terminal_outcome_ack_unknown");
    }
    switch (terminalized.status) {
      case TerminalizeUnknownReviewPublicationStatus.Terminalized:
      case TerminalizeUnknownReviewPublicationStatus.Restored:
        return {
          status: ReviewV2PublicationExecutionStatus.Terminalized,
          safeReason: input.finalReason,
          terminalOutcome: input.finalOutcome,
        };
      case TerminalizeUnknownReviewPublicationStatus.VersionConflict:
      case TerminalizeUnknownReviewPublicationStatus.StaleClaim:
        return retryable(`publication_terminal_outcome_${terminalized.status}`);
      case TerminalizeUnknownReviewPublicationStatus.Missing:
      case TerminalizeUnknownReviewPublicationStatus.TooEarly:
      case TerminalizeUnknownReviewPublicationStatus.Conflict:
        return manual(`publication_terminal_outcome_${terminalized.status}`);
    }
  }

  private async terminalizeUnclaimedNoEffect(input: {
    readonly command: ReviewV2PublicationExecutionCommand;
    readonly view: ReviewPublicationAttemptView;
    readonly operation: ReviewPublicationOperation;
    readonly finalReason: string;
    readonly lastErrorCode: string;
  }): Promise<ReviewV2PublicationExecutionResult> {
    let terminalized;
    try {
      terminalized = await this.dependencies.application.terminalizeUnknown({
        publicationAttemptId: input.command.publicationAttemptId,
        publicationOperationId: input.operation.publicationOperationId,
        expectedAttemptVersion: input.view.attempt.version,
        claimId: null,
        claimFencingToken: null,
        tombstoneId: deterministicId(
          "tombstone",
          `${input.command.publicationAttemptId}\0${input.operation.publicationOperationId}`,
        ),
        finalOutcome: ReviewPublicationTerminalOutcome.SupersededNoEffect,
        finalReason: input.finalReason,
        lastErrorCode: input.lastErrorCode,
        terminalizedBy: `worker:${input.command.ownerIdHash}`,
        retainUntil: input.view.attempt.retainUntil,
      });
    } catch {
      return manual("publication_unclaimed_terminalization_unavailable");
    }
    return terminalized.status ===
      TerminalizeUnknownReviewPublicationStatus.Terminalized ||
      terminalized.status === TerminalizeUnknownReviewPublicationStatus.Restored
      ? {
          status: ReviewV2PublicationExecutionStatus.Terminalized,
          safeReason: input.finalReason,
          terminalOutcome: ReviewPublicationTerminalOutcome.SupersededNoEffect,
        }
      : manual(`publication_unclaimed_terminalization_${terminalized.status}`);
  }

  private async terminalizeOrRetry(input: {
    readonly command: ReviewV2PublicationExecutionCommand;
    readonly view: ReviewPublicationAttemptView;
    readonly operation: ReviewPublicationOperation;
    readonly claim: ReviewPublicationClaimTerm;
    readonly finalReason: string;
    readonly lastErrorCode: string;
  }): Promise<ReviewV2PublicationExecutionResult> {
    if (this.dependencies.clock.now() < input.operation.reconcileUntil) {
      return retryable(input.lastErrorCode);
    }
    let terminalized;
    try {
      terminalized = await this.dependencies.application.terminalizeUnknown({
        publicationAttemptId: input.command.publicationAttemptId,
        publicationOperationId: input.operation.publicationOperationId,
        expectedAttemptVersion: input.view.attempt.version,
        claimId: input.claim.claimId,
        claimFencingToken: input.claim.fencingToken,
        tombstoneId: deterministicId(
          "tombstone",
          `${input.command.publicationAttemptId}\0${input.operation.publicationOperationId}`,
        ),
        finalReason: safeIdentifier(
          input.finalReason,
          "publication_outcome_unknown",
        ),
        lastErrorCode: safeIdentifier(input.lastErrorCode, "unknown_error"),
        terminalizedBy: `worker:${input.command.ownerIdHash}`,
        retainUntil: input.view.attempt.retainUntil,
      });
    } catch {
      return retryable("publication_terminalize_ack_unknown");
    }
    switch (terminalized.status) {
      case TerminalizeUnknownReviewPublicationStatus.Terminalized:
      case TerminalizeUnknownReviewPublicationStatus.Restored:
        return {
          status: ReviewV2PublicationExecutionStatus.TerminalUnknown,
          safeReason: "publication_terminal_unknown_manual_review_required",
        };
      case TerminalizeUnknownReviewPublicationStatus.TooEarly:
      case TerminalizeUnknownReviewPublicationStatus.VersionConflict:
      case TerminalizeUnknownReviewPublicationStatus.StaleClaim:
        return retryable(`publication_terminalize_${terminalized.status}`);
      case TerminalizeUnknownReviewPublicationStatus.Missing:
      case TerminalizeUnknownReviewPublicationStatus.Conflict:
        return manual(`publication_terminalize_${terminalized.status}`);
    }
  }

  private async recordOrRestoreEffect(input: {
    readonly operation: ReviewPublicationOperation;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
    readonly object: ReviewPublicationGatewayObject;
    readonly effectKind: ReviewPublicationExternalEffectKind;
  }): Promise<ReviewPublicationExternalEffect | null> {
    const view = await this.dependencies.attempts.findById(
      input.operation.publicationAttemptId,
    );
    const existing = view?.effects.find(
      (effect) =>
        effect.publicationOperationId ===
          input.operation.publicationOperationId &&
        effect.externalObjectId === input.object.externalObjectId,
    );
    if (existing) return existing;
    const effectId = deterministicId(
      "effect",
      `${input.capability.operationAttemptId}\0${input.capability.effectReportId}\0${input.object.externalObjectId}`,
    );
    const reportRequestHash = sha256(
      canonicalJson({
        effectId,
        capabilityId: input.capability.capabilityId,
        effectReportId: input.capability.effectReportId,
        externalObjectId: input.object.externalObjectId,
        observedObjectHash: input.object.observedObjectHash,
        effectKind: input.effectKind,
      }),
    );
    let recorded;
    try {
      recorded = await this.dependencies.application.recordEffect({
        capability: input.capability,
        effectId,
        reportRequestHash,
        externalObjectId: input.object.externalObjectId,
        observedObjectHash: input.object.observedObjectHash,
        effectKind: input.effectKind,
      });
    } catch {
      recorded = null;
    }
    if (
      recorded?.status === RecordReviewExternalEffectStatus.Recorded ||
      recorded?.status === RecordReviewExternalEffectStatus.Restored
    ) {
      return recorded.effect;
    }
    const afterConflict = await this.dependencies.attempts.findById(
      input.operation.publicationAttemptId,
    );
    return (
      afterConflict?.effects.find(
        (effect) =>
          effect.publicationOperationId ===
            input.operation.publicationOperationId &&
          effect.externalObjectId === input.object.externalObjectId,
      ) ?? null
    );
  }

  private async loadInventory(
    gateway: ReviewV2ScmReconciliationGateway,
    operation: ReviewPublicationOperation,
  ): Promise<readonly ReviewPublicationGatewayObject[]> {
    const objects: ReviewPublicationGatewayObject[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < this.policy.maxMarkerPages; page += 1) {
      const result = await gateway.findAllByMarker({ operation, cursor });
      objects.push(...result.objects);
      if (result.nextCursor === null) {
        return normalizeInventory(objects, operation);
      }
      if (
        result.nextCursor.trim().length === 0 ||
        seenCursors.has(result.nextCursor)
      ) {
        throw new Error("publication_marker_cursor_invalid");
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("publication_marker_pagination_limit_exceeded");
  }

  private async renewForMutation(
    command: ReviewV2PublicationExecutionCommand,
    claim: ReviewPublicationClaimTerm,
  ): Promise<
    | { readonly claim: ReviewPublicationClaimTerm }
    | { readonly result: ReviewV2PublicationExecutionResult }
  > {
    try {
      const renewed = await this.dependencies.application.renewClaim({
        publicationAttemptId: command.publicationAttemptId,
        claimId: claim.claimId,
        ownerIdHash: command.ownerIdHash,
        claimFencingToken: claim.fencingToken,
        extendByMs: this.policy.claimDurationMs,
        minimumRemainingMs: this.policy.minimumMutationLeaseMs,
      });
      return renewed.status === RenewReviewPublicationClaimStatus.Renewed
        ? { claim: renewed.claim }
        : {
            result:
              renewed.status === RenewReviewPublicationClaimStatus.StaleClaim
                ? busy("publication_claim_fenced_before_mutation")
                : retryable(`publication_claim_renewal_${renewed.status}`),
          };
    } catch {
      return { result: retryable("publication_claim_renewal_unavailable") };
    }
  }

  private async readFreshness(
    provider: ReviewV2ScmProvider,
    permit: ReviewPublicationPermitIdentity,
  ): Promise<FreshnessAssessment> {
    try {
      const read = await this.dependencies.freshness.read(provider, permit);
      return assessFreshness(read, permit);
    } catch {
      return {
        status: "unavailable",
        safeReason: "publication_freshness_read_failed",
      };
    }
  }
}

function buildClaimCommand(input: {
  readonly view: ReviewPublicationAttemptView;
  readonly operation: ReviewPublicationOperation;
  readonly ownerIdHash: string;
  readonly signingKeyId: string;
  readonly now: Date;
  readonly claimDurationMs: number;
}) {
  const retainUntilMs = input.view.attempt.retainUntil.getTime();
  const expiresAt = new Date(
    Math.min(input.now.getTime() + input.claimDurationMs, retainUntilMs),
  );
  if (expiresAt <= input.now) {
    throw new Error("publication_claim_retention_exhausted");
  }
  const reportUntil = new Date(
    Math.min(
      Math.max(expiresAt.getTime(), input.operation.reconcileUntil.getTime()),
      retainUntilMs,
    ),
  );
  const acquireRequestIdHash = sha256(
    `rr.publication-claim.v2\0${input.view.attempt.publicationAttemptId}\0${input.view.attempt.version}\0${input.ownerIdHash}`,
  );
  const claimId = deterministicId("claim", acquireRequestIdHash);
  const claimCapabilityId = deterministicId(
    "claim-capability",
    acquireRequestIdHash,
  );
  const body = {
    publicationAttemptId: input.view.attempt.publicationAttemptId,
    expectedAttemptVersion: input.view.attempt.version,
    claimId,
    ownerIdHash: input.ownerIdHash,
    acquireRequestIdHash,
    claimCapabilityId,
    capabilitySigningKeyId: input.signingKeyId,
    expiresAt,
    reportUntil,
    retainUntil: input.view.attempt.retainUntil,
  };
  return { ...body, requestHash: sha256(canonicalJson(body)) };
}

function buildBeginCommand(input: {
  readonly view: ReviewPublicationAttemptView;
  readonly operation: ReviewPublicationOperation;
  readonly claim: ReviewPublicationClaimTerm;
  readonly signingKeyId: string;
}) {
  const acquireRequestIdHash = sha256(
    `rr.publication-operation-begin.v2\0${input.operation.publicationOperationId}\0${input.claim.claimId}\0${input.claim.fencingToken}`,
  );
  const operationAttemptId = deterministicId(
    "operation-attempt",
    acquireRequestIdHash,
  );
  const body = {
    publicationAttemptId: input.view.attempt.publicationAttemptId,
    publicationOperationId: input.operation.publicationOperationId,
    expectedAttemptVersion: input.view.attempt.version,
    claimId: input.claim.claimId,
    claimFencingToken: input.claim.fencingToken,
    acquireRequestIdHash,
    operationAttemptId,
    operationCapabilityId: deterministicId(
      "operation-capability",
      acquireRequestIdHash,
    ),
    capabilitySigningKeyId: input.signingKeyId,
    effectReportId: deterministicId("effect-report", acquireRequestIdHash),
    effectReportUntil: new Date(input.operation.reconcileUntil),
    retainUntil: input.view.attempt.retainUntil,
  };
  return { ...body, requestHash: sha256(canonicalJson(body)) };
}

function buildCompletionCommand(input: {
  readonly view: ReviewPublicationAttemptView;
  readonly operation: ReviewPublicationOperation;
  readonly claim: ReviewPublicationClaimTerm;
  readonly effect: ReviewPublicationExternalEffect;
}) {
  const completionRequestIdHash = sha256(
    `rr.publication-complete.v2\0${input.operation.publicationOperationId}\0${input.claim.claimId}\0${input.effect.effectId}`,
  );
  const receiptId = deterministicId("receipt", completionRequestIdHash);
  const receiptHash = sha256(
    canonicalJson({
      receiptId,
      publicationAttemptId: input.view.attempt.publicationAttemptId,
      publicationOperationId: input.operation.publicationOperationId,
      canonicalEffectId: input.effect.effectId,
      canonicalExternalObjectId: input.effect.externalObjectId,
      status: ReviewPublicationReceiptStatus.Succeeded,
    }),
  );
  const body = {
    publicationAttemptId: input.view.attempt.publicationAttemptId,
    publicationOperationId: input.operation.publicationOperationId,
    expectedAttemptVersion: input.view.attempt.version,
    claimId: input.claim.claimId,
    claimFencingToken: input.claim.fencingToken,
    completionRequestIdHash,
    receiptId,
    canonicalEffectId: input.effect.effectId,
    receiptHash,
  };
  return { ...body, requestHash: sha256(canonicalJson(body)) };
}

function reconstructLatestOperationCapability(
  view: ReviewPublicationAttemptView,
  operation: ReviewPublicationOperation,
): ReviewPublicationOperationCapabilityFacts | null {
  const latest = view.operationAttempts
    .filter(
      (attempt) =>
        attempt.publicationOperationId === operation.publicationOperationId,
    )
    .sort(
      (left, right) =>
        right.startedAt.getTime() - left.startedAt.getTime() ||
        right.operationAttemptId.localeCompare(left.operationAttemptId),
    )[0];
  if (!latest) return null;
  const targetExternalObjectId = operation.dependsOnOperationId
    ? (view.receipts.find(
        (receipt) =>
          receipt.publicationOperationId === operation.dependsOnOperationId,
      )?.canonicalExternalObjectId ?? null)
    : null;
  return operationCapabilityFacts({
    attempt: view.attempt,
    operation,
    operationAttempt: latest,
    targetExternalObjectId,
  });
}

function canonicalVisibleEffect(
  view: ReviewPublicationAttemptView,
  operation: ReviewPublicationOperation,
  objects: readonly ReviewPublicationGatewayObject[],
): ReviewPublicationExternalEffect | null {
  const visibleIds = new Set(objects.map((object) => object.externalObjectId));
  return selectCanonicalExternalEffect(
    view.effects.filter(
      (effect) =>
        effect.publicationOperationId === operation.publicationOperationId &&
        visibleIds.has(effect.externalObjectId),
    ),
  );
}

function normalizeInventory(
  input: readonly ReviewPublicationGatewayObject[],
  operation: ReviewPublicationOperation,
): readonly ReviewPublicationGatewayObject[] {
  const byId = new Map<string, ReviewPublicationGatewayObject>();
  for (const object of input) {
    validateGatewayObject(object, operation);
    const existing = byId.get(object.externalObjectId);
    if (existing && !sameGatewayObject(existing, object)) {
      throw new Error("publication_marker_object_conflict");
    }
    byId.set(object.externalObjectId, object);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.observedAt.getTime() - right.observedAt.getTime() ||
      left.externalObjectId.localeCompare(right.externalObjectId),
  );
}

function mergeGatewayObjects(
  ...groups: readonly (readonly ReviewPublicationGatewayObject[])[]
): readonly ReviewPublicationGatewayObject[] {
  const merged = new Map<string, ReviewPublicationGatewayObject>();
  for (const object of groups.flat()) {
    const existing = merged.get(object.externalObjectId);
    if (!existing || object.observedAt < existing.observedAt) {
      merged.set(object.externalObjectId, object);
    }
  }
  return [...merged.values()];
}

function validateGatewayObject(
  object: ReviewPublicationGatewayObject,
  operation: ReviewPublicationOperation,
): void {
  assertIdentifier(
    object.externalObjectId,
    "publication_gateway_object_id_invalid",
  );
  if (
    object.markerHash !== operation.markerHash ||
    !hashPattern.test(object.bodyHash) ||
    !hashPattern.test(object.observedObjectHash)
  ) {
    throw new Error("publication_gateway_marker_identity_mismatch");
  }
  if (
    !(object.observedAt instanceof Date) ||
    !Number.isFinite(object.observedAt.getTime())
  ) {
    throw new Error("publication_gateway_observed_at_invalid");
  }
}

function currentOperationObjects(
  objects: readonly ReviewPublicationGatewayObject[],
  operation: ReviewPublicationOperation,
): readonly ReviewPublicationGatewayObject[] {
  return objects.filter((object) =>
    isCurrentOperationObject(object, operation),
  );
}

function hasCurrentOperationObject(
  objects: readonly ReviewPublicationGatewayObject[],
  operation: ReviewPublicationOperation,
): boolean {
  return objects.some((object) => isCurrentOperationObject(object, operation));
}

function isCurrentOperationObject(
  object: ReviewPublicationGatewayObject,
  operation: ReviewPublicationOperation,
): boolean {
  return object.bodyHash === operation.bodyHash;
}

function sameGatewayObject(
  left: ReviewPublicationGatewayObject,
  right: ReviewPublicationGatewayObject,
): boolean {
  return (
    left.effectKind === right.effectKind &&
    left.markerHash === right.markerHash &&
    left.bodyHash === right.bodyHash &&
    left.observedObjectHash === right.observedObjectHash &&
    left.observedAt.getTime() === right.observedAt.getTime()
  );
}

function assessFreshness(
  read: ReviewV2PublicationFreshnessRead,
  permit: ReviewPublicationPermitIdentity,
): FreshnessAssessment {
  if (read.status === ReviewV2PublicationFreshnessReadStatus.Unavailable) {
    return { status: "unavailable", safeReason: read.safeReason };
  }
  if (read.status === ReviewV2PublicationFreshnessReadStatus.Missing) {
    return {
      status: "changed",
      snapshot: null,
      safeReason: read.safeReason,
    };
  }
  if (read.status !== ReviewV2PublicationFreshnessReadStatus.Available) {
    return {
      status: "unavailable",
      safeReason: "publication_freshness_unavailable",
    };
  }
  const snapshot = read.snapshot;
  if (
    snapshot.reviewedHeadSha !== permit.reviewedHeadSha ||
    snapshot.reviewRevisionHash !== permit.reviewRevisionHash ||
    snapshot.lifecycleStateHash !== permit.lifecycleStateHash ||
    snapshot.commandLedgerWatermark !== permit.commandLedgerWatermark ||
    snapshot.authorizationId !== permit.authorizationId ||
    snapshot.producerReleaseId !== permit.producerReleaseId ||
    snapshot.permitEpoch !== permit.permitEpoch ||
    snapshot.publicationSafetyDecisionHash !==
      permit.publicationSafetyDecisionHash ||
    snapshot.publicationNotAfter.getTime() !==
      permit.publicationNotAfter.getTime()
  ) {
    return {
      status: "changed",
      snapshot,
      safeReason: "publication_live_facts_changed",
    };
  }
  return { status: "current", snapshot };
}

function sameFreshness(
  left: ReviewV2PublicationFreshnessSnapshot,
  right: ReviewV2PublicationFreshnessSnapshot,
): boolean {
  return (
    left.reviewedHeadSha === right.reviewedHeadSha &&
    left.reviewRevisionHash === right.reviewRevisionHash &&
    left.lifecycleStateHash === right.lifecycleStateHash &&
    left.commandLedgerWatermark === right.commandLedgerWatermark &&
    left.baseSha === right.baseSha &&
    left.mergeBaseSha === right.mergeBaseSha &&
    left.authorizationId === right.authorizationId &&
    left.producerReleaseId === right.producerReleaseId &&
    left.permitEpoch === right.permitEpoch &&
    left.publicationSafetyDecisionHash ===
      right.publicationSafetyDecisionHash &&
    left.publicationNotAfter.getTime() === right.publicationNotAfter.getTime()
  );
}

function inspectTerminal(
  view: ReviewPublicationAttemptView,
  operationId: string,
): ReviewV2PublicationExecutionResult | null {
  const receipt = view.receipts.find(
    (candidate) => candidate.publicationOperationId === operationId,
  );
  if (receipt) {
    return {
      status: ReviewV2PublicationExecutionStatus.AlreadyCompleted,
      safeReason: "publication_operation_already_completed",
      receiptStatus: receipt.status,
    };
  }
  if (
    view.attempt.terminalOutcome ===
    ReviewPublicationTerminalOutcome.TerminalUnknown
  ) {
    return {
      status: ReviewV2PublicationExecutionStatus.TerminalUnknown,
      safeReason: "publication_terminal_unknown_manual_review_required",
    };
  }
  if (
    view.attempt.terminalOutcome !== null &&
    view.attempt.terminalOutcome !== ReviewPublicationTerminalOutcome.Succeeded
  ) {
    return {
      status: ReviewV2PublicationExecutionStatus.Terminalized,
      safeReason: `publication_${view.attempt.terminalOutcome}`,
      terminalOutcome: view.attempt.terminalOutcome,
    };
  }
  if (view.attempt.state === ReviewPublicationAttemptState.Terminal) {
    return manual("publication_attempt_terminal_without_operation_receipt");
  }
  return null;
}

function requireOperation(
  view: ReviewPublicationAttemptView,
  operationId: string,
): ReviewPublicationOperation {
  const operation = view.attempt.operations.find(
    (candidate) => candidate.publicationOperationId === operationId,
  );
  if (!operation) throw new Error("publication_operation_missing");
  return operation;
}

function currentClaim(
  view: ReviewPublicationAttemptView,
  expected: ReviewPublicationClaimTerm,
): ReviewPublicationClaimTerm | null {
  const current = view.activeClaim;
  if (
    !current ||
    current.claimId !== expected.claimId ||
    current.ownerIdHash !== expected.ownerIdHash ||
    current.fencingToken !== expected.fencingToken
  ) {
    return null;
  }
  return current;
}

function mayHaveExternalEffect(
  view: ReviewPublicationAttemptView,
  operation: ReviewPublicationOperation,
): boolean {
  return (
    operation.state !== ReviewPublicationOperationState.Planned ||
    view.operationAttempts.some(
      (attempt) =>
        attempt.publicationOperationId === operation.publicationOperationId,
    ) ||
    view.effects.some(
      (effect) =>
        effect.publicationOperationId === operation.publicationOperationId,
    )
  );
}

function mapBeginFailure(
  status: Exclude<
    BeginReviewPublicationOperationStatus,
    | BeginReviewPublicationOperationStatus.Begun
    | BeginReviewPublicationOperationStatus.Restored
  >,
): ReviewV2PublicationExecutionResult {
  switch (status) {
    case BeginReviewPublicationOperationStatus.VersionConflict:
    case BeginReviewPublicationOperationStatus.StaleClaim:
    case BeginReviewPublicationOperationStatus.DependencyNotCompleted:
    case BeginReviewPublicationOperationStatus.OperationInFlight:
      return retryable(`publication_begin_${status}`);
    case BeginReviewPublicationOperationStatus.OperationCompleted:
      return {
        status: ReviewV2PublicationExecutionStatus.AlreadyCompleted,
        safeReason: "publication_operation_already_completed",
      };
    case BeginReviewPublicationOperationStatus.Missing:
    case BeginReviewPublicationOperationStatus.RequestConflict:
    case BeginReviewPublicationOperationStatus.Terminal:
      return manual(`publication_begin_${status}`);
  }
}

function retryable(safeReason: string): ReviewV2PublicationExecutionResult {
  return { status: ReviewV2PublicationExecutionStatus.Retryable, safeReason };
}

function busy(safeReason: string): ReviewV2PublicationExecutionResult {
  return { status: ReviewV2PublicationExecutionStatus.Busy, safeReason };
}

function manual(safeReason: string): ReviewV2PublicationExecutionResult {
  return {
    status: ReviewV2PublicationExecutionStatus.ManualRequired,
    safeReason,
  };
}

function assertPolicy(policy: ReviewV2PublicationExecutorPolicy): void {
  if (
    !Number.isSafeInteger(policy.claimDurationMs) ||
    policy.claimDurationMs <= 0
  ) {
    throw new Error("review_v2_publication_claim_duration_invalid");
  }
  if (
    !Number.isSafeInteger(policy.minimumMutationLeaseMs) ||
    policy.minimumMutationLeaseMs <= 0 ||
    policy.minimumMutationLeaseMs > policy.claimDurationMs
  ) {
    throw new Error("review_v2_publication_minimum_mutation_lease_invalid");
  }
  if (
    !Number.isSafeInteger(policy.maxMarkerPages) ||
    policy.maxMarkerPages <= 0 ||
    policy.maxMarkerPages > 1_000
  ) {
    throw new Error("review_v2_publication_marker_page_limit_invalid");
  }
}

function assertCommand(command: ReviewV2PublicationExecutionCommand): void {
  assertIdentifier(
    command.publicationAttemptId,
    "publication_attempt_id_invalid",
  );
  assertIdentifier(
    command.publicationOperationId,
    "publication_operation_id_invalid",
  );
  if (!hashPattern.test(command.ownerIdHash)) {
    throw new Error("publication_owner_hash_invalid");
  }
}

function assertIdentifier(value: string, code: string): void {
  if (value.trim().length === 0 || value.length > 512) throw new Error(code);
}

function deterministicId(kind: string, preimage: string): string {
  return `rr-${kind}-${sha256(`rr.${kind}.v2\0${preimage}`)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonical(value));
}

function normalizeCanonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeCanonical(entry)]),
    );
  }
  return value;
}

function safeIdentifier(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  return normalized || fallback;
}

async function closeSession(session: ReviewV2ScmGatewaySession): Promise<void> {
  try {
    await session.close();
  } catch {
    // Credential disposal is best-effort after the scoped client is unreachable.
  }
}
