import { defaultCodexSeedScriptUrl } from "@reviewrouter/features-provider-setup";

export function resolveInstallCodexRedirect(request: Request): string {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    return new URL("/getting-started#codex-oauth", request.url).toString();
  }

  return defaultCodexSeedScriptUrl;
}
