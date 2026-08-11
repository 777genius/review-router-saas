import { isLoopbackHostname } from "./loopback-hostname.mjs";

const INSTALLER_PATH = "scripts/seed-codex-rotating-auth.sh";
const ACTION_REF_PATTERN =
  /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([a-f0-9]{40})$/i;

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ readonly allowLoopback?: boolean }} [options]
 */
export function resolveCodexRotatingInstallerDescriptor(env, options = {}) {
  const url = read(env, "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_URL");
  const version = read(env, "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_VERSION");
  const sha256 = read(env, "REVIEW_ROUTER_CODEX_ROTATING_INSTALLER_SHA256");
  if (!url || !version || !sha256) {
    throw new Error("codex_rotating_installer_descriptor_incomplete");
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error("invalid_codex_rotating_installer_sha256");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("invalid_codex_rotating_installer_url");
  }
  if (
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error("invalid_codex_rotating_installer_url");
  }

  const loopback = isLoopbackHostname(parsedUrl.hostname);
  if (
    loopback &&
    options.allowLoopback === true &&
    parsedUrl.protocol === "http:"
  ) {
    if (version.length > 120) {
      throw new Error("invalid_codex_rotating_installer_version");
    }
    return { url, version, sha256: sha256.toLowerCase() };
  }

  if (!/^(?:v[0-9]+\.[0-9]+\.[0-9]+|[a-f0-9]{40})$/i.test(version)) {
    throw new Error("invalid_codex_rotating_installer_version");
  }

  const actionRef = read(env, "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF");
  const match = actionRef.match(ACTION_REF_PATTERN);
  const actionRepository = match?.[1];
  const actionSha = match?.[2];
  if (!actionRepository || !actionSha || parsedUrl.protocol !== "https:") {
    throw new Error("invalid_codex_rotating_installer_url");
  }
  if (
    /^[a-f0-9]{40}$/i.test(version) &&
    version.toLowerCase() !== actionSha.toLowerCase()
  ) {
    throw new Error("invalid_codex_rotating_installer_version");
  }
  const expectedUrl = `https://raw.githubusercontent.com/${actionRepository}/${actionSha.toLowerCase()}/${INSTALLER_PATH}`;
  if (url.toLowerCase() !== expectedUrl.toLowerCase()) {
    throw new Error("invalid_codex_rotating_installer_url");
  }

  return { url: expectedUrl, version, sha256: sha256.toLowerCase() };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 */
function read(env, name) {
  return String(env[name] ?? "").trim();
}
