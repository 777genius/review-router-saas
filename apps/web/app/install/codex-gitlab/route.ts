import { NextResponse } from "next/server";
import { resolveGitLabCodexInstallRedirect } from "@/server/codex-seed-script-url";

export function GET(request: Request): NextResponse {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    return NextResponse.redirect(
      new URL("/getting-started#gitlab", request.url),
      307,
    );
  }

  return NextResponse.redirect(resolveGitLabCodexInstallRedirect(), 307);
}
