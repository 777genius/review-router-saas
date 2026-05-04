import { NextResponse } from "next/server";
import { resolveInstallCodexRedirect } from "@/server/install-codex-redirect";

export function GET(request: Request): NextResponse {
  return NextResponse.redirect(resolveInstallCodexRedirect(request), 307);
}
