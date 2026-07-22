import {
  requiredCapabilitiesForDecision,
  reviewSafetyScopeKey,
  safetyScopeApplies,
  type ReviewSafetyCapabilityDecision,
  type ReviewSafetyEmergencyControl,
  type ReviewSafetyPolicy,
  type ReviewSafetyPolicySnapshot,
  type ReviewSafetyResolutionTarget,
} from "../../domain/review-safety-policy";
import {
  ReviewSafetyCapability,
  ReviewSafetyDecisionKind,
  ReviewSafetyPolicyScope,
  ReviewSafetyRolloutMode,
  canonicalJson,
  cloneDate,
} from "../../domain/review-run-control-types";
import type { ClockPort, Sha256DigestPort } from "../ports/platform-ports";
import type {
  ReviewSafetyDecisionResolverPort,
  ReviewSafetyEmergencyControlQueryPort,
  ReviewSafetyPolicyQueryPort,
} from "../ports/review-safety-policy-ports";

export class ResolveReviewSafetyPolicy implements ReviewSafetyDecisionResolverPort {
  constructor(
    private readonly dependencies: {
      readonly clock: ClockPort;
      readonly digest: Sha256DigestPort;
      readonly policyQueries: ReviewSafetyPolicyQueryPort;
      readonly emergencyQueries: ReviewSafetyEmergencyControlQueryPort;
    },
  ) {}

  async resolveReviewSafetyPolicy(input: {
    readonly decisionKind: ReviewSafetyDecisionKind;
    readonly target: ReviewSafetyResolutionTarget;
  }): Promise<ReviewSafetyPolicySnapshot> {
    const resolvedAt = this.dependencies.clock.now();
    if (
      input.decisionKind === ReviewSafetyDecisionKind.StatusOrReconciliation
    ) {
      return this.buildSnapshot({
        input,
        resolvedAt,
        capabilityDecisions: [],
        emergencyStopped: false,
        emergencyVersionVector: [],
        controlReadState: "recovery_bypass",
      });
    }

    const capabilities = requiredCapabilitiesForDecision(input.decisionKind);
    let policies: readonly ReviewSafetyPolicy[] = [];
    let controls: readonly ReviewSafetyEmergencyControl[] = [];
    let controlReadState = "readable";
    try {
      [policies, controls] = await Promise.all([
        this.dependencies.policyQueries.findApplicableReviewSafetyPolicies({
          target: input.target,
          capabilities,
        }),
        this.dependencies.emergencyQueries.findApplicableReviewSafetyEmergencyControls(
          input.target,
        ),
      ]);
    } catch {
      controlReadState = "unreadable";
    }

    const emergency = resolveEmergencyControls(
      controls,
      input.target,
      controlReadState === "readable",
    );
    const capabilityDecisions = capabilities.map((capability) =>
      resolveCapability(
        capability,
        policies.filter(
          (policy) =>
            policy.capability === capability &&
            safetyScopeApplies(policy.scope, input.target),
        ),
        input.target,
      ),
    );
    return this.buildSnapshot({
      input,
      resolvedAt,
      capabilityDecisions,
      emergencyStopped: emergency.stopped,
      emergencyVersionVector: emergency.versionVector,
      controlReadState,
    });
  }

  private async buildSnapshot(input: {
    readonly input: {
      readonly decisionKind: ReviewSafetyDecisionKind;
      readonly target: ReviewSafetyResolutionTarget;
    };
    readonly resolvedAt: Date;
    readonly capabilityDecisions: readonly ReviewSafetyCapabilityDecision[];
    readonly emergencyStopped: boolean;
    readonly emergencyVersionVector: readonly string[];
    readonly controlReadState: string;
  }): Promise<ReviewSafetyPolicySnapshot> {
    const effectAllowed =
      !input.emergencyStopped &&
      input.capabilityDecisions.every((decision) => decision.effectAllowed);
    const shadow =
      !input.emergencyStopped &&
      input.capabilityDecisions.some(
        (decision) => decision.effectiveMode === ReviewSafetyRolloutMode.Shadow,
      );
    const hashInput = {
      decisionKind: input.input.decisionKind,
      target: {
        workspaceId: input.input.target.workspaceId,
        repositoryConnectionId: input.input.target.repositoryConnectionId,
        scmRepositoryIdentityId: input.input.target.scmRepositoryIdentityId,
        providerTasks: [...(input.input.target.providerTasks ?? [])].sort(
          (left, right) =>
            `${left.providerKind}:${left.taskKind}`.localeCompare(
              `${right.providerKind}:${right.taskKind}`,
            ),
        ),
      },
      controlReadState: input.controlReadState,
      emergencyVersionVector: input.emergencyVersionVector,
      capabilityDecisions: input.capabilityDecisions.map((decision) => ({
        capability: decision.capability,
        effectiveMode: decision.effectiveMode,
        effectAllowed: decision.effectAllowed,
        selectorMatched: decision.selectorMatched,
        contributingPolicyVersions: decision.contributingPolicyVersions,
      })),
    };
    return {
      decisionKind: input.input.decisionKind,
      effectAllowed,
      shadow,
      emergencyStopped: input.emergencyStopped,
      capabilityDecisions: input.capabilityDecisions.map((decision) => ({
        ...decision,
        contributingPolicyVersions: [...decision.contributingPolicyVersions],
      })),
      emergencyVersionVector: [...input.emergencyVersionVector],
      safetyDecisionHash: await this.dependencies.digest.digestUtf8(
        canonicalJson(hashInput),
      ),
      resolvedAt: cloneDate(input.resolvedAt),
    };
  }
}

function resolveEmergencyControls(
  controls: readonly ReviewSafetyEmergencyControl[],
  target: ReviewSafetyResolutionTarget,
  readable: boolean,
): { readonly stopped: boolean; readonly versionVector: readonly string[] } {
  const scopeKeys = [
    ReviewSafetyPolicyScope.Global,
    `${ReviewSafetyPolicyScope.Workspace}:${target.workspaceId}`,
    [
      ReviewSafetyPolicyScope.Repository,
      target.workspaceId,
      target.repositoryConnectionId,
      target.scmRepositoryIdentityId,
    ].join(":"),
  ];
  if (!readable) {
    return {
      stopped: true,
      versionVector: scopeKeys.map((scope) => `${scope}:unreadable`),
    };
  }
  const applicable = controls.filter((control) =>
    safetyScopeApplies(control.scope, target),
  );
  const byScope = new Map(
    applicable.map((control) => [reviewSafetyScopeKey(control.scope), control]),
  );
  const global = byScope.get(ReviewSafetyPolicyScope.Global);
  return {
    stopped: !global || applicable.some((control) => control.stopped),
    versionVector: scopeKeys.map((scope) => {
      const control = byScope.get(scope);
      return control
        ? `${control.emergencyControlId}:${control.version}:${control.stopped ? "stopped" : "open"}`
        : `${scope}:missing`;
    }),
  };
}

function resolveCapability(
  capability: ReviewSafetyCapability,
  policies: readonly ReviewSafetyPolicy[],
  target: ReviewSafetyResolutionTarget,
): ReviewSafetyCapabilityDecision {
  const byScope = new Map(
    policies.map((policy) => [policy.scope.scope, policy]),
  );
  const ordered = [
    byScope.get(ReviewSafetyPolicyScope.Global),
    byScope.get(ReviewSafetyPolicyScope.Workspace),
    byScope.get(ReviewSafetyPolicyScope.Repository),
  ];
  const global = ordered[0];
  let effectiveMode = global?.rolloutMode ?? ReviewSafetyRolloutMode.Disabled;
  let selectorMatched = global ? selectorsMatch(global, target) : true;
  let enrollmentRequired =
    effectiveMode === ReviewSafetyRolloutMode.Allowlisted;

  for (const policy of ordered.slice(1)) {
    if (!policy) {
      continue;
    }
    selectorMatched = selectorMatched && selectorsMatch(policy, target);
    if (
      effectiveMode === ReviewSafetyRolloutMode.Disabled ||
      effectiveMode === ReviewSafetyRolloutMode.Shadow
    ) {
      continue;
    }
    if (
      policy.rolloutMode === ReviewSafetyRolloutMode.Disabled ||
      policy.rolloutMode === ReviewSafetyRolloutMode.Shadow
    ) {
      effectiveMode = policy.rolloutMode;
      enrollmentRequired = false;
      continue;
    }
    if (policy.rolloutMode === ReviewSafetyRolloutMode.Allowlisted) {
      effectiveMode = ReviewSafetyRolloutMode.Allowlisted;
      enrollmentRequired = true;
      continue;
    }
    if (
      effectiveMode === ReviewSafetyRolloutMode.Allowlisted &&
      policy.rolloutMode === ReviewSafetyRolloutMode.Enabled
    ) {
      effectiveMode = ReviewSafetyRolloutMode.Enabled;
      enrollmentRequired = false;
    }
  }

  return {
    capability,
    effectiveMode,
    effectAllowed:
      effectiveMode === ReviewSafetyRolloutMode.Enabled &&
      !enrollmentRequired &&
      selectorMatched,
    selectorMatched,
    contributingPolicyVersions: ordered
      .filter((policy): policy is ReviewSafetyPolicy => policy !== undefined)
      .map(
        (policy) =>
          `${policy.policyId}:${policy.version}:${policy.rolloutMode}`,
      ),
  };
}

function selectorsMatch(
  policy: ReviewSafetyPolicy,
  target: ReviewSafetyResolutionTarget,
): boolean {
  if (policy.providerTaskSelectors.length === 0) {
    return true;
  }
  const targets = target.providerTasks ?? [];
  return (
    targets.length > 0 &&
    targets.every((targetSelector) =>
      policy.providerTaskSelectors.some(
        (selector) =>
          selector.providerKind === targetSelector.providerKind &&
          selector.taskKind === targetSelector.taskKind,
      ),
    )
  );
}
