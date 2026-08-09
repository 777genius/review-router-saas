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
    return NextResponse.json(
      { error: message },
      {
        status: isSafeSetupConflict(message) ? 409 : 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

function isSafeSetupConflict(message: string): boolean {
  return (
    message === "codex_rotating_setup_manifest_reused" ||
    message === "codex_rotating_setup_confirmation_stale_epoch" ||
    message === "codex_rotating_mutation_fence_conflict"
  );
}
