import type { PrismaClient } from "@prisma/client";

type HostedAccountCooldownPrismaClient = Pick<
  PrismaClient,
  "hostedCodexAccount"
>;

type HostedAccountHealthSnapshot = {
  readonly state: string;
  readonly cooldownUntil: Date | null;
  readonly healthVersion: bigint;
};

export async function normalizeExpiredHostedAccountCooldownWithCas(
  prisma: HostedAccountCooldownPrismaClient,
  input: {
    readonly accountId: string;
    readonly now: Date;
    readonly snapshot?: HostedAccountHealthSnapshot;
  },
): Promise<boolean> {
  let snapshot = input.snapshot ?? (await readHealth(prisma, input.accountId));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!snapshot) return false;
    if (snapshot.state === "healthy") return true;
    if (
      snapshot.state !== "cooldown" ||
      snapshot.cooldownUntil === null ||
      snapshot.cooldownUntil > input.now
    ) {
      return false;
    }
    try {
      const normalized = await prisma.hostedCodexAccount.updateMany({
        where: {
          id: input.accountId,
          state: "cooldown",
          cooldownUntil: { lte: input.now },
          healthVersion: snapshot.healthVersion,
        },
        data: {
          state: "healthy",
          cooldownUntil: null,
          healthVersion: snapshot.healthVersion + 1n,
          lastHealthyAt: input.now,
          updatedAt: input.now,
        },
      });
      if (normalized.count === 1) return true;
    } catch (error) {
      if (!isHostedAccountTransactionWriteConflict(error)) throw error;
    }
    snapshot = await readHealth(prisma, input.accountId);
  }
  return snapshot?.state === "healthy";
}

export function isHostedAccountTransactionWriteConflict(
  error: unknown,
): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly cause?: { readonly kind?: unknown };
  };
  return (
    candidate.code === "P2034" ||
    candidate.cause?.kind === "TransactionWriteConflict" ||
    (typeof candidate.message === "string" &&
      candidate.message.includes("TransactionWriteConflict"))
  );
}

function readHealth(
  prisma: HostedAccountCooldownPrismaClient,
  accountId: string,
): Promise<HostedAccountHealthSnapshot | null> {
  return prisma.hostedCodexAccount.findUnique({
    where: { id: accountId },
    select: { state: true, cooldownUntil: true, healthVersion: true },
  });
}
