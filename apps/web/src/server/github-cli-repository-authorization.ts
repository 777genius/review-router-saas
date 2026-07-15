import { z } from "zod";
import { repositoryPermissionAllowsRepoManagement } from "./dashboard-access-policy";

const githubApiBaseUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";

const githubRepositorySchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)]),
  full_name: z.string().min(3),
  permissions: z
    .object({
      admin: z.boolean().optional(),
      maintain: z.boolean().optional(),
      push: z.boolean().optional(),
      pull: z.boolean().optional(),
    })
    .optional(),
  role_name: z.string().nullable().optional(),
});

export type AuthorizedGitHubCliRepository = {
  readonly githubRepositoryId: string;
  readonly fullName: string;
};

export async function authorizeGitHubCliRepository(input: {
  readonly accessToken: string;
  readonly repositoryFullName: string;
  readonly fetch?: typeof fetch;
}): Promise<AuthorizedGitHubCliRepository> {
  const [owner, repository] = parseRepositoryFullName(input.repositoryFullName);
  const response = await (input.fetch ?? fetch)(
    new URL(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
      githubApiBaseUrl,
    ),
    {
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.accessToken}`,
        "User-Agent": "ReviewRouter",
        "X-GitHub-Api-Version": githubApiVersion,
      },
    },
  );

  if (response.status === 401) throw new Error("github_cli_token_invalid");
  if (response.status === 403)
    throw new Error("github_cli_repository_forbidden");
  if (response.status === 404)
    throw new Error("github_cli_repository_not_found");
  if (!response.ok) throw new Error("github_cli_api_error");

  const githubRepository = githubRepositorySchema.parse(await response.json());
  const permission = repositoryPermission(githubRepository.permissions);
  if (
    !repositoryPermissionAllowsRepoManagement({
      permission,
      roleName: githubRepository.role_name ?? null,
    })
  ) {
    throw new Error("github_cli_repository_forbidden");
  }
  if (
    githubRepository.full_name.toLowerCase() !==
    input.repositoryFullName.toLowerCase()
  ) {
    throw new Error("github_cli_repository_mismatch");
  }

  return {
    githubRepositoryId: String(githubRepository.id),
    fullName: githubRepository.full_name,
  };
}

function parseRepositoryFullName(value: string): readonly [string, string] {
  const match = value.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match?.[1] || !match[2]) throw new Error("invalid_repository");
  return [match[1], match[2]];
}

function repositoryPermission(
  permissions:
    | {
        readonly admin?: boolean | undefined;
        readonly maintain?: boolean | undefined;
        readonly push?: boolean | undefined;
        readonly pull?: boolean | undefined;
      }
    | undefined,
): string | null {
  if (permissions?.admin) return "admin";
  if (permissions?.maintain) return "maintain";
  if (permissions?.push) return "write";
  if (permissions?.pull) return "read";
  return null;
}
