import { NextResponse } from "next/server";
import { assertDashboardRepositoryMutationAllowed } from "../../../../../src/server/dashboard-mutations";
import { getPrisma } from "../../../../../src/server/prisma";
import { issueCodexRotatingSetupForRepository } from "../../../../../src/server/codex-rotating-setup-command";
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
