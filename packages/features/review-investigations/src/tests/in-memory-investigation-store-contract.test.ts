import { defineInvestigationStoreContract } from "../testing/investigation-store-contract";
import {
  createInvestigationLeaseBindingSeed,
  createInvestigationLeaseStoreContractCandidate,
  defineInvestigationLeaseStoreContract,
} from "../testing/investigation-lease-store-contract";
import { InMemoryInvestigationStore } from "../infrastructure/memory/in-memory-investigation-store";
import {
  InvestigationStoreTransitionKind,
  type InvestigationStorePort,
} from "../application/ports/investigation-store-port";
import type { CreateReviewInvestigationLeaseInput } from "../domain/investigation-lease";
import { ReviewInvestigationLeaseState } from "../domain/investigation-lease";
import { abortInvestigationTurn } from "../domain/review-investigation";
import { ReviewInvestigationAbortReason } from "../domain/review-investigation-types";
import { describe, expect, it } from "vitest";

defineInvestigationStoreContract("InMemoryInvestigationStore", async () => {
  const store = new InMemoryInvestigationStore();
  return {
    store,
    async restart() {
      return InMemoryInvestigationStore.fromSnapshot(store.exportSnapshot());
    },
    async dispose() {},
  };
});

defineInvestigationLeaseStoreContract(
  "InMemoryInvestigationStore",
  async () => {
    const store = new InMemoryInvestigationStore();
    return {
      store,
      seedBinding: (candidate) => seedBinding(store, candidate),
      async restart() {
        return InMemoryInvestigationStore.fromSnapshot(store.exportSnapshot());
      },
      async dispose() {},
    };
  },
);

describe("InMemoryInvestigationStore shadow lease binding", () => {
  it("revokes the active lease atomically when its turn is superseded", async () => {
    const store = new InMemoryInvestigationStore();
    const candidate = createInvestigationLeaseStoreContractCandidate("stale");
    await seedBinding(store, candidate);
    const acquired = await store.acquireLease(candidate);
    const current = await store.findById(candidate.investigationId);
    const superseded = abortInvestigationTurn({
      investigation: current!,
      abort: {
        turnId: candidate.turnId,
        reason: ReviewInvestigationAbortReason.SupersededExecution,
        nextEligibleAt: null,
      },
      abortedAt: "2026-08-05T10:00:30.000Z",
    });
    await store.commit({
      investigation: superseded,
      expectedVersion: current!.version,
      commandId: "abort-stale-lease",
      commandHash: "c".repeat(64),
      transition: {
        kind: InvestigationStoreTransitionKind.TurnAborted,
        turnId: candidate.turnId,
        reason: ReviewInvestigationAbortReason.SupersededExecution,
      },
    });

    await expect(
      store.findLease(acquired.lease!.leaseId),
    ).resolves.toMatchObject({ state: ReviewInvestigationLeaseState.Revoked });
  });
});

async function seedBinding(
  store: InvestigationStorePort,
  candidate: Omit<CreateReviewInvestigationLeaseInput, "fencingToken">,
): Promise<void> {
  const { base, planned } = createInvestigationLeaseBindingSeed(candidate);
  await store.commit({
    investigation: base,
    expectedVersion: null,
    commandId: `open-${candidate.investigationId}`,
    commandHash: "a".repeat(64),
    transition: { kind: InvestigationStoreTransitionKind.Opened },
  });
  await store.commit({
    investigation: planned,
    expectedVersion: base.version,
    commandId: `plan-${candidate.investigationId}`,
    commandHash: "b".repeat(64),
    transition: {
      kind: InvestigationStoreTransitionKind.TurnPlanned,
      turnId: candidate.turnId,
    },
  });
}
