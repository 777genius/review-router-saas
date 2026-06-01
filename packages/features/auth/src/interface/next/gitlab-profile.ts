import { parseExternalIdentity } from "../../domain/external-identity";

export function parseNextAuthGitLabProfile(profile: unknown) {
  const gitlabProfile = profile as
    | {
        id?: number | string;
        username?: string;
        nickname?: string;
        name?: string | null;
        avatar_url?: string | null;
        picture?: string | null;
        image?: string | null;
        email?: string | null;
      }
    | undefined;

  if (!gitlabProfile?.id) {
    throw new Error("gitlab_profile_external_user_id_missing");
  }
  const login =
    gitlabProfile.username ?? gitlabProfile.nickname ?? gitlabProfile.name;
  if (!login) {
    throw new Error("gitlab_profile_login_missing");
  }

  return parseExternalIdentity({
    provider: "gitlab",
    externalUserId: String(gitlabProfile.id),
    login,
    primaryEmail: gitlabProfile?.email ?? null,
    avatarUrl:
      gitlabProfile?.avatar_url ??
      gitlabProfile?.picture ??
      gitlabProfile?.image ??
      null,
  });
}
