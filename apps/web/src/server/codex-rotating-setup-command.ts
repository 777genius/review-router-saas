import type { PrismaClient } from "@reviewrouter/platform-db";
import type { CodexRotatingInstallerArgument } from "@reviewrouter/features-provider-setup";
import {
  isCodexRotatingOAuthAllowedForRepository,
  requireReviewRouterDatabaseRecoveryWitness,
} from "@reviewrouter/platform-config";
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
  readonly recovery?: {
    readonly requestId: string;
    readonly epoch: bigint;
  };
}) {
  assertCodexRotatingSetupRepository(input.repository);

  const baseUrl = resolveCodexRotatingPublicWebUrl();
  const databaseRecoveryWitness = requireReviewRouterDatabaseRecoveryWitness();
  return issueCodexRotatingSetupCommand({
    prisma: input.prisma,
    workspaceId: input.repository.workspaceId,
    repositoryId: input.repository.id,
    repositoryFullName: input.repository.fullName,
    githubRepositoryId: input.repository.githubRepositoryId!.toString(),
    installer: resolveCodexRotatingSeedScriptDescriptor(),
    runtimeEnvironment: process.env,
    setupManifestUrl: new URL(
      "/api/codex-rotating/setup-manifest",
      baseUrl,
    ).toString(),
    setupPrepareUrl: new URL(
      "/api/codex-rotating/setup-prepare",
      baseUrl,
    ).toString(),
    setupDispatchUrl: new URL(
      "/api/codex-rotating/setup-dispatch",
      baseUrl,
    ).toString(),
    setupDispatchOutcomeUrl: new URL(
      "/api/codex-rotating/setup-dispatch-outcome",
      baseUrl,
    ).toString(),
    setupStatusUrl: new URL(
      "/api/codex-rotating/setup-status",
      baseUrl,
    ).toString(),
    databaseRecoveryWitness,
    admittedOperation: async (tx) => {
      await createDashboardRateLimitPolicy(tx).assertReviewConfigSaveAllowed({
        workspaceId: input.repository.workspaceId,
        resourceId: `codex-rotating-setup:${input.repository.id}`,
      });
    },
    ...(input.installerArguments
      ? { installerArguments: input.installerArguments }
      : {}),
    ...(input.recovery ? { recovery: input.recovery } : {}),
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
