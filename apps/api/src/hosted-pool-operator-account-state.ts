import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  PrismaHostedAccountRepository,
  hostedAccountId,
  setHostedAccountAvailability,
} from "@reviewrouter/features-hosted-account-pool";

/** Keep invalid-auth provenance in the existing audit ledger, atomically with pause CAS.
 * A later encrypted generation is required before such a pause can be resumed.
 */
export async function setOperatorHostedAccountState(input: {
  readonly prisma: PrismaClient;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly operatorId: string;
  readonly expectedHealthVersion: number;
  readonly action: "pause" | "resume";
}) {
  return input.prisma.$transaction(async (tx) => {
    const row = await tx.hostedCodexAccount.findFirst({
      where: {
        id: input.accountId,
        workspaceId: input.workspaceId,
        tombstonedAt: null,
        pool: {
          workspaceId: input.workspaceId,
          isDefault: true,
          status: "active",
          tombstonedAt: null,
        },
      },
      select: { state: true, activeGeneration: true },
    });
    if (!row?.activeGeneration)
      throw new Error("hosted_pool_operator_forbidden");
    const invalidPause = await tx.auditEvent.findFirst({
      where: {
        workspaceId: input.workspaceId,
        targetType: "hosted_codex_account",
        targetId: input.accountId,
        action: "hosted_pool.operator_pause_requires_relogin",
        metadata: {
          path: ["generation"],
          equals: row.activeGeneration.toString(),
        },
      },
      select: { id: true },
    });
    if (input.action === "resume" && (row.state !== "paused" || invalidPause))
      throw new Error("hosted_pool_resume_requires_relogin");
    const updated = await setHostedAccountAvailability(
      {
        accountId: hostedAccountId(input.accountId),
        expectedHealthVersion: input.expectedHealthVersion,
        availability:
          input.action === "pause"
            ? { status: "paused", reason: "Paused by operator" }
            : { status: "healthy" },
        now: new Date(),
      },
      new PrismaHostedAccountRepository(tx),
    );
    await tx.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actor: input.operatorId,
        targetType: "hosted_codex_account",
        targetId: input.accountId,
        action:
          input.action === "pause" &&
          (invalidPause ||
            !["healthy", "paused", "cooldown"].includes(row.state))
            ? "hosted_pool.operator_pause_requires_relogin"
            : `hosted_pool.operator_${input.action}`,
        metadata: {
          generation: row.activeGeneration.toString(),
          healthVersion: updated.healthVersion,
        },
      },
    });
    return {
      accountId: updated.id,
      healthVersion: updated.healthVersion,
      availability: updated.availability.status,
    };
  });
}
