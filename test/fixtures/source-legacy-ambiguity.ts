import { createHash } from "node:crypto";
import {
  sha256Canonical,
  type LegacyAmbiguityEvidence,
} from "../../packages/features/release-rollout/src";

export interface LegacyAmbiguityInventoryFixture {
  readonly activeLeaseIds: readonly string[];
  readonly fetchedSetupIds: readonly string[];
  readonly pendingIntentIds: readonly string[];
  readonly intentStatuses: readonly string[];
}

export function sourceLegacyAmbiguityFixture(input?: {
  rolloutId?: string;
  sourceSystemIdentifier?: string;
  sourceDatabaseName?: string;
  sourceRecoveryWitnessSha256?: string;
  authorityPrincipal?: string;
  fenceId?: string;
  fenceEstablishedAt?: string;
  fencedInventorySha256?: string;
  firstObservedAt?: string;
  eligibilityCutoff?: string;
  inventory?: LegacyAmbiguityInventoryFixture;
}): LegacyAmbiguityEvidence {
  const rolloutId = input?.rolloutId ?? "rollout-test";
  const inventory = input?.inventory ?? {
    activeLeaseIds: [],
    fetchedSetupIds: [],
    pendingIntentIds: [],
    intentStatuses: [],
  };
  const inventorySha256 =
    "sha256:" +
    createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  const unsigned = {
    schemaVersion: 1 as const,
    rolloutId,
    sourceSystemIdentifier: input?.sourceSystemIdentifier ?? "100",
    sourceDatabaseName: input?.sourceDatabaseName ?? "reviewrouter",
    sourceRecoveryWitnessSha256:
      input?.sourceRecoveryWitnessSha256 ?? "b".repeat(64),
    authorityPrincipal: input?.authorityPrincipal ?? "source_admin",
    fenceId: input?.fenceId ?? "source-fence:" + rolloutId,
    fenceEstablishedAt: input?.fenceEstablishedAt ?? "2026-08-15T00:00:00.000Z",
    fencedInventorySha256:
      input?.fencedInventorySha256 ?? "sha256:" + "f".repeat(64),
    inventorySha256,
    ...inventory,
    observations: [
      {
        observedAt: input?.firstObservedAt ?? "2026-08-15T00:00:01.000Z",
        inventorySha256,
      },
      {
        observedAt: input?.eligibilityCutoff ?? "2026-08-15T00:00:02.000Z",
        inventorySha256,
      },
    ] as const,
    eligibilityCutoff: input?.eligibilityCutoff ?? "2026-08-15T00:00:02.000Z",
    stable: true as const,
  };
  return Object.freeze({
    ...unsigned,
    receiptSha256: "sha256:" + sha256Canonical(unsigned),
  });
}
