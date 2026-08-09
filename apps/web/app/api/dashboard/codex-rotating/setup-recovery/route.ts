import { NextResponse } from "next/server";
import { assertDashboardRepositoryMutationAllowed } from "../../../../../src/server/dashboard-mutations";
import { getPrisma } from "../../../../../src/server/prisma";
import { recoverAndIssueCodexRotatingSetup } from "../../../../../src/server/codex-rotating-setup-recovery";
import { codexRotatingSecretName } from "@reviewrouter/features-provider-setup";
import { PrismaCodexRotatingSetupRecovery } from "../../../../../src/server/prisma-codex-rotating-setup-recovery";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
    const repositoryId = url.searchParams.get("repositoryId")?.trim() ?? "";
    if (!workspaceId || !repositoryId) throw new Error("invalid_request");
    const prisma = getPrisma();
    const repository = await prisma.repositoryConnection.findUnique({
      where: { id: repositoryId },
      select: {
        id: true,
        workspaceId: true,
        owner: true,
        name: true,
        githubRepositoryId: true,
        installation: { select: { githubInstallationId: true } },
      },
    });
    if (
      !repository ||
      repository.workspaceId !== workspaceId ||
      !repository.githubRepositoryId ||
      !repository.installation
    ) {
      throw new Error("repository_not_found");
    }
    await assertDashboardRepositoryMutationAllowed(workspaceId, {
      ...repository,
      githubRepositoryId: repository.githubRepositoryId,
      installation: repository.installation,
    });
    const status = await new PrismaCodexRotatingSetupRecovery(
      prisma,
    ).inspectStatus({
      workspaceId,
      repositoryId,
      issuanceEnabled:
        process.env.REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED !== "0",
    });
    return NextResponse.json(
      status.status === "identity_quarantined"
        ? {
            status: "identity_quarantined",
            reason: status.quarantine.reason,
            observedProviderInstanceId:
              status.quarantine.observedProviderInstanceId,
            expectedProviderInstanceId:
              status.quarantine.expectedProviderInstanceId,
            quarantinedAt: status.quarantine.quarantinedAt.toISOString(),
            action:
              "Repair the repository/provider binding through the identity migration operator lane; setup recovery will not rewrite immutable identity.",
          }
        : status,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const code = safeRecoveryErrorCode(error);
    return NextResponse.json(
      { error: code },
      {
        status: statusForRecoveryError(code),
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const formData = await request.formData();
    const workspaceId = readFormValue(formData, "workspaceId");
    const repositoryId = readFormValue(formData, "repositoryId");
    const acknowledgement = readFormValue(formData, "acknowledgement");
    const recoveryRequestId = readFormValue(formData, "recoveryRequestId");
    const prisma = getPrisma();
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
        selected: true,
        archived: true,
        installation: {
          select: { status: true, githubInstallationId: true },
        },
      },
    });
    if (
      !repository ||
      repository.workspaceId !== workspaceId ||
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
    const actor = await assertDashboardRepositoryMutationAllowed(
      workspaceId,
      githubRepository,
    );
    const result = await recoverAndIssueCodexRotatingSetup({
      prisma,
      repository: githubRepository,
      actor: actor.actor,
      recoveryRequestId,
      acknowledgement,
    });
    return NextResponse.json(
      {
        command: result.command,
        expiresAt: result.expiresAt,
        providerInstanceId: result.providerInstanceId,
        secretNames: [codexRotatingSecretName],
        recoveryStatus: result.recoveryStatus,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const code = safeRecoveryErrorCode(error);
    return NextResponse.json(
      { error: code },
      {
        status: statusForRecoveryError(code),
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

function readFormValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      name === "acknowledgement"
        ? "codex_rotating_setup_recovery_acknowledgement_required"
        : "invalid_form",
    );
  }
  return value.trim();
}

function safeRecoveryErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message.startsWith("rate_limit_exceeded:")) return "rate_limited";
  const allowed = new Set([
    "repository_not_found",
    "repository_not_selected",
    "repository_archived",
    "installation_not_active",
    "repository_mutation_forbidden",
    "workspace_mutation_forbidden",
    "codex_rotating_provider_not_found",
    "codex_rotating_provider_identity_mismatch",
    "codex_rotating_identity_quarantined",
    "codex_rotating_setup_recovery_acknowledgement_required",
    "codex_rotating_setup_recovery_request_invalid",
    "codex_rotating_setup_recovery_not_required",
    "codex_rotating_setup_recovery_already_used",
    "codex_rotating_setup_recovery_required",
    "codex_rotating_setup_issuance_quiesced",
    "codex_rotating_setup_lock_failed",
    "rate_limited",
  ]);
  return allowed.has(message) ? message : "dashboard_action_failed";
}

function statusForRecoveryError(code: string): number {
  if (code === "repository_not_found") return 404;
  if (code === "rate_limited") return 429;
  if (
    code === "repository_mutation_forbidden" ||
    code === "workspace_mutation_forbidden"
  ) {
    return 403;
  }
  if (
    code.includes("recovery") ||
    code === "codex_rotating_identity_quarantined" ||
    code === "codex_rotating_setup_issuance_quiesced" ||
    code === "codex_rotating_setup_lock_failed"
  ) {
    return 409;
  }
  return 400;
}
