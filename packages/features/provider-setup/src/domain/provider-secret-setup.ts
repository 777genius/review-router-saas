import {
  fromProviderSetupKind,
  getProviderSecretNames,
  type ProviderSetupKind,
} from "@reviewrouter/features-review-providers";
import {
  buildCodexRotatingSetupManifest,
  codexRotatingSecretName,
  renderCodexRotatingInstallerCommand,
  type CodexRotatingSetupManifest,
} from "@reviewrouter/features-codex-oauth-rotating";
import { z } from "zod";

const providerSecretKinds = [
  "codex_oauth",
  "codex_oauth_rotating",
  "openai_api_key",
  "claude_code_oauth",
  "openrouter_api_key",
] as const satisfies readonly ProviderSetupKind[];

export const providerSecretKindSchema = z.enum(providerSecretKinds);

export type ProviderSecretKind = z.infer<typeof providerSecretKindSchema>;

export const providerSecretScopeSchema = z.enum([
  "repository",
  "organization_selected_repositories",
  "organization_private_repositories",
  "organization_all_repositories",
]);

export type ProviderSecretScope = z.infer<typeof providerSecretScopeSchema>;

export type ProviderSecretSetupCommand = {
  readonly scope: ProviderSecretScope;
  readonly title: string;
  readonly description: string;
  readonly command: string;
  readonly storesSecretIn: "github_repository_secret" | "github_org_secret";
  readonly targetLabel: string;
  readonly secretNames: readonly string[];
  readonly selectedRepositories: readonly string[];
  readonly validatesBeforeWrite: boolean;
  readonly failureRecovery: string;
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
export const defaultCodexRotatingSeedScriptUrl =
  "https://raw.githubusercontent.com/777genius/review-router/main/scripts/seed-codex-rotating-auth.sh";

export function buildProviderSecretSetupGuidance(input: {
  readonly provider: ProviderSecretKind;
  readonly repoFullName: string;
  readonly organizationLogin?: string | null;
  readonly seedScriptUrl?: string;
  readonly rotatingSetup?: {
    readonly installerUrl: string;
    readonly installerVersion: string;
    readonly installerSha256: string;
    readonly setupManifestUrl?: string;
    readonly setupConfirmUrl?: string;
    readonly repositoryId: string;
    readonly providerInstanceId?: string;
    readonly setupNonce?: string;
    readonly now?: Date;
    readonly ttlSeconds?: number;
    readonly generationHashSalt?: string;
    readonly accountFingerprintSalt?: string;
  };
}): ProviderSecretSetupGuidance {
  const [owner, repo] = parseRepoFullName(input.repoFullName);
  const organizationLogin = input.organizationLogin?.trim() || null;

  if (input.provider === "codex_oauth_rotating") {
    if (!input.rotatingSetup) {
      throw new Error("codex_rotating_setup_manifest_required");
    }
    const manifest = buildCodexRotatingSetupManifest({
      repositoryFullName: input.repoFullName,
      installerUrl: input.rotatingSetup.installerUrl,
      installerVersion: input.rotatingSetup.installerVersion,
      installerSha256: input.rotatingSetup.installerSha256,
      repositoryId: input.rotatingSetup.repositoryId,
      ...(input.rotatingSetup?.providerInstanceId
        ? { providerInstanceId: input.rotatingSetup.providerInstanceId }
        : {}),
      ...(input.rotatingSetup?.setupNonce
        ? { setupNonce: input.rotatingSetup.setupNonce }
        : {}),
      ...(input.rotatingSetup?.now ? { now: input.rotatingSetup.now } : {}),
      ...(input.rotatingSetup?.ttlSeconds
        ? { ttlSeconds: input.rotatingSetup.ttlSeconds }
        : {}),
      ...(input.rotatingSetup?.generationHashSalt
        ? { generationHashSalt: input.rotatingSetup.generationHashSalt }
        : {}),
      ...(input.rotatingSetup?.accountFingerprintSalt
        ? { accountFingerprintSalt: input.rotatingSetup.accountFingerprintSalt }
        : {}),
    });
    return buildCodexRotatingSecretSetupGuidance({
      repoFullName: input.repoFullName,
      manifest,
      ...(input.rotatingSetup.setupManifestUrl
        ? { setupManifestUrl: input.rotatingSetup.setupManifestUrl }
        : {}),
      ...(input.rotatingSetup.setupConfirmUrl
        ? { setupConfirmUrl: input.rotatingSetup.setupConfirmUrl }
        : {}),
    });
  }

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
                scope: "organization_selected_repositories" as const,
                title: "Recommended: org secret scoped to this repository",
                description:
                  "Stores CODEX_AUTH_JSON as an organization secret available only to this repository.",
                command: `curl -fsSL ${seedScriptUrl} | bash -s -- --confirm-write --scope org --org ${shellQuote(owner)} --visibility selected --repos ${shellQuote(repo)}`,
                storesSecretIn: "github_org_secret" as const,
                targetLabel: `${owner} organization secret, selected repo ${repo}`,
                secretNames: ["CODEX_AUTH_JSON"],
                selectedRepositories: [`${owner}/${repo}`],
                validatesBeforeWrite: true,
                failureRecovery:
                  "If validation says reseed auth.json, run codex login on this trusted machine and rerun this exact command.",
                sendsSecretToReviewRouter: false as const,
              },
              {
                scope: "organization_private_repositories" as const,
                title: "Organization secret for private repositories",
                description:
                  "Stores CODEX_AUTH_JSON as an organization secret available to private repositories in this organization.",
                command: `curl -fsSL ${seedScriptUrl} | bash -s -- --confirm-write --scope org --org ${shellQuote(owner)} --visibility private`,
                storesSecretIn: "github_org_secret" as const,
                targetLabel: `${owner} organization secret, private repositories`,
                secretNames: ["CODEX_AUTH_JSON"],
                selectedRepositories: [],
                validatesBeforeWrite: true,
                failureRecovery:
                  "If validation says reseed auth.json, run codex login on this trusted machine and rerun this exact command.",
                sendsSecretToReviewRouter: false as const,
              },
              {
                scope: "organization_all_repositories" as const,
                title: "Organization secret for all repositories",
                description:
                  "Stores CODEX_AUTH_JSON as an organization secret available to all repositories in this organization.",
                command: `curl -fsSL ${seedScriptUrl} | bash -s -- --confirm-write --scope org --org ${shellQuote(owner)} --visibility all`,
                storesSecretIn: "github_org_secret" as const,
                targetLabel: `${owner} organization secret, all repositories`,
                secretNames: ["CODEX_AUTH_JSON"],
                selectedRepositories: [],
                validatesBeforeWrite: true,
                failureRecovery:
                  "If validation says reseed auth.json, run codex login on this trusted machine and rerun this exact command.",
                sendsSecretToReviewRouter: false as const,
              },
            ]
          : []),
        {
          scope: "repository",
          title: "Repository secret",
          description:
            "Stores CODEX_AUTH_JSON directly in this repository's Actions secrets.",
          command: `curl -fsSL ${seedScriptUrl} | bash -s -- --confirm-write --scope repo --repo ${shellQuote(input.repoFullName)}`,
          storesSecretIn: "github_repository_secret",
          targetLabel: `${input.repoFullName} repository secret`,
          secretNames: ["CODEX_AUTH_JSON"],
          selectedRepositories: [input.repoFullName],
          validatesBeforeWrite: true,
          failureRecovery:
            "If validation says reseed auth.json, run codex login on this trusted machine and rerun this exact command.",
          sendsSecretToReviewRouter: false,
        },
      ],
      warnings: [
        "Run this on a trusted machine where Codex CLI is already logged in with ChatGPT subscription auth. The seed script detects both legacy ~/.codex/auth.json and the active ~/.codex/accounts/*.auth.json account.",
        "The generated command includes --confirm-write and explicit target flags so non-interactive curl usage can write GitHub secrets only after the target is clear in the command.",
        "ReviewRouter SaaS never receives CODEX_AUTH_JSON; the script writes directly to GitHub Actions secrets through gh.",
        "For public repositories, fork pull requests are skipped for secret-backed provider execution by default.",
      ],
    };
  }

  const secretName = secretNameForProviderSetup(input.provider);
  const isClaudeCodeOAuth = input.provider === "claude_code_oauth";
  const failureRecovery = isClaudeCodeOAuth
    ? "If CI reports Claude auth errors, generate a fresh token with claude setup-token and rerun this command. Do not paste a shell command as the secret value."
    : "If GitHub rejects the command, verify gh auth and repository admin access.";

  return {
    provider: input.provider,
    recommendedScope: organizationLogin
      ? "organization_selected_repositories"
      : "repository",
    commands: [
      ...(organizationLogin
        ? [
            {
              scope: "organization_selected_repositories" as const,
              title: "Recommended: org secret scoped to this repository",
              description: `Stores ${secretName} as an organization secret available only to this repository.`,
              command: `gh secret set ${secretName} --org ${shellQuote(owner)} --repos ${shellQuote(repo)} --app actions`,
              storesSecretIn: "github_org_secret" as const,
              targetLabel: `${owner} organization secret, selected repo ${repo}`,
              secretNames: [secretName],
              selectedRepositories: [`${owner}/${repo}`],
              validatesBeforeWrite: false,
              failureRecovery: isClaudeCodeOAuth
                ? failureRecovery
                : "If GitHub rejects the command, verify gh auth, organization ownership, and selected repository access.",
              sendsSecretToReviewRouter: false as const,
            },
            {
              scope: "organization_private_repositories" as const,
              title: "Organization secret for private repositories",
              description: `Stores ${secretName} as an organization secret available to private repositories in this organization.`,
              command: `gh secret set ${secretName} --org ${shellQuote(owner)} --visibility private --app actions`,
              storesSecretIn: "github_org_secret" as const,
              targetLabel: `${owner} organization secret, private repositories`,
              secretNames: [secretName],
              selectedRepositories: [],
              validatesBeforeWrite: false,
              failureRecovery: isClaudeCodeOAuth
                ? failureRecovery
                : "If GitHub rejects the command, verify gh auth, organization ownership, and GitHub plan support for org secrets.",
              sendsSecretToReviewRouter: false as const,
            },
            {
              scope: "organization_all_repositories" as const,
              title: "Organization secret for all repositories",
              description: `Stores ${secretName} as an organization secret available to all repositories in this organization.`,
              command: `gh secret set ${secretName} --org ${shellQuote(owner)} --visibility all --app actions`,
              storesSecretIn: "github_org_secret" as const,
              targetLabel: `${owner} organization secret, all repositories`,
              secretNames: [secretName],
              selectedRepositories: [],
              validatesBeforeWrite: false,
              failureRecovery: isClaudeCodeOAuth
                ? failureRecovery
                : "If GitHub rejects the command, verify gh auth, organization ownership, and GitHub plan support for org secrets.",
              sendsSecretToReviewRouter: false as const,
            },
          ]
        : []),
      {
        scope: "repository",
        title: "Repository secret",
        description: `Stores ${secretName} directly in this repository's Actions secrets.`,
        command: `gh secret set ${secretName} --repo ${shellQuote(input.repoFullName)}${isClaudeCodeOAuth ? " --app actions" : ""}`,
        storesSecretIn: "github_repository_secret",
        targetLabel: `${input.repoFullName} repository secret`,
        secretNames: [secretName],
        selectedRepositories: [input.repoFullName],
        validatesBeforeWrite: false,
        failureRecovery,
        sendsSecretToReviewRouter: false,
      },
    ],
    warnings: isClaudeCodeOAuth
      ? [
          "Run claude setup-token on a trusted machine and store only the printed token value.",
          "Do not store the shell command itself, Claude keychain files, or Claude local config files.",
          "Do not store ANTHROPIC_API_KEY for Claude Code subscription OAuth; ReviewRouter uses CLAUDE_CODE_OAUTH_TOKEN for this provider.",
          "Regenerate the token before its roughly one-year expiration or when CI reports Claude auth errors.",
          "ReviewRouter SaaS never receives CLAUDE_CODE_OAUTH_TOKEN; set it directly in GitHub Actions secrets.",
          "For public repositories, fork pull requests are skipped for secret-backed provider execution by default.",
        ]
      : [
          "ReviewRouter SaaS does not need to see this key; set it directly in GitHub Actions secrets.",
          "Prefer organization selected-repository secrets for team-owned repositories.",
        ],
  };
}

function buildCodexRotatingSecretSetupGuidance(input: {
  readonly repoFullName: string;
  readonly manifest: CodexRotatingSetupManifest;
  readonly setupManifestUrl?: string;
  readonly setupConfirmUrl?: string;
}): ProviderSecretSetupGuidance {
  return {
    provider: "codex_oauth_rotating",
    recommendedScope: "repository",
    commands: [
      {
        scope: "repository",
        title: "Repository secret with automatic refresh",
        description:
          "Stores REVIEWROUTER_CODEX_AUTH_JSON directly in this repository and lets GitHub-hosted runs refresh it after each Codex bootstrap.",
        command: renderCodexRotatingInstallerCommand({
          manifest: input.manifest,
          ...(input.setupManifestUrl
            ? { setupManifestUrl: input.setupManifestUrl }
            : {}),
          ...(input.setupConfirmUrl
            ? { setupConfirmUrl: input.setupConfirmUrl }
            : {}),
        }),
        storesSecretIn: "github_repository_secret",
        targetLabel: `${input.repoFullName} repository secret`,
        secretNames: [codexRotatingSecretName],
        selectedRepositories: [input.repoFullName],
        validatesBeforeWrite: true,
        failureRecovery:
          "If CI reports needs_reconnect or unknown_auth_state, reopen provider setup and run a fresh repository command. If the installer refuses old dedicated auth, rerun it with --force-reseed.",
        sendsSecretToReviewRouter: false,
      },
    ],
    warnings: [
      "Rotating Codex OAuth is repository-scoped; organization secrets are intentionally disabled because each repository keeps an isolated refresh generation.",
      "The command downloads a versioned installer, verifies SHA256 locally, then writes REVIEWROUTER_CODEX_AUTH_JSON directly to GitHub Actions secrets through gh.",
      "The installer creates a dedicated ~/.reviewrouter/codex/<repo> CODEX_HOME and does not mutate the normal ~/.codex login cache.",
      "ReviewRouter SaaS never receives plaintext auth.json; CI sends only the encrypted GitHub-secret payload needed for writeback.",
      "Generated production workflows run on GitHub-hosted same-repository PRs only; fork and bot-triggered PRs never receive secret-bearing Codex review. Draft review is disabled by default and can be enabled with the REVIEW_ROUTER_REVIEW_DRAFTS repository variable.",
    ],
  };
}

function secretNameForProviderSetup(provider: ProviderSecretKind): string {
  const [secretName] = getProviderSecretNames(fromProviderSetupKind(provider));
  if (!secretName) {
    throw new Error(`missing_provider_secret_name:${provider}`);
  }
  return secretName;
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
