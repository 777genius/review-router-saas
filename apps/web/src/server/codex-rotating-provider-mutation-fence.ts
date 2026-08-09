import { Prisma } from "@prisma/client";
import { assertCanonicalCodexRotatingProviderId } from "@reviewrouter/features-provider-setup";

type FenceTransaction = Prisma.TransactionClient;

const setupLockRetryIntervalMs = 100;
const setupLockMaxAttempts = 50;

export type CodexRotatingSetupFenceRow = {
  readonly id: string;
  readonly providerInstanceRowId: string;
  readonly providerInstanceId: string;
  readonly mutationEpoch: bigint | null;
};

export async function lockCodexRotatingSetupProvider(
  prisma: FenceTransaction,
  providerInstanceId: string,
): Promise<void> {
  for (let attempt = 1; attempt <= setupLockMaxAttempts; attempt += 1) {
    const rows = await prisma.$queryRaw<
      Array<{ readonly acquired: boolean }>
    >(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended(${`codex-rotating-setup:${providerInstanceId}`}, 0)
      ) AS "acquired"
    `);
    if (rows[0]?.acquired === true) return;
    if (attempt < setupLockMaxAttempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, setupLockRetryIntervalMs),
      );
    }
  }
  throw new Error("codex_rotating_setup_lock_failed");
}

export async function lockCodexRotatingProviderRow(
  prisma: FenceTransaction,
  providerInstanceRowId: string,
): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ readonly id: string }>>`
    SELECT "id" FROM "CodexOAuthProviderInstance"
    WHERE "id" = ${providerInstanceRowId}
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new Error("codex_rotating_provider_not_found");
}

export async function isCodexRotatingSetupFenceOwner(
  prisma: FenceTransaction,
  row: CodexRotatingSetupFenceRow,
): Promise<boolean> {
  if (row.mutationEpoch === null) return false;
  const provider = await prisma.codexOAuthProviderInstance.findUnique({
    where: { id: row.providerInstanceRowId },
    select: {
      providerInstanceId: true,
      repository: { select: { githubRepositoryId: true } },
      mutationEpoch: true,
      mutationOwner: true,
      mutationOwnerId: true,
    },
  });
  if (!provider?.repository.githubRepositoryId) {
    throw new Error("codex_rotating_provider_identity_mismatch");
  }
  assertCanonicalCodexRotatingProviderId({
    providerInstanceId: provider.providerInstanceId,
    githubRepositoryId: provider.repository.githubRepositoryId.toString(),
  });
  return (
    provider.providerInstanceId === row.providerInstanceId &&
    provider.mutationEpoch === row.mutationEpoch &&
    provider.mutationOwner === "setup" &&
    provider.mutationOwnerId === row.id
  );
}

export async function pinCodexRotatingSetupRecovery(
  prisma: FenceTransaction,
  providerInstanceRowId: string,
  manifestId: string,
): Promise<void> {
  await prisma.codexOAuthProviderInstance.update({
    where: { id: providerInstanceRowId },
    data: {
      state: "unknown_auth_state",
      mutationEpoch: { increment: 1 },
      mutationOwner: "recovery",
      mutationOwnerId: manifestId,
    },
  });
}
