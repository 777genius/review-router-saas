import { describe, expect, it } from "vitest";
import {
  parseReviewConfiguration,
  safeDefaultReviewConfiguration,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  buildConfiguredProviderSetupByRepositoryId,
  buildEffectiveProviderSetupStateByRepositoryId,
  buildProviderSetupMismatchRepositoryIds,
  repositoryHealthStatusWithProviderSetupReadiness,
} from "./dashboard-provider-setup-readiness";

describe("dashboard provider setup readiness", () => {
  it("does not treat legacy Codex setup as configured for rotating Codex", () => {
    const configured = buildConfiguredProviderSetupByRepositoryId({
      providerSetup: [
        providerSetup({
          authMode: "codex_subscription_oauth",
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        }),
      ],
      repositories: [{ id: "repo_1" }],
      repositoryConfigs: [],
      activeConfig: safeDefaultReviewConfiguration,
    });

    expect(configured.has("repo_1")).toBe(false);
  });

  it("uses only configured setup rows that match the effective provider auth", () => {
    const configuredAt = new Date("2026-01-02T00:00:00Z");
    const configured = buildConfiguredProviderSetupByRepositoryId({
      providerSetup: [
        providerSetup({
          authMode: "codex_subscription_oauth",
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        }),
        providerSetup({
          authMode: "codex_subscription_oauth_rotating",
          updatedAt: configuredAt,
        }),
      ],
      repositories: [{ id: "repo_1" }],
      repositoryConfigs: [],
      activeConfig: safeDefaultReviewConfiguration,
    });

    expect(configured.get("repo_1")?.updatedAt).toEqual(configuredAt);
  });

  it("does not treat a repository as configured when any matching provider setup row is missing", () => {
    const providerSetupRows = [
      providerSetup({
        providerKind: "openrouter",
        authMode: "openrouter_api_key",
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      }),
      providerSetup({
        providerKind: "claude",
        authMode: "claude_code_oauth",
        state: "missing",
        updatedAt: new Date("2026-01-03T00:00:00Z"),
      }),
    ];
    const activeConfig = multiProviderReviewConfig();
    const effectiveProviderSetupStateByRepositoryId =
      buildEffectiveProviderSetupStateByRepositoryId({
        providerSetup: providerSetupRows,
        repositories: [{ id: "repo_1" }],
        repositoryConfigs: [],
        activeConfig,
      });

    expect(
      buildConfiguredProviderSetupByRepositoryId({
        providerSetup: providerSetupRows,
        repositories: [{ id: "repo_1" }],
        repositoryConfigs: [],
        activeConfig,
      }).has("repo_1"),
    ).toBe(false);
    expect(
      repositoryHealthStatusWithProviderSetupReadiness({
        repositoryId: "repo_1",
        healthStatus: "healthy",
        effectiveProviderSetupStateByRepositoryId,
        providerSetupMismatchRepositoryIds:
          buildProviderSetupMismatchRepositoryIds({
            providerSetup: providerSetupRows,
            repositories: [{ id: "repo_1" }],
            repositoryConfigs: [],
            activeConfig,
          }),
      }),
    ).toBe("provider_needs_setup");
  });

  it("does not treat a multi-auth repository as configured after only one provider is confirmed", () => {
    const providerSetupRows = [
      providerSetup({
        providerKind: "openrouter",
        authMode: "openrouter_api_key",
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      }),
    ];
    const activeConfig = multiProviderReviewConfig();
    const effectiveProviderSetupStateByRepositoryId =
      buildEffectiveProviderSetupStateByRepositoryId({
        providerSetup: providerSetupRows,
        repositories: [{ id: "repo_1" }],
        repositoryConfigs: [],
        activeConfig,
      });

    expect(
      buildConfiguredProviderSetupByRepositoryId({
        providerSetup: providerSetupRows,
        repositories: [{ id: "repo_1" }],
        repositoryConfigs: [],
        activeConfig,
      }).has("repo_1"),
    ).toBe(false);
    expect(
      repositoryHealthStatusWithProviderSetupReadiness({
        repositoryId: "repo_1",
        healthStatus: "healthy",
        effectiveProviderSetupStateByRepositoryId,
        providerSetupMismatchRepositoryIds:
          buildProviderSetupMismatchRepositoryIds({
            providerSetup: providerSetupRows,
            repositories: [{ id: "repo_1" }],
            repositoryConfigs: [],
            activeConfig,
          }),
      }),
    ).toBe("provider_needs_setup");
  });

  it("uses repository overrides when matching provider setup rows", () => {
    const openRouterConfig = reviewConfigFor(
      "openrouter",
      "openrouter_api_key",
    );
    const configured = buildConfiguredProviderSetupByRepositoryId({
      providerSetup: [
        providerSetup({
          authMode: "codex_subscription_oauth_rotating",
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        }),
        providerSetup({
          providerKind: "openrouter",
          authMode: "openrouter_api_key",
          updatedAt: new Date("2026-01-02T00:00:00Z"),
        }),
      ],
      repositories: [{ id: "repo_1" }],
      repositoryConfigs: [
        {
          repositoryId: "repo_1",
          config: { config: openRouterConfig },
        },
      ],
      activeConfig: safeDefaultReviewConfiguration,
    });

    expect(configured.get("repo_1")?.updatedAt).toEqual(
      new Date("2026-01-02T00:00:00Z"),
    );
  });

  it("downgrades healthy reports when provider setup no longer matches policy", () => {
    const providerSetupRows = [
      providerSetup({
        authMode: "codex_subscription_oauth",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ];
    const effectiveProviderSetupStateByRepositoryId =
      buildEffectiveProviderSetupStateByRepositoryId({
        providerSetup: providerSetupRows,
        repositories: [{ id: "repo_1" }],
        repositoryConfigs: [],
        activeConfig: safeDefaultReviewConfiguration,
      });

    expect(
      repositoryHealthStatusWithProviderSetupReadiness({
        repositoryId: "repo_1",
        healthStatus: "healthy",
        effectiveProviderSetupStateByRepositoryId,
        providerSetupMismatchRepositoryIds:
          buildProviderSetupMismatchRepositoryIds({
            providerSetup: providerSetupRows,
            repositories: [{ id: "repo_1" }],
            repositoryConfigs: [],
            activeConfig: safeDefaultReviewConfiguration,
          }),
      }),
    ).toBe("provider_needs_setup");
  });

  it("downgrades healthy reports when matching provider setup is missing", () => {
    const providerSetupRows = [
      providerSetup({
        authMode: "codex_subscription_oauth_rotating",
        state: "missing",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ];
    const effectiveProviderSetupStateByRepositoryId =
      buildEffectiveProviderSetupStateByRepositoryId({
        providerSetup: providerSetupRows,
        repositories: [{ id: "repo_1" }],
        repositoryConfigs: [],
        activeConfig: safeDefaultReviewConfiguration,
      });

    expect(
      repositoryHealthStatusWithProviderSetupReadiness({
        repositoryId: "repo_1",
        healthStatus: "healthy",
        effectiveProviderSetupStateByRepositoryId,
        providerSetupMismatchRepositoryIds:
          buildProviderSetupMismatchRepositoryIds({
            providerSetup: providerSetupRows,
            repositories: [{ id: "repo_1" }],
            repositoryConfigs: [],
            activeConfig: safeDefaultReviewConfiguration,
          }),
      }),
    ).toBe("provider_needs_setup");
  });

  it("downgrades healthy reports when setup metadata is absent for the effective policy", () => {
    const effectiveProviderSetupStateByRepositoryId =
      buildEffectiveProviderSetupStateByRepositoryId({
        providerSetup: [],
        repositories: [{ id: "repo_1" }],
        repositoryConfigs: [],
        activeConfig: safeDefaultReviewConfiguration,
      });

    expect(effectiveProviderSetupStateByRepositoryId.get("repo_1")).toEqual({
      state: "missing",
      updatedAt: new Date(0),
    });
    expect(
      repositoryHealthStatusWithProviderSetupReadiness({
        repositoryId: "repo_1",
        healthStatus: "healthy",
        effectiveProviderSetupStateByRepositoryId,
        providerSetupMismatchRepositoryIds: new Set(),
      }),
    ).toBe("provider_needs_setup");
  });

  it("downgrades healthy reports when only an unrelated old provider setup row exists", () => {
    const providerSetupRows = [
      providerSetup({
        authMode: "codex_subscription_oauth_rotating",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ];
    const openRouterConfig = reviewConfigFor(
      "openrouter",
      "openrouter_api_key",
    );

    expect(
      repositoryHealthStatusWithProviderSetupReadiness({
        repositoryId: "repo_1",
        healthStatus: "healthy",
        effectiveProviderSetupStateByRepositoryId:
          buildEffectiveProviderSetupStateByRepositoryId({
            providerSetup: providerSetupRows,
            repositories: [{ id: "repo_1" }],
            repositoryConfigs: [
              {
                repositoryId: "repo_1",
                config: { config: openRouterConfig },
              },
            ],
            activeConfig: safeDefaultReviewConfiguration,
          }),
        providerSetupMismatchRepositoryIds:
          buildProviderSetupMismatchRepositoryIds({
            providerSetup: providerSetupRows,
            repositories: [{ id: "repo_1" }],
            repositoryConfigs: [
              {
                repositoryId: "repo_1",
                config: { config: openRouterConfig },
              },
            ],
            activeConfig: safeDefaultReviewConfiguration,
          }),
      }),
    ).toBe("provider_needs_setup");
  });

  it("keeps healthy reports when a matching provider setup row exists beside unrelated old setup", () => {
    const providerSetupRows = [
      providerSetup({
        authMode: "codex_subscription_oauth_rotating",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      }),
      providerSetup({
        providerKind: "openrouter",
        authMode: "openrouter_api_key",
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      }),
    ];
    const openRouterConfig = reviewConfigFor(
      "openrouter",
      "openrouter_api_key",
    );

    expect(
      repositoryHealthStatusWithProviderSetupReadiness({
        repositoryId: "repo_1",
        healthStatus: "healthy",
        effectiveProviderSetupStateByRepositoryId:
          buildEffectiveProviderSetupStateByRepositoryId({
            providerSetup: providerSetupRows,
            repositories: [{ id: "repo_1" }],
            repositoryConfigs: [
              {
                repositoryId: "repo_1",
                config: { config: openRouterConfig },
              },
            ],
            activeConfig: safeDefaultReviewConfiguration,
          }),
        providerSetupMismatchRepositoryIds:
          buildProviderSetupMismatchRepositoryIds({
            providerSetup: providerSetupRows,
            repositories: [{ id: "repo_1" }],
            repositoryConfigs: [
              {
                repositoryId: "repo_1",
                config: { config: openRouterConfig },
              },
            ],
            activeConfig: safeDefaultReviewConfiguration,
          }),
      }),
    ).toBe("healthy");
  });
});

function providerSetup(input: {
  readonly providerKind?: string;
  readonly authMode: string;
  readonly state?: string;
  readonly updatedAt: Date;
}) {
  return {
    repositoryId: "repo_1",
    providerKind: input.providerKind ?? "codex",
    authMode: input.authMode,
    state: input.state ?? "configured",
    updatedAt: input.updatedAt,
  };
}

function reviewConfigFor(
  kind: "codex" | "openrouter",
  authMode: "codex_subscription_oauth_rotating" | "openrouter_api_key",
): ReviewConfiguration {
  return parseReviewConfiguration({
    schemaVersion: 2,
    providers: [
      {
        kind,
        authMode,
        model: kind === "codex" ? "gpt-5.5" : "poolside/laguna-m.1:free",
        reasoningEffort: "medium",
        agenticContext: true,
        fastMode: false,
      },
    ],
    execution: {
      providerMaxParallel: 1,
      inlineMinAgreement: 1,
    },
    blockingPolicy: { failOnSeverity: "critical" },
    limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
  });
}

function multiProviderReviewConfig(): ReviewConfiguration {
  return parseReviewConfiguration({
    schemaVersion: 2,
    providers: [
      {
        kind: "openrouter",
        authMode: "openrouter_api_key",
        model: "poolside/laguna-m.1:free",
        reasoningEffort: "medium",
        agenticContext: true,
        fastMode: false,
        requiredHealthy: true,
      },
      {
        kind: "claude",
        authMode: "claude_code_oauth",
        model: "sonnet",
        reasoningEffort: "medium",
        agenticContext: true,
        fastMode: false,
        requiredHealthy: false,
      },
    ],
    execution: {
      providerMaxParallel: 2,
      inlineMinAgreement: 1,
    },
    blockingPolicy: { failOnSeverity: "critical" },
    limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
  });
}
