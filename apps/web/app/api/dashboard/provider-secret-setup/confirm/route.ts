import { NextResponse } from "next/server";
import { confirmProviderSecretSetupClientAction } from "../../../../dashboard/actions";

export async function POST(
  request: Request,
): Promise<NextResponse<{ readonly params: Record<string, string> }>> {
  const formData = await request.formData();
  const result = await confirmProviderSecretSetupClientAction(formData);

  return NextResponse.json(result);
}
