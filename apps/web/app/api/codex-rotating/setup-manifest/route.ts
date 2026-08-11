import { NextResponse } from "next/server";
import { getPrisma } from "../../../../src/server/prisma";
import { resolveCodexRotatingSetupManifestForNonce } from "../../../../src/server/codex-rotating-setup-manifest";
import { requireReviewRouterDatabaseRecoveryWitness } from "@reviewrouter/platform-config";

export async function GET(request: Request): Promise<
  NextResponse<
    | {
        readonly manifestBase64: string;
        readonly expiresAt: string;
        readonly recoveryExpiresAt: string;
        readonly payloadClaimed: boolean;
        readonly recoveryEpoch: string;
      }
    | { readonly error: string }
  >
> {
  const nonce = new URL(request.url).searchParams.get("nonce")?.trim();
  if (!nonce) {
    return NextResponse.json(
      { error: "codex_rotating_setup_manifest_not_found" },
      { status: 404 },
    );
  }

  try {
    const result = await resolveCodexRotatingSetupManifestForNonce({
      prisma: getPrisma(),
      setupNonce: nonce,
      databaseRecoveryWitness: requireReviewRouterDatabaseRecoveryWitness(),
      runtimeEnvironment: process.env,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json(
      { error: message },
      {
        status:
          message.includes("reused") ||
          message.includes("stale_epoch") ||
          message.includes("recovery_required")
            ? 409
            : 404,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
