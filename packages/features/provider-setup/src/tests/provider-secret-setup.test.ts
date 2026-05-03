import { describe, expect, it } from "vitest";
import { buildProviderSecretSetupGuidance } from "../domain/provider-secret-setup";

describe("provider secret setup guidance", () => {
  it("builds a Codex OAuth org selected-repository command without sending secrets to SaaS", () => {
    const guidance = buildProviderSecretSetupGuidance({
      provider: "codex_oauth",
      repoFullName: "agent-teams-ai/tvaity",
      organizationLogin: "agent-teams-ai",
    });

    expect(guidance.recommendedScope).toBe(
      "organization_selected_repositories",
    );
    expect(guidance.commands[0]).toMatchObject({
      storesSecretIn: "github_org_secret",
      sendsSecretToReviewRouter: false,
    });
    expect(guidance.commands[0]?.command).toContain(
      "REVIEW_ROUTER_SECRET_SCOPE=org",
    );
    expect(guidance.commands[0]?.command).toContain(
      "REVIEW_ROUTER_ORG_SECRET_REPOS=tvaity",
    );
    expect(guidance.commands[0]?.command).not.toContain("CODEX_AUTH_JSON=");
  });

  it("builds repository API key commands without embedding secret values", () => {
    const guidance = buildProviderSecretSetupGuidance({
      provider: "openai_api_key",
      repoFullName: "777genius/example",
    });

    expect(guidance.recommendedScope).toBe("repository");
    expect(guidance.commands[0]?.command).toBe(
      "gh secret set OPENAI_API_KEY --repo 777genius/example",
    );
    expect(guidance.commands[0]?.command).not.toContain("sk-");
  });
});
