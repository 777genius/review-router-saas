import { resolveCodexRotatingInstallRedirect } from "./codex-rotating-seed-script";

export function resolveInstallCodexRedirect(request: Request): string {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    return new URL(
      "/getting-started#codex-oauth-rotating",
      request.url,
    ).toString();
  }

  return resolveCodexRotatingInstallRedirect();
}
