import { NextResponse } from "next/server";
import {
  codexRotatingSetupLedger,
  codexRotatingSetupLedgerHttpError,
} from "../../../../src/server/codex-rotating-setup-ledger";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    return NextResponse.json(
      await codexRotatingSetupLedger.recordOutcome(await request.json()),
      { headers: { "Cache-Control": "no-store" } },
    );
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
