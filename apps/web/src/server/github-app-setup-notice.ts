export type GitHubAppSetupNotice = {
  readonly title: string;
  readonly body: string;
};

export function buildGitHubAppSetupNotice(input: {
  readonly installationId?: string | null;
  readonly setupAction?: string | null;
  readonly signedIn: boolean;
}): GitHubAppSetupNotice | null {
  const installationId = input.installationId?.trim();
  if (!installationId || !/^\d+$/.test(installationId)) return null;

  const setupAction = input.setupAction?.trim();
  if (setupAction && setupAction !== "install" && setupAction !== "update") {
    return null;
  }

  const title =
    setupAction === "update"
      ? "GitHub App access updated"
      : "GitHub App installed";
  const nextStep = input.signedIn
    ? "Repository sync should start from the signed GitHub webhook. If repositories do not appear within a minute, request a sync from the dashboard."
    : "Sign in with GitHub to map the installation to your dashboard workspace and continue setup.";

  return {
    title,
    body: `${nextStep} Installation ID: ${installationId}.`,
  };
}
