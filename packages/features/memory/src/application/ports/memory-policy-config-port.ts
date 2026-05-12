import type { MemoryBundlePolicy } from "../../domain/memory-bundle-policy";
import { defaultMemoryBundlePolicy } from "../../domain/memory-bundle-policy";
import { memoryError } from "../../domain/memory-errors";
import type { MemoryScope } from "../../domain/memory-scope-policy";

export type MemoryAllowedScopePolicy = Record<MemoryScope, boolean>;

export type MemorySuggestionTtlPolicy = Record<MemoryScope, number>;

export type MemoryExportPolicy = {
  readonly defaultItemLimit: number;
  readonly maxItemLimit: number;
  readonly defaultMaxBytes: number;
  readonly maxBytes: number;
};

export type MemoryAuthorityPolicy = {
  readonly repositoryMaintainerCanManage: boolean;
  readonly membersCanView: boolean;
};

export type MemoryForkPullRequestMode =
  | "repository_only"
  | "workspace_without_user_prefs"
  | "disabled";

export type MemoryPolicyConfig = {
  readonly policyVersion: number;
  readonly safetyPolicyVersion: number;
  readonly memoryEnabled: boolean;
  readonly allowedScopes: MemoryAllowedScopePolicy;
  readonly suggestionTtlDays: MemorySuggestionTtlPolicy;
  readonly runtimeBundle: MemoryBundlePolicy;
  readonly export: MemoryExportPolicy;
  readonly authority: MemoryAuthorityPolicy;
  readonly forkPullRequestMode: MemoryForkPullRequestMode;
};

export type MemoryPolicyConfigOverrides = Partial<
  Omit<
    MemoryPolicyConfig,
    | "allowedScopes"
    | "suggestionTtlDays"
    | "runtimeBundle"
    | "export"
    | "authority"
  >
> & {
  readonly allowedScopes?: Partial<MemoryAllowedScopePolicy>;
  readonly suggestionTtlDays?: Partial<MemorySuggestionTtlPolicy>;
  readonly runtimeBundle?: Partial<MemoryBundlePolicy>;
  readonly export?: Partial<MemoryExportPolicy>;
  readonly authority?: Partial<MemoryAuthorityPolicy>;
};

export interface MemoryPolicyConfigPort {
  getPolicy(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
  }): Promise<MemoryPolicyConfig>;
}

export const defaultMemoryPolicyConfig: MemoryPolicyConfig = Object.freeze({
  policyVersion: 1,
  safetyPolicyVersion: 1,
  memoryEnabled: true,
  allowedScopes: Object.freeze({
    repository: true,
    workspace: true,
    user_prefs: true,
  }),
  suggestionTtlDays: Object.freeze({
    repository: 14,
    workspace: 14,
    user_prefs: 30,
  }),
  runtimeBundle: Object.freeze({
    ...defaultMemoryBundlePolicy,
  }),
  export: Object.freeze({
    defaultItemLimit: 5_000,
    maxItemLimit: 10_000,
    defaultMaxBytes: 10 * 1024 * 1024,
    maxBytes: 10 * 1024 * 1024,
  }),
  authority: Object.freeze({
    repositoryMaintainerCanManage: true,
    membersCanView: true,
  }),
  forkPullRequestMode: "repository_only",
});

export function createMemoryPolicyConfig(
  overrides: MemoryPolicyConfigOverrides = {},
): MemoryPolicyConfig {
  const config: MemoryPolicyConfig = {
    ...defaultMemoryPolicyConfig,
    ...overrides,
    allowedScopes: {
      ...defaultMemoryPolicyConfig.allowedScopes,
      ...overrides.allowedScopes,
    },
    suggestionTtlDays: {
      ...defaultMemoryPolicyConfig.suggestionTtlDays,
      ...overrides.suggestionTtlDays,
    },
    runtimeBundle: {
      ...defaultMemoryPolicyConfig.runtimeBundle,
      ...overrides.runtimeBundle,
    },
    export: {
      ...defaultMemoryPolicyConfig.export,
      ...overrides.export,
    },
    authority: {
      ...defaultMemoryPolicyConfig.authority,
      ...overrides.authority,
    },
  };
  assertValidMemoryPolicyConfig(config);
  return Object.freeze({
    ...config,
    allowedScopes: Object.freeze({ ...config.allowedScopes }),
    suggestionTtlDays: Object.freeze({ ...config.suggestionTtlDays }),
    runtimeBundle: Object.freeze({ ...config.runtimeBundle }),
    export: Object.freeze({ ...config.export }),
    authority: Object.freeze({ ...config.authority }),
  });
}

export class StaticMemoryPolicyConfig implements MemoryPolicyConfigPort {
  private readonly policy: MemoryPolicyConfig;

  constructor(overrides: MemoryPolicyConfigOverrides = {}) {
    this.policy = createMemoryPolicyConfig(overrides);
  }

  async getPolicy(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
  }): Promise<MemoryPolicyConfig> {
    if (!input.workspaceId.trim()) {
      throw memoryError("memory_input_invalid");
    }
    return this.policy;
  }
}

function assertValidMemoryPolicyConfig(config: MemoryPolicyConfig): void {
  assertPositiveInteger(config.policyVersion);
  assertPositiveInteger(config.safetyPolicyVersion);
  for (const value of Object.values(config.suggestionTtlDays)) {
    assertPositiveInteger(value);
  }
  assertPositiveInteger(config.runtimeBundle.maxItems);
  assertPositiveInteger(config.runtimeBundle.maxCharacters);
  assertPositiveInteger(config.export.defaultItemLimit);
  assertPositiveInteger(config.export.maxItemLimit);
  assertPositiveInteger(config.export.defaultMaxBytes);
  assertPositiveInteger(config.export.maxBytes);
  if (config.export.defaultItemLimit > config.export.maxItemLimit) {
    throw memoryError("memory_input_invalid");
  }
  if (config.export.defaultMaxBytes > config.export.maxBytes) {
    throw memoryError("memory_input_invalid");
  }
}

function assertPositiveInteger(value: number): void {
  if (Number.isSafeInteger(value) && value > 0) return;
  throw memoryError("memory_input_invalid");
}
