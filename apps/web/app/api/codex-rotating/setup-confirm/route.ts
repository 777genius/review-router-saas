import { NextResponse } from "next/server";
import { getPrisma } from "../../../../src/server/prisma";
import { confirmCodexRotatingSetupManifest } from "../../../../src/server/codex-rotating-setup-manifest";

export async function POST(
  request: Request,
): Promise<
  NextResponse<{ readonly status?: "accepted"; readonly error?: string }>
> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const result = await confirmCodexRotatingSetupManifest({
      prisma: getPrisma(),
      payload,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const safeError = safeSetupError(message);
    return NextResponse.json(
      { error: safeError },
      {
        status: isSafeSetupConflict(safeError) ? 409 : 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

function isSafeSetupConflict(message: string): boolean {
  return (
    message === "codex_rotating_setup_manifest_reused" ||
    message === "codex_rotating_setup_confirmation_stale_epoch" ||
    message === "codex_rotating_mutation_fence_conflict" ||
    message === "codex_rotating_setup_payload_claim_conflict"
  );
}

function safeSetupError(message: string): string {
  return [
    "codex_rotating_setup_manifest_reused",
    "codex_rotating_setup_confirmation_stale_epoch",
    "codex_rotating_mutation_fence_conflict",
    "codex_rotating_setup_payload_claim_conflict",
    "codex_rotating_setup_confirmation_mismatch",
    "codex_rotating_setup_manifest_expired",
    "codex_rotating_setup_manifest_not_found",
    "codex_rotating_not_enabled",
  ].includes(message)
    ? message
    : "codex_rotating_setup_confirmation_invalid";
}
