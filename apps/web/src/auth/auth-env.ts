export type AuthEnvironmentStatus = {
  readonly configured: boolean;
  readonly missing: readonly string[];
};

type AuthEnvironment = {
  readonly [key: string]: string | undefined;
};

const requiredAuthEnv = ["AUTH_SECRET"] as const;

export function getAuthEnvironmentStatus(
  env: AuthEnvironment = process.env,
): AuthEnvironmentStatus {
  const missing: string[] = [...requiredAuthEnv].filter((name) => !env[name]);
  const githubConfigured = isGitHubAuthConfigured(env);
  const gitlabConfigured = isGitLabAuthConfigured(env);
  if (!githubConfigured && !gitlabConfigured) {
    if (!env.GITHUB_APP_CLIENT_ID) missing.push("GITHUB_APP_CLIENT_ID");
    if (!env.GITHUB_APP_CLIENT_SECRET) {
      missing.push("GITHUB_APP_CLIENT_SECRET");
    }
    if (!env.GITLAB_OAUTH_CLIENT_ID) missing.push("GITLAB_OAUTH_CLIENT_ID");
    if (!env.GITLAB_OAUTH_CLIENT_SECRET) {
      missing.push("GITLAB_OAUTH_CLIENT_SECRET");
    }
  }

  return {
    configured: missing.length === 0,
    missing,
  };
}

export function isGitHubAuthConfigured(
  env: AuthEnvironment = process.env,
): boolean {
  return Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET);
}

export function isGitLabAuthConfigured(
  env: AuthEnvironment = process.env,
): boolean {
  return Boolean(env.GITLAB_OAUTH_CLIENT_ID && env.GITLAB_OAUTH_CLIENT_SECRET);
}

export function readOptionalAuthEnv(name: string): string {
  return process.env[name] ?? `missing-${name.toLowerCase()}`;
}
