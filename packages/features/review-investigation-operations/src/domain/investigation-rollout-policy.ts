export enum InvestigationRolloutCapability {
  Recording = "recording",
  Shadow = "shadow",
  ContextCritic = "context_critic",
  VerifiedClean = "verified_clean",
  CrossRevisionReplay = "cross_revision_replay",
  ProductionEffects = "production_effects",
}

export const investigationRolloutCapabilities = Object.freeze([
  InvestigationRolloutCapability.ContextCritic,
  InvestigationRolloutCapability.CrossRevisionReplay,
  InvestigationRolloutCapability.ProductionEffects,
  InvestigationRolloutCapability.Recording,
  InvestigationRolloutCapability.Shadow,
  InvestigationRolloutCapability.VerifiedClean,
] as const);

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
  Unavailable = "unavailable",
}

export type InvestigationRolloutTarget = Readonly<{
  workspaceId: string;
  repositoryConnectionId: string;
  scmRepositoryIdentityId: string;
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

export const investigationRolloutCapabilityDependencies: Readonly<
  Record<
    InvestigationRolloutCapability,
    readonly InvestigationRolloutCapability[]
  >
> = Object.freeze({
  [InvestigationRolloutCapability.ContextCritic]: Object.freeze([
    InvestigationRolloutCapability.Shadow,
  ]),
  [InvestigationRolloutCapability.CrossRevisionReplay]: Object.freeze([
    InvestigationRolloutCapability.Shadow,
  ]),
  [InvestigationRolloutCapability.ProductionEffects]: Object.freeze([
    InvestigationRolloutCapability.ContextCritic,
    InvestigationRolloutCapability.Shadow,
  ]),
  [InvestigationRolloutCapability.Recording]: Object.freeze([]),
  [InvestigationRolloutCapability.Shadow]: Object.freeze([
    InvestigationRolloutCapability.Recording,
  ]),
  [InvestigationRolloutCapability.VerifiedClean]: Object.freeze([
    InvestigationRolloutCapability.ContextCritic,
    InvestigationRolloutCapability.ProductionEffects,
  ]),
});

const explicitlyAllowlistedCapabilities =
  new Set<InvestigationRolloutCapability>([
    InvestigationRolloutCapability.VerifiedClean,
    InvestigationRolloutCapability.CrossRevisionReplay,
    InvestigationRolloutCapability.ProductionEffects,
  ]);

export function createInvestigationRolloutPolicy(input: {
  readonly emergencyDisabled: boolean;
  readonly enabledCapabilities: readonly InvestigationRolloutCapability[];
  readonly selectors?: InvestigationRolloutPolicy["selectors"];
}): InvestigationRolloutPolicy {
  const enabled = new Set(input.enabledCapabilities);
  for (const capability of investigationRolloutCapabilities) {
    requireDependency(
      enabled,
      capability,
      investigationRolloutCapabilityDependencies[capability],
    );
    if (
      enabled.has(capability) &&
      explicitlyAllowlistedCapabilities.has(capability) &&
      (input.selectors?.[capability]?.length ?? 0) === 0
    ) {
      throw new Error(`rollout_selector_required:${capability}`);
    }
  }
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
  return evaluateCapabilityForTarget(policy, capability, target, new Set());
}

function evaluateCapabilityForTarget(
  policy: InvestigationRolloutPolicy,
  capability: InvestigationRolloutCapability,
  target: InvestigationRolloutTarget,
  visited: Set<InvestigationRolloutCapability>,
): InvestigationRolloutDecision {
  if (visited.has(capability)) return InvestigationRolloutDecision.Unavailable;
  if (!policy.enabledCapabilities.has(capability))
    return InvestigationRolloutDecision.Disabled;
  const selectors = policy.selectors[capability] ?? [];
  if (
    explicitlyAllowlistedCapabilities.has(capability) &&
    selectors.length === 0
  ) {
    return InvestigationRolloutDecision.OutsideCohort;
  }
  if (
    selectors.length > 0 &&
    !selectors.some((selector) => matches(selector, target))
  ) {
    return InvestigationRolloutDecision.OutsideCohort;
  }
  const nextVisited = new Set(visited).add(capability);
  for (const dependency of investigationRolloutCapabilityDependencies[
    capability
  ]) {
    const decision = evaluateCapabilityForTarget(
      policy,
      dependency,
      target,
      nextVisited,
    );
    if (decision !== InvestigationRolloutDecision.Allowed) return decision;
  }
  return InvestigationRolloutDecision.Allowed;
}

export function isInvestigationRolloutCapability(
  value: unknown,
): value is InvestigationRolloutCapability {
  return mapInvestigationRolloutCapability(value) !== null;
}

export function mapInvestigationRolloutCapability(
  value: unknown,
): InvestigationRolloutCapability | null {
  switch (value) {
    case InvestigationRolloutCapability.ContextCritic:
      return InvestigationRolloutCapability.ContextCritic;
    case InvestigationRolloutCapability.CrossRevisionReplay:
      return InvestigationRolloutCapability.CrossRevisionReplay;
    case InvestigationRolloutCapability.ProductionEffects:
      return InvestigationRolloutCapability.ProductionEffects;
    case InvestigationRolloutCapability.Recording:
      return InvestigationRolloutCapability.Recording;
    case InvestigationRolloutCapability.Shadow:
      return InvestigationRolloutCapability.Shadow;
    case InvestigationRolloutCapability.VerifiedClean:
      return InvestigationRolloutCapability.VerifiedClean;
    default:
      return null;
  }
}

export function isInvestigationRolloutCapabilitySetDependencyClosed(
  capabilities: ReadonlySet<InvestigationRolloutCapability>,
): boolean {
  for (const capability of capabilities) {
    if (
      investigationRolloutCapabilityDependencies[capability].some(
        (dependency) => !capabilities.has(dependency),
      )
    ) {
      return false;
    }
  }
  return true;
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
