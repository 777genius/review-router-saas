import { describe, expect, it } from "vitest";
import {
  findReviewConfiguration,
  clearReviewConfiguration,
  mapConfigToRuntimeEnv,
  parseReviewConfiguration,
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
      FAIL_ON_SEVERITY: "critical",
      INLINE_MAX_COMMENTS: "5",
    });
    expect(Object.keys(env).join("\n")).not.toContain("SECRET");
    expect(Object.keys(env).join("\n")).not.toContain("KEY");
  });

  it("maps OpenRouter API-key config to fully-qualified runtime models", () => {
    const env = mapConfigToRuntimeEnv({
      ...safeDefaultReviewConfiguration,
      provider: {
        ...safeDefaultReviewConfiguration.provider,
        kind: "openrouter",
        authMode: "openrouter_api_key",
        model: "poolside/laguna-m.1:free",
      },
    });

    expect(env).toMatchObject({
      REVIEW_AUTH_MODE: "openrouter-api",
      REVIEW_PROVIDERS: "openrouter/poolside/laguna-m.1:free",
      SYNTHESIS_MODEL: "openrouter/poolside/laguna-m.1:free",
      CODEX_MODEL: "poolside/laguna-m.1:free",
    });
    expect(Object.keys(env).join("\n")).not.toContain("SECRET");
    expect(Object.keys(env).join("\n")).not.toContain("KEY");
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
        config: {
          ...safeDefaultReviewConfiguration,
          provider: {
            ...safeDefaultReviewConfiguration.provider,
            reasoningEffort: "high",
            fastMode: true,
          },
        },
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
        config: {
          ...safeDefaultReviewConfiguration,
          provider: {
            ...safeDefaultReviewConfiguration.provider,
            model: "gpt-5.4",
          },
        },
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
        config: {
          ...safeDefaultReviewConfiguration,
          provider: {
            ...safeDefaultReviewConfiguration.provider,
            model: "gpt-5.4-mini",
          },
          blockingPolicy: { failOnSeverity: "major" },
        },
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
        config: {
          ...safeDefaultReviewConfiguration,
          provider: {
            ...safeDefaultReviewConfiguration.provider,
            model: "gpt-5.4",
          },
        },
      },
      { configurations },
    );
    await saveReviewConfiguration(
      {
        target: repositoryTarget,
        config: {
          ...safeDefaultReviewConfiguration,
          provider: {
            ...safeDefaultReviewConfiguration.provider,
            model: "gpt-5.4-mini",
          },
        },
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
