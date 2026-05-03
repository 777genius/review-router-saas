export type AuthEnvironmentStatus = {
  readonly configured: boolean;
  readonly missing: readonly string[];
};

type AuthEnvironment = {
  readonly [key: string]: string | undefined;
};

const requiredAuthEnv = [
  "AUTH_SECRET",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
] as const;

export function getAuthEnvironmentStatus(
  env: AuthEnvironment = process.env,
): AuthEnvironmentStatus {
  const missing = requiredAuthEnv.filter((name) => !env[name]);

  return {
    configured: missing.length === 0,
    missing,
  };
}

export function readOptionalAuthEnv(name: string): string {
  return process.env[name] ?? `missing-${name.toLowerCase()}`;
}
