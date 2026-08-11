import { NextResponse } from "next/server";
import { assertDashboardRepositoryRecoveryAllowed } from "../../../../../src/server/dashboard-mutations";
import { getPrisma } from "../../../../../src/server/prisma";
import { recoverAndIssueCodexRotatingSetup } from "../../../../../src/server/codex-rotating-setup-recovery";
import {
  assertCodexRotatingSetupRecoveryHttpFields,
  codexRotatingSetupRecoveryHttpStatus,
  safeCodexRotatingSetupRecoveryErrorCode,
} from "@reviewrouter/features-provider-setup";
import { PrismaCodexRotatingSetupRecovery } from "../../../../../src/server/prisma-codex-rotating-setup-recovery";
import { requireReviewRouterDatabaseRecoveryWitness } from "@reviewrouter/platform-config";

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
    await assertDashboardRepositoryRecoveryAllowed(workspaceId, {
      ...repository,
      githubRepositoryId: repository.githubRepositoryId,
      installation: repository.installation,
    });
    const status = await new PrismaCodexRotatingSetupRecovery(
      prisma,
      requireReviewRouterDatabaseRecoveryWitness(),
    ).inspectStatus({
      workspaceId,
      repositoryId,
      issuanceEnabled:
        process.env.REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED === "1",
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
    const code = safeCodexRotatingSetupRecoveryErrorCode(error);
    return NextResponse.json(
      { error: code },
      {
        status: codexRotatingSetupRecoveryHttpStatus(code),
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
    assertCodexRotatingSetupRecoveryHttpFields({
      acknowledgement,
      recoveryRequestId,
    });
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
    const actor = await assertDashboardRepositoryRecoveryAllowed(
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
        recoveryStatus: result.recoveryStatus,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const code = safeCodexRotatingSetupRecoveryErrorCode(error);
    return NextResponse.json(
      { error: code },
      {
        status: codexRotatingSetupRecoveryHttpStatus(code),
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
        : name === "recoveryRequestId"
          ? "codex_rotating_setup_recovery_request_invalid"
          : "invalid_request",
    );
  }
  return value.trim();
}
