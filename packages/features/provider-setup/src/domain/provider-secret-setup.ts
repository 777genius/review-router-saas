import { z } from "zod";

export const providerSecretKindSchema = z.enum([
  "codex_oauth",
  "openai_api_key",
  "openrouter_api_key",
]);

export type ProviderSecretKind = z.infer<typeof providerSecretKindSchema>;

export const providerSecretScopeSchema = z.enum([
  "repository",
  "organization_selected_repositories",
]);

export type ProviderSecretScope = z.infer<typeof providerSecretScopeSchema>;

export type ProviderSecretSetupCommand = {
  readonly title: string;
  readonly description: string;
  readonly command: string;
  readonly storesSecretIn: "github_repository_secret" | "github_org_secret";
  readonly sendsSecretToReviewRouter: false;
};

export type ProviderSecretSetupGuidance = {
  readonly provider: ProviderSecretKind;
  readonly recommendedScope: ProviderSecretScope;
  readonly commands: readonly ProviderSecretSetupCommand[];
  readonly warnings: readonly string[];
};

export const defaultCodexSeedScriptUrl =
  "https://raw.githubusercontent.com/777genius/review-router/main/scripts/seed-codex-auth.sh";

export function buildProviderSecretSetupGuidance(input: {
  readonly provider: ProviderSecretKind;
  readonly repoFullName: string;
  readonly organizationLogin?: string | null;
  readonly seedScriptUrl?: string;
}): ProviderSecretSetupGuidance {
  const [owner, repo] = parseRepoFullName(input.repoFullName);
  const organizationLogin = input.organizationLogin?.trim() || null;

  if (input.provider === "codex_oauth") {
    const seedScriptUrl = shellQuote(
      input.seedScriptUrl ?? defaultCodexSeedScriptUrl,
    );
    return {
      provider: "codex_oauth",
      recommendedScope: organizationLogin
        ? "organization_selected_repositories"
        : "repository",
      commands: [
        ...(organizationLogin
          ? [
              {
                title: "Recommended: org secret scoped to this repository",
                description:
                  "Stores CODEX_AUTH_JSON as an organization secret available only to this repository.",
                command: `curl -fsSL ${seedScriptUrl} | REVIEW_ROUTER_SECRET_SCOPE=org REVIEW_ROUTER_ORG=${shellQuote(owner)} REVIEW_ROUTER_ORG_SECRET_REPOS=${shellQuote(repo)} bash`,
                storesSecretIn: "github_org_secret" as const,
                sendsSecretToReviewRouter: false as const,
              },
            ]
          : []),
        {
          title: "Repository secret",
          description:
            "Stores CODEX_AUTH_JSON directly in this repository's Actions secrets.",
          command: `curl -fsSL ${seedScriptUrl} | REVIEW_ROUTER_SECRET_SCOPE=repo REVIEW_ROUTER_REPO=${shellQuote(input.repoFullName)} bash`,
          storesSecretIn: "github_repository_secret",
          sendsSecretToReviewRouter: false,
        },
      ],
      warnings: [
        "Run this on a trusted machine where Codex CLI is already logged in with ChatGPT subscription auth.",
        "ReviewRouter SaaS never receives CODEX_AUTH_JSON; the script writes directly to GitHub Actions secrets through gh.",
        "For public repositories, fork pull requests are skipped for secret-backed provider execution by default.",
      ],
    };
  }

  const secretName =
    input.provider === "openai_api_key"
      ? "OPENAI_API_KEY"
      : "OPENROUTER_API_KEY";
  return {
    provider: input.provider,
    recommendedScope: organizationLogin
      ? "organization_selected_repositories"
      : "repository",
    commands: [
      ...(organizationLogin
        ? [
            {
              title: "Recommended: org secret scoped to this repository",
              description: `Stores ${secretName} as an organization secret available only to this repository.`,
              command: `gh secret set ${secretName} --org ${shellQuote(owner)} --repos ${shellQuote(repo)} --app actions`,
              storesSecretIn: "github_org_secret" as const,
              sendsSecretToReviewRouter: false as const,
            },
          ]
        : []),
      {
        title: "Repository secret",
        description: `Stores ${secretName} directly in this repository's Actions secrets.`,
        command: `gh secret set ${secretName} --repo ${shellQuote(input.repoFullName)}`,
        storesSecretIn: "github_repository_secret",
        sendsSecretToReviewRouter: false,
      },
    ],
    warnings: [
      "ReviewRouter SaaS does not need to see this key; set it directly in GitHub Actions secrets.",
      "Prefer organization selected-repository secrets for team-owned repositories.",
    ],
  };
}

function parseRepoFullName(repoFullName: string): readonly [string, string] {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo || repo.includes("/")) {
    throw new Error(`invalid_repo_full_name:${repoFullName}`);
  }
  return [owner, repo];
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
