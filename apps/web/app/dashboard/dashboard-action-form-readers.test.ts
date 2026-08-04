import { describe, expect, it } from "vitest";
import {
  readProviderSetupSelection,
  readReviewConfigurationForm,
  readReviewDiscussionMode,
} from "./dashboard-action-form-readers";

describe("dashboard action form readers", () => {
  it("normalizes stale legacy Codex policy submissions to rotating Codex without dropping hybrid providers", () => {
    const formData = reviewConfigFormData([
      {
        authMode: "codex_subscription_oauth",
        model: "gpt-5.5",
        reasoningEffort: "high",
      },
      {
        authMode: "openrouter_api_key",
        model: "openai/gpt-5.3-codex",
        reasoningEffort: "medium",
      },
    ]);

    const config = readReviewConfigurationForm(formData);

    expect(config.providers).toHaveLength(2);
    expect(config.provider).toMatchObject({
      kind: "codex",
      authMode: "codex_subscription_oauth_rotating",
      model: "gpt-5.5",
      reasoningEffort: "high",
      requiredHealthy: true,
    });
    expect(config.providers[1]).toMatchObject({
      kind: "openrouter",
      authMode: "openrouter_api_key",
      model: "openai/gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    expect(config.execution).toMatchObject({
      providerLimit: 2,
      providerMaxParallel: 2,
      inlineMinAgreement: 2,
    });
    expect(config.investigationRollout).toEqual({
      recordingEnabled: false,
      shadowEnabled: false,
      contextCriticEnabled: false,
      verifiedCleanEnabled: false,
      crossRevisionReplayEnabled: false,
      productionEffectsEnabled: false,
    });
  });

  it("preserves explicitly enabled investigation rollout flags", () => {
    const formData = reviewConfigFormData([
      {
        authMode: "openrouter_api_key",
        model: "openai/gpt-5.3-codex",
        reasoningEffort: "medium",
      },
    ]);
    for (const flag of [
      "recordingEnabled",
      "shadowEnabled",
      "contextCriticEnabled",
      "verifiedCleanEnabled",
      "crossRevisionReplayEnabled",
      "productionEffectsEnabled",
    ]) {
      formData.set(`investigationRollout.${flag}`, "true");
    }

    expect(readReviewConfigurationForm(formData).investigationRollout).toEqual({
      recordingEnabled: true,
      shadowEnabled: true,
      contextCriticEnabled: true,
      verifiedCleanEnabled: true,
      crossRevisionReplayEnabled: true,
      productionEffectsEnabled: true,
    });
  });

  it.each(["codex_subscription_oauth", "codex_openai_api_key"] as const)(
    "normalizes stale provider setup auth mode %s to rotating Codex",
    (authMode) => {
      const formData = new FormData();
      formData.set("providerKind", "codex");
      formData.set("authMode", authMode);

      expect(readProviderSetupSelection(formData)).toEqual({
        providerKind: "codex",
        authMode: "codex_subscription_oauth_rotating",
      });
    },
  );

  it("rejects duplicate provider rows from policy submissions", () => {
    const formData = reviewConfigFormData([
      {
        authMode: "openrouter_api_key",
        model: "openai/gpt-5.3-codex",
        reasoningEffort: "medium",
      },
      {
        authMode: "openrouter_api_key",
        model: "openai/gpt-5.3-codex",
        reasoningEffort: "high",
      },
    ]);

    expect(() => readReviewConfigurationForm(formData)).toThrow(
      "duplicate_review_provider",
    );
  });

  it("defaults review discussion replies off unless setup explicitly opts in", () => {
    const formData = new FormData();

    expect(readReviewDiscussionMode(formData)).toBe("off");

    formData.set("reviewDiscussionMode", "suggest");

    expect(readReviewDiscussionMode(formData)).toBe("suggest");
  });
});

function reviewConfigFormData(
  providers: readonly {
    readonly authMode: string;
    readonly model: string;
    readonly reasoningEffort: string;
  }[],
): FormData {
  const formData = new FormData();
  formData.set("providerCount", String(providers.length));
  formData.set("providerMaxParallel", String(providers.length));
  formData.set("inlineMinAgreement", String(providers.length));
  formData.set("failOnSeverity", "critical");
  formData.set("inlineMaxComments", "5");
  formData.set("targetTokensPerBatch", "50000");

  providers.forEach((provider, index) => {
    formData.set(`providerAuthMode.${index}`, provider.authMode);
    formData.set(`providerModel.${index}`, provider.model);
    formData.set(`providerReasoningEffort.${index}`, provider.reasoningEffort);
    formData.set(`providerAgenticContext.${index}`, "true");
    formData.set(`providerFastMode.${index}`, "false");
    formData.set(`providerRequiredHealthy.${index}`, String(index === 0));
  });

  return formData;
}
