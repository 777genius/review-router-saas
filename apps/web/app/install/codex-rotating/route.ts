import { NextResponse } from "next/server";
import { resolveCodexRotatingInstallRedirect } from "@/server/codex-rotating-seed-script";

export function GET(): NextResponse {
  return NextResponse.redirect(resolveCodexRotatingInstallRedirect(), 307);
}
