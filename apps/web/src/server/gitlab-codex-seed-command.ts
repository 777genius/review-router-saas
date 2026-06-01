import { resolveGitLabCodexSeedScriptUrl } from "./codex-seed-script-url";
import { getPrisma } from "./prisma";

export type GitLabCodexSeedCommand = {
  readonly command: string;
  readonly secretName: "CODEX_AUTH_JSON";
  readonly sendsSecretToReviewRouter: false;
  readonly targetLabel: string;
};

export async function buildGitLabCodexSeedCommand(input: {
  readonly workspaceId: string;
  readonly installationId?: string | undefined;
}): Promise<GitLabCodexSeedCommand> {
  const prisma = getPrisma();
  const installation = await prisma.gitLabInstallation.findFirst({
    where: {
      workspaceId: input.workspaceId,
      ...(input.installationId ? { id: input.installationId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      repositories: {
        where: { provider: "gitlab", selected: true },
        orderBy: { fullName: "asc" },
        select: { externalRepositoryId: true, fullName: true },
      },
    },
  });
  if (!installation) {
    throw new Error("gitlab_installation_not_found");
  }
  if (installation.repositories.length === 0) {
    throw new Error("gitlab_installation_projects_missing");
  }

  const scriptUrl = resolveGitLabCodexSeedScriptUrl();
  const gitLabUrl = process.env.GITLAB_OAUTH_BASE_URL ?? "https://gitlab.com";
  const projectIds = installation.repositories.map(
    (repository) => repository.externalRepositoryId,
  );
  assertGitLabProjectIds(projectIds);
  const targetArgs = `--scope project --project-ids ${shellQuote(
    projectIds.join(","),
  )}`;
  const targetLabel = `${installation.repositories.length} GitLab project${
    installation.repositories.length === 1 ? "" : "s"
  }`;

  return {
    command: [
      'export GITLAB_TOKEN="paste_token_here"',
      `curl -fsSL ${shellQuote(scriptUrl)} | bash -s -- --confirm-write --gitlab-url ${shellQuote(
        gitLabUrl,
      )} ${targetArgs}`,
    ].join("\n"),
    secretName: "CODEX_AUTH_JSON",
    sendsSecretToReviewRouter: false,
    targetLabel,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertGitLabProjectIds(projectIds: readonly string[]): void {
  if (
    projectIds.some(
      (projectId) => projectId.trim().length === 0 || projectId.includes(","),
    )
  ) {
    throw new Error("invalid_gitlab_project_ids");
  }
}
