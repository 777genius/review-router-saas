import type { PrismaClient } from "@reviewrouter/platform-db";
import type { CodexRotatingInstallerArgument } from "@reviewrouter/features-provider-setup";
import { isCodexRotatingOAuthAllowedForRepository } from "@reviewrouter/platform-config";
import { createDashboardRateLimitPolicy } from "./dashboard-rate-limits";
import {
  resolveCodexRotatingPublicWebUrl,
  resolveCodexRotatingSeedScriptDescriptor,
} from "./codex-rotating-seed-script";
import { issueCodexRotatingSetupCommand } from "./codex-rotating-setup-manifest";

export type CodexRotatingSetupRepository = {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: string;
  readonly githubRepositoryId: bigint | null;
  readonly fullName: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly installation: { readonly status: string } | null;
};

export async function issueCodexRotatingSetupForRepository(input: {
  readonly prisma: PrismaClient;
  readonly repository: CodexRotatingSetupRepository;
  readonly installerArguments?: readonly CodexRotatingInstallerArgument[];
}) {
  assertCodexRotatingSetupRepository(input.repository);

  await createDashboardRateLimitPolicy(
    input.prisma,
  ).assertReviewConfigSaveAllowed({
    workspaceId: input.repository.workspaceId,
    resourceId: `codex-rotating-setup:${input.repository.id}`,
  });

  const baseUrl = resolveCodexRotatingPublicWebUrl();
  return issueCodexRotatingSetupCommand({
    prisma: input.prisma,
    workspaceId: input.repository.workspaceId,
    repositoryId: input.repository.id,
    repositoryFullName: input.repository.fullName,
    githubRepositoryId: input.repository.githubRepositoryId!.toString(),
    installer: resolveCodexRotatingSeedScriptDescriptor(),
    setupManifestUrl: new URL(
      "/api/codex-rotating/setup-manifest",
      baseUrl,
    ).toString(),
    setupConfirmUrl: new URL(
      "/api/codex-rotating/setup-confirm",
      baseUrl,
    ).toString(),
    ...(input.installerArguments
      ? { installerArguments: input.installerArguments }
      : {}),
  });
}

export function assertCodexRotatingSetupRepository(
  repository: CodexRotatingSetupRepository,
): void {
  if (repository.provider !== "github" || !repository.githubRepositoryId) {
    throw new Error("repository_not_found");
  }
  if (!repository.selected) throw new Error("repository_not_selected");
  if (repository.archived) throw new Error("repository_archived");
  if (repository.installation?.status !== "active") {
    throw new Error("installation_not_active");
  }
  if (!isCodexRotatingOAuthAllowedForRepository(repository.fullName)) {
    throw new Error("codex_rotating_not_enabled");
  }
}
