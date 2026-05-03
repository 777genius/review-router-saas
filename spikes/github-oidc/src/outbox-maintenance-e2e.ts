import {
  OutboxHandlerError,
  PrismaOutboxEventRepository,
  enqueueOutboxEvent,
  listWorkspaceOutboxFailures,
  processOutboxBatch,
  retryDeadLetterOutboxEvent,
  type OutboxHandler,
} from "../../../packages/features/outbox/src/index.ts";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";

const prisma = createPrismaClient();
const outbox = new PrismaOutboxEventRepository(prisma);
const now = new Date();
const e2eId = `outbox-maintenance-e2e-${Date.now()}`;
const workspaceId = `workspace-${e2eId}`;
const clock = { now: () => now };
const prefix = `${e2eId}:`;

try {
  await enqueueOutboxEvent(
    {
      type: "outbox.e2e",
      version: 1,
      idempotencyKey: `${prefix}dead-letter`,
      workspaceId,
      payload: { purpose: "manual retry e2e" },
      maxAttempts: 3,
      occurredAt: now,
    },
    { outbox },
  );

  const permanentFailureHandler: OutboxHandler = {
    type: "outbox.e2e",
    version: 1,
    handle: async () => {
      throw new OutboxHandlerError(
        "Permanent test failure",
        "e2e_permanent_failure",
        false,
      );
    },
  };

  const deadLetterResult = await processOutboxBatch(
    { limit: 5, handlers: [permanentFailureHandler] },
    { outbox, clock },
  );
  if (deadLetterResult.deadLettered !== 1) {
    throw new Error(
      `expected dead letter, got ${JSON.stringify(deadLetterResult)}`,
    );
  }

  const failures = await listWorkspaceOutboxFailures(
    { workspaceId, limit: 5 },
    { outbox },
  );
  const deadLetter = failures.find((event) => event.status === "dead_letter");
  if (!deadLetter) {
    throw new Error("dead-letter event was not listed");
  }

  const retryResult = await retryDeadLetterOutboxEvent(
    { workspaceId, eventId: deadLetter.id },
    { outbox, clock },
  );
  if (retryResult.status !== "queued") {
    throw new Error(
      `expected queued retry, got ${JSON.stringify(retryResult)}`,
    );
  }

  const successHandler: OutboxHandler = {
    type: "outbox.e2e",
    version: 1,
    handle: async () => undefined,
  };
  const retriedResult = await processOutboxBatch(
    { limit: 5, handlers: [successHandler] },
    { outbox, clock },
  );
  if (retriedResult.processed !== 1) {
    throw new Error(
      `expected retried event processed, got ${JSON.stringify(retriedResult)}`,
    );
  }

  await prisma.outboxEvent.create({
    data: {
      type: "outbox.e2e",
      version: 1,
      idempotencyKey: `${prefix}stale-processing`,
      workspaceId,
      payload: { purpose: "stale processing e2e" },
      status: "processing",
      attempts: 1,
      maxAttempts: 3,
      occurredAt: now,
      updatedAt: new Date(now.getTime() - 120_000),
    },
  });

  const staleResult = await processOutboxBatch(
    { limit: 5, processingStaleAfterMs: 60_000, handlers: [successHandler] },
    { outbox, clock },
  );
  if (staleResult.recoveredStale !== 1 || staleResult.processed !== 1) {
    throw new Error(
      `expected stale recovery + process, got ${JSON.stringify(staleResult)}`,
    );
  }

  const remainingFailures = await listWorkspaceOutboxFailures(
    { workspaceId, limit: 5 },
    { outbox },
  );
  if (remainingFailures.length !== 0) {
    throw new Error(
      `expected no remaining failures, got ${JSON.stringify(remainingFailures)}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspaceId,
        deadLetterResult,
        retriedResult,
        staleResult,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.outboxEvent.deleteMany({
    where: { idempotencyKey: { startsWith: prefix } },
  });
  await prisma.$disconnect();
}
