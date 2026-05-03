const LOCAL_DEVELOPMENT_API_URL = "http://localhost:4000";

export function resolveWorkflowPublicApiUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const isProduction = env.NODE_ENV === "production";
  const explicitUrl = firstNonEmpty(
    env.REVIEW_ROUTER_PUBLIC_API_URL,
    env.REVIEW_ROUTER_API_URL,
  );
  if (explicitUrl) {
    assertSafeWorkflowPublicApiUrl(explicitUrl, {
      allowLocalhost: !isProduction,
    });
    return explicitUrl;
  }

  if (isProduction) {
    throw new Error("missing_env:REVIEW_ROUTER_PUBLIC_API_URL");
  }

  return LOCAL_DEVELOPMENT_API_URL;
}

function firstNonEmpty(
  ...values: readonly (string | undefined)[]
): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function assertSafeWorkflowPublicApiUrl(
  value: string,
  policy: { readonly allowLocalhost: boolean },
): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid_workflow_api_url");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("invalid_workflow_api_url");
  }
  if (parsed.protocol === "https:") {
    return;
  }
  if (
    policy.allowLocalhost &&
    parsed.protocol === "http:" &&
    isLocalhost(parsed.hostname)
  ) {
    return;
  }

  throw new Error("invalid_workflow_api_url");
}

function isLocalhost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}
