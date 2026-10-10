import { describe, expect, it } from "vitest";
import {
  findReviewConfiguration,
  clearReviewConfiguration,
  mapConfigToRuntimeEnv,
  parseReviewConfiguration,
  parseReviewConfigurationStrict,
  PrismaReviewConfigurationRepository,
  reviewConfigurationTargetKey,
  resolveReviewConfiguration,
  resolveReviewRuntimeEnv,
  saveReviewConfiguration,
  safeDefaultReviewConfiguration,
  effectiveInlineMaxComments,
  type PersistedReviewConfiguration,
  type ReviewConfigurationBatchReaderPort,
  type ReviewConfigurationRepositoryPort,
} from "../index";

const enabledInvestigationRollout = {
  recordingEnabled: true,
  shadowEnabled: true,
  contextCriticEnabled: true,
  verifiedCleanEnabled: true,
  crossRevisionReplayEnabled: true,
  productionEffectsEnabled: true,
} as const;

const disabledInvestigationRollout = {
  recordingEnabled: false,
  shadowEnabled: false,
  contextCriticEnabled: false,
  verifiedCleanEnabled: false,
  crossRevisionReplayEnabled: false,
  productionEffectsEnabled: false,
} as const;

const defaultInvestigationRuntimeEnv = {
  REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: "1",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED: "1",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: "1",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED: "0",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: "1",
} as const;

const disabledInvestigationRuntimeEnv = {
  REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "0",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: "0",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED: "0",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: "0",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED: "0",
  REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: "0",
} as const;

class InMemoryReviewConfigurationRepository
  implements
    ReviewConfigurationRepositoryPort,
    ReviewConfigurationBatchReaderPort
{
  private readonly versions = new Map<string, PersistedReviewConfiguration[]>();

  async findLatest(
    target: Parameters<ReviewConfigurationRepositoryPort["findLatest"]>[0],
  ) {
    const records = this.versions.get(reviewConfigurationTargetKey(target));
    return records?.at(-1) ?? null;
  }

  async findLatestForRepositories(input: {
    readonly workspaceId: string;
    readonly repositoryIds: readonly string[];
  }) {
    return [...new Set(input.repositoryIds)].flatMap((repositoryId) => {
      const config = this.versions
        .get(
          reviewConfigurationTargetKey({
            scope: "repository",
            workspaceId: input.workspaceId,
            repositoryId,
          }),
        )
        ?.at(-1);
      return config ? [{ repositoryId, config }] : [];
    });
  }

  async saveNextVersion(
    input: Parameters<ReviewConfigurationRepositoryPort["saveNextVersion"]>[0],
  ) {
    const key = reviewConfigurationTargetKey(input.target);
    const records = this.versions.get(key) ?? [];
    const persisted = {
      version: records.length + 1,
      config: input.config,
    } satisfies PersistedReviewConfiguration;
    this.versions.set(key, [...records, persisted]);
    return persisted;
  }

  async deleteTarget(
    target: Parameters<ReviewConfigurationRepositoryPort["deleteTarget"]>[0],
  ) {
    return this.versions.delete(reviewConfigurationTargetKey(target));
  }
}

describe("review configuration", () => {
  it("maps safe default rotating Codex OAuth config to runtime env without secrets", () => {
    const env = mapConfigToRuntimeEnv(safeDefaultReviewConfiguration);

    expect(env).toMatchObject({
      REVIEW_AUTH_MODE: "codex-oauth-rotating",
      CODEX_MODEL: "gpt-5.6-sol",
      CODEX_REASONING_EFFORT: "xhigh",
      CODEX_AGENTIC_CONTEXT: "true",
      CODEX_FAST_MODE: "false",
      REVIEW_PROVIDERS: "codex/gpt-5.6-sol",
      REQUIRED_HEALTHY_PROVIDERS: "codex/gpt-5.6-sol",
      SYNTHESIS_MODEL: "codex/gpt-5.6-sol",
      PROVIDER_LIMIT: "1",
      PROVIDER_MAX_PARALLEL: "1",
      INLINE_MIN_AGREEMENT: "1",
      FAIL_ON_SEVERITY: "critical",
      INLINE_MAX_COMMENTS: "50",
      INLINE_MIN_SEVERITY: "minor",
      ...defaultInvestigationRuntimeEnv,
    });
    expect(safeDefaultReviewConfiguration.investigationRollout).toEqual({
      recordingEnabled: true,
      shadowEnabled: true,
      contextCriticEnabled: true,
      verifiedCleanEnabled: true,
      crossRevisionReplayEnabled: false,
      productionEffectsEnabled: true,
    });
    expect(Object.keys(env).join("\n")).not.toContain("SECRET");
    expect(Object.keys(env).join("\n")).not.toContain("KEY");
  });

  it("treats the stored legacy inline cap of 5 as 50 and keeps 0 disabled", () => {
    expect(effectiveInlineMaxComments(0)).toBe(0);
    expect(effectiveInlineMaxComments(5)).toBe(50);
    expect(effectiveInlineMaxComments(12)).toBe(12);
  });

  it.each(["max", "ultra"] as const)(
    "persists and maps %s reasoning effort to runtime env",
    (reasoningEffort) => {
      const config = parseReviewConfigurationStrict({
        ...safeDefaultReviewConfiguration,
        provider: {
          ...safeDefaultReviewConfiguration.provider,
          reasoningEffort,
        },
        providers: [
          {
            ...safeDefaultReviewConfiguration.provider,
            reasoningEffort,
          },
        ],
      });

      expect(config.provider.reasoningEffort).toBe(reasoningEffort);
      const runtimeEnv = mapConfigToRuntimeEnv(config);
      expect(runtimeEnv.CODEX_REASONING_EFFORT).toBe(reasoningEffort);
      if (reasoningEffort === "ultra") {
        expect(runtimeEnv.RUN_TIMEOUT_SECONDS).toBe("1800");
      } else {
        expect(runtimeEnv).not.toHaveProperty("RUN_TIMEOUT_SECONDS");
      }
    },
  );

  it.each(["max", "ultra"] as const)(
    "tolerates stored %s effort for an older model but rejects a new save",
    (reasoningEffort) => {
      const input = {
        ...safeDefaultReviewConfiguration,
        provider: {
          ...safeDefaultReviewConfiguration.provider,
          model: "gpt-5.5",
          reasoningEffort,
        },
        providers: [
          {
            ...safeDefaultReviewConfiguration.provider,
            model: "gpt-5.5",
            reasoningEffort,
          },
        ],
      };

      expect(parseReviewConfiguration(input).provider.reasoningEffort).toBe(
        reasoningEffort,
      );
      expect(() => parseReviewConfigurationStrict(input)).toThrow(
        "review_reasoning_effort_unsupported_for_model",
      );
    },
  );

  it("maps only explicitly enabled investigation rollout flags to canonical 1 values", () => {
    const config = parseReviewConfiguration({
      ...safeDefaultReviewConfiguration,
      investigationRollout: enabledInvestigationRollout,
    });

    expect(mapConfigToRuntimeEnv(config)).toMatchObject({
      REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED: "1",
      REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: "1",
    });
    expect(() =>
      parseReviewConfiguration({
        ...safeDefaultReviewConfiguration,
        investigationRollout: { recordingEnabled: "1" },
      }),
    ).toThrow();
  });

  it("keeps an explicitly disabled investigation rollout disabled", () => {
    const config = parseReviewConfiguration({
      ...safeDefaultReviewConfiguration,
      investigationRollout: disabledInvestigationRollout,
    });

    expect(mapConfigToRuntimeEnv(config)).toMatchObject(
      disabledInvestigationRuntimeEnv,
    );
  });

  it("maps OpenRouter API-key config to fully-qualified runtime models", () => {
    const provider = {
      ...safeDefaultReviewConfiguration.provider,
      kind: "openrouter" as const,
      authMode: "openrouter_api_key" as const,
      model: "poolside/laguna-m.1:free",
    };
    const env = mapConfigToRuntimeEnv({
      ...safeDefaultReviewConfiguration,
      provider,
      providers: [provider],
    });

    expect(env).toMatchObject({
      REVIEW_AUTH_MODE: "openrouter-api",
      REVIEW_PROVIDERS: "openrouter/poolside/laguna-m.1:free",
      REQUIRED_HEALTHY_PROVIDERS: "openrouter/poolside/laguna-m.1:free",
      SYNTHESIS_MODEL: "openrouter/poolside/laguna-m.1:free",
      PROVIDER_LIMIT: "1",
      PROVIDER_MAX_PARALLEL: "1",
      CODEX_REASONING_EFFORT: "xhigh",
      CODEX_AGENTIC_CONTEXT: "true",
    });
    expect(env).not.toHaveProperty("CODEX_MODEL");
    expect(Object.keys(env).join("\n")).not.toContain("SECRET");
    expect(Object.keys(env).join("\n")).not.toContain("KEY");
  });

  it("maps Claude Code OAuth config without leaking secret names or Codex env", () => {
    const provider = {
      ...safeDefaultReviewConfiguration.provider,
      kind: "claude" as const,
      authMode: "claude_code_oauth" as const,
      model: "sonnet",
    };
    const env = mapConfigToRuntimeEnv({
      ...safeDefaultReviewConfiguration,
      provider,
      providers: [provider],
    });

    expect(env).toMatchObject({
      REVIEW_AUTH_MODE: "claude-oauth",
      REVIEW_PROVIDERS: "claude/sonnet",
      REQUIRED_HEALTHY_PROVIDERS: "claude/sonnet",
      SYNTHESIS_MODEL: "claude/sonnet",
      CLAUDE_MODEL: "sonnet",
      CLAUDE_AGENTIC_CONTEXT: "true",
      PROVIDER_LIMIT: "1",
      PROVIDER_MAX_PARALLEL: "1",
    });
    expect(env).not.toHaveProperty("CODEX_MODEL");
    expect(Object.keys(env).join("\n")).not.toContain("SECRET");
    expect(Object.keys(env).join("\n")).not.toContain("KEY");
  });

  it("rejects provider auth mode pairs that do not match catalog ownership", () => {
    expect(() =>
      parseReviewConfiguration({
        schemaVersion: 2,
        providers: [
          {
            kind: "codex",
            authMode: "claude_code_oauth",
            model: "sonnet",
            reasoningEffort: "medium",
            agenticContext: true,
            fastMode: false,
          },
        ],
        blockingPolicy: { failOnSeverity: "critical" },
        limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
      }),
    ).toThrow();
  });

  it("normalizes legacy v1 config into v2 provider list", () => {
    const config = parseReviewConfiguration({
      schemaVersion: 1,
      provider: {
        kind: "codex",
        authMode: "codex_subscription_oauth",
        model: "gpt-5.4",
      },
      blockingPolicy: { failOnSeverity: "critical" },
      limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
    });

    expect(config).toMatchObject({
      schemaVersion: 2,
      provider: {
        authMode: "codex_subscription_oauth_rotating",
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
      },
      providers: [
        {
          authMode: "codex_subscription_oauth_rotating",
          model: "gpt-5.4",
          requiredHealthy: true,
        },
      ],
      execution: {
        providerLimit: 1,
        providerMaxParallel: 1,
        inlineMinAgreement: 1,
      },
    });
  });

  it("normalizes all-false required health flags to first provider", () => {
    const config = parseReviewConfiguration({
      schemaVersion: 2,
      providers: [
        {
          kind: "openrouter",
          authMode: "openrouter_api_key",
          model: "openai/gpt-5.3-codex",
          requiredHealthy: false,
        },
        {
          kind: "openrouter",
          authMode: "openrouter_api_key",
          model: "poolside/laguna-m.1:free",
          requiredHealthy: false,
        },
      ],
      blockingPolicy: { failOnSeverity: "critical" },
      limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
    });

    expect(
      config.providers.map((provider) => provider.requiredHealthy),
    ).toEqual([true, false]);
  });

  it("maps hybrid rotating Codex provider config to parallel runtime env", () => {
    const env = mapConfigToRuntimeEnv(
      parseReviewConfiguration({
        ...safeDefaultReviewConfiguration,
        providers: [
          {
            kind: "codex",
            authMode: "codex_subscription_oauth",
            model: "gpt-5.5",
            reasoningEffort: "high",
            agenticContext: true,
            fastMode: false,
          },
          {
            kind: "openrouter",
            authMode: "openrouter_api_key",
            model: "poolside/laguna-m.1:free",
            reasoningEffort: "medium",
            agenticContext: true,
            fastMode: false,
          },
          {
            kind: "claude",
            authMode: "claude_code_oauth",
            model: "sonnet",
            reasoningEffort: "medium",
            agenticContext: true,
            fastMode: false,
          },
        ],
        execution: {
          providerLimit: 3,
          providerMaxParallel: 3,
          inlineMinAgreement: 2,
        },
      }),
    );

    expect(env).toMatchObject({
      REVIEW_AUTH_MODE: "codex-oauth-rotating",
      REVIEW_PROVIDERS:
        "codex/gpt-5.5,openrouter/poolside/laguna-m.1:free,claude/sonnet",
      REQUIRED_HEALTHY_PROVIDERS: "codex/gpt-5.5",
      SYNTHESIS_MODEL: "codex/gpt-5.5",
      CODEX_MODEL: "gpt-5.5",
      CODEX_REASONING_EFFORT: "high",
      CLAUDE_MODEL: "sonnet",
      CLAUDE_AGENTIC_CONTEXT: "true",
      PROVIDER_LIMIT: "3",
      PROVIDER_MAX_PARALLEL: "3",
      INLINE_MIN_AGREEMENT: "2",
    });
  });

  it("rejects multiple rotating Codex providers", () => {
    expect(() =>
      parseReviewConfiguration({
        schemaVersion: 2,
        providers: [
          {
            kind: "codex",
            authMode: "codex_subscription_oauth_rotating",
            model: "gpt-5.5",
          },
          {
            kind: "codex",
            authMode: "codex_subscription_oauth_rotating",
            model: "gpt-5.4",
          },
        ],
        blockingPolicy: { failOnSeverity: "critical" },
        limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
      }),
    ).toThrow("codex_rotating_single_provider_required");
  });

  it("rejects exact duplicate provider and model rows", () => {
    expect(() =>
      parseReviewConfigurationStrict({
        schemaVersion: 2,
        providers: [
          {
            kind: "openrouter",
            authMode: "openrouter_api_key",
            model: "openai/gpt-5.3-codex",
          },
          {
            kind: "openrouter",
            authMode: "openrouter_api_key",
            model: "openai/gpt-5.3-codex",
          },
        ],
        blockingPolicy: { failOnSeverity: "critical" },
        limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
      }),
    ).toThrow("duplicate_review_provider");
  });

  it("deduplicates exact duplicate provider rows when reading persisted configs", () => {
    const config = parseReviewConfiguration({
      schemaVersion: 2,
      providers: [
        {
          kind: "openrouter",
          authMode: "openrouter_api_key",
          model: "openai/gpt-5.3-codex",
        },
        {
          kind: "openrouter",
          authMode: "openrouter_api_key",
          model: "openai/gpt-5.3-codex",
        },
      ],
      execution: {
        providerMaxParallel: 2,
        inlineMinAgreement: 2,
      },
      blockingPolicy: { failOnSeverity: "critical" },
      limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
    });

    expect(config.providers).toHaveLength(1);
    expect(config.execution).toMatchObject({
      providerLimit: 1,
      providerMaxParallel: 1,
      inlineMinAgreement: 1,
    });
  });

  it("rejects invalid limits", () => {
    expect(() =>
      parseReviewConfiguration({
        provider: {
          kind: "codex",
          authMode: "codex_subscription_oauth",
          model: "gpt-5.5",
        },
        blockingPolicy: { failOnSeverity: "critical" },
        limits: { inlineMaxComments: 500, targetTokensPerBatch: 50000 },
      }),
    ).toThrow();
  });

  it("versions workspace review configuration through the repository port", async () => {
    const configurations = new InMemoryReviewConfigurationRepository();
    const target = { scope: "workspace", workspaceId: "workspace_1" } as const;

    await expect(
      saveReviewConfiguration(
        {
          target,
          config: safeDefaultReviewConfiguration,
        },
        { configurations },
      ),
    ).resolves.toMatchObject({ version: 1 });

    const updated = await saveReviewConfiguration(
      {
        target,
        config: (() => {
          const provider = {
            ...safeDefaultReviewConfiguration.provider,
            reasoningEffort: "high" as const,
            fastMode: true,
          };
          return {
            ...safeDefaultReviewConfiguration,
            provider,
            providers: [provider],
            investigationRollout: disabledInvestigationRollout,
          };
        })(),
      },
      { configurations },
    );

    expect(updated.version).toBe(2);
    await expect(
      findReviewConfiguration(target, { configurations }),
    ).resolves.toMatchObject({
      version: 2,
      config: {
        provider: { reasoningEffort: "high", fastMode: true },
        investigationRollout: disabledInvestigationRollout,
      },
    });
  });

  it("persists normalized provider rows through the Prisma repository", async () => {
    type ProviderRow = {
      providerKind: string;
      providerAuthMode: string;
      model: string;
      reasoningEffort: string;
      agenticContext: boolean;
      fastMode: boolean;
      requiredHealthy: boolean;
    };
    type VersionRow = {
      id: string;
      version: number;
      schemaVersion: number;
      providerKind: string;
      providerAuthMode: string;
      model: string;
      reasoningEffort: string;
      agenticContext: boolean;
      fastMode: boolean;
      failOnSeverity: string;
      inlineMaxComments: number;
      providerLimit: number;
      providerMaxParallel: number;
      inlineMinAgreement: number;
      targetTokensPerBatch: number;
      reviewLanguage: string | null;
      investigationRecordingEnabled: boolean;
      investigationShadowEnabled: boolean;
      investigationContextCriticEnabled: boolean;
      investigationVerifiedCleanEnabled: boolean;
      investigationCrossRevisionReplayEnabled: boolean;
      investigationProductionEffectsEnabled: boolean;
      providers: ProviderRow[];
    };
    type ConfigurationRow = {
      id: string;
      workspaceId: string;
      active: boolean;
    };
    type PrismaStub = {
      $transaction<T>(
        callback: (
          tx: Omit<PrismaStub, "$transaction"> & {
            $queryRaw(): Promise<unknown[]>;
          },
        ) => Promise<T>,
      ): Promise<T>;
      reviewConfiguration: {
        upsert(): Promise<ConfigurationRow>;
        findUnique(): Promise<{ active: boolean; versions: VersionRow[] }>;
        update(input: {
          where: { id: string };
          data: { active: boolean };
        }): Promise<ConfigurationRow>;
        deleteMany(): Promise<{ count: number }>;
      };
      reviewConfigurationVersion: {
        findFirst(): Promise<{ version: number } | null>;
        create(input: {
          data: Omit<VersionRow, "providers"> & {
            providers: { create: ProviderRow[] };
          };
        }): Promise<VersionRow>;
      };
    };
    const configuration: ConfigurationRow = {
      id: "review_config_1",
      workspaceId: "workspace_1",
      active: true,
    };
    const versions: VersionRow[] = [];
    let transactionAttempts = 0;
    const prisma: PrismaStub = {
      $transaction: async <T>(
        callback: (
          tx: Omit<PrismaStub, "$transaction"> & {
            $queryRaw(): Promise<unknown[]>;
          },
        ) => Promise<T>,
      ) => {
        transactionAttempts += 1;
        if (transactionAttempts === 1) {
          throw { code: "P2034" };
        }
        return callback({
          $queryRaw: async () => [],
          reviewConfiguration: prisma.reviewConfiguration,
          reviewConfigurationVersion: prisma.reviewConfigurationVersion,
        });
      },
      reviewConfiguration: {
        upsert: async () => ({ ...configuration }),
        findUnique: async () => ({
          active: configuration.active,
          versions: versions.length ? [versions[versions.length - 1]!] : [],
        }),
        update: async ({ where, data }) => {
          if (where.id !== configuration.id) {
            throw new Error("review_configuration_not_found");
          }
          configuration.active = data.active;
          return { ...configuration };
        },
        deleteMany: async () => ({ count: 1 }),
      },
      reviewConfigurationVersion: {
        findFirst: async () =>
          versions.length
            ? { version: versions[versions.length - 1]!.version }
            : null,
        create: async ({
          data,
        }: {
          data: Omit<VersionRow, "providers"> & {
            providers: {
              create: ProviderRow[];
            };
          };
        }) => {
          const record = {
            id: `version_${versions.length + 1}`,
            version: data.version,
            schemaVersion: data.schemaVersion,
            providerKind: data.providerKind,
            providerAuthMode: data.providerAuthMode,
            model: data.model,
            reasoningEffort: data.reasoningEffort,
            agenticContext: data.agenticContext,
            fastMode: data.fastMode,
            failOnSeverity: data.failOnSeverity,
            inlineMaxComments: data.inlineMaxComments,
            providerLimit: data.providerLimit,
            providerMaxParallel: data.providerMaxParallel,
            inlineMinAgreement: data.inlineMinAgreement,
            targetTokensPerBatch: data.targetTokensPerBatch,
            reviewLanguage: data.reviewLanguage ?? null,
            investigationRecordingEnabled: data.investigationRecordingEnabled,
            investigationShadowEnabled: data.investigationShadowEnabled,
            investigationContextCriticEnabled:
              data.investigationContextCriticEnabled,
            investigationVerifiedCleanEnabled:
              data.investigationVerifiedCleanEnabled,
            investigationCrossRevisionReplayEnabled:
              data.investigationCrossRevisionReplayEnabled,
            investigationProductionEffectsEnabled:
              data.investigationProductionEffectsEnabled,
            providers: data.providers.create,
          };
          versions.push(record);
          return record;
        },
      },
    };
    const repository = new PrismaReviewConfigurationRepository(prisma as never);
    const config = parseReviewConfiguration({
      ...safeDefaultReviewConfiguration,
      providers: [
        {
          kind: "codex",
          authMode: "codex_subscription_oauth",
          model: "gpt-5.5",
          reasoningEffort: "high",
          agenticContext: true,
          fastMode: false,
        },
        {
          kind: "openrouter",
          authMode: "openrouter_api_key",
          model: "poolside/laguna-m.1:free",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
        },
      ],
      execution: {
        providerLimit: 2,
        providerMaxParallel: 2,
        inlineMinAgreement: 2,
      },
      investigationRollout: enabledInvestigationRollout,
    });

    const saved = await repository.saveNextVersion({
      target: { scope: "workspace", workspaceId: "workspace_1" },
      config,
    });
    const latest = await repository.findLatest({
      scope: "workspace",
      workspaceId: "workspace_1",
    });

    expect(saved.config.providers).toHaveLength(2);
    expect(latest?.config.providers.map((provider) => provider.model)).toEqual([
      "gpt-5.5",
      "poolside/laguna-m.1:free",
    ]);
    expect(versions[0]?.model).toBe("gpt-5.5");
    expect(versions[0]?.providers.map((provider) => provider.model)).toEqual([
      "gpt-5.5",
      "poolside/laguna-m.1:free",
    ]);
    expect(
      versions[0]?.providers.map((provider) => provider.requiredHealthy),
    ).toEqual([true, false]);
    expect(latest?.config.investigationRollout).toEqual(
      enabledInvestigationRollout,
    );
    expect(versions[0]?.investigationProductionEffectsEnabled).toBe(true);
    expect(transactionAttempts).toBe(2);
  });

  it("resolves repository config before workspace default and safe default", async () => {
    const configurations = new InMemoryReviewConfigurationRepository();
    const workspaceTarget = {
      scope: "workspace",
      workspaceId: "workspace_1",
    } as const;
    const repositoryTarget = {
      scope: "repository",
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
    } as const;

    await expect(
      resolveReviewConfiguration(repositoryTarget, { configurations }),
    ).resolves.toMatchObject({
      source: "default",
      config: { provider: { model: "gpt-5.6-sol" } },
    });

    await saveReviewConfiguration(
      {
        target: workspaceTarget,
        config: (() => {
          const provider = {
            ...safeDefaultReviewConfiguration.provider,
            model: "gpt-5.4",
          };
          return {
            ...safeDefaultReviewConfiguration,
            provider,
            providers: [provider],
            investigationRollout: disabledInvestigationRollout,
          };
        })(),
      },
      { configurations },
    );
    await expect(
      resolveReviewConfiguration(repositoryTarget, { configurations }),
    ).resolves.toMatchObject({
      source: "workspace",
      config: {
        provider: { model: "gpt-5.4" },
        investigationRollout: {
          recordingEnabled: false,
          productionEffectsEnabled: false,
        },
      },
    });

    await saveReviewConfiguration(
      {
        target: repositoryTarget,
        config: (() => {
          const provider = {
            ...safeDefaultReviewConfiguration.provider,
            model: "gpt-5.4-mini",
          };
          return {
            ...safeDefaultReviewConfiguration,
            provider,
            providers: [provider],
            blockingPolicy: { failOnSeverity: "major" as const },
            investigationRollout: enabledInvestigationRollout,
          };
        })(),
      },
      { configurations },
    );

    await expect(
      resolveReviewRuntimeEnv(repositoryTarget, { configurations }),
    ).resolves.toMatchObject({
      source: "repository",
      runtimeEnv: {
        CODEX_MODEL: "gpt-5.4-mini",
        CODEX_FAST_MODE: "false",
        FAIL_ON_SEVERITY: "major",
        REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: "1",
        REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED: "1",
      },
    });
  });

  it("clears repository overrides and falls back to workspace config", async () => {
    const configurations = new InMemoryReviewConfigurationRepository();
    const workspaceTarget = {
      scope: "workspace",
      workspaceId: "workspace_1",
    } as const;
    const repositoryTarget = {
      scope: "repository",
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
    } as const;

    await saveReviewConfiguration(
      {
        target: workspaceTarget,
        config: (() => {
          const provider = {
            ...safeDefaultReviewConfiguration.provider,
            model: "gpt-5.4",
          };
          return {
            ...safeDefaultReviewConfiguration,
            provider,
            providers: [provider],
          };
        })(),
      },
      { configurations },
    );
    await saveReviewConfiguration(
      {
        target: repositoryTarget,
        config: (() => {
          const provider = {
            ...safeDefaultReviewConfiguration.provider,
            model: "gpt-5.4-mini",
          };
          return {
            ...safeDefaultReviewConfiguration,
            provider,
            providers: [provider],
          };
        })(),
      },
      { configurations },
    );

    await expect(
      resolveReviewConfiguration(repositoryTarget, { configurations }),
    ).resolves.toMatchObject({
      source: "repository",
      config: { provider: { model: "gpt-5.4-mini" } },
    });
    await expect(
      clearReviewConfiguration(repositoryTarget, { configurations }),
    ).resolves.toBe(true);
    await expect(
      resolveReviewConfiguration(repositoryTarget, { configurations }),
    ).resolves.toMatchObject({
      source: "workspace",
      config: { provider: { model: "gpt-5.4" } },
    });
    await expect(
      clearReviewConfiguration(repositoryTarget, { configurations }),
    ).resolves.toBe(false);
  });
});

const gatewayProvider = {
  kind: "codex",
  authMode: "codex_account_gateway",
  model: "mimo-v2-pro",
  reasoningEffort: "high",
  agenticContext: false,
  fastMode: true,
  gatewayBindingId: "binding-safe",
  gatewayProfileRef: "profile-mimo",
} as const;
const gatewayConfigInput = (provider: unknown) => ({
  schemaVersion: 2,
  providers: [provider],
  blockingPolicy: { failOnSeverity: "critical" },
  limits: { inlineMaxComments: 50, targetTokensPerBatch: 50000 },
});

// Detects lost flat references, legacy coercion, OpenAI-only reasoning gates or primary drift.
it("retains gateway references and upstream settings in v1 and v2 normalization", () => {
  const first = parseReviewConfigurationStrict(
    gatewayConfigInput(gatewayProvider),
  );
  expect(first.provider).toEqual({ ...gatewayProvider, requiredHealthy: true });
  expect(first.provider).toBe(first.providers[0]);
  const legacyShape = parseReviewConfiguration({
    schemaVersion: 1,
    provider: gatewayProvider,
    blockingPolicy: {},
    limits: {},
  });
  expect(legacyShape.provider).toEqual(first.provider);
  const mixed = parseReviewConfigurationStrict({
    ...gatewayConfigInput(gatewayProvider),
    provider: { ...gatewayProvider, gatewayBindingId: "ignored-primary" },
    providers: [
      gatewayProvider,
      {
        ...gatewayProvider,
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "ultra",
        gatewayBindingId: "binding-second",
        gatewayProfileRef: "profile-openrouter",
      },
    ],
  });
  expect(mixed.provider).toEqual(first.provider);
  expect(mixed.providers[1]).toMatchObject({
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "ultra",
    fastMode: true,
    gatewayBindingId: "binding-second",
    gatewayProfileRef: "profile-openrouter",
  });
});

// Detects silently deduplicating two selections that happen to use the same model.
it("keeps distinct bindings ordered and rejects only exact duplicate selections", () => {
  const second = { ...gatewayProvider, gatewayBindingId: "binding-second" };
  const input = {
    ...gatewayConfigInput(gatewayProvider),
    providers: [gatewayProvider, second],
  };
  expect(parseReviewConfigurationStrict(input).providers).toHaveLength(2);
  expect(() =>
    parseReviewConfigurationStrict({
      ...input,
      providers: [gatewayProvider, gatewayProvider],
    }),
  ).toThrow("duplicate_review_provider");
});

// Detects missing/partial selections, URL/token references or unbounded identifiers being accepted.
it.each([
  { gatewayBindingId: undefined },
  { gatewayProfileRef: undefined },
  { gatewayBindingId: "" },
  { gatewayProfileRef: " " },
  { gatewayBindingId: "b".repeat(161) },
  { gatewayProfileRef: "p".repeat(161) },
  { gatewayBindingId: "https://private.example/binding" },
  { gatewayProfileRef: "sk-secret-value" },
  { model: "https://private.example/model" },
])("rejects malformed gateway selection %j", (patch) => {
  expect(() =>
    parseReviewConfiguration(
      gatewayConfigInput({ ...gatewayProvider, ...patch }),
    ),
  ).toThrow();
});

// Detects reference smuggling in a foreign/unknown auth mode or kind, and caller authority fields.
it.each([
  { kind: "claude" },
  { kind: "openrouter" },
  { kind: "mimo" },
  { authMode: "unknown_gateway" },
  { authMode: "codex_subscription_oauth_rotating" },
  { authMode: "codex_subscription_oauth_hosted_pool" },
  { authMode: "codex_openai_api_key" },
  { ownerWorkspaceId: "caller-owner" },
  { principal: "caller-user" },
  { token: "secret" },
  { relayUrl: "https://private.example" },
  { nativeAccountId: 7 },
])("rejects gateway mode misuse %j", (patch) => {
  expect(() =>
    parseReviewConfigurationStrict(
      gatewayConfigInput({ ...gatewayProvider, ...patch }),
    ),
  ).toThrow();
});
