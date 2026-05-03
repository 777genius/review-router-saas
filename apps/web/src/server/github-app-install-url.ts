export function buildGitHubAppInstallUrl(input: {
  readonly appSlug?: string | null | undefined;
}): string | null {
  const slug = input.appSlug?.trim();
  if (!slug) return null;
  if (!/^[a-zA-Z0-9-]+$/.test(slug)) return null;
  return `https://github.com/apps/${slug}/installations/new`;
}

export function getGitHubAppInstallUrl(): string | null {
  return buildGitHubAppInstallUrl({
    appSlug: process.env.GITHUB_APP_SLUG,
  });
}
