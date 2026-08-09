import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeGitHubCliRepository } from "../../../../../src/server/github-cli-repository-authorization";
import { issueCodexRotatingSetupForRepository } from "../../../../../src/server/codex-rotating-setup-command";
import { getPrisma } from "../../../../../src/server/prisma";

const requestSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    reuseCurrentAuth: z.boolean().optional().default(false),
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const accessToken = readBearerToken(request);
    const body = requestSchema.parse(await request.json());
    const authorized = await authorizeGitHubCliRepository({
      accessToken,
      repositoryFullName: body.repository,
    });
    const prisma = getPrisma();
    const repository = await prisma.repositoryConnection.findFirst({
      where: {
        provider: "github",
        githubRepositoryId: BigInt(authorized.githubRepositoryId),
      },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        githubRepositoryId: true,
        fullName: true,
        selected: true,
        archived: true,
        installation: { select: { status: true } },
      },
    });
    if (!repository) throw new Error("repository_not_found");
    if (
      repository.fullName.toLowerCase() !== authorized.fullName.toLowerCase()
    ) {
      throw new Error("repository_mismatch");
    }

    const setup = await issueCodexRotatingSetupForRepository({
      prisma,
      repository,
      installerArguments: [
        body.reuseCurrentAuth
          ? "--reuse-existing-auth-i-know-it-is-current"
          : "--force-reseed",
      ],
    });
    return NextResponse.json(
      {
        command: setup.command,
        expiresAt: setup.expiresAt,
        providerInstanceId: setup.providerInstanceId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const code = safeErrorCode(error);
    return NextResponse.json(
      { error: code },
      {
        status: statusForError(code),
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

function readBearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  if (!token || token.length < 16 || token.length > 4096) {
    throw new Error("github_cli_token_required");
  }
  return token;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message.startsWith("rate_limit_exceeded:")) return "rate_limited";
  const code = message.split(":", 1)[0] ?? "unknown_error";
  const allowed = new Set([
    "github_cli_token_required",
    "github_cli_token_invalid",
    "github_cli_repository_forbidden",
    "github_cli_repository_not_found",
    "github_cli_repository_mismatch",
    "github_cli_api_error",
    "invalid_repository",
    "repository_not_found",
    "repository_mismatch",
    "repository_not_selected",
    "repository_archived",
    "installation_not_active",
    "codex_rotating_not_enabled",
    "codex_rotating_setup_issuance_quiesced",
    "codex_rotating_installer_missing",
    "codex_rotating_installer_descriptor_incomplete",
    "codex_rotating_setup_in_progress",
    "codex_rotating_setup_lock_failed",
    "invalid_codex_rotating_installer_sha256",
    "invalid_review_router_web_url",
    "rate_limited",
  ]);
  return allowed.has(code) ? code : "invalid_request";
}

function statusForError(code: string): number {
  if (code === "codex_rotating_setup_issuance_quiesced") return 503;
  if (
    code === "github_cli_token_required" ||
    code === "github_cli_token_invalid"
  ) {
    return 401;
  }
  if (code === "github_cli_repository_forbidden") return 403;
  if (
    code === "github_cli_repository_not_found" ||
    code === "repository_not_found"
  ) {
    return 404;
  }
  if (code === "rate_limited") return 429;
  if (
    code === "codex_rotating_setup_in_progress" ||
    code === "codex_rotating_setup_lock_failed"
  ) {
    return 409;
  }
  return 400;
}
