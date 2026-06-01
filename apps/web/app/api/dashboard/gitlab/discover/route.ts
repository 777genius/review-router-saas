import { NextResponse } from "next/server";
import { z } from "zod";
import { assertDashboardWorkspaceAdminAllowed } from "../../../../../src/server/dashboard-mutations";
import { discoverGitLabConnectProjects } from "../../../../../src/server/gitlab-connect";

const bodySchema = z
  .object({
    workspaceId: z.string().min(1),
    sourceUrl: z.string().min(1),
    token: z.string().min(1),
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = bodySchema.parse(await request.json());
    await assertDashboardWorkspaceAdminAllowed(body.workspaceId);
    const result = await discoverGitLabConnectProjects(body);
    return NextResponse.json(result);
  } catch (error) {
    return gitLabConnectErrorResponse(error);
  }
}

function gitLabConnectErrorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "unknown_error";
  return NextResponse.json(
    {
      error: {
        code: safeGitLabConnectErrorCode(message),
        message: safeGitLabConnectErrorCode(message).replaceAll("_", " "),
      },
    },
    { status: statusForError(message) },
  );
}

function safeGitLabConnectErrorCode(message: string): string {
  const code = message.split(":")[0] ?? "unknown_error";
  return /^[a-z0-9_]{1,96}$/.test(code) ? code : "unknown_error";
}

function statusForError(message: string): number {
  if (message.includes("requires_sign_in")) return 401;
  if (message.includes("forbidden")) return 403;
  if (message.includes("gitlab_api_error_401")) return 401;
  if (message.includes("gitlab_api_error_403")) return 403;
  if (message.includes("gitlab_api_error_404")) return 404;
  return 400;
}
