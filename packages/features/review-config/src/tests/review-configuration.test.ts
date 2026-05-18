import { describe, expect, it } from "vitest";
import {
  findReviewConfiguration,
  clearReviewConfiguration,
  mapConfigToRuntimeEnv,
  parseReviewConfiguration,
  PrismaReviewConfigurationRepository,
  reviewConfigurationTargetKey,
  resolveReviewConfiguration,
  resolveReviewRuntimeEnv,
  saveReviewConfiguration,
  safeDefaultReviewConfiguration,
  type PersistedReviewConfiguration,
  type ReviewConfigurationRepositoryPort,
} from "../index";

class InMemoryReviewConfigurationRepository implements ReviewConfigurationRepositoryPort {
  private readonly versions = new Map<string, PersistedReviewConfiguration[]>();

  async findLatest(
    target: Parameters<ReviewConfigurationRepositoryPort["findLatest"]>[0],
  ) {
    const records = this.versions.get(reviewConfigurationTargetKey(target));
    return records?.at(-1) ?? null;
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
  it("maps safe default Codex OAuth config to runtime env without secrets", () => {
    const env = mapConfigToRuntimeEnv(safeDefaultReviewConfiguration);

    expect(env).toMatchObject({
      REVIEW_AUTH_MODE: "codex-oauth",
      CODEX_MODEL: "gpt-5.5",
      CODEX_REASONING_EFFORT: "medium",
      CODEX_AGENTIC_CONTEXT: "true",
      CODEX_FAST_MODE: "false",
      REVIEW_PROVIDERS: "codex/gpt-5.5",
      REQUIRED_HEALTHY_PROVIDERS: "codex/gpt-5.5",
      SYNTHESIS_MODEL: "codex/gpt-5.5",
      PROVIDER_LIMIT: "1",
      PROVIDER_MAX_PARALLEL: "1",
      INLINE_MIN_AGREEMENT: "1",
      FAIL_ON_SEVERITY: "critical",
      INLINE_MAX_COMMENTS: "5",
    });
    expect(Object.keys(env).join("\n")).not.toContain("SECRET");
    expect(Object.keys(env).join("\n")).not.toContain("KEY");
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
      CODEX_REASONING_EFFORT: "medium",
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
      provider: { model: "gpt-5.4" },
      providers: [{ model: "gpt-5.4", requiredHealthy: true }],
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
          kind: "codex",
          authMode: "codex_subscription_oauth",
          model: "gpt-5.5",
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

  it("maps mixed provider config to parallel runtime env", () => {
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
        ],
        execution: {
          providerLimit: 2,
          providerMaxParallel: 2,
          inlineMinAgreement: 2,
        },
      }),
    );

    expect(env).toMatchObject({
      REVIEW_AUTH_MODE: "codex-oauth",
      REVIEW_PROVIDERS: "codex/gpt-5.5,openrouter/poolside/laguna-m.1:free",
      REQUIRED_HEALTHY_PROVIDERS: "codex/gpt-5.5",
      SYNTHESIS_MODEL: "codex/gpt-5.5",
      CODEX_MODEL: "gpt-5.5",
      CODEX_REASONING_EFFORT: "high",
      PROVIDER_LIMIT: "2",
      PROVIDER_MAX_PARALLEL: "2",
      INLINE_MIN_AGREEMENT: "2",
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
      config: { provider: { reasoningEffort: "high", fastMode: true } },
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
      providers: ProviderRow[];
    };
    type PrismaStub = {
      $transaction<T>(callback: (tx: PrismaStub) => Promise<T>): Promise<T>;
      reviewConfiguration: {
        upsert(): Promise<{ id: string }>;
        findUnique(): Promise<{ versions: VersionRow[] }>;
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
    const versions: VersionRow[] = [];
    const prisma: PrismaStub = {
      $transaction: async <T>(callback: (tx: PrismaStub) => Promise<T>) =>
        callback(prisma),
      reviewConfiguration: {
        upsert: async () => ({ id: "review_config_1" }),
        findUnique: async () => ({
          versions: versions.length ? [versions[versions.length - 1]!] : [],
        }),
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
      config: { provider: { model: "gpt-5.5" } },
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
          };
        })(),
      },
      { configurations },
    );
    await expect(
      resolveReviewConfiguration(repositoryTarget, { configurations }),
    ).resolves.toMatchObject({
      source: "workspace",
      config: { provider: { model: "gpt-5.4" } },
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
