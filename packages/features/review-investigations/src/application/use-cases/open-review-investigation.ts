import { canonicalJson } from "../../domain/canonicalization";
import type {
  ReviewInvestigationContract,
  ReviewInvestigationRevision,
  ReviewInvestigationScope,
  SeedInvestigationObligation,
} from "../../domain/coverage-contract";
import {
  createInvestigationObligation,
  InvestigationObligationOrigin,
  obligationIdentity,
  satisfyInvestigationObligation,
  type InvestigationEvidenceReceipt,
} from "../../domain/investigation-obligation";
import type { ReviewInvestigationPolicy } from "../../domain/investigation-policy";
import { createReviewInvestigation } from "../../domain/review-investigation";
import type { ReviewInvestigationRuntimeProfile } from "../../domain/review-investigation-types";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationExecutionAuthorityPort } from "../ports/execution-authority-port";
import {
  InvestigationStoreTransitionKind,
  type InvestigationStorePort,
} from "../ports/investigation-store-port";
import {
  toInvestigationReadModel,
  type ReviewInvestigationReadModel,
} from "../investigation-read-model";
import {
  commitOrThrow,
  digestCanonical,
  requireCurrentExecution,
  restoreCommandOrThrow,
  withCurrentDossierDigest,
} from "./investigation-use-case-support";

export type OpenReviewInvestigationCommand = Readonly<{
  commandId: string;
  scope: ReviewInvestigationScope;
  revision: ReviewInvestigationRevision;
  executionId: string;
  workSlotId: string;
  stableReviewUnitKey: string;
  providerVoteLaneId: string;
  providerStrategyId: string;
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
    private readonly clock: InvestigationClockPort,
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
    await requireCurrentExecution({ authority: this.authority, investigation: command });
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
    const receipts = new Map(
      command.initialReceipts.map((receipt) => [receipt.canonicalSubject, receipt]),
    );
    const obligations = await Promise.all(
      command.seedObligations.map(async (seed) => {
        const identity = obligationIdentity({
          coverageContractVersion: command.contract.coverageContractVersion,
          stableReviewUnitKey: command.stableReviewUnitKey,
          kind: seed.kind,
          canonicalSubject: seed.canonicalSubject,
          canonicalRequirement: seed.canonicalRequirement,
        });
        let obligation = createInvestigationObligation({
          obligationId: await digestCanonical(this.digest, { ...identity }),
          identity,
          riskPriority: seed.riskPriority,
          origin: InvestigationObligationOrigin.CoverageContract,
        });
        const receipt = receipts.get(seed.canonicalSubject);
        if (receipt) {
          obligation = satisfyInvestigationObligation({
            obligation,
            receipt,
            reviewRevisionHash: command.revision.reviewRevisionHash,
            gatewayPolicyVersion: command.contract.gatewayPolicyVersion,
          });
        }
        return obligation;
      }),
    );
    const now = this.clock.now().toISOString();
    let investigation = createReviewInvestigation({
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
      obligations,
      dossierDigest: "0".repeat(64),
      createdAt: now,
      updatedAt: now,
    });
    investigation = await withCurrentDossierDigest(this.digest, investigation);
    const committed = await commitOrThrow({
      store: this.store,
      investigation,
      expectedVersion: null,
      commandId: command.commandId,
      commandHash,
      transition: { kind: InvestigationStoreTransitionKind.Opened },
    });
    return toInvestigationReadModel(committed);
  }
}
