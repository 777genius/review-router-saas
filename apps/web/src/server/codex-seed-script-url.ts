const DEFAULT_LOCAL_WEB_URL = "http://localhost:3000";

export function resolveCodexSeedScriptUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const baseUrl = normalizeWebUrl(
    env.REVIEW_ROUTER_WEB_URL?.trim() || DEFAULT_LOCAL_WEB_URL,
  );
  return `${baseUrl}/install/codex`;
}

function normalizeWebUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid_review_router_web_url");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("invalid_review_router_web_url");
  }

  if (parsed.protocol !== "https:" && !isLocalDevelopmentUrl(parsed)) {
    throw new Error("invalid_review_router_web_url");
  }

  return parsed.toString().replace(/\/$/, "");
}

function isLocalDevelopmentUrl(parsed: URL): boolean {
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname.endsWith(".localhost"))
  );
}
