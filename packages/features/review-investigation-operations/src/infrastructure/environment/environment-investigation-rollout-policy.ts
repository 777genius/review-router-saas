import {
  InvestigationRolloutCapability,
  InvestigationRolloutProvider,
  createInvestigationRolloutPolicy,
  type InvestigationRolloutPolicy,
  type InvestigationRolloutSelector,
} from "../../domain/investigation-rollout-policy";
import type { InvestigationRolloutPolicyQueryPort } from "../../application/ports/operations-ports";

export const investigationRecordingEnabledEnv =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED";
export const investigationShadowEnabledEnv =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED";
export const investigationContextCriticEnabledEnv =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED";
export const investigationVerifiedCleanEnabledEnv =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED";
export const investigationCrossRevisionReplayEnabledEnv =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED";
export const investigationProductionEffectsEnabledEnv =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED";
export const investigationEmergencyDisabledEnv =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_EMERGENCY_DISABLED";
export const investigationRolloutSelectorsEnv =
  "REVIEW_ROUTER_REVIEW_INVESTIGATION_SELECTORS_JSON";

const capabilityEnvironment = Object.freeze([
  [investigationRecordingEnabledEnv, InvestigationRolloutCapability.Recording],
  [investigationShadowEnabledEnv, InvestigationRolloutCapability.Shadow],
  [
    investigationContextCriticEnabledEnv,
    InvestigationRolloutCapability.ContextCritic,
  ],
  [
    investigationVerifiedCleanEnabledEnv,
    InvestigationRolloutCapability.VerifiedClean,
  ],
  [
    investigationCrossRevisionReplayEnabledEnv,
    InvestigationRolloutCapability.CrossRevisionReplay,
  ],
  [
    investigationProductionEffectsEnabledEnv,
    InvestigationRolloutCapability.ProductionEffects,
  ],
] as const);

export class EnvironmentInvestigationRolloutPolicyQuery implements InvestigationRolloutPolicyQueryPort {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  async readCurrentPolicy(): Promise<InvestigationRolloutPolicy> {
    return readEnvironmentInvestigationRolloutPolicy(this.env);
  }
}

export function readEnvironmentInvestigationRolloutPolicy(
  env: Readonly<Record<string, string | undefined>>,
): InvestigationRolloutPolicy {
  return createInvestigationRolloutPolicy({
    emergencyDisabled: readToggle(env, investigationEmergencyDisabledEnv),
    enabledCapabilities: capabilityEnvironment
      .filter(([name]) => readToggle(env, name))
      .map(([, capability]) => capability),
    selectors: readSelectors(env[investigationRolloutSelectorsEnv]),
  });
}

function readToggle(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  const value = env[name];
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`investigation_rollout_toggle_invalid:${name}`);
}

function readSelectors(
  value: string | undefined,
): InvestigationRolloutPolicy["selectors"] {
  if (value === undefined || value.trim() === "") return Object.freeze({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("investigation_rollout_selectors_invalid");
  }
  const root = exactRecord(parsed);
  const capabilities = new Set(Object.values(InvestigationRolloutCapability));
  for (const key of Object.keys(root)) {
    if (!capabilities.has(key as InvestigationRolloutCapability)) {
      throw new Error("investigation_rollout_selector_capability_invalid");
    }
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(root).map(([key, selectors]) => [
        key,
        selectorList(selectors),
      ]),
    ),
  );
}

function selectorList(value: unknown): readonly InvestigationRolloutSelector[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("investigation_rollout_selector_list_invalid");
  }
  return Object.freeze(value.map(selector));
}

function selector(value: unknown): InvestigationRolloutSelector {
  const row = exactRecord(value);
  const keys = new Set([
    "workspaceIds",
    "repositoryConnectionIds",
    "providers",
    "trustDomains",
    "producerReleaseIds",
  ]);
  for (const key of Object.keys(row)) {
    if (!keys.has(key)) {
      throw new Error("investigation_rollout_selector_field_invalid");
    }
  }
  if (Object.keys(row).length === 0) {
    throw new Error("investigation_rollout_selector_empty");
  }
  const providerValues = optionalStrings(row.providers, "providers");
  const providers = providerValues?.map((provider) => {
    if (
      !Object.values(InvestigationRolloutProvider).includes(
        provider as InvestigationRolloutProvider,
      )
    ) {
      throw new Error("investigation_rollout_selector_provider_invalid");
    }
    return provider as InvestigationRolloutProvider;
  });
  return Object.freeze({
    ...optionalSelectorField(row, "workspaceIds"),
    ...optionalSelectorField(row, "repositoryConnectionIds"),
    ...(providers === undefined ? {} : { providers }),
    ...optionalSelectorField(row, "trustDomains"),
    ...optionalSelectorField(row, "producerReleaseIds"),
  });
}

function optionalSelectorField(
  row: Readonly<Record<string, unknown>>,
  field:
    | "workspaceIds"
    | "repositoryConnectionIds"
    | "trustDomains"
    | "producerReleaseIds",
): Readonly<Partial<Record<typeof field, readonly string[]>>> {
  const values = optionalStrings(row[field], field);
  return values === undefined ? {} : { [field]: values };
}

function optionalStrings(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 100 ||
    value.some(
      (item) =>
        typeof item !== "string" || item.length === 0 || item.length > 512,
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`investigation_rollout_selector_${field}_invalid`);
  }
  return Object.freeze([...value]);
}

function exactRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("investigation_rollout_selectors_invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}
