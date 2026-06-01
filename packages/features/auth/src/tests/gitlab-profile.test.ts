import { describe, expect, it } from "vitest";
import { parseNextAuthGitLabProfile } from "../interface/next/gitlab-profile";

describe("parseNextAuthGitLabProfile", () => {
  it("maps GitLab profile ids and login fallback deterministically", () => {
    expect(
      parseNextAuthGitLabProfile({
        id: 123,
        nickname: "gitlab-maintainer",
        email: "maintainer@example.com",
        avatar_url: "https://gitlab.com/uploads/avatar.png",
      }),
    ).toMatchObject({
      provider: "gitlab",
      externalUserId: "123",
      login: "gitlab-maintainer",
      primaryEmail: "maintainer@example.com",
      avatarUrl: "https://gitlab.com/uploads/avatar.png",
    });
  });

  it("fails fast when GitLab omits an identity or login", () => {
    expect(() =>
      parseNextAuthGitLabProfile({ username: "maintainer" }),
    ).toThrow("gitlab_profile_external_user_id_missing");
    expect(() => parseNextAuthGitLabProfile({ id: 123 })).toThrow(
      "gitlab_profile_login_missing",
    );
  });
});
