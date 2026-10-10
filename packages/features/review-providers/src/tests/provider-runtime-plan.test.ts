import { describe, expect, it } from "vitest";
import { buildProviderRuntimePlan, toRuntimeProviderId } from "../index";

const baseInput = {
  schemaVersion: 2,
  execution: {
    providerLimit: 1,
    providerMaxParallel: 1,
    inlineMinAgreement: 1,
  },
  blockingPolicy: { failOnSeverity: "critical" as const },
  limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
};

describe("provider runtime plan", () => {
  it("matches existing Codex runtime env contract", () => {
    const plan = buildProviderRuntimePlan({
      ...baseInput,
      providers: [
        {
          kind: "codex",
          authMode: "codex_subscription_oauth",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
          requiredHealthy: true,
        },
      ],
    });

    expect(plan.runtimeEnv).toMatchObject({
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
    });
    expect(plan.runtimeEnv.INLINE_MAX_COMMENTS).toBe("50");
    expect(plan.runtimeEnv.INLINE_MIN_SEVERITY).toBe("minor");
    expect(plan.requiredSecretNames).toEqual(["CODEX_AUTH_JSON"]);
    expect(plan.requiredCliTools).toEqual(["codex"]);
  });

  it.each(["max", "ultra"] as const)(
    "passes %s reasoning effort through the runtime plan",
    (reasoningEffort) => {
      const plan = buildProviderRuntimePlan({
        ...baseInput,
        providers: [
          {
            kind: "codex",
            authMode: "codex_subscription_oauth_rotating",
            model: "gpt-5.6-sol",
            reasoningEffort,
            agenticContext: true,
            fastMode: false,
            requiredHealthy: true,
          },
        ],
      });

      expect(plan.runtimeEnv.CODEX_REASONING_EFFORT).toBe(reasoningEffort);
    },
  );

  it("plans rotating Codex OAuth without falling back to the legacy secret", () => {
    const plan = buildProviderRuntimePlan({
      ...baseInput,
      providers: [
        {
          kind: "codex",
          authMode: "codex_subscription_oauth_rotating",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
          requiredHealthy: true,
        },
      ],
    });

    expect(plan.runtimeEnv.REVIEW_AUTH_MODE).toBe("codex-oauth-rotating");
    expect(plan.requiredSecretNames).toEqual([]);
    expect(plan.requiredSecretNames).not.toContain(
      "REVIEWROUTER_CODEX_AUTH_JSON",
    );
    expect(plan.requiredSecretNames).not.toContain("CODEX_AUTH_JSON");
    expect(plan.requiredCliTools).toEqual(["codex"]);
  });

  it("emits only required healthy provider ids", () => {
    const plan = buildProviderRuntimePlan({
      ...baseInput,
      providers: [
        {
          kind: "codex",
          authMode: "codex_subscription_oauth",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
          requiredHealthy: true,
        },
        {
          kind: "openrouter",
          authMode: "openrouter_api_key",
          model: "openai/gpt-oss-120b:free",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
          requiredHealthy: false,
        },
      ],
    });

    expect(plan.runtimeEnv.REVIEW_PROVIDERS).toBe(
      "codex/gpt-5.5,openrouter/openai/gpt-oss-120b:free",
    );
    expect(plan.runtimeEnv.REQUIRED_HEALTHY_PROVIDERS).toBe("codex/gpt-5.5");
  });

  it("builds Claude runtime env without Codex env", () => {
    const plan = buildProviderRuntimePlan({
      ...baseInput,
      providers: [
        {
          kind: "claude",
          authMode: "claude_code_oauth",
          model: "sonnet",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
        },
      ],
    });

    expect(plan.runtimeEnv).toMatchObject({
      REVIEW_AUTH_MODE: "claude-oauth",
      REVIEW_PROVIDERS: "claude/sonnet",
      REQUIRED_HEALTHY_PROVIDERS: "claude/sonnet",
      SYNTHESIS_MODEL: "claude/sonnet",
      CLAUDE_MODEL: "sonnet",
      CLAUDE_AGENTIC_CONTEXT: "true",
    });
    expect(plan.runtimeEnv).not.toHaveProperty("CODEX_MODEL");
    expect(plan.requiredSecretNames).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(plan.requiredCliTools).toEqual(["claude"]);
  });

  it("keeps OpenRouter as the public provider while planning Codex agent runtime", () => {
    const plan = buildProviderRuntimePlan({
      ...baseInput,
      providers: [
        {
          kind: "openrouter",
          authMode: "openrouter_api_key",
          model: "openai/gpt-5.3-codex",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
        },
      ],
    });

    expect(plan.runtimeEnv).toMatchObject({
      REVIEW_AUTH_MODE: "openrouter-api",
      REVIEW_PROVIDERS: "openrouter/openai/gpt-5.3-codex",
      REQUIRED_HEALTHY_PROVIDERS: "openrouter/openai/gpt-5.3-codex",
      SYNTHESIS_MODEL: "openrouter/openai/gpt-5.3-codex",
      CODEX_REASONING_EFFORT: "medium",
      CODEX_AGENTIC_CONTEXT: "true",
      CODEX_FAST_MODE: "false",
    });
    expect(plan.runtimeEnv).not.toHaveProperty("CODEX_MODEL");
    expect(plan.requiredSecretNames).toEqual(["OPENROUTER_API_KEY"]);
    expect(plan.requiredCliTools).toEqual(["codex"]);
  });

  it("plans the exact MiMo public-engine provider without Codex or OpenRouter fallback", () => {
    const plan = buildProviderRuntimePlan({
      ...baseInput,
      providers: [
        {
          kind: "codex-mimo",
          authMode: "mimo_token_plan_api_key",
          model: "mimo-v2.6-pro",
          reasoningEffort: "xhigh",
          agenticContext: true,
          fastMode: false,
        },
      ],
    });

    expect(plan.runtimeEnv).toMatchObject({
      REVIEW_AUTH_MODE: "mimo-token-plan-api",
      REVIEW_PROVIDERS: "codex-mimo/mimo-v2.6-pro",
      REQUIRED_HEALTHY_PROVIDERS: "codex-mimo/mimo-v2.6-pro",
      SYNTHESIS_MODEL: "codex-mimo/mimo-v2.6-pro",
      CODEX_REASONING_EFFORT: "xhigh",
      CODEX_AGENTIC_CONTEXT: "true",
      CODEX_FAST_MODE: "false",
    });
    expect(plan.requiredSecretNames).toEqual(["MIMO_TOKEN_PLAN_API_KEY"]);
    expect(plan.requiredCliTools).toEqual(["codex"]);
  });

  it("deduplicates mixed provider requirements while preserving provider order", () => {
    const plan = buildProviderRuntimePlan({
      ...baseInput,
      execution: {
        providerLimit: 3,
        providerMaxParallel: 3,
        inlineMinAgreement: 2,
      },
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
          kind: "claude",
          authMode: "claude_code_oauth",
          model: "sonnet",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
        },
        {
          kind: "claude",
          authMode: "claude_code_oauth",
          model: "opus",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
        },
      ],
    });

    expect(plan.providerIds).toEqual([
      "codex/gpt-5.5",
      "claude/sonnet",
      "claude/opus",
    ]);
    expect(plan.requiredSecretNames).toEqual([
      "CODEX_AUTH_JSON",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    expect(plan.requiredCliTools).toEqual(["codex", "claude"]);
    expect(plan.runtimeEnv.PROVIDER_MAX_PARALLEL).toBe("3");
    expect(plan.runtimeEnv.INLINE_MIN_AGREEMENT).toBe("2");
    expect(plan.runtimeEnv.REQUIRED_HEALTHY_PROVIDERS).toBe("codex/gpt-5.5");
    expect(plan.runtimeEnv.CLAUDE_AGENTIC_CONTEXT).toBe("true");
  });

  it("normalizes all-false required health flags to the first provider", () => {
    const plan = buildProviderRuntimePlan({
      ...baseInput,
      providers: [
        {
          kind: "codex",
          authMode: "codex_subscription_oauth",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
          requiredHealthy: false,
        },
        {
          kind: "openrouter",
          authMode: "openrouter_api_key",
          model: "poolside/laguna-m.1:free",
          reasoningEffort: "medium",
          agenticContext: true,
          fastMode: false,
          requiredHealthy: false,
        },
      ],
    });

    expect(plan.runtimeEnv.REQUIRED_HEALTHY_PROVIDERS).toBe("codex/gpt-5.5");
  });

  it("fails closed for invalid provider/auth pairs and secret-shaped env values", () => {
    expect(() =>
      buildProviderRuntimePlan({
        ...baseInput,
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
      }),
    ).toThrow("provider_auth_mode_kind_mismatch");

    expect(() =>
      toRuntimeProviderId({
        kind: "claude",
        authMode: "claude_code_oauth",
        model: " ",
        reasoningEffort: "medium",
        agenticContext: true,
        fastMode: false,
      }),
    ).toThrow("provider_model_required");
  });
});

// Detects treating a gateway profile as a new agent or exporting selection as authority.
it("plans a gateway model with safe settings only, without fallback or credentials", () => {
  const plan = buildProviderRuntimePlan({
    ...baseInput,
    providers: [
      {
        kind: "codex",
        authMode: "codex_account_gateway",
        model: "mimo-v2-pro",
        gatewayBindingId: "binding-safe",
        gatewayProfileRef: "profile-mimo",
        reasoningEffort: "high",
        agenticContext: false,
        fastMode: true,
      },
    ],
  });
  expect(plan.primaryRuntimeAuthMode).toBe("codex-account-gateway");
  expect(plan.providerIds).toEqual(["codex/mimo-v2-pro"]);
  expect(plan.requiredSecretNames).toEqual([]);
  expect(plan.requiredCliTools).toEqual(["codex"]);
  expect(plan.runtimeEnv).toEqual({
    REVIEWROUTER_CONFIG_SCHEMA_VERSION: "2",
    REVIEW_AUTH_MODE: "codex-account-gateway",
    REVIEW_PROVIDERS: "codex/mimo-v2-pro",
    REQUIRED_HEALTHY_PROVIDERS: "codex/mimo-v2-pro",
    SYNTHESIS_MODEL: "codex/mimo-v2-pro",
    PROVIDER_LIMIT: "1",
    PROVIDER_MAX_PARALLEL: "1",
    INLINE_MIN_AGREEMENT: "1",
    INLINE_MAX_COMMENTS: "50",
    INLINE_MIN_SEVERITY: "minor",
    TARGET_TOKENS_PER_BATCH: "50000",
    FAIL_ON_SEVERITY: "critical",
    CODEX_MODEL: "mimo-v2-pro",
    CODEX_REASONING_EFFORT: "high",
    CODEX_AGENTIC_CONTEXT: "false",
    CODEX_FAST_MODE: "true",
  });
});
