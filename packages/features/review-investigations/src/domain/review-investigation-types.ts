export enum ReviewInvestigationState {
  Provisional = "provisional",
  AwaitingTurn = "awaiting_turn",
  TurnLeased = "turn_leased",
  AwaitingCritic = "awaiting_critic",
  ReadyToConclude = "ready_to_conclude",
  Concluded = "concluded",
  Inconclusive = "inconclusive",
  Superseded = "superseded",
  Expired = "expired",
}

export enum InvestigationObligationState {
  Open = "open",
  Satisfied = "satisfied",
  Unresolvable = "unresolvable",
}

export enum InvestigationObligationKind {
  InventoryWitness = "inventory_witness",
  ChangedContent = "changed_content",
  BaseContent = "base_content",
  RelatedManifest = "related_manifest",
  DirectReferenceSearch = "direct_reference_search",
  DirectCaller = "direct_caller",
  DirectCallee = "direct_callee",
  TestEvidence = "test_evidence",
  SchemaContract = "schema_contract",
  ConfigurationContract = "configuration_contract",
  MigrationContract = "migration_contract",
  GeneratedSource = "generated_source",
  DependencyContract = "dependency_contract",
  SideEffectParity = "side_effect_parity",
  ExternalContract = "external_contract",
  BinaryArtifact = "binary_artifact",
  FindingRevalidation = "finding_revalidation",
  ContextCritic = "context_critic",
}

export enum ReviewInvestigationConclusion {
  VerifiedClean = "verified_clean",
  Findings = "findings",
  Inconclusive = "inconclusive",
}

export enum ReviewInvestigationRuntimeProfile {
  GatewayAttestedAgentV1 = "gateway_attested_agent_v1",
  OrchestratedToolLoopV1 = "orchestrated_tool_loop_v1",
  PreassembledContextV1 = "preassembled_context_v1",
  PromptOnlyV1 = "prompt_only_v1",
  AgenticUnboundedV1 = "agentic_unbounded_v1",
}

export enum ContextOperationOutcomeKind {
  Succeeded = "succeeded",
  Rejected = "rejected",
  Failed = "failed",
}

export enum ContextOperationFailureClass {
  RecoverableRequest = "recoverable_request",
  IncompleteResult = "incomplete_result",
  ConfinementViolation = "confinement_violation",
  InfrastructureFailure = "infrastructure_failure",
  BudgetExceeded = "budget_exceeded",
}

export enum ReviewInvestigationAbortReason {
  CapacityUnavailable = "capacity_unavailable",
  AuthenticationUnavailable = "authentication_unavailable",
  RetryableInfrastructureFailure = "retryable_infrastructure_failure",
  Timeout = "timeout",
  Cancelled = "cancelled",
  ConfinementViolation = "confinement_violation",
  SchemaInvalidOutput = "schema_invalid_output",
  StaleExecution = "stale_execution",
  SupersededExecution = "superseded_execution",
}

export enum ContextCriticDecision {
  Accept = "accept",
  Veto = "veto",
  Abstain = "abstain",
}

export enum ReviewInvestigationFeatureFlag {
  Recording = "review_investigation_recording_enabled",
  Shadow = "review_investigation_shadow_enabled",
  ContextCritic = "review_investigation_context_critic_enabled",
  VerifiedClean = "review_investigation_verified_clean_enabled",
  CrossRevisionReplay = "review_investigation_cross_revision_replay_enabled",
  ProductionEffects = "review_investigation_production_effects_enabled",
}

export enum ReviewInvestigationTurnPurpose {
  Discovery = "discovery",
  Critic = "critic",
}

export enum InvestigationTurnProviderKind {
  Codex = "codex",
  ClaudeCode = "claude_code",
}

export enum InvestigationFindingSeverity {
  Critical = "critical",
  Major = "major",
  Minor = "minor",
}

export enum ReviewInvestigationNextActionKind {
  RunTurn = "run_turn",
  RunCritic = "run_critic",
  AwaitCapacity = "await_capacity",
  Conclude = "conclude",
  Terminal = "terminal",
}
