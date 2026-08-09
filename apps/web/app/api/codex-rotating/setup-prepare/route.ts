import { NextResponse } from "next/server";
import { prepareCodexRotatingSetup } from "@reviewrouter/features-provider-setup";
import { getPrisma } from "../../../../src/server/prisma";
import { PrismaCodexRotatingSetupPayloadClaim } from "../../../../src/server/prisma-codex-rotating-setup-payload-claim";

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    const result = await prepareCodexRotatingSetup(payload, {
      claims: new PrismaCodexRotatingSetupPayloadClaim(getPrisma()),
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json(
      { error: safePrepareError(message) },
      {
        status:
          message.includes("claim_") || message.includes("stale_epoch")
            ? 409
            : 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

function safePrepareError(message: string): string {
  return [
    "codex_rotating_setup_payload_claim_conflict",
    "codex_rotating_setup_payload_claim_mismatch",
    "codex_rotating_setup_payload_claim_expired",
    "codex_rotating_setup_confirmation_stale_epoch",
    "codex_rotating_setup_manifest_not_found",
  ].includes(message)
    ? message
    : "codex_rotating_setup_payload_claim_invalid";
}
