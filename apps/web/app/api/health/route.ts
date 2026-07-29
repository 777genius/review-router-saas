import { NextResponse } from "next/server";

export function GET(): NextResponse {
  return NextResponse.json(
    {
      service: "review-router-web",
      status: "ok",
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
