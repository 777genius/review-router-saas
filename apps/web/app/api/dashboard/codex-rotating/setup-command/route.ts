import { NextResponse } from "next/server";
import { isCodexRotatingOAuthAllowedForRepository } from "@reviewrouter/platform-config";
import { assertDashboardRepositoryMutationAllowed } from "../../../../../src/server/dashboard-mutations";
import { createDashboardRateLimitPolicy } from "../../../../../src/server/dashboard-rate-limits";
import { getPrisma } from "../../../../../src/server/prisma";
import {
  resolveCodexRotatingPublicWebUrl,
  resolveCodexRotatingSeedScriptDescriptor,
} from "../../../../../src/server/codex-rotating-seed-script";
import { issueCodexRotatingSetupCommand } from "../../../../../src/server/codex-rotating-setup-manifest";
import { codexRotatingSecretName } from "@reviewrouter/features-provider-setup";

export async function POST(request: Request): Promise<
  NextResponse<
    | {
        readonly command: string;
        readonly expiresAt: string;
        readonly providerInstanceId: string;
        readonly secretNames: readonly string[];
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
    if (!repository.selected) throw new Error("repository_not_selected");
    if (repository.archived) throw new Error("repository_archived");
    if (githubRepository.installation.status !== "active") {
      throw new Error("installation_not_active");
    }
    if (!isCodexRotatingOAuthAllowedForRepository(repository.fullName)) {
      throw new Error("codex_rotating_not_enabled");
    }

    await assertDashboardRepositoryMutationAllowed(
      workspaceId,
      githubRepository,
    );
    await createDashboardRateLimitPolicy(prisma).assertReviewConfigSaveAllowed({
      workspaceId,
      resourceId: `codex-rotating-setup:${repositoryId}`,
    });

    const baseUrl = resolveCodexRotatingPublicWebUrl();
    const setupManifestUrl = new URL(
      "/api/codex-rotating/setup-manifest",
      baseUrl,
    ).toString();
    const setupConfirmUrl = new URL(
      "/api/codex-rotating/setup-confirm",
      baseUrl,
    ).toString();
    const installer = resolveCodexRotatingSeedScriptDescriptor();
    const setup = await issueCodexRotatingSetupCommand({
      prisma,
      workspaceId,
      repositoryId,
      repositoryFullName: repository.fullName,
      githubRepositoryId: githubRepository.githubRepositoryId.toString(),
      installer,
      setupManifestUrl,
      setupConfirmUrl,
    });

    return NextResponse.json({
      command: setup.command,
      expiresAt: setup.expiresAt,
      providerInstanceId: setup.providerInstanceId,
      secretNames: [codexRotatingSecretName],
    });
  } catch (error) {
    return NextResponse.json(
      { error: codexRotatingSetupCommandErrorCode(error) },
      { status: 400 },
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
    [
      "repository_not_found",
      "repository_not_selected",
      "repository_archived",
      "installation_not_active",
      "repository_mutation_forbidden",
      "workspace_mutation_forbidden",
      "codex_rotating_not_enabled",
      "codex_rotating_installer_missing",
      "codex_rotating_installer_descriptor_incomplete",
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
