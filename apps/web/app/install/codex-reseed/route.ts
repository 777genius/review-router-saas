import { NextResponse } from "next/server";
import { resolveCodexReseedInstallRedirect } from "@/server/codex-rotating-seed-script";

export function GET(): NextResponse {
  return NextResponse.redirect(resolveCodexReseedInstallRedirect(), 307);
}
