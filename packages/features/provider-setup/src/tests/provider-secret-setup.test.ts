import { describe, expect, it } from "vitest";
import {
  buildProviderSecretSetupGuidance,
  providerSecretKindSchema,
} from "../domain/provider-secret-setup";

describe("provider secret setup guidance", () => {
  it("builds repository-only rotating Codex OAuth guidance with installer pinning", () => {
    const guidance = buildProviderSecretSetupGuidance({
      provider: "codex_oauth_rotating",
      repoFullName: "777genius/agent-teams-ai",
      organizationLogin: "777genius",
      rotatingSetup: {
        repositoryId: "123456",
        installerUrl: "https://reviewrouter.site/install/codex-rotating",
        installerVersion: "v1.2.3",
        installerSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        providerInstanceId: "codex-rotating:123456",
        setupNonce: "stp:123456789",
        now: new Date("2026-05-25T12:00:00.000Z"),
        generationHashSalt: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        accountFingerprintSalt: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });

    expect(guidance.provider).toBe("codex_oauth_rotating");
    expect(guidance.recommendedScope).toBe("repository");
    expect(guidance.commands).toHaveLength(1);
    expect(guidance.commands[0]).toMatchObject({
      scope: "repository",
      storesSecretIn: "github_repository_secret",
      targetLabel: "777genius/agent-teams-ai repository secret",
      secretNames: ["REVIEWROUTER_CODEX_AUTH_JSON"],
      selectedRepositories: ["777genius/agent-teams-ai"],
      validatesBeforeWrite: true,
      sendsSecretToReviewRouter: false,
    });
    expect(guidance.commands[0]?.command).toContain("curl -fsSL");
    expect(guidance.commands[0]?.command).toContain("shasum -a 256");
    expect(guidance.commands[0]?.command).toContain("sha256sum");
    expect(guidance.commands[0]?.command).toContain(
      "Installer SHA256 mismatch",
    );
    expect(guidance.commands[0]?.command).toContain(
      "REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64",
    );
    expect(guidance.commands[0]?.command).not.toContain("| bash");
    expect(guidance.warnings.join(" ")).toContain("repository-scoped");
    expect(guidance.warnings.join(" ")).toContain(
      "Draft review is disabled by default",
    );
    expect(guidance.warnings.join(" ")).toContain(
      "REVIEW_ROUTER_REVIEW_DRAFTS",
    );
    expect(guidance.commands[0]?.failureRecovery).toContain("--force-reseed");
  });

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
    expect(guidance.commands[0]?.command).toContain("--scope org");
    expect(guidance.commands[0]?.command).toContain("--visibility selected");
    expect(guidance.commands[0]?.command).toContain("--confirm-write");
    expect(guidance.commands[0]?.command).toContain("--repos tvaity");
    expect(guidance.commands[0]?.command).not.toContain("CODEX_AUTH_JSON=");
    expect(
      guidance.commands.find(
        (command) => command.scope === "organization_private_repositories",
      )?.command,
    ).toContain("--visibility private");
    expect(
      guidance.commands.find(
        (command) => command.scope === "organization_all_repositories",
      )?.command,
    ).toContain("--visibility all");
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

  it("builds Claude Code OAuth repository guidance without sending the token to SaaS", () => {
    const guidance = buildProviderSecretSetupGuidance({
      provider: "claude_code_oauth",
      repoFullName: "777genius/example",
    });

    expect(
      providerSecretKindSchema.safeParse("claude_code_oauth").success,
    ).toBe(true);
    expect(guidance.recommendedScope).toBe("repository");
    expect(guidance.commands[0]).toMatchObject({
      scope: "repository",
      targetLabel: "777genius/example repository secret",
      secretNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
      selectedRepositories: ["777genius/example"],
      validatesBeforeWrite: false,
      sendsSecretToReviewRouter: false,
    });
    expect(guidance.commands[0]?.command).toBe(
      "gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo 777genius/example --app actions",
    );
    expect(guidance.commands[0]?.command).not.toContain("sk-ant-oat01");
    expect(guidance.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("claude setup-token"),
        expect.stringContaining("Do not store the shell command itself"),
        expect.stringContaining("Do not store ANTHROPIC_API_KEY"),
        expect.stringContaining("ReviewRouter SaaS never receives"),
      ]),
    );
  });

  it("builds Claude Code OAuth org selected-repository guidance", () => {
    const guidance = buildProviderSecretSetupGuidance({
      provider: "claude_code_oauth",
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
      secretNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
      selectedRepositories: ["agent-teams-ai/tvaity"],
      validatesBeforeWrite: false,
      sendsSecretToReviewRouter: false,
    });
    expect(guidance.commands[0]?.command).toBe(
      "gh secret set CLAUDE_CODE_OAUTH_TOKEN --org agent-teams-ai --repos tvaity --app actions",
    );
  });

  it("builds Claude Code OAuth org private and all-repository guidance", () => {
    const guidance = buildProviderSecretSetupGuidance({
      provider: "claude_code_oauth",
      repoFullName: "agent-teams-ai/tvaity",
      organizationLogin: "agent-teams-ai",
    });

    expect(
      guidance.commands.find(
        (command) => command.scope === "organization_private_repositories",
      )?.command,
    ).toBe(
      "gh secret set CLAUDE_CODE_OAUTH_TOKEN --org agent-teams-ai --visibility private --app actions",
    );
    expect(
      guidance.commands.find(
        (command) => command.scope === "organization_all_repositories",
      )?.command,
    ).toBe(
      "gh secret set CLAUDE_CODE_OAUTH_TOKEN --org agent-teams-ai --visibility all --app actions",
    );
  });
});
