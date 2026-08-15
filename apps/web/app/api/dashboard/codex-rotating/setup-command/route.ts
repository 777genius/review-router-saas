import { NextResponse } from "next/server";
import { assertDashboardRepositoryMutationAllowed } from "../../../../../src/server/dashboard-mutations";
import { getPrisma } from "../../../../../src/server/prisma";
import { issueCodexRotatingSetupForRepository } from "../../../../../src/server/codex-rotating-setup-command";

export async function POST(request: Request): Promise<
  NextResponse<
    | {
        readonly command: string;
        readonly expiresAt: string;
        readonly providerInstanceId: string;
      }
    | { readonly error: string }
  >
> {
  const formData = await request.formData();
  const workspaceId = readFormValue(formData, "workspaceId");
  const repositoryId = readFormValue(formData, "repositoryId");
  const prisma = getPrisma();

  try {
    const repository = await prisma.repositoryConnection.findUnique({
      where: { id: repositoryId },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        githubRepositoryId: true,
        owner: true,
        name: true,
        fullName: true,
        visibility: true,
        selected: true,
        archived: true,
        installation: {
          select: {
            status: true,
            githubInstallationId: true,
          },
        },
      },
    });
    if (!repository || repository.workspaceId !== workspaceId) {
      throw new Error("repository_not_found");
    }
    if (
      repository.provider !== "github" ||
      !repository.githubRepositoryId ||
      !repository.installation
    ) {
      throw new Error("repository_not_found");
    }
    const githubRepository = {
      ...repository,
      githubRepositoryId: repository.githubRepositoryId,
      installation: repository.installation,
    };
    await assertDashboardRepositoryMutationAllowed(
      workspaceId,
      githubRepository,
    );
    const setup = await issueCodexRotatingSetupForRepository({
      prisma,
      repository,
    });

    return NextResponse.json({
      command: setup.command,
      expiresAt: setup.expiresAt,
      providerInstanceId: setup.providerInstanceId,
    });
  } catch (error) {
    const code = codexRotatingSetupCommandErrorCode(error);
    return NextResponse.json(
      { error: code },
      {
        status:
          code === "codex_rotating_setup_issuance_quiesced"
            ? 503
            : code === "codex_rotating_setup_in_progress" ||
                code === "codex_rotating_setup_recovery_required" ||
                code === "codex_rotating_identity_quarantined" ||
                code === "codex_rotating_mutation_fence_conflict" ||
                code === "codex_rotating_setup_lock_failed"
              ? 409
              : 400,
      },
    );
  }
}

function readFormValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("invalid_form");
  }
  return value.trim();
}

function codexRotatingSetupCommandErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message.startsWith("rate_limit_exceeded:")) {
    return "rate_limited";
  }
  if (
    message === "invalid_codex_rotating_installer_url" ||
    message === "invalid_codex_rotating_installer_version"
  ) {
    return "server_misconfigured";
  }
  if (
    [
      "repository_not_found",
      "repository_not_selected",
      "repository_archived",
      "installation_not_active",
      "repository_mutation_forbidden",
      "workspace_mutation_forbidden",
      "codex_rotating_not_enabled",
      "codex_rotating_setup_issuance_quiesced",
      "codex_rotating_installer_missing",
      "codex_rotating_installer_descriptor_incomplete",
      "codex_rotating_setup_in_progress",
      "codex_rotating_setup_recovery_required",
      "codex_rotating_identity_quarantined",
      "codex_rotating_setup_issuance_quiesced",
      "codex_rotating_mutation_fence_conflict",
      "codex_rotating_setup_lock_failed",
      "invalid_codex_rotating_installer_sha256",
      "invalid_review_router_web_url",
    ].includes(message)
  ) {
    return message;
  }
  if (
    message.startsWith("missing_env:") ||
    message.startsWith("invalid_env:")
  ) {
    return "server_misconfigured";
  }
  return "dashboard_action_failed";
}
