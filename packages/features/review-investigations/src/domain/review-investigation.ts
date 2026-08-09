import {
  canonicalJson,
  ReviewInvestigationDomainError,
  type CanonicalValue,
} from "./canonicalization";
import {
  assertInvestigationContract,
  assertInvestigationRevision,
  assertInvestigationScope,
  type ReviewInvestigationContract,
  type ReviewInvestigationRevision,
  type ReviewInvestigationScope,
} from "./coverage-contract";
import type { ReviewInvestigationCertificate } from "./investigation-certificate";
import type { ReplayEvidenceCheckpoint } from "./replay-evidence-checkpoint";
import {
  hasIndependentCriticProvenance,
  requiresIndependentCritic,
} from "./investigation-critic-policy";
import {
  InvestigationObligationOrigin,
  markInvestigationObligationUnresolvable,
  mergeInvestigationObligations,
  obligationCanonicalObject,
  satisfyInvestigationObligation,
  sortObligations,
  type InvestigationObligation,
} from "./investigation-obligation";
import {
  assertInvestigationPolicy,
  currentInvestigationPolicyCanonicalVersion,
  InvestigationPolicyCanonicalVersion,
  policyCanonicalValue,
  type ReviewInvestigationPolicy,
} from "./investigation-policy";
import { isValidInvestigationTokenUsage } from "./investigation-token-usage";
import {
  assertInvestigationTurnObligationClaimScope,
  findingCanonicalValue,
  turnCanonicalValue,
  type InvestigationFinding,
  type InvestigationTurn,
  type InvestigationTurnAbort,
  type InvestigationTurnCommit,
  type InvestigationTurnProvenance,
  summarizeTerminalDiscoveryProvenance,
  turnProvenanceCanonicalValue,
} from "./investigation-turn";
import {
  ContextCriticDecision,
  InvestigationObligationKind,
  InvestigationObligationState,
  ReviewInvestigationAbortReason,
  ReviewInvestigationConclusion,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
} from "./review-investigation-types";
import {
  InvestigationPrivateMaterialExpiryDisposition,
  InvestigationPrivateMaterialExpiryReason,
} from "./investigation-private-material";

export type ReviewInvestigation = Readonly<{
  investigationId: string;
  naturalIdentityHash: string;
  version: number;
  scope: ReviewInvestigationScope;
  revision: ReviewInvestigationRevision;
  executionId: string;
  workSlotId: string;
  stableReviewUnitKey: string;
  providerVoteLaneId: string;
  providerStrategyId: string;
  investigationManifestCanonicalJson: string | null;
  investigationManifestHash: string | null;
  runtimeProfile: ReviewInvestigationRuntimeProfile;
  contract: ReviewInvestigationContract;
  policyCanonicalVersion: InvestigationPolicyCanonicalVersion;
  policy: ReviewInvestigationPolicy;
  state: ReviewInvestigationState;
  obligations: readonly InvestigationObligation[];
  findings: readonly InvestigationFinding[];
  activeTurn: InvestigationTurn | null;
  semanticTurns: number;
  operationalAttempts: number;
  expansionDepth: number;
  criticCycles: number;
  criticDecision: ContextCriticDecision | null;
  totalUsageTokens: number;
  totalDurationMs: number;
  turnProvenance: readonly InvestigationTurnProvenance[];
  conclusion: ReviewInvestigationConclusion | null;
  certificate: ReviewInvestigationCertificate | null;
  replayEvidenceCheckpoint: ReplayEvidenceCheckpoint | null;
  dossierDigest: string;
  nextEligibleAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type InvestigationPrivateMaterialExpiryReconciliation = Readonly<{
  disposition: InvestigationPrivateMaterialExpiryDisposition;
  investigation: ReviewInvestigation;
  affectedObligationIds: readonly string[];
  expiredTurnId: string | null;
}>;

export enum ExpiredActiveTurnReconciliationDisposition {
  Unchanged = "unchanged",
  Recovered = "recovered",
  Inconclusive = "inconclusive",
  Superseded = "superseded",
}

export type ExpiredActiveTurnReconciliation = Readonly<{
  disposition: ExpiredActiveTurnReconciliationDisposition;
  investigation: ReviewInvestigation;
  expiredTurnId: string | null;
}>;

export function createReviewInvestigation(
  input: Omit<
    ReviewInvestigation,
    | "version"
    | "state"
    | "findings"
    | "activeTurn"
    | "semanticTurns"
    | "operationalAttempts"
    | "expansionDepth"
    | "criticCycles"
    | "criticDecision"
    | "totalUsageTokens"
    | "totalDurationMs"
    | "turnProvenance"
    | "conclusion"
    | "certificate"
    | "replayEvidenceCheckpoint"
    | "nextEligibleAt"
    | "investigationManifestCanonicalJson"
    | "investigationManifestHash"
    | "policyCanonicalVersion"
  > & { readonly obligations: readonly InvestigationObligation[] },
  admittedManifest: Readonly<{
    canonicalJson: string;
    hash: string;
  }> | null = null,
): ReviewInvestigation {
  assertInvestigationScope(input.scope);
  assertInvestigationRevision(input.revision);
  assertInvestigationContract(input.contract);
  assertInvestigationPolicy(input.policy);
  const obligations = mergeInvestigationObligations([], input.obligations);
  if (
    obligations.length === 0 ||
    obligations.length > input.policy.maxObligations
  ) {
    throw new ReviewInvestigationDomainError("seed_obligation_count_invalid");
  }
  const inventory = obligations.filter(
    (item) => item.kind === InvestigationObligationKind.InventoryWitness,
  );
  if (inventory.length !== 1) {
    throw new ReviewInvestigationDomainError("inventory_witness_required");
  }
  return {
    ...input,
    investigationManifestCanonicalJson: admittedManifest?.canonicalJson ?? null,
    investigationManifestHash: admittedManifest?.hash ?? null,
    policyCanonicalVersion: currentInvestigationPolicyCanonicalVersion,
    version: 1,
    state:
      inventory[0]!.state === InvestigationObligationState.Satisfied
        ? ReviewInvestigationState.AwaitingTurn
        : ReviewInvestigationState.Provisional,
    obligations,
    findings: [],
    activeTurn: null,
    semanticTurns: 0,
    operationalAttempts: 0,
    expansionDepth: 0,
    criticCycles: 0,
    criticDecision: null,
    totalUsageTokens: 0,
    totalDurationMs: 0,
    turnProvenance: [],
    conclusion: null,
    certificate: null,
    replayEvidenceCheckpoint: null,
    nextEligibleAt: null,
  };
}

export function createReplayedReviewInvestigation(
  input: Parameters<typeof createReviewInvestigation>[0],
  admittedManifest: Parameters<typeof createReviewInvestigation>[1],
): ReviewInvestigation {
  const investigation = createReviewInvestigation(input, admittedManifest);
  const inventory = investigation.obligations.find(
    (item) => item.kind === InvestigationObligationKind.InventoryWitness,
  )!;
  if (inventory.state !== InvestigationObligationState.Satisfied) {
    return investigation;
  }
  // Replayed receipts do not authenticate provider/model provenance on target.
  return {
    ...investigation,
    state: ReviewInvestigationState.AwaitingTurn,
  };
}

export function planInvestigationTurn(input: {
  readonly investigation: ReviewInvestigation;
  readonly turn: InvestigationTurn;
}): ReviewInvestigation {
  const current = input.investigation;
  const expectedPurpose =
    current.state === ReviewInvestigationState.AwaitingCritic
      ? ReviewInvestigationTurnPurpose.Critic
      : ReviewInvestigationTurnPurpose.Discovery;
  if (
    current.activeTurn !== null ||
    ![
      ReviewInvestigationState.Provisional,
      ReviewInvestigationState.AwaitingTurn,
      ReviewInvestigationState.AwaitingCritic,
    ].includes(current.state) ||
    input.turn.purpose !== expectedPurpose ||
    input.turn.leasedAtVersion !== current.version + 1 ||
    input.turn.dossierDigest !== current.dossierDigest
  ) {
    throw new ReviewInvestigationDomainError("turn_plan_invalid");
  }
  if (
    expectedPurpose === ReviewInvestigationTurnPurpose.Discovery &&
    current.semanticTurns >= current.policy.maxSemanticTurns
  ) {
    return transitionToInconclusive(current, input.turn.leasedAt);
  }
  if (
    expectedPurpose === ReviewInvestigationTurnPurpose.Critic &&
    current.criticCycles >= current.policy.maxCriticCycles
  ) {
    return transitionToInconclusive(current, input.turn.leasedAt);
  }
  return {
    ...current,
    version: current.version + 1,
    state: ReviewInvestigationState.TurnLeased,
    activeTurn: { ...input.turn },
    nextEligibleAt: null,
    updatedAt: input.turn.leasedAt,
  };
}

export function commitInvestigationTurn(input: {
  readonly investigation: ReviewInvestigation;
  readonly commit: InvestigationTurnCommit;
  readonly committedAt: string;
}): ReviewInvestigation {
  const current = input.investigation;
  const turn = current.activeTurn;
  if (
    current.state !== ReviewInvestigationState.TurnLeased ||
    turn === null ||
    turn.turnId !== input.commit.turnId
  ) {
    throw new ReviewInvestigationDomainError("turn_commit_invalid");
  }
  assertInvestigationTurnObligationClaimScope({
    turn,
    closureClaims: input.commit.closureClaims,
    unresolvableClaims: input.commit.unresolvableDecisions,
  });
  validateTurnBounds(current, input.commit);
  if (
    (turn.purpose === ReviewInvestigationTurnPurpose.Discovery &&
      input.commit.criticDecision !== null) ||
    (turn.purpose === ReviewInvestigationTurnPurpose.Critic &&
      input.commit.criticDecision === null)
  ) {
    throw new ReviewInvestigationDomainError("turn_critic_decision_invalid");
  }
  if (
    turn.purpose === ReviewInvestigationTurnPurpose.Critic &&
    input.commit.criticDecision === ContextCriticDecision.Veto &&
    input.commit.proposedObligations.length === 0 &&
    input.commit.findings.length === 0
  ) {
    throw new ReviewInvestigationDomainError("critic_veto_evidence_required");
  }
  validateCriticOutput(turn.purpose, input.commit);
  validateTurnProvenance(current, turn, input.commit);
  let obligations = [...current.obligations];
  for (const claim of input.commit.closureClaims) {
    obligations = replaceObligation(
      obligations,
      claim.obligationId,
      (obligation) =>
        satisfyInvestigationObligation({
          obligation,
          receipt: claim.receipt,
          reviewRevisionHash: current.revision.reviewRevisionHash,
          gatewayPolicyVersion: current.contract.gatewayPolicyVersion,
        }),
    );
  }
  for (const decision of input.commit.unresolvableDecisions) {
    obligations = replaceObligation(
      obligations,
      decision.obligationId,
      (obligation) =>
        markInvestigationObligationUnresolvable({
          obligation,
          reason: decision.reason,
          deterministicPolicy: decision.deterministicPolicy,
        }),
    );
  }
  obligations = [
    ...mergeInvestigationObligations(
      obligations,
      input.commit.proposedObligations,
    ),
  ];
  if (
    obligations.filter(
      (item) => item.kind === InvestigationObligationKind.InventoryWitness,
    ).length !== 1
  ) {
    throw new ReviewInvestigationDomainError(
      "inventory_witness_cardinality_invalid",
    );
  }
  validateFindingEvidence(
    obligations,
    input.commit.findings,
    input.commit.acceptedEvidenceReceiptIds ?? [],
  );
  const findings = mergeFindings(current.findings, input.commit.findings);
  let next: ReviewInvestigation = {
    ...current,
    version: current.version + 1,
    obligations,
    findings,
    activeTurn: null,
    semanticTurns:
      turn.purpose === ReviewInvestigationTurnPurpose.Discovery
        ? current.semanticTurns + 1
        : current.semanticTurns,
    expansionDepth:
      input.commit.proposedObligations.length > 0
        ? current.expansionDepth + 1
        : current.expansionDepth,
    criticCycles:
      turn.purpose === ReviewInvestigationTurnPurpose.Critic
        ? current.criticCycles + 1
        : current.criticCycles,
    criticDecision:
      turn.purpose === ReviewInvestigationTurnPurpose.Critic
        ? input.commit.criticDecision
        : current.criticDecision,
    totalUsageTokens: current.totalUsageTokens + input.commit.usageTokens,
    totalDurationMs: current.totalDurationMs + input.commit.durationMs,
    turnProvenance: input.commit.provenance
      ? [...current.turnProvenance, { ...input.commit.provenance }]
      : current.turnProvenance,
    state: current.state,
    updatedAt: input.committedAt,
  };
  const effectiveCriticDecision = effectiveCriticDecisionForCommit(
    next,
    turn,
    input.commit.criticDecision,
  );
  if (effectiveCriticDecision !== input.commit.criticDecision) {
    next = { ...next, criticDecision: effectiveCriticDecision };
  }
  return decideStateAfterCommit(next, turn.purpose, effectiveCriticDecision);
}

export function commitHistoricalInvestigationTurn(input: {
  readonly investigation: ReviewInvestigation;
  readonly commit: InvestigationTurnCommit;
  readonly committedAt: string;
}): ReviewInvestigation {
  const committed = commitInvestigationTurn(input);
  return {
    ...committed,
    state: ReviewInvestigationState.Superseded,
    conclusion: null,
    certificate: null,
    nextEligibleAt: null,
  };
}

export function reconcileExpiredActiveTurn(input: {
  readonly investigation: ReviewInvestigation;
  readonly reconciledAt: string;
  readonly superseded: boolean;
}): ExpiredActiveTurnReconciliation {
  const current = input.investigation;
  const turn = current.activeTurn;
  const reconciledAtMs = canonicalTimestampMs(
    input.reconciledAt,
    "investigation_turn_reconciled_at_invalid",
  );
  if (
    current.state !== ReviewInvestigationState.TurnLeased ||
    turn === null ||
    canonicalTimestampMs(turn.expiresAt, "investigation_turn_expiry_invalid") >
      reconciledAtMs
  ) {
    return {
      disposition: ExpiredActiveTurnReconciliationDisposition.Unchanged,
      investigation: current,
      expiredTurnId: null,
    };
  }
  if (input.superseded) {
    return {
      disposition: ExpiredActiveTurnReconciliationDisposition.Superseded,
      investigation: {
        ...current,
        version: current.version + 1,
        state: ReviewInvestigationState.Superseded,
        activeTurn: null,
        nextEligibleAt: null,
        updatedAt: input.reconciledAt,
      },
      expiredTurnId: turn.turnId,
    };
  }
  const operationalAttempts = current.operationalAttempts + 1;
  if (operationalAttempts >= current.policy.maxOperationalAttempts) {
    return {
      disposition: ExpiredActiveTurnReconciliationDisposition.Inconclusive,
      investigation: transitionToInconclusive(
        {
          ...current,
          version: current.version + 1,
          activeTurn: null,
          operationalAttempts,
          nextEligibleAt: null,
        },
        input.reconciledAt,
      ),
      expiredTurnId: turn.turnId,
    };
  }
  return {
    disposition: ExpiredActiveTurnReconciliationDisposition.Recovered,
    investigation: {
      ...current,
      version: current.version + 1,
      state:
        turn.purpose === ReviewInvestigationTurnPurpose.Critic
          ? ReviewInvestigationState.AwaitingCritic
          : ReviewInvestigationState.AwaitingTurn,
      activeTurn: null,
      operationalAttempts,
      nextEligibleAt: null,
      updatedAt: input.reconciledAt,
    },
    expiredTurnId: turn.turnId,
  };
}

export function abortInvestigationTurn(input: {
  readonly investigation: ReviewInvestigation;
  readonly abort: InvestigationTurnAbort;
  readonly abortedAt: string;
}): ReviewInvestigation {
  const current = input.investigation;
  if (
    current.state !== ReviewInvestigationState.TurnLeased ||
    current.activeTurn?.turnId !== input.abort.turnId
  ) {
    throw new ReviewInvestigationDomainError("turn_abort_invalid");
  }
  if (
    input.abort.reason === ReviewInvestigationAbortReason.StaleExecution ||
    input.abort.reason === ReviewInvestigationAbortReason.SupersededExecution
  ) {
    return {
      ...current,
      version: current.version + 1,
      state: ReviewInvestigationState.Superseded,
      activeTurn: null,
      updatedAt: input.abortedAt,
    };
  }
  if (
    input.abort.reason === ReviewInvestigationAbortReason.ConfinementViolation
  ) {
    return transitionToInconclusive(
      { ...current, activeTurn: null, version: current.version + 1 },
      input.abortedAt,
    );
  }
  const operationalAttempts = current.operationalAttempts + 1;
  if (operationalAttempts >= current.policy.maxOperationalAttempts) {
    return transitionToInconclusive(
      {
        ...current,
        activeTurn: null,
        operationalAttempts,
        version: current.version + 1,
      },
      input.abortedAt,
    );
  }
  return {
    ...current,
    version: current.version + 1,
    state:
      current.activeTurn.purpose === ReviewInvestigationTurnPurpose.Critic
        ? ReviewInvestigationState.AwaitingCritic
        : ReviewInvestigationState.AwaitingTurn,
    activeTurn: null,
    operationalAttempts,
    nextEligibleAt: input.abort.nextEligibleAt,
    updatedAt: input.abortedAt,
  };
}

export function reconcileInvestigationPrivateMaterialExpiry(input: {
  readonly investigation: ReviewInvestigation;
  readonly obligationIds: readonly string[];
  readonly expiredAt: string;
}): InvestigationPrivateMaterialExpiryReconciliation {
  const current = input.investigation;
  const expiredAtMs = canonicalTimestampMs(
    input.expiredAt,
    "private_material_expired_at_invalid",
  );
  const terminalStates = new Set<ReviewInvestigationState>([
    ReviewInvestigationState.Concluded,
    ReviewInvestigationState.Inconclusive,
    ReviewInvestigationState.Superseded,
    ReviewInvestigationState.Expired,
  ]);
  if (terminalStates.has(current.state)) {
    return privateMaterialExpiryResult(
      InvestigationPrivateMaterialExpiryDisposition.Unchanged,
      current,
    );
  }
  if (current.activeTurn !== null) {
    return privateMaterialExpiryResult(
      InvestigationPrivateMaterialExpiryDisposition.DeferredActiveTurn,
      current,
    );
  }

  const candidateIds = new Set(input.obligationIds);
  const affectedObligationIds = current.obligations
    .filter(
      (obligation) =>
        candidateIds.has(obligation.obligationId) &&
        obligation.state === InvestigationObligationState.Open,
    )
    .map((obligation) => obligation.obligationId)
    .sort();
  if (affectedObligationIds.length === 0) {
    return privateMaterialExpiryResult(
      InvestigationPrivateMaterialExpiryDisposition.Unchanged,
      current,
    );
  }

  const affected = new Set(affectedObligationIds);
  const updatedAt = new Date(
    Math.max(
      expiredAtMs,
      canonicalTimestampMs(
        current.updatedAt,
        "investigation_updated_at_invalid",
      ),
    ),
  ).toISOString();
  const expiredTurnId = null;
  const investigation: ReviewInvestigation = {
    ...current,
    version: current.version + 1,
    state: ReviewInvestigationState.Inconclusive,
    obligations: current.obligations.map((obligation) =>
      affected.has(obligation.obligationId)
        ? markInvestigationObligationUnresolvable({
            obligation,
            reason:
              InvestigationPrivateMaterialExpiryReason.RegenerationUnavailable,
            deterministicPolicy: true,
          })
        : obligation,
    ),
    activeTurn: null,
    conclusion: ReviewInvestigationConclusion.Inconclusive,
    nextEligibleAt: null,
    updatedAt,
  };
  return {
    disposition: InvestigationPrivateMaterialExpiryDisposition.Inconclusive,
    investigation,
    affectedObligationIds,
    expiredTurnId,
  };
}

export function concludeReviewInvestigation(input: {
  readonly investigation: ReviewInvestigation;
  readonly certificate: ReviewInvestigationCertificate;
  readonly replayEvidenceCheckpoint: ReplayEvidenceCheckpoint | null;
  readonly concludedAt: string;
}): ReviewInvestigation {
  const current = enforceCriticPolicyForConclusion(input.investigation);
  if (
    ![
      ReviewInvestigationState.ReadyToConclude,
      ReviewInvestigationState.Inconclusive,
    ].includes(current.state) ||
    current.activeTurn !== null ||
    current.certificate !== null ||
    input.certificate.investigationId !== current.investigationId ||
    input.certificate.investigationVersion !== current.version ||
    (input.replayEvidenceCheckpoint !== null &&
      (input.replayEvidenceCheckpoint.sourceInvestigationId !==
        current.investigationId ||
        input.replayEvidenceCheckpoint.sourceInvestigationVersion !==
          current.version + 1))
  ) {
    throw new ReviewInvestigationDomainError(
      "investigation_conclusion_invalid",
    );
  }
  const conclusion =
    current.state === ReviewInvestigationState.Inconclusive
      ? ReviewInvestigationConclusion.Inconclusive
      : current.findings.length > 0
        ? ReviewInvestigationConclusion.Findings
        : ReviewInvestigationConclusion.VerifiedClean;
  if (
    conclusion === ReviewInvestigationConclusion.VerifiedClean &&
    current.criticDecision !== ContextCriticDecision.Accept
  ) {
    throw new ReviewInvestigationDomainError("verified_clean_critic_required");
  }
  if (input.certificate.conclusion !== conclusion) {
    throw new ReviewInvestigationDomainError("certificate_conclusion_mismatch");
  }
  const terminalProvenance = summarizeTerminalDiscoveryProvenance(
    current.turnProvenance,
  );
  if (
    input.certificate.terminalProviderKind !==
      terminalProvenance.providerKind ||
    input.certificate.terminalActualModel !== terminalProvenance.actualModel
  ) {
    throw new ReviewInvestigationDomainError(
      "certificate_terminal_provenance_mismatch",
    );
  }
  return {
    ...current,
    version: current.version + 1,
    state:
      conclusion === ReviewInvestigationConclusion.Inconclusive
        ? ReviewInvestigationState.Inconclusive
        : ReviewInvestigationState.Concluded,
    conclusion,
    certificate: { ...input.certificate },
    replayEvidenceCheckpoint: input.replayEvidenceCheckpoint
      ? { ...input.replayEvidenceCheckpoint }
      : null,
    updatedAt: input.concludedAt,
  };
}

export function enforceCriticPolicyForConclusion(
  investigation: ReviewInvestigation,
): ReviewInvestigation {
  if (
    investigation.state === ReviewInvestigationState.ReadyToConclude &&
    investigation.findings.length === 0 &&
    requiresIndependentCritic({
      criticPolicyVersion: investigation.contract.criticPolicyVersion,
      obligations: investigation.obligations,
    }) &&
    (investigation.turnProvenance.length !==
      investigation.semanticTurns + investigation.criticCycles ||
      !hasIndependentCriticProvenance(investigation.turnProvenance))
  ) {
    return transitionToInconclusive(investigation, investigation.updatedAt);
  }
  return investigation;
}

export function investigationDossierCanonicalValue(
  investigation: ReviewInvestigation,
): Readonly<Record<string, CanonicalValue>> {
  const policyCanonicalVersion = investigation.policyCanonicalVersion;
  return {
    investigationId: investigation.investigationId,
    naturalIdentityHash: investigation.naturalIdentityHash,
    version: investigation.version,
    scope: { ...investigation.scope },
    revision: { ...investigation.revision },
    executionId: investigation.executionId,
    workSlotId: investigation.workSlotId,
    stableReviewUnitKey: investigation.stableReviewUnitKey,
    providerVoteLaneId: investigation.providerVoteLaneId,
    providerStrategyId: investigation.providerStrategyId,
    ...(investigation.investigationManifestHash === null
      ? {}
      : { investigationManifestHash: investigation.investigationManifestHash }),
    runtimeProfile: investigation.runtimeProfile,
    contract: { ...investigation.contract },
    ...(policyCanonicalVersion === InvestigationPolicyCanonicalVersion.LegacyV1
      ? {}
      : { policyCanonicalVersion }),
    policy: policyCanonicalValue(investigation.policy, policyCanonicalVersion),
    state: investigation.state,
    obligations: sortObligations(investigation.obligations).map(
      obligationCanonicalObject,
    ),
    findings: [...investigation.findings]
      .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint))
      .map(findingCanonicalValue),
    activeTurn: investigation.activeTurn
      ? turnCanonicalValue(investigation.activeTurn)
      : null,
    semanticTurns: investigation.semanticTurns,
    operationalAttempts: investigation.operationalAttempts,
    expansionDepth: investigation.expansionDepth,
    criticCycles: investigation.criticCycles,
    criticDecision: investigation.criticDecision,
    totalUsageTokens: investigation.totalUsageTokens,
    totalDurationMs: investigation.totalDurationMs,
    turnProvenance: investigation.turnProvenance.map(
      turnProvenanceCanonicalValue,
    ),
    conclusion: investigation.conclusion,
    certificateHash: investigation.certificate?.certificateHash ?? null,
    replayEvidenceCheckpointHash:
      investigation.replayEvidenceCheckpoint?.checkpointHash ?? null,
    nextEligibleAt: investigation.nextEligibleAt,
    createdAt: investigation.createdAt,
    updatedAt: investigation.updatedAt,
  };
}

export function serializeReviewInvestigation(
  investigation: ReviewInvestigation,
): string {
  return canonicalJson({
    ...investigationDossierCanonicalValue(investigation),
    dossierDigest: investigation.dossierDigest,
    certificate: investigation.certificate
      ? { ...investigation.certificate }
      : null,
    replayEvidenceCheckpoint: investigation.replayEvidenceCheckpoint
      ? { ...investigation.replayEvidenceCheckpoint }
      : null,
  });
}

function decideStateAfterCommit(
  investigation: ReviewInvestigation,
  purpose: ReviewInvestigationTurnPurpose,
  criticDecision: ContextCriticDecision | null,
): ReviewInvestigation {
  if (
    investigation.obligations.length > investigation.policy.maxObligations ||
    investigation.expansionDepth > investigation.policy.maxExpansionDepth ||
    investigation.findings.length > investigation.policy.maxFindings ||
    investigation.obligations.some(
      (item) => item.state === InvestigationObligationState.Unresolvable,
    )
  ) {
    return transitionToInconclusive(investigation, investigation.updatedAt);
  }
  const allSatisfied = investigation.obligations.every(
    (item) => item.state === InvestigationObligationState.Satisfied,
  );
  if (purpose === ReviewInvestigationTurnPurpose.Critic) {
    if (criticDecision === ContextCriticDecision.Accept && allSatisfied) {
      return {
        ...investigation,
        state: ReviewInvestigationState.ReadyToConclude,
      };
    }
    if (
      criticDecision === ContextCriticDecision.Veto &&
      investigation.criticCycles < investigation.policy.maxCriticCycles
    ) {
      return { ...investigation, state: ReviewInvestigationState.AwaitingTurn };
    }
    if (
      criticDecision === ContextCriticDecision.Abstain &&
      investigation.criticCycles < investigation.policy.maxCriticCycles
    ) {
      return {
        ...investigation,
        state: ReviewInvestigationState.AwaitingCritic,
      };
    }
    return transitionToInconclusive(investigation, investigation.updatedAt);
  }
  if (allSatisfied) {
    return {
      ...investigation,
      state:
        investigation.findings.length > 0
          ? ReviewInvestigationState.ReadyToConclude
          : ReviewInvestigationState.AwaitingCritic,
    };
  }
  if (investigation.semanticTurns >= investigation.policy.maxSemanticTurns) {
    return transitionToInconclusive(investigation, investigation.updatedAt);
  }
  return { ...investigation, state: ReviewInvestigationState.AwaitingTurn };
}

function effectiveCriticDecisionForCommit(
  investigation: ReviewInvestigation,
  turn: InvestigationTurn,
  decision: ContextCriticDecision | null,
): ContextCriticDecision | null {
  if (
    turn.purpose !== ReviewInvestigationTurnPurpose.Critic ||
    decision !== ContextCriticDecision.Accept ||
    investigation.findings.length > 0 ||
    !requiresIndependentCritic({
      criticPolicyVersion: investigation.contract.criticPolicyVersion,
      obligations: investigation.obligations,
    }) ||
    hasIndependentCriticProvenance(investigation.turnProvenance, turn.turnId)
  ) {
    return decision;
  }
  return ContextCriticDecision.Abstain;
}

function transitionToInconclusive(
  investigation: ReviewInvestigation,
  at: string,
): ReviewInvestigation {
  return {
    ...investigation,
    state: ReviewInvestigationState.Inconclusive,
    conclusion: ReviewInvestigationConclusion.Inconclusive,
    activeTurn: null,
    updatedAt: at,
  };
}

function privateMaterialExpiryResult(
  disposition: Exclude<
    InvestigationPrivateMaterialExpiryDisposition,
    InvestigationPrivateMaterialExpiryDisposition.Inconclusive
  >,
  investigation: ReviewInvestigation,
): InvestigationPrivateMaterialExpiryReconciliation {
  return {
    disposition,
    investigation,
    affectedObligationIds: Object.freeze([]),
    expiredTurnId: null,
  };
}

function canonicalTimestampMs(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new ReviewInvestigationDomainError(code);
  }
  return parsed;
}

function validateTurnBounds(
  investigation: ReviewInvestigation,
  commit: InvestigationTurnCommit,
): void {
  if (
    commit.proposedObligations.length >
      investigation.policy.maxProposalsPerTurn ||
    commit.closureClaims.length > investigation.policy.maxReceiptsPerTurn ||
    commit.findings.length + investigation.findings.length >
      investigation.policy.maxFindings ||
    !Number.isSafeInteger(commit.usageTokens) ||
    commit.usageTokens < 0 ||
    !Number.isSafeInteger(commit.durationMs) ||
    commit.durationMs < 0
  ) {
    throw new ReviewInvestigationDomainError("turn_bounds_exceeded");
  }
}

function validateCriticOutput(
  purpose: ReviewInvestigationTurnPurpose,
  commit: InvestigationTurnCommit,
): void {
  if (purpose !== ReviewInvestigationTurnPurpose.Critic) return;
  if (
    commit.closureClaims.length > 0 ||
    commit.unresolvableDecisions.length > 0 ||
    (commit.criticDecision === ContextCriticDecision.Accept &&
      (commit.proposedObligations.length > 0 || commit.findings.length > 0)) ||
    (commit.criticDecision === ContextCriticDecision.Abstain &&
      (commit.proposedObligations.length > 0 || commit.findings.length > 0))
  ) {
    throw new ReviewInvestigationDomainError("critic_output_contradictory");
  }
}

function validateTurnProvenance(
  investigation: ReviewInvestigation,
  turn: InvestigationTurn,
  commit: InvestigationTurnCommit,
): void {
  const provenance = commit.provenance;
  const acceptedEvidenceReceiptIds = [
    ...new Set(commit.acceptedEvidenceReceiptIds ?? []),
  ].sort();
  if (provenance === null) {
    if (acceptedEvidenceReceiptIds.length > 0) {
      throw new ReviewInvestigationDomainError("turn_provenance_invalid");
    }
    return;
  }
  if (
    provenance.turnId !== turn.turnId ||
    provenance.purpose !== turn.purpose ||
    provenance.runtimeProfile !== investigation.runtimeProfile ||
    provenance.totalTokens !== commit.usageTokens ||
    provenance.durationMs !== commit.durationMs ||
    !isValidInvestigationTokenUsage(provenance) ||
    investigation.turnProvenance.some((item) => item.turnId === turn.turnId)
  ) {
    throw new ReviewInvestigationDomainError("turn_provenance_invalid");
  }
}

function replaceObligation(
  obligations: readonly InvestigationObligation[],
  obligationId: string,
  update: (obligation: InvestigationObligation) => InvestigationObligation,
): InvestigationObligation[] {
  let found = false;
  const result = obligations.map((obligation) => {
    if (obligation.obligationId !== obligationId) return obligation;
    found = true;
    return update(obligation);
  });
  if (!found) throw new ReviewInvestigationDomainError("obligation_unknown");
  return [...sortObligations(result)];
}

function mergeFindings(
  current: readonly InvestigationFinding[],
  additions: readonly InvestigationFinding[],
): readonly InvestigationFinding[] {
  const byFingerprint = new Map(
    current.map((item) => [item.fingerprint, item]),
  );
  for (const finding of additions) {
    if (finding.fingerprint.trim().length === 0) {
      throw new ReviewInvestigationDomainError("finding_fingerprint_invalid");
    }
    const existing = byFingerprint.get(finding.fingerprint);
    if (
      existing &&
      canonicalJson(findingCanonicalValue(existing)) !==
        canonicalJson(findingCanonicalValue(finding))
    ) {
      throw new ReviewInvestigationDomainError("finding_identity_collision");
    }
    byFingerprint.set(finding.fingerprint, {
      ...finding,
      evidenceReceiptIds: [...finding.evidenceReceiptIds].sort(),
    });
  }
  return [...byFingerprint.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
}

function validateFindingEvidence(
  obligations: readonly InvestigationObligation[],
  findings: readonly InvestigationFinding[],
  acceptedTurnEvidenceReceiptIds: readonly string[],
): void {
  const acceptedReceipts = new Set([
    ...obligations
      .map((item) => item.receipt?.receiptId ?? null)
      .filter((item): item is string => item !== null),
    ...acceptedTurnEvidenceReceiptIds,
  ]);
  for (const finding of findings) {
    if (
      finding.evidenceReceiptIds.length === 0 ||
      finding.evidenceReceiptIds.some(
        (receiptId) => !acceptedReceipts.has(receiptId),
      ) ||
      (finding.line !== null &&
        (!Number.isSafeInteger(finding.line) || finding.line <= 0))
    ) {
      throw new ReviewInvestigationDomainError("finding_evidence_invalid");
    }
  }
}

export function proposalOriginForTurn(
  purpose: ReviewInvestigationTurnPurpose,
): InvestigationObligationOrigin {
  return purpose === ReviewInvestigationTurnPurpose.Critic
    ? InvestigationObligationOrigin.CriticProposal
    : InvestigationObligationOrigin.AgentProposal;
}
