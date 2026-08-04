export enum InvestigationOperatorState {
  Provisional = "provisional",
  AwaitingTurn = "awaiting_turn",
  TurnLeased = "turn_leased",
  AwaitingCritic = "awaiting_critic",
  ReadyToConclude = "ready_to_conclude",
  Concluded = "concluded",
  Inconclusive = "inconclusive",
  Superseded = "superseded",
  Expired = "expired",
  Unknown = "unknown",
}

export enum InvestigationOperatorNextAction {
  RunTurn = "run_turn",
  RunCritic = "run_critic",
  AwaitCapacity = "await_capacity",
  Conclude = "conclude",
  Terminal = "terminal",
  Unknown = "unknown",
}

export enum InvestigationOperatorConclusion {
  VerifiedClean = "verified_clean",
  Findings = "findings",
  Inconclusive = "inconclusive",
  None = "none",
  Unknown = "unknown",
}

export enum InvestigationCompatibilityStatus {
  Compatible = "compatible",
  Legacy = "legacy",
  Unsupported = "unsupported",
  Unknown = "unknown",
}

export type InvestigationOperatorStatus = Readonly<{
  investigationId: string;
  repositoryScopeHash: string;
  reviewRevisionHash: string;
  state: InvestigationOperatorState;
  version: number;
  openObligationCount: number;
  satisfiedObligationCount: number;
  unresolvableObligationCount: number;
  nextAction: InvestigationOperatorNextAction;
  capacityEligibleAt: string | null;
  lastFailureCode: string | null;
  conclusion: InvestigationOperatorConclusion;
  compatibility: InvestigationCompatibilityStatus;
  producerReleaseId: string;
  protocolVersion: string;
  gatewayPolicyVersion: string;
  updatedAt: string;
}>;

export function sanitizeOperatorStatus(
  status: InvestigationOperatorStatus,
): InvestigationOperatorStatus {
  if (!/^[a-f0-9]{64}$/u.test(status.repositoryScopeHash))
    throw new Error("repository_scope_hash_invalid");
  if (!/^[a-f0-9]{64}$/u.test(status.reviewRevisionHash))
    throw new Error("review_revision_hash_invalid");
  for (const field of [
    status.investigationId,
    status.producerReleaseId,
    status.protocolVersion,
    status.gatewayPolicyVersion,
  ]) {
    if (!field || field.length > 512)
      throw new Error("operator_identifier_invalid");
  }
  for (const count of [
    status.version,
    status.openObligationCount,
    status.satisfiedObligationCount,
    status.unresolvableObligationCount,
  ]) {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("operator_count_invalid");
  }
  const safe = JSON.stringify(status);
  if (/token|secret|prompt|sourceCode|canonicalJson/iu.test(safe)) {
    throw new Error("operator_status_contains_private_field");
  }
  return Object.freeze({ ...status });
}
