import { NextResponse } from "next/server";
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "codex_rotating_source_attestor_required" },
    { status: 409, headers: { "Cache-Control": "no-store" } },
  );
}
