import {
  isLoopbackHostname,
  resolveReviewRouterActionRef,
} from "@reviewrouter/platform-config";

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

export function resolveReviewRouterPublicWebUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitWebUrl =
    env.REVIEW_ROUTER_PUBLIC_WEB_URL?.trim() ||
    env.REVIEW_ROUTER_WEB_URL?.trim() ||
    env.NEXTAUTH_URL?.trim();
  if (!explicitWebUrl && env.NODE_ENV === "production") {
    throw new Error("missing_review_router_web_url");
  }
  return normalizeWebUrl(explicitWebUrl || DEFAULT_LOCAL_WEB_URL, env.NODE_ENV);
}

const resolveCodexSeedBaseUrl = resolveReviewRouterPublicWebUrl;

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

function normalizeWebUrl(
  value: string,
  environment: NodeJS.ProcessEnv["NODE_ENV"],
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid_review_router_web_url");
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error("invalid_review_router_web_url");
  }

  const local = isLoopbackHostname(parsed.hostname);
  if (
    (environment === "production" && (parsed.protocol !== "https:" || local)) ||
    (environment !== "production" &&
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && local))
  ) {
    throw new Error("invalid_review_router_web_url");
  }

  return parsed.toString().replace(/\/$/, "");
}
