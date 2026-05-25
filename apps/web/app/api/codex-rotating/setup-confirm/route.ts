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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "unknown_error" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
