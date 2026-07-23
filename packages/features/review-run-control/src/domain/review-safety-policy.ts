import {
  ProviderTaskSelector,
  ReviewProviderKind,
  ReviewSafetyCapability,
  ReviewSafetyDecisionKind,
  ReviewSafetyPolicyScope,
  ReviewSafetyRolloutMode,
  ReviewTaskKind,
  assertDate,
  assertIdentifier,
  assertPositiveInteger,
  cloneDate,
  invalid,
} from "./review-run-control-types";

export type GlobalReviewSafetyScope = {
  readonly scope: ReviewSafetyPolicyScope.Global;
};

export type WorkspaceReviewSafetyScope = {
  readonly scope: ReviewSafetyPolicyScope.Workspace;
  readonly workspaceId: string;
};

export type RepositoryReviewSafetyScope = {
  readonly scope: ReviewSafetyPolicyScope.Repository;
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
  readonly scmRepositoryIdentityId: string;
};

export type ReviewSafetyScope =
  | GlobalReviewSafetyScope
  | WorkspaceReviewSafetyScope
  | RepositoryReviewSafetyScope;

export type ReviewSafetyPolicy = {
  readonly policyId: string;
  readonly scope: ReviewSafetyScope;
  readonly capability: ReviewSafetyCapability;
  readonly version: number;
  readonly rolloutMode: ReviewSafetyRolloutMode;
  readonly providerTaskSelectors: readonly ProviderTaskSelector[];
  readonly updatedBy: string;
  readonly updatedAt: Date;
};

export type ReviewSafetyEmergencyControl = {
  readonly emergencyControlId: string;
  readonly scope: ReviewSafetyScope;
  readonly version: number;
  readonly stopped: boolean;
  readonly reason: string;
  readonly updatedBy: string;
  readonly updatedAt: Date;
};

export type ReviewSafetyCapabilityDecision = {
  readonly capability: ReviewSafetyCapability;
  readonly effectiveMode: ReviewSafetyRolloutMode;
  readonly effectAllowed: boolean;
  readonly selectorMatched: boolean;
  readonly contributingPolicyVersions: readonly string[];
};

export type ReviewSafetyPolicySnapshot = {
  readonly decisionKind: ReviewSafetyDecisionKind;
  readonly effectAllowed: boolean;
  readonly shadow: boolean;
  readonly emergencyStopped: boolean;
  readonly capabilityDecisions: readonly ReviewSafetyCapabilityDecision[];
  readonly emergencyVersionVector: readonly string[];
  readonly safetyDecisionHash: string;
  readonly resolvedAt: Date;
};

export type ReviewSafetyResolutionTarget = {
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
  readonly scmRepositoryIdentityId: string;
  readonly providerTasks?:
    | readonly {
        readonly providerKind: ReviewProviderKind;
        readonly taskKind: ReviewTaskKind;
      }[]
    | undefined;
};

const shadowCapable = new Set<ReviewSafetyCapability>([
  ReviewSafetyCapability.RunAuthorizationV2,
  ReviewSafetyCapability.EvidenceReuseV2,
  ReviewSafetyCapability.PromptOnlyReuse,
  ReviewSafetyCapability.ContextGatewayReuse,
]);

const decisionCapabilities: Readonly<
  Record<ReviewSafetyDecisionKind, readonly ReviewSafetyCapability[]>
> = {
  [ReviewSafetyDecisionKind.RunAuthorization]: [
    ReviewSafetyCapability.RunAuthorizationV2,
  ],
  [ReviewSafetyDecisionKind.InvocationLeaseAdmission]: [
    ReviewSafetyCapability.RunAuthorizationV2,
  ],
  [ReviewSafetyDecisionKind.ObservationAcceptance]: [
    ReviewSafetyCapability.EvidenceWritesV2,
  ],
  [ReviewSafetyDecisionKind.AuthorizedExecutionContinuation]: [],
  [ReviewSafetyDecisionKind.ExactRevisionCrossExecutionReuse]: [
    ReviewSafetyCapability.EvidenceReuseV2,
  ],
  [ReviewSafetyDecisionKind.PromptOnlyCrossRevisionReuse]: [
    ReviewSafetyCapability.EvidenceReuseV2,
    ReviewSafetyCapability.PromptOnlyReuse,
  ],
  [ReviewSafetyDecisionKind.ContextGatewayCrossRevisionReuse]: [
    ReviewSafetyCapability.EvidenceReuseV2,
    ReviewSafetyCapability.ContextGatewayReuse,
  ],
  [ReviewSafetyDecisionKind.ExecutionFinalizationWithPermit]: [
    ReviewSafetyCapability.PublicationOperationsV2,
  ],
  [ReviewSafetyDecisionKind.PublicationMutation]: [
    ReviewSafetyCapability.PublicationOperationsV2,
  ],
  [ReviewSafetyDecisionKind.MutationEpochActivation]: [
    ReviewSafetyCapability.MutationEpochV2,
  ],
  [ReviewSafetyDecisionKind.StatusOrReconciliation]: [],
};

export function requiredCapabilitiesForDecision(
  decisionKind: ReviewSafetyDecisionKind,
): readonly ReviewSafetyCapability[] {
  return [...decisionCapabilities[decisionKind]];
}

export function createReviewSafetyPolicy(input: {
  readonly policyId: string;
  readonly scope: ReviewSafetyScope;
  readonly capability: ReviewSafetyCapability;
  readonly rolloutMode: ReviewSafetyRolloutMode;
  readonly providerTaskSelectors?: readonly ProviderTaskSelector[] | undefined;
  readonly updatedBy: string;
  readonly updatedAt: Date;
  readonly version?: number | undefined;
}): ReviewSafetyPolicy {
  assertIdentifier(input.policyId, "policy_id");
  assertSafetyScope(input.scope);
  assertIdentifier(input.updatedBy, "updated_by");
  assertDate(input.updatedAt, "updated_at");
  const version = input.version ?? 1;
  assertPositiveInteger(version, "version");
  if (
    input.rolloutMode === ReviewSafetyRolloutMode.Shadow &&
    !shadowCapable.has(input.capability)
  ) {
    invalid("capability_has_no_shadow_semantics");
  }
  const selectors = normalizeSelectors(input.providerTaskSelectors ?? []);
  return {
    policyId: input.policyId,
    scope: cloneSafetyScope(input.scope),
    capability: input.capability,
    version,
    rolloutMode: input.rolloutMode,
    providerTaskSelectors: selectors,
    updatedBy: input.updatedBy,
    updatedAt: cloneDate(input.updatedAt),
  };
}

export function createReviewSafetyEmergencyControl(input: {
  readonly emergencyControlId: string;
  readonly scope: ReviewSafetyScope;
  readonly stopped: boolean;
  readonly reason: string;
  readonly updatedBy: string;
  readonly updatedAt: Date;
  readonly version?: number | undefined;
}): ReviewSafetyEmergencyControl {
  assertIdentifier(input.emergencyControlId, "emergency_control_id");
  assertSafetyScope(input.scope);
  assertIdentifier(input.reason, "reason");
  assertIdentifier(input.updatedBy, "updated_by");
  assertDate(input.updatedAt, "updated_at");
  const version = input.version ?? 1;
  assertPositiveInteger(version, "version");
  return {
    emergencyControlId: input.emergencyControlId,
    scope: cloneSafetyScope(input.scope),
    version,
    stopped: input.stopped,
    reason: input.reason,
    updatedBy: input.updatedBy,
    updatedAt: cloneDate(input.updatedAt),
  };
}

export function reviewSafetyScopeKey(scope: ReviewSafetyScope): string {
  switch (scope.scope) {
    case ReviewSafetyPolicyScope.Global:
      return ReviewSafetyPolicyScope.Global;
    case ReviewSafetyPolicyScope.Workspace:
      return `${ReviewSafetyPolicyScope.Workspace}:${scope.workspaceId}`;
    case ReviewSafetyPolicyScope.Repository:
      return [
        ReviewSafetyPolicyScope.Repository,
        scope.workspaceId,
        scope.repositoryConnectionId,
        scope.scmRepositoryIdentityId,
      ].join(":");
  }
}

export function reviewSafetyPolicyKey(input: {
  readonly scope: ReviewSafetyScope;
  readonly capability: ReviewSafetyCapability;
}): string {
  return `${reviewSafetyScopeKey(input.scope)}:${input.capability}`;
}

export function safetyScopeApplies(
  scope: ReviewSafetyScope,
  target: ReviewSafetyResolutionTarget,
): boolean {
  switch (scope.scope) {
    case ReviewSafetyPolicyScope.Global:
      return true;
    case ReviewSafetyPolicyScope.Workspace:
      return scope.workspaceId === target.workspaceId;
    case ReviewSafetyPolicyScope.Repository:
      return (
        scope.workspaceId === target.workspaceId &&
        scope.repositoryConnectionId === target.repositoryConnectionId &&
        scope.scmRepositoryIdentityId === target.scmRepositoryIdentityId
      );
  }
}

export function cloneReviewSafetyPolicy(
  policy: ReviewSafetyPolicy,
): ReviewSafetyPolicy {
  return {
    ...policy,
    scope: cloneSafetyScope(policy.scope),
    providerTaskSelectors: policy.providerTaskSelectors.map((selector) => ({
      ...selector,
    })),
    updatedAt: cloneDate(policy.updatedAt),
  };
}

export function cloneReviewSafetyEmergencyControl(
  control: ReviewSafetyEmergencyControl,
): ReviewSafetyEmergencyControl {
  return {
    ...control,
    scope: cloneSafetyScope(control.scope),
    updatedAt: cloneDate(control.updatedAt),
  };
}

export function cloneSafetyScope(scope: ReviewSafetyScope): ReviewSafetyScope {
  return { ...scope };
}

function assertSafetyScope(scope: ReviewSafetyScope): void {
  switch (scope.scope) {
    case ReviewSafetyPolicyScope.Global:
      return;
    case ReviewSafetyPolicyScope.Workspace:
      assertIdentifier(scope.workspaceId, "workspace_id");
      return;
    case ReviewSafetyPolicyScope.Repository:
      assertIdentifier(scope.workspaceId, "workspace_id");
      assertIdentifier(
        scope.repositoryConnectionId,
        "repository_connection_id",
      );
      assertIdentifier(
        scope.scmRepositoryIdentityId,
        "scm_repository_identity_id",
      );
      return;
  }
}

function normalizeSelectors(
  selectors: readonly ProviderTaskSelector[],
): readonly ProviderTaskSelector[] {
  if (selectors.length > 64) {
    invalid("provider_task_selectors_too_many");
  }
  const unique = new Map<string, ProviderTaskSelector>();
  for (const selector of selectors) {
    const key = `${selector.providerKind}:${selector.taskKind}`;
    unique.set(key, { ...selector });
  }
  return [...unique.values()].sort((left, right) =>
    `${left.providerKind}:${left.taskKind}`.localeCompare(
      `${right.providerKind}:${right.taskKind}`,
    ),
  );
}
