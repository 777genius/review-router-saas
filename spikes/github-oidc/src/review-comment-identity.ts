export function expectedGitHubAppBotLogin(appSlug: string | undefined): string {
  const normalized = appSlug?.trim();
  if (!normalized) {
    throw new Error("github_app_slug_required_for_comment_identity_e2e");
  }
  return `${normalized}[bot]`;
}

export function assertGitHubAppCommentAuthor(input: {
  readonly actualLogin: string;
  readonly expectedLogin: string;
  readonly surface: "advisory" | "inline";
}): void {
  if (input.actualLogin === input.expectedLogin) return;
  throw new Error(
    `ReviewRouter ${input.surface} comment author mismatch: expected=${input.expectedLogin} actual=${input.actualLogin}`,
  );
}
