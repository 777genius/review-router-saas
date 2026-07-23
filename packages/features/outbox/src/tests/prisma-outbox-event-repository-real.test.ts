import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { PrismaOutboxEventRepository } from "../infrastructure/prisma/prisma-outbox-event-repository";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("Prisma outbox fenced claims", () => {
  let prisma: PrismaClient;
  const prefix = `outbox-fence-${randomUUID()}`;
  const definition = { type: "outbox.fencing.test", version: 1 };

  beforeAll(() => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 5 });
  });

  afterAll(async () => {
    await prisma?.outboxEvent.deleteMany({
      where: { idempotencyKey: { startsWith: prefix } },
    });
    await prisma?.$disconnect();
  });

  it("rejects stale completion after an expired claim is taken over", async () => {
    const outbox = new PrismaOutboxEventRepository(prisma);
    await outbox.enqueue({
      type: definition.type,
      version: definition.version,
      idempotencyKey: `${prefix}-race`,
      payload: {},
      occurredAt: new Date(),
    });
    const [oldClaim] = await outbox.claimDue({
      limit: 1,
      now: new Date(),
      claimOwnerHash: "old-owner",
      claimForMs: 60_000,
      availableHandlers: [definition],
      knownHandlers: [definition],
    });
    expect(oldClaim?.claimVersion).not.toBeNull();

    await expect(
      outbox.renewClaim({
        claimId: oldClaim!.claimId!,
        claimVersion: oldClaim!.claimVersion!,
        claimOwnerHash: "old-owner",
        claimUntil: new Date(Date.now() - 1_000),
      }),
    ).resolves.toEqual({ status: "applied" });
    const recoveryNow = new Date();
    await expect(
      outbox.recoverStaleProcessing({
        now: recoveryNow,
        legacyStaleBefore: new Date(0),
        nextAttemptAt: new Date(recoveryNow.getTime() - 1_000),
        limit: 1,
        errorCode: "processing_stale",
        safeErrorSummary: "expired test claim",
      }),
    ).resolves.toEqual({ recovered: 1 });

    const [newClaim] = await outbox.claimDue({
      limit: 1,
      now: new Date(),
      claimOwnerHash: "new-owner",
      claimForMs: 60_000,
      availableHandlers: [definition],
      knownHandlers: [definition],
    });
    expect(newClaim!.claimVersion! > oldClaim!.claimVersion!).toBe(true);
    await expect(
      outbox.markProcessed({
        id: oldClaim!.id,
        claimId: oldClaim!.claimId!,
        claimVersion: oldClaim!.claimVersion!,
        processedAt: new Date(),
      }),
    ).resolves.toEqual({ status: "stale_claim" });
    await expect(
      outbox.markProcessed({
        id: newClaim!.id,
        claimId: newClaim!.claimId!,
        claimVersion: newClaim!.claimVersion!,
        processedAt: new Date(),
      }),
    ).resolves.toEqual({ status: "applied" });
  });

  it("restores only an identical idempotency envelope", async () => {
    const outbox = new PrismaOutboxEventRepository(prisma);
    const event = {
      type: definition.type,
      version: definition.version,
      idempotencyKey: `${prefix}-idempotency`,
      workspaceId: "workspace-test",
      payload: { nested: { right: 2, left: 1 } },
      occurredAt: new Date(),
    };
    await expect(outbox.enqueue(event)).resolves.toEqual({ created: true });
    await expect(
      outbox.enqueue({
        ...event,
        payload: { nested: { left: 1, right: 2 } },
      }),
    ).resolves.toEqual({ created: false });
    await expect(
      outbox.enqueue({ ...event, payload: { nested: { left: 1 } } }),
    ).rejects.toThrow("outbox_idempotency_conflict");
  });

  it("database guard rejects an unfenced legacy processing transition", async () => {
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.outboxFencingControl.update({
          where: { id: 1 },
          data: {
            enabled: true,
            activatedAt: new Date(),
            activatedBy: "outbox-fencing-test",
          },
        });
        const event = await transaction.outboxEvent.create({
          data: {
            type: definition.type,
            version: definition.version,
            idempotencyKey: `${prefix}-guard`,
            payload: {},
            occurredAt: new Date(),
          },
        });
        await transaction.outboxEvent.update({
          where: { id: event.id },
          data: { status: "processing" },
        });
      }),
    ).rejects.toThrow(/outbox_unfenced_claim/);
  });
});
