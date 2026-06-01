import { NextResponse } from "next/server";
import { z } from "zod";
import { assertDashboardWorkspaceAdminAllowed } from "../../../../../src/server/dashboard-mutations";
import { buildGitLabCodexSeedCommand } from "../../../../../src/server/gitlab-codex-seed-command";

const bodySchema = z
  .object({
    workspaceId: z.string().min(1),
    installationId: z.string().min(1).optional(),
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = bodySchema.parse(await request.json());
    await assertDashboardWorkspaceAdminAllowed(body.workspaceId);
    const command = await buildGitLabCodexSeedCommand(body);
    return NextResponse.json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json(
      { error: safeGitLabCodexCommandErrorCode(message) },
      { status: statusForError(message) },
    );
  }
}

function safeGitLabCodexCommandErrorCode(message: string): string {
  const code = message.split(":")[0] ?? "unknown_error";
  return /^[a-z0-9_]{1,96}$/.test(code) ? code : "unknown_error";
}

function statusForError(message: string): number {
  if (message.includes("requires_sign_in")) return 401;
  if (message.includes("forbidden")) return 403;
  if (message.includes("gitlab_installation_not_found")) return 404;
  return 400;
}
