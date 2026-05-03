import { describe, expect, it } from "vitest";
import {
  mapConfigToRuntimeEnv,
  parseReviewConfiguration,
  safeDefaultReviewConfiguration,
} from "../index";

describe("review configuration", () => {
  it("maps safe default Codex OAuth config to runtime env without secrets", () => {
    const env = mapConfigToRuntimeEnv(safeDefaultReviewConfiguration);

    expect(env).toMatchObject({
      REVIEW_AUTH_MODE: "codex-oauth",
      CODEX_MODEL: "gpt-5.5",
      CODEX_REASONING_EFFORT: "medium",
      CODEX_AGENTIC_CONTEXT: "true",
      FAIL_ON_SEVERITY: "critical",
      INLINE_MAX_COMMENTS: "5",
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
});
