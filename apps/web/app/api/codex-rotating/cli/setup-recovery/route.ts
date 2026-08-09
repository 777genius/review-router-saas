import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeGitHubCliRepository } from "../../../../../src/server/github-cli-repository-authorization";
import { getPrisma } from "../../../../../src/server/prisma";
import { recoverAndIssueCodexRotatingSetup } from "../../../../../src/server/codex-rotating-setup-recovery";

const requestSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    acknowledgement: z.literal("all_prior_installers_and_writers_are_stopped"),
    recoveryRequestId: z.string().regex(/^[A-Za-z0-9_.:-]{8,160}$/),
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const accessToken = readBearerToken(request);
    const rawBody: unknown = await request.json();
    const parsed = requestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const acknowledgement =
        typeof rawBody === "object" && rawBody
          ? (rawBody as { acknowledgement?: unknown }).acknowledgement
          : undefined;
      throw new Error(
        acknowledgement === "all_prior_installers_and_writers_are_stopped"
          ? "invalid_request"
          : "codex_rotating_setup_recovery_acknowledgement_required",
      );
    }
    const body = parsed.data;
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
    const result = await recoverAndIssueCodexRotatingSetup({
      prisma,
      repository,
      actor: `github-cli:token-sha256:${createHash("sha256")
        .update(accessToken)
        .digest("hex")}`,
      recoveryRequestId: body.recoveryRequestId,
      acknowledgement: body.acknowledgement,
    });
    return NextResponse.json(
      {
        command: result.command,
        expiresAt: result.expiresAt,
        providerInstanceId: result.providerInstanceId,
        recoveryStatus: result.recoveryStatus,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const code = message.startsWith("rate_limit_exceeded:")
      ? "rate_limited"
      : SAFE_ERRORS.has(message)
        ? message
        : "invalid_request";
    return NextResponse.json(
      { error: code },
      {
        status: statusForError(code),
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

const SAFE_ERRORS = new Set([
  "github_cli_token_required",
  "github_cli_token_invalid",
  "github_cli_repository_forbidden",
  "github_cli_repository_not_found",
  "repository_not_found",
  "repository_mismatch",
  "codex_rotating_identity_quarantined",
  "codex_rotating_provider_identity_mismatch",
  "codex_rotating_setup_recovery_acknowledgement_required",
  "codex_rotating_setup_recovery_not_required",
  "codex_rotating_setup_recovery_already_used",
  "codex_rotating_setup_recovery_required",
  "codex_rotating_setup_recovery_request_conflict",
  "codex_rotating_mutation_still_active",
  "codex_rotating_mutation_ownership_ambiguous",
  "codex_rotating_setup_issuance_quiesced",
  "codex_rotating_setup_lock_failed",
  "invalid_request",
  "rate_limited",
]);

function readBearerToken(request: Request): string {
  const match = (request.headers.get("authorization") ?? "").match(
    /^Bearer\s+(\S+)$/i,
  );
  const token = match?.[1];
  if (!token || token.length < 16 || token.length > 4096) {
    throw new Error("github_cli_token_required");
  }
  return token;
}

function statusForError(code: string): number {
  if (
    code === "github_cli_token_required" ||
    code === "github_cli_token_invalid"
  )
    return 401;
  if (code === "github_cli_repository_forbidden") return 403;
  if (code.includes("not_found")) return 404;
  if (code === "rate_limited") return 429;
  if (code === "codex_rotating_setup_issuance_quiesced") return 503;
  if (code.startsWith("codex_rotating_")) return 409;
  return 400;
}
