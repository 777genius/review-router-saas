import { NextResponse } from "next/server";
import { defaultCodexSeedScriptUrl } from "@reviewrouter/features-provider-setup";

export function GET(): NextResponse {
  return NextResponse.redirect(defaultCodexSeedScriptUrl, 307);
}
