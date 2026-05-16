import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  MemoryTransactionPort,
  MemoryTransactionalPorts,
} from "../../application/ports/memory-transaction-port";
import { PrismaMemoryAudit } from "./prisma-memory-audit";
import { PrismaMemoryItemRepository } from "./prisma-memory-item-repository";
import { PrismaMemoryOutbox } from "./prisma-memory-outbox";
import { PrismaMemorySuggestionRepository } from "./prisma-memory-suggestion-repository";

export class PrismaMemoryTransaction implements MemoryTransactionPort {
  constructor(private readonly prisma: PrismaClient) {}

  async run<T>(
    work: (ports: MemoryTransactionalPorts) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) =>
      work(createMemoryTxPorts(tx)),
    );
  }
}

function createMemoryTxPorts(
  tx: Prisma.TransactionClient,
): MemoryTransactionalPorts {
  return {
    memoryItems: new PrismaMemoryItemRepository(tx),
    memorySuggestions: new PrismaMemorySuggestionRepository(tx),
    memoryAudit: new PrismaMemoryAudit(tx),
    memoryOutbox: new PrismaMemoryOutbox(tx),
  };
}
