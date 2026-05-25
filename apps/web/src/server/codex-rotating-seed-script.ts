import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_HOSTED_WEB_URL = "https://reviewrouter.site";
const DEFAULT_LOCAL_WEB_URL = "http://localhost:3000";
const SCRIPT_PATH = "scripts/seed-codex-rotating-auth.sh";

export type CodexRotatingSeedScriptDescriptor = {
  readonly url: string;
  readonly version: string;
  readonly sha256: string;
};

export function resolveCodexRotatingSeedScriptDescriptor(
  env: NodeJS.ProcessEnv = process.env,
): CodexRotatingSeedScriptDescriptor {
  const explicitUrl = env.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL?.trim();
  const explicitVersion =
    env.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION?.trim();
  const explicitSha256 =
    env.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256?.trim();

  if (explicitUrl || explicitVersion || explicitSha256) {
    if (!explicitUrl || !explicitVersion || !explicitSha256) {
      throw new Error("codex_rotating_installer_descriptor_incomplete");
    }
    assertSha256(explicitSha256);
    return {
      url: explicitUrl,
      version: explicitVersion,
      sha256: explicitSha256.toLowerCase(),
    };
  }

  const baseUrl = normalizeWebUrl(
    env.REVIEW_ROUTER_PUBLIC_WEB_URL?.trim() ||
      env.REVIEW_ROUTER_WEB_URL?.trim() ||
      env.NEXTAUTH_URL?.trim() ||
      (env.NODE_ENV === "production"
        ? DEFAULT_HOSTED_WEB_URL
        : DEFAULT_LOCAL_WEB_URL),
  );
  return {
    url: `${baseUrl}/install/codex-rotating`,
    version: env.REVIEW_ROUTER_ACTION_VERSION?.trim() || "dev",
    sha256: hashLocalRotatingInstaller(),
  };
}

export function resolveCodexRotatingInstallRedirect(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const actionRef = env.REVIEW_ROUTER_ACTION_REF?.trim();
  const pinnedSha = actionRef?.match(/@([a-f0-9]{40})$/i)?.[1];
  const ref = pinnedSha ?? "main";
  return `https://raw.githubusercontent.com/777genius/review-router/${ref}/scripts/seed-codex-rotating-auth.sh`;
}

function hashLocalRotatingInstaller(): string {
  const script = readFileSync(join(process.cwd(), SCRIPT_PATH));
  return createHash("sha256").update(script).digest("hex");
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("invalid_codex_rotating_installer_sha256");
  }
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
