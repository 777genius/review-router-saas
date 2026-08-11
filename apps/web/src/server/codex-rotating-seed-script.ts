import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isLoopbackHostname,
  resolveReviewRouterCodexRotatingActionRef,
} from "@reviewrouter/platform-config";
import { resolveReviewRouterPublicWebUrl } from "./codex-seed-script-url";
import { resolveCodexRotatingInstallerDescriptor } from "../../../../packages/shared/src/validation/codex-rotating-installer-descriptor.mjs";

const SCRIPT_PATH = "scripts/seed-codex-rotating-auth.sh";
const RESEED_SCRIPT_PATH = "scripts/reseed-codex-rotating-auth.sh";

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
    return resolveCodexRotatingInstallerDescriptor(env, {
      allowLoopback: true,
    });
  }

  const baseUrl = resolveCodexRotatingPublicWebUrl(env);
  const actionRef = resolveReviewRouterCodexRotatingActionRef(env);
  const localUrl = `${baseUrl}/install/codex-rotating`;
  const parsedBaseUrl = new URL(baseUrl);
  if (!isLoopbackHostname(parsedBaseUrl.hostname)) {
    throw new Error("codex_rotating_installer_descriptor_incomplete");
  }
  return {
    url: localUrl,
    version: resolvePinnedActionSha(actionRef)!,
    sha256: hashLocalRotatingInstaller(env),
  };
}

export function readLocalRotatingInstallerSource(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  return readFileSync(resolveLocalRotatingInstallerPath(env, cwd), "utf8");
}

export function resolveCodexRotatingPublicWebUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveReviewRouterPublicWebUrl(env);
}

export function resolveCodexRotatingInstallRedirect(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const actionRef = resolveReviewRouterCodexRotatingActionRef(env);
  const atIndex = actionRef.lastIndexOf("@");
  const repository = actionRef.slice(0, atIndex);
  const ref = actionRef.slice(atIndex + 1);
  return `https://raw.githubusercontent.com/${repository}/${ref}/scripts/seed-codex-rotating-auth.sh`;
}

export function resolveCodexReseedInstallRedirect(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const actionRef = resolveReviewRouterCodexRotatingActionRef(env);
  const atIndex = actionRef.lastIndexOf("@");
  const repository = actionRef.slice(0, atIndex);
  const ref = actionRef.slice(atIndex + 1);
  return `https://raw.githubusercontent.com/${repository}/${ref}/${RESEED_SCRIPT_PATH}`;
}

function hashLocalRotatingInstaller(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const scriptPath = resolveLocalRotatingInstallerPath(env, cwd);
  const script = readFileSync(scriptPath);
  return createHash("sha256").update(script).digest("hex");
}

function resolveLocalRotatingInstallerPath(
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  const candidates = [
    env.REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_PATH?.trim(),
    join(cwd, SCRIPT_PATH),
    join(cwd, "..", SCRIPT_PATH),
    join(cwd, "..", "..", SCRIPT_PATH),
    join(cwd, "..", "..", "..", SCRIPT_PATH),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const scriptPath = candidates.find((candidate) => existsSync(candidate));
  if (!scriptPath) {
    throw new Error("codex_rotating_installer_missing");
  }
  return scriptPath;
}

function resolvePinnedActionSha(value: string | undefined): string | null {
  const match = value?.trim().match(/@([a-f0-9]{40})$/i);
  const sha = match?.[1];
  return sha ? sha.toLowerCase() : null;
}
