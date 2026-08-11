import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  codexRotatingSetupRecoveryAcknowledgement,
  recoverCodexRotatingSetup,
} from "@reviewrouter/features-provider-setup";
import { requireReviewRouterDatabaseRecoveryWitness } from "@reviewrouter/platform-config";
import {
  assertCodexRotatingSetupRepository,
  issueCodexRotatingSetupForRepository,
  type CodexRotatingSetupRepository,
} from "./codex-rotating-setup-command";
import { PrismaCodexRotatingSetupRecovery } from "./prisma-codex-rotating-setup-recovery";

export { codexRotatingSetupRecoveryAcknowledgement };

export async function recoverAndIssueCodexRotatingSetup(input: {
  readonly prisma: PrismaClient;
  readonly repository: CodexRotatingSetupRepository;
  readonly actor: string;
  readonly recoveryRequestId: string;
  readonly acknowledgement: string;
  readonly accountSwitch?: boolean;
}) {
  assertCodexRotatingSetupRepository(input.repository);
  if (process.env.REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED !== "1") {
    throw new Error("codex_rotating_setup_issuance_quiesced");
  }
  const recovery = await recoverCodexRotatingSetup(
    {
      workspaceId: input.repository.workspaceId,
      repositoryId: input.repository.id,
      githubRepositoryId: input.repository.githubRepositoryId!.toString(),
      recoveryRequestId: input.recoveryRequestId,
      actor: input.actor,
      acknowledgement: input.acknowledgement,
      ...(input.accountSwitch !== undefined
        ? { accountSwitch: input.accountSwitch }
        : {}),
    },
    {
      recovery: new PrismaCodexRotatingSetupRecovery(
        input.prisma,
        requireReviewRouterDatabaseRecoveryWitness(),
      ),
    },
  );
  const setup = await issueCodexRotatingSetupForRepository({
    prisma: input.prisma,
    repository: input.repository,
    installerArguments: ["--force-reseed"],
    recovery: {
      requestId: input.recoveryRequestId,
      epoch: recovery.recoveryEpoch,
    },
  });
  return { ...setup, recoveryStatus: recovery.status } as const;
}
