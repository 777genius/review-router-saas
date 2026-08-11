import { NextResponse } from "next/server";
import {
  codexRotatingSetupLedger,
  codexRotatingSetupLedgerHttpError,
} from "../../../../src/server/codex-rotating-setup-ledger";

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json" },
      {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  try {
    const result = await codexRotatingSetupLedger.prepare(payload);
    return NextResponse.json(result, {
      status: result.status === "prepared" ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const mapped = codexRotatingSetupLedgerHttpError(error);
    return NextResponse.json(
      { error: mapped.error },
      {
        status: mapped.status,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
