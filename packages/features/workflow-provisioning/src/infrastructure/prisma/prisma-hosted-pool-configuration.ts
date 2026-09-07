import {
  findReviewConfiguration,
  PrismaReviewConfigurationTransactionRepository,
  safeDefaultReviewConfiguration,
  saveReviewConfiguration,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config";
import type { Prisma } from "@prisma/client";

export async function switchRepositoryConfigurationAuthMode(input: {
  readonly transaction: Prisma.TransactionClient;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly authMode:
    | "codex_subscription_oauth_hosted_pool"
    | "codex_subscription_oauth_rotating";
}): Promise<boolean> {
  const configurations = new PrismaReviewConfigurationTransactionRepository(
    input.transaction,
  );
  const repositoryTarget = {
    scope: "repository" as const,
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
  };
  // Keep interactive-transaction queries sequential. Prisma does not execute
  // them concurrently on one transaction connection, while Promise.all hides
  // ordering and violates the project's transaction architecture invariant.
  const repositoryConfiguration = await findReviewConfiguration(
    repositoryTarget,
    { configurations },
  );
  const workspaceConfiguration = await findReviewConfiguration(
    { scope: "workspace", workspaceId: input.workspaceId },
    { configurations },
  );
  const current =
    repositoryConfiguration?.config ??
    workspaceConfiguration?.config ??
    safeDefaultReviewConfiguration;
  const next = withCodexAuthMode(current, input.authMode);
  if (!next) return false;
  await saveReviewConfiguration(
    {
      target: repositoryTarget,
      config: next,
      expectedVersion: repositoryConfiguration?.version ?? null,
    },
    { configurations },
  );
  return true;
}

function withCodexAuthMode(
  configuration: ReviewConfiguration,
  authMode:
    | "codex_subscription_oauth_hosted_pool"
    | "codex_subscription_oauth_rotating",
): ReviewConfiguration | null {
  let foundCodex = false;
  const providers = configuration.providers.map((provider) => {
    if (provider.kind !== "codex") return provider;
    foundCodex = true;
    return { ...provider, authMode };
  });
  if (!foundCodex) return null;
  return {
    ...configuration,
    providers,
    provider: providers[0]!,
  };
}
