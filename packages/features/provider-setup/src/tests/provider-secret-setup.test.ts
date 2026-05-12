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
      scope: "organization_selected_repositories",
      storesSecretIn: "github_org_secret",
      targetLabel: "agent-teams-ai organization secret, selected repo tvaity",
      secretNames: ["CODEX_AUTH_JSON"],
      selectedRepositories: ["agent-teams-ai/tvaity"],
      validatesBeforeWrite: true,
      sendsSecretToReviewRouter: false,
    });
    expect(guidance.commands[0]?.command).toContain(
      "REVIEW_ROUTER_SECRET_SCOPE=org",
    );
    expect(guidance.commands[0]?.command).toContain(
      "REVIEW_ROUTER_ORG_SECRET_VISIBILITY=selected",
    );
    expect(guidance.commands[0]?.command).toContain(
      "REVIEW_ROUTER_CONFIRM_WRITE=1",
    );
    expect(guidance.commands[0]?.command).toContain(
      "REVIEW_ROUTER_ORG_SECRET_REPOS=tvaity",
    );
    expect(guidance.commands[0]?.command).not.toContain("CODEX_AUTH_JSON=");
    expect(
      guidance.commands.find(
        (command) => command.scope === "organization_private_repositories",
      )?.command,
    ).toContain("REVIEW_ROUTER_ORG_SECRET_VISIBILITY=private");
    expect(
      guidance.commands.find(
        (command) => command.scope === "organization_all_repositories",
      )?.command,
    ).toContain("REVIEW_ROUTER_ORG_SECRET_VISIBILITY=all");
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
    expect(guidance.commands[0]).toMatchObject({
      scope: "repository",
      targetLabel: "777genius/example repository secret",
      secretNames: ["OPENAI_API_KEY"],
      selectedRepositories: ["777genius/example"],
      validatesBeforeWrite: false,
    });
    expect(guidance.commands[0]?.command).not.toContain("sk-");
  });

  it("builds OpenRouter org selected-repository commands without embedding key values", () => {
    const guidance = buildProviderSecretSetupGuidance({
      provider: "openrouter_api_key",
      repoFullName: "agent-teams-ai/tvaity",
      organizationLogin: "agent-teams-ai",
    });

    expect(guidance.recommendedScope).toBe(
      "organization_selected_repositories",
    );
    expect(guidance.commands[0]?.command).toBe(
      "gh secret set OPENROUTER_API_KEY --org agent-teams-ai --repos tvaity --app actions",
    );
    expect(guidance.commands[0]).toMatchObject({
      scope: "organization_selected_repositories",
      targetLabel: "agent-teams-ai organization secret, selected repo tvaity",
      secretNames: ["OPENROUTER_API_KEY"],
      selectedRepositories: ["agent-teams-ai/tvaity"],
    });
    expect(guidance.commands[0]?.command).not.toContain("sk-or-");
    expect(
      guidance.commands.find(
        (command) => command.scope === "organization_private_repositories",
      )?.command,
    ).toBe(
      "gh secret set OPENROUTER_API_KEY --org agent-teams-ai --visibility private --app actions",
    );
    expect(
      guidance.commands.find(
        (command) => command.scope === "organization_all_repositories",
      )?.command,
    ).toBe(
      "gh secret set OPENROUTER_API_KEY --org agent-teams-ai --visibility all --app actions",
    );
  });
});
