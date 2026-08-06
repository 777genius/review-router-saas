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
import { createReviewInvestigation } from "../../domain/review-investigation";
import type { ReviewInvestigationRuntimeProfile } from "../../domain/review-investigation-types";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationExecutionAuthorityPort } from "../ports/execution-authority-port";
import type { InvestigationManifestIdentityPort } from "../ports/investigation-manifest-identity-port";
import {
  InvestigationStoreTransitionKind,
  type InvestigationStorePort,
} from "../ports/investigation-store-port";
import {
  toInvestigationReadModel,
  type ReviewInvestigationReadModel,
} from "../investigation-read-model";
import {
  admitInvestigationManifest,
  commitOrThrow,
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
    const privateMaterials = await prepareInvestigationSeedPrivateMaterials({
      investigation,
      privateQueries: seed.privateQueries,
      preparer: this.privateMaterial,
    });
    const committed = await commitOrThrow({
      store: this.store,
      investigation,
      expectedVersion: null,
      commandId: command.commandId,
      commandHash,
      transition: { kind: InvestigationStoreTransitionKind.Opened },
      privateMaterials,
    });
    return toInvestigationReadModel(committed);
  }
}
