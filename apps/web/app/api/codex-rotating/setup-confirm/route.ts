import { NextResponse } from "next/server";

export async function POST(): Promise<
  NextResponse<{ readonly error: string }>
> {
  return NextResponse.json(
    { error: "codex_rotating_legacy_stable_secret_removed" },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
