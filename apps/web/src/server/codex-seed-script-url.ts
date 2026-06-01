import { resolveReviewRouterActionRef } from "@reviewrouter/platform-config";

const DEFAULT_HOSTED_WEB_URL = "https://reviewrouter.site";
const DEFAULT_LOCAL_WEB_URL = "http://localhost:3000";
const REVIEW_ROUTER_REPOSITORY = "777genius/review-router";

export function resolveCodexSeedScriptUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveCodexSeedBaseUrl(env)}/install/codex`;
}

export function resolveGitLabCodexSeedScriptUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveCodexSeedBaseUrl(env)}/install/codex-gitlab`;
}

function resolveCodexSeedBaseUrl(env: NodeJS.ProcessEnv): string {
  const explicitWebUrl =
    env.REVIEW_ROUTER_PUBLIC_WEB_URL?.trim() ||
    env.REVIEW_ROUTER_WEB_URL?.trim() ||
    env.NEXTAUTH_URL?.trim();
  const requestedWebUrl = explicitWebUrl || defaultWebUrlForEnvironment(env);
  const safeWebUrl =
    env.NODE_ENV === "production" && isLocalWebUrl(requestedWebUrl)
      ? DEFAULT_HOSTED_WEB_URL
      : requestedWebUrl;
  return normalizeWebUrl(safeWebUrl);
}

export function resolveGitLabCodexInstallRedirect(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const ref = resolveRawGitHubActionRef(resolveReviewRouterActionRef(env));
  return `https://raw.githubusercontent.com/777genius/review-router/${ref}/scripts/seed-codex-gitlab-auth.sh`;
}

function resolveRawGitHubActionRef(actionRef: string): string {
  const ref = actionRef
    .trim()
    .match(new RegExp(`^${escapeRegExp(REVIEW_ROUTER_REPOSITORY)}@(.+)$`))?.[1]
    ?.trim();
  if (!ref) return "main";
  if (/^[a-f0-9]{40}$/i.test(ref)) return ref.toLowerCase();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref) && !ref.endsWith(".")) {
    return ref;
  }
  return "main";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultWebUrlForEnvironment(env: NodeJS.ProcessEnv): string {
  return env.NODE_ENV === "production"
    ? DEFAULT_HOSTED_WEB_URL
    : DEFAULT_LOCAL_WEB_URL;
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

function isLocalWebUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
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
