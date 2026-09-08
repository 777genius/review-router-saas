import { InvestigationExecutionAuthorityVerdict } from "../ports/execution-authority-port";
import { canonicalJson } from "../../domain/canonicalization";
import type {
  ReviewInvestigationContract,
  ReviewInvestigationRevision,
  ReviewInvestigationScope,
  SeedInvestigationObligation,
} from "../../domain/coverage-contract";
import {
  VersionedCoverageSeedPolicy,
  type CoverageSeedPolicy,
} from "../../domain/coverage-policies";
import type { InvestigationEvidenceReceipt } from "../../domain/investigation-obligation";
import type { ReviewInvestigationPolicy } from "../../domain/investigation-policy";
import { createReviewInvestigation, type ReviewInvestigation } from "../../domain/review-investigation";
import type { ReviewInvestigationRuntimeProfile } from "../../domain/review-investigation-types";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationExecutionAuthorityPort } from "../ports/execution-authority-port";
import type { InvestigationManifestIdentityPort } from "../ports/investigation-manifest-identity-port";
import {
  InvestigationStoreTransitionKind,
  InvestigationStoreCommitStatus,
  InvestigationStoreCommitGuardKind,
  type InvestigationStoreCommitResult,
  type InvestigationStorePort,
} from "../ports/investigation-store-port";
import {
  toInvestigationReadModel,
  type ReviewInvestigationReadModel,
} from "../investigation-read-model";
import {
  admitInvestigationManifest,
  digestCanonical,
  requireCurrentExecution,
  restoreCommandOrThrow,
  withCurrentDossierDigest,
} from "./investigation-use-case-support";
import {
  prepareInvestigationSeed,
  prepareInvestigationSeedPrivateMaterials,
} from "./investigation-seed-support";
import { PrepareInvestigationSearchQueryPrivateMaterial } from "./prepare-investigation-search-query-private-material";

export type OpenReviewInvestigationCommand = Readonly<{
  commandId: string;
  scope: ReviewInvestigationScope;
  revision: ReviewInvestigationRevision;
  executionId: string;
  workSlotId: string;
  stableReviewUnitKey: string;
  providerVoteLaneId: string;
  providerStrategyId: string;
  investigationManifestCanonicalJson?: string;
  investigationManifestHash?: string;
  runtimeProfile: ReviewInvestigationRuntimeProfile;
  contract: ReviewInvestigationContract;
  policy: ReviewInvestigationPolicy;
  seedObligations: readonly SeedInvestigationObligation[];
  initialReceipts: readonly InvestigationEvidenceReceipt[];
}>;

export class OpenReviewInvestigation {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly digest: InvestigationDigestPort,
    private readonly manifestIdentity: InvestigationManifestIdentityPort,
    private readonly clock: InvestigationClockPort,
    private readonly coverageSeedPolicy: CoverageSeedPolicy = new VersionedCoverageSeedPolicy(),
    private readonly privateMaterial?: PrepareInvestigationSearchQueryPrivateMaterial,
  ) {}

  async execute(
    command: OpenReviewInvestigationCommand,
  ): Promise<ReviewInvestigationReadModel> {
    const commandHash = await this.digest.digestUtf8(
      canonicalJson({
        operation: "open_review_investigation",
        command: {
          ...command,
          seedObligations: command.seedObligations.map((item) => ({ ...item })),
          initialReceipts: command.initialReceipts.map((item) => ({ ...item })),
        },
      }),
    );
    const restored = await restoreCommandOrThrow({
      store: this.store,
      commandId: command.commandId,
      commandHash,
    });
    if (restored) return toInvestigationReadModel(restored);
    const admittedManifest =
      command.investigationManifestCanonicalJson === undefined &&
      command.investigationManifestHash === undefined
        ? null
        : await admitInvestigationManifest({
            canonicalJson: command.investigationManifestCanonicalJson ?? "",
            hash: command.investigationManifestHash ?? "",
            identity: this.manifestIdentity,
          });
    await requireCurrentExecution({
      authority: this.authority,
      investigation: command,
    });
    const naturalIdentityHash = await digestCanonical(this.digest, {
      scope: { ...command.scope },
      revision: { ...command.revision },
      executionId: command.executionId,
      workSlotId: command.workSlotId,
      stableReviewUnitKey: command.stableReviewUnitKey,
      providerVoteLaneId: command.providerVoteLaneId,
      coverageContractVersion: command.contract.coverageContractVersion,
      runtimeProfileVersion: command.contract.runtimeProfileVersion,
    });
    const seed = await prepareInvestigationSeed({
      contract: command.contract,
      revision: command.revision,
      stableReviewUnitKey: command.stableReviewUnitKey,
      seedObligations: command.seedObligations,
      initialReceipts: command.initialReceipts,
      coverageSeedPolicy: this.coverageSeedPolicy,
      digest: this.digest,
    });
    const now = this.clock.now().toISOString();
    let investigation = createReviewInvestigation(
      {
        investigationId: `investigation-${naturalIdentityHash.slice(0, 32)}`,
        naturalIdentityHash,
        scope: { ...command.scope },
        revision: { ...command.revision },
        executionId: command.executionId,
        workSlotId: command.workSlotId,
        stableReviewUnitKey: command.stableReviewUnitKey,
        providerVoteLaneId: command.providerVoteLaneId,
        providerStrategyId: command.providerStrategyId,
        runtimeProfile: command.runtimeProfile,
        contract: { ...command.contract },
        policy: { ...command.policy },
        obligations: seed.obligations,
        dossierDigest: "0".repeat(64),
        createdAt: now,
        updatedAt: now,
      },
      admittedManifest,
    );
    investigation = await withCurrentDossierDigest(this.digest, investigation);
    const adopt = async (existing: ReviewInvestigation) => {
      assertCompatibleOpen(existing, investigation);
      return openedResult(await this.store.adopt({
        investigation: existing,
        expectedVersion: existing.version,
        commandId: command.commandId,
        commandHash,
        requireCurrentExecution: () => requireCurrentExecution({
          authority: this.authority, investigation: existing,
        }),
      }));
    };
    const existing = await this.store.findByNaturalIdentity(naturalIdentityHash);
    if (existing) return toInvestigationReadModel(await adopt(existing));
    const privateMaterials = await prepareInvestigationSeedPrivateMaterials({
      investigation,
      privateQueries: seed.privateQueries,
      preparer: this.privateMaterial,
    });
    const committed = await this.store.commit({
      investigation,
      expectedVersion: null,
      commandId: command.commandId,
      commandHash,
      transition: { kind: InvestigationStoreTransitionKind.Opened },
      privateMaterials,
      guard: {
        kind: InvestigationStoreCommitGuardKind.ExecutionAuthority,
        expectedVerdict: InvestigationExecutionAuthorityVerdict.Current,
        requireCurrentExecution: () => requireCurrentExecution({
          authority: this.authority, investigation,
        }),
      },
    });
    // One reconciliation, exclusively after a losing create with an existing
    // natural identity. Adoption version conflicts are never retried.
    if (committed.status === InvestigationStoreCommitStatus.ConcurrencyConflict) {
      const winner = await this.store.findByNaturalIdentity(naturalIdentityHash);
      if (winner) return toInvestigationReadModel(await adopt(winner));
    }
    return toInvestigationReadModel(openedResult(committed));
  }
}

function openedResult(result: InvestigationStoreCommitResult): ReviewInvestigation {
  if (result.status === InvestigationStoreCommitStatus.Committed ||
      result.status === InvestigationStoreCommitStatus.Restored) {
    if (!result.investigation) throw new Error("store_snapshot_missing");
    return result.investigation;
  }
  if (result.status === InvestigationStoreCommitStatus.IdempotencyConflict) {
    throw new Error("investigation_idempotency_conflict");
  }
  if (result.status === InvestigationStoreCommitStatus.LeaseFenceConflict) {
    throw new Error("investigation_lease_fencing_stale");
  }
  throw new Error("investigation_concurrency_conflict");
}

function assertCompatibleOpen(existing: ReviewInvestigation, seed: ReviewInvestigation): void {
  const identity = (item: ReviewInvestigation) => ({
    naturalIdentityHash: item.naturalIdentityHash,
    scope: { ...item.scope }, revision: { ...item.revision },
    executionId: item.executionId, workSlotId: item.workSlotId,
    stableReviewUnitKey: item.stableReviewUnitKey,
    providerVoteLaneId: item.providerVoteLaneId,
    providerStrategyId: item.providerStrategyId,
    runtimeProfile: item.runtimeProfile,
    contract: { ...item.contract }, policy: { ...item.policy },
    investigationManifestCanonicalJson: item.investigationManifestCanonicalJson,
    investigationManifestHash: item.investigationManifestHash,
  });
  if (canonicalJson(identity(existing)) !== canonicalJson(identity(seed))) {
    throw new Error("investigation_open_identity_conflict");
  }
  for (const obligation of seed.obligations) {
    const current = existing.obligations.find(item => item.obligationId === obligation.obligationId);
    if (!current || current.coverageContractVersion !== obligation.coverageContractVersion ||
        current.stableReviewUnitKey !== obligation.stableReviewUnitKey ||
        current.kind !== obligation.kind || current.canonicalSubject !== obligation.canonicalSubject ||
        current.canonicalRequirement !== obligation.canonicalRequirement ||
        current.riskPriority < obligation.riskPriority ||
        current.origin !== obligation.origin ||
        (obligation.receipt !== null && canonicalJson(current.receipt) !== canonicalJson(obligation.receipt))) {
      throw new Error("investigation_open_seed_conflict");
    }
  }
}
