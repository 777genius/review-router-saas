import { parseGitHubExternalIdentity } from "../../domain/github-external-identity";

export function parseNextAuthGitHubProfile(profile: unknown) {
  const githubProfile = profile as
    | {
        id?: number | string;
        login?: string;
        name?: string | null;
        avatar_url?: string | null;
        image?: string | null;
        email?: string | null;
      }
    | undefined;

  return parseGitHubExternalIdentity({
    githubUserId: String(githubProfile?.id ?? ""),
    githubLogin: githubProfile?.login ?? githubProfile?.name ?? "",
    primaryEmail: githubProfile?.email ?? null,
    avatarUrl: githubProfile?.avatar_url ?? githubProfile?.image ?? null,
  });
}
