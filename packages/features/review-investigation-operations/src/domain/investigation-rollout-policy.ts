export enum InvestigationRolloutCapability {
  Recording = "recording",
  Shadow = "shadow",
  ContextCritic = "context_critic",
  VerifiedClean = "verified_clean",
  CrossRevisionReplay = "cross_revision_replay",
  ProductionEffects = "production_effects",
}

export enum InvestigationRolloutProvider {
  Codex = "codex",
  Claude = "claude",
  Unknown = "unknown",
}

export enum InvestigationRolloutDecision {
  Allowed = "allowed",
  Disabled = "disabled",
  OutsideCohort = "outside_cohort",
  EmergencyDisabled = "emergency_disabled",
}

export type InvestigationRolloutTarget = Readonly<{
  workspaceId: string;
  repositoryConnectionId: string;
  provider: InvestigationRolloutProvider;
  trustDomain: string;
  producerReleaseId: string;
}>;

export type InvestigationRolloutSelector = Readonly<{
  workspaceIds?: readonly string[];
  repositoryConnectionIds?: readonly string[];
  providers?: readonly InvestigationRolloutProvider[];
  trustDomains?: readonly string[];
  producerReleaseIds?: readonly string[];
}>;

export type InvestigationRolloutPolicy = Readonly<{
  emergencyDisabled: boolean;
  enabledCapabilities: ReadonlySet<InvestigationRolloutCapability>;
  selectors: Readonly<
    Partial<
      Record<
        InvestigationRolloutCapability,
        readonly InvestigationRolloutSelector[]
      >
    >
  >;
}>;

export function createInvestigationRolloutPolicy(input: {
  readonly emergencyDisabled: boolean;
  readonly enabledCapabilities: readonly InvestigationRolloutCapability[];
  readonly selectors?: InvestigationRolloutPolicy["selectors"];
}): InvestigationRolloutPolicy {
  const enabled = new Set(input.enabledCapabilities);
  requireDependency(enabled, InvestigationRolloutCapability.Shadow, [
    InvestigationRolloutCapability.Recording,
  ]);
  requireDependency(enabled, InvestigationRolloutCapability.ContextCritic, [
    InvestigationRolloutCapability.Shadow,
  ]);
  requireDependency(enabled, InvestigationRolloutCapability.ProductionEffects, [
    InvestigationRolloutCapability.Shadow,
    InvestigationRolloutCapability.ContextCritic,
  ]);
  requireDependency(enabled, InvestigationRolloutCapability.VerifiedClean, [
    InvestigationRolloutCapability.ContextCritic,
    InvestigationRolloutCapability.ProductionEffects,
  ]);
  requireDependency(
    enabled,
    InvestigationRolloutCapability.CrossRevisionReplay,
    [InvestigationRolloutCapability.Shadow],
  );
  return Object.freeze({
    emergencyDisabled: input.emergencyDisabled,
    enabledCapabilities: enabled,
    selectors: Object.freeze({ ...(input.selectors ?? {}) }),
  });
}

export function evaluateInvestigationRollout(
  policy: InvestigationRolloutPolicy,
  capability: InvestigationRolloutCapability,
  target: InvestigationRolloutTarget,
): InvestigationRolloutDecision {
  if (policy.emergencyDisabled)
    return InvestigationRolloutDecision.EmergencyDisabled;
  if (!policy.enabledCapabilities.has(capability))
    return InvestigationRolloutDecision.Disabled;
  const selectors = policy.selectors[capability] ?? [];
  if (selectors.length === 0) return InvestigationRolloutDecision.Allowed;
  return selectors.some((selector) => matches(selector, target))
    ? InvestigationRolloutDecision.Allowed
    : InvestigationRolloutDecision.OutsideCohort;
}

function requireDependency(
  enabled: ReadonlySet<InvestigationRolloutCapability>,
  capability: InvestigationRolloutCapability,
  dependencies: readonly InvestigationRolloutCapability[],
): void {
  if (!enabled.has(capability)) return;
  for (const dependency of dependencies) {
    if (!enabled.has(dependency)) {
      throw new Error(`rollout_dependency_missing:${capability}:${dependency}`);
    }
  }
}

function matches(
  selector: InvestigationRolloutSelector,
  target: InvestigationRolloutTarget,
): boolean {
  return (
    includes(selector.workspaceIds, target.workspaceId) &&
    includes(selector.repositoryConnectionIds, target.repositoryConnectionId) &&
    includes(selector.providers, target.provider) &&
    includes(selector.trustDomains, target.trustDomain) &&
    includes(selector.producerReleaseIds, target.producerReleaseId)
  );
}

function includes<T>(values: readonly T[] | undefined, value: T): boolean {
  return values === undefined || values.length === 0 || values.includes(value);
}
