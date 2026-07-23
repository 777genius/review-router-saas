import { adjudicateReviewPublicationOutcome } from "../application/use-cases/adjudicate-review-publication-outcome";
import { beginReviewPublicationOperation } from "../application/use-cases/begin-review-publication-operation";
import { claimReviewPublication } from "../application/use-cases/claim-review-publication";
import { claimReviewPublicationForReconciliation } from "../application/use-cases/claim-review-publication-for-reconciliation";
import { completeReviewPublicationOperation } from "../application/use-cases/complete-review-publication-operation";
import { recordReviewExternalEffect } from "../application/use-cases/record-review-external-effect";
import { renewReviewPublicationClaim } from "../application/use-cases/renew-review-publication-claim";
import { requestReviewPublication } from "../application/use-cases/request-review-publication";
import { terminalizeUnknownReviewPublication } from "../application/use-cases/terminalize-unknown-review-publication";
import {
  ReviewPublicationCapability,
  ReviewPublicationCapabilityDisabledError,
  type AdjudicateReviewPublicationOutcomeCommandPort,
  type BeginReviewPublicationOperationCommandPort,
  type ClaimReviewPublicationCommandPort,
  type CompleteReviewPublicationOperationCommandPort,
  type RecordReviewExternalEffectCommandPort,
  type RenewReviewPublicationClaimCommandPort,
  type RequestReviewPublicationCommandPort,
  type ReviewPublicationAttemptQueryPort,
  type ReviewPublicationAdjudicationEvidencePort,
  type ReviewPublicationCapabilityGate,
  type ReviewPublicationClockPort,
  type ReviewPublicationDecisionPorts,
  type ReviewPublicationIdempotencyQueryPort,
  type TerminalizeUnknownReviewPublicationCommandPort,
} from "../application/ports/review-publication-ports";

export { PrismaReviewPublicationRepository } from "../infrastructure/prisma/prisma-review-publication-repository";

export type ReviewPublicationV2CommandPorts = {
  readonly requests: RequestReviewPublicationCommandPort;
  readonly claims: ClaimReviewPublicationCommandPort;
  readonly claimRenewals: RenewReviewPublicationClaimCommandPort;
  readonly operationBegins: BeginReviewPublicationOperationCommandPort;
  readonly effects: RecordReviewExternalEffectCommandPort;
  readonly completions: CompleteReviewPublicationOperationCommandPort;
  readonly terminalizations: TerminalizeUnknownReviewPublicationCommandPort;
  readonly adjudications: AdjudicateReviewPublicationOutcomeCommandPort;
};

export function createReviewPublicationV2Application(dependencies: {
  readonly clock: ReviewPublicationClockPort;
  readonly decisions: ReviewPublicationDecisionPorts;
  readonly attempts: ReviewPublicationAttemptQueryPort;
  readonly idempotency: ReviewPublicationIdempotencyQueryPort;
  readonly adjudicationEvidence: ReviewPublicationAdjudicationEvidencePort;
  readonly commands: ReviewPublicationV2CommandPorts;
  readonly enabledCapabilities?: ReadonlySet<ReviewPublicationCapability>;
}) {
  const capabilityGate = new ConfiguredReviewPublicationCapabilityGate(
    dependencies.enabledCapabilities ?? new Set<ReviewPublicationCapability>(),
  );
  return {
    request: (command: Parameters<typeof requestReviewPublication>[0]) =>
      requestReviewPublication(command, {
        capabilities: capabilityGate,
        clock: dependencies.clock,
        decisions: dependencies.decisions,
        commands: dependencies.commands.requests,
      }),
    claim: (command: Parameters<typeof claimReviewPublication>[0]) =>
      claimReviewPublication(command, {
        capabilities: capabilityGate,
        clock: dependencies.clock,
        decisions: dependencies.decisions,
        attempts: dependencies.attempts,
        idempotency: dependencies.idempotency,
        commands: dependencies.commands.claims,
      }),
    claimForReconciliation: (
      command: Parameters<typeof claimReviewPublicationForReconciliation>[0],
    ) =>
      claimReviewPublicationForReconciliation(command, {
        capabilities: capabilityGate,
        clock: dependencies.clock,
        attempts: dependencies.attempts,
        idempotency: dependencies.idempotency,
        commands: dependencies.commands.claims,
      }),
    renewClaim: (command: Parameters<typeof renewReviewPublicationClaim>[0]) =>
      renewReviewPublicationClaim(command, {
        clock: dependencies.clock,
        commands: dependencies.commands.claimRenewals,
      }),
    beginOperation: (
      command: Parameters<typeof beginReviewPublicationOperation>[0],
    ) =>
      beginReviewPublicationOperation(command, {
        capabilities: capabilityGate,
        clock: dependencies.clock,
        decisions: dependencies.decisions,
        attempts: dependencies.attempts,
        idempotency: dependencies.idempotency,
        commands: dependencies.commands.operationBegins,
      }),
    recordEffect: (command: Parameters<typeof recordReviewExternalEffect>[0]) =>
      recordReviewExternalEffect(command, {
        clock: dependencies.clock,
        commands: dependencies.commands.effects,
      }),
    completeOperation: (
      command: Parameters<typeof completeReviewPublicationOperation>[0],
    ) =>
      completeReviewPublicationOperation(command, {
        clock: dependencies.clock,
        commands: dependencies.commands.completions,
      }),
    terminalizeUnknown: (
      command: Parameters<typeof terminalizeUnknownReviewPublication>[0],
    ) =>
      terminalizeUnknownReviewPublication(command, {
        clock: dependencies.clock,
        commands: dependencies.commands.terminalizations,
      }),
    adjudicate: (
      command: Parameters<typeof adjudicateReviewPublicationOutcome>[0],
    ) =>
      adjudicateReviewPublicationOutcome(command, {
        clock: dependencies.clock,
        evidence: dependencies.adjudicationEvidence,
        commands: dependencies.commands.adjudications,
      }),
  };
}

class ConfiguredReviewPublicationCapabilityGate implements ReviewPublicationCapabilityGate {
  constructor(
    private readonly enabled: ReadonlySet<ReviewPublicationCapability>,
  ) {}

  require(capability: ReviewPublicationCapability): void {
    if (!this.enabled.has(capability)) {
      throw new ReviewPublicationCapabilityDisabledError(capability);
    }
  }
}
