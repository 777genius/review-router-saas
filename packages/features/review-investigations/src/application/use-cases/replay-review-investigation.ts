import { canonicalJson } from "../../domain/canonicalization";
import {
  assertInvestigationRevision,
  assertInvestigationScope,
  type ReviewInvestigationRevision,
  type ReviewInvestigationScope,
} from "../../domain/coverage-contract";
import {
  createInvestigationObligation,
  satisfyInvestigationObligation,
  type InvestigationObligation,
} from "../../domain/investigation-obligation";
import {
  createReplayedReviewInvestigation,
  type ReviewInvestigation,
} from "../../domain/review-investigation";
import {
  InvestigationObligationKind,
  InvestigationObligationState,
  ReviewInvestigationState,
} from "../../domain/review-investigation-types";
import {
  toInvestigationReadModel,
  type ReviewInvestigationReadModel,
} from "../investigation-read-model";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationExecutionAuthorityPort } from "../ports/execution-authority-port";
import {
  InvestigationReceiptReplayVerdict,
  type InvestigationReceiptReplayPort,
} from "../ports/investigation-receipt-replay-port";
import {
  InvestigationStoreTransitionKind,
  type InvestigationStorePort,
} from "../ports/investigation-store-port";
import {
  commitOrThrow,
  digestCanonical,
  requireCurrentExecution,
  restoreCommandOrThrow,
  withCurrentDossierDigest,
} from "./investigation-use-case-support";

export type ReplayReviewInvestigationCommand = Readonly<{
  commandId: string;
  sourceInvestigationId: string;
  sourceCertificateHash: string;
  targetScope: ReviewInvestigationScope;
  targetRevision: ReviewInvestigationRevision;
  targetExecutionId: string;
  targetWorkSlotId: string;
}>;

export class ReplayReviewInvestigation {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly replay: InvestigationReceiptReplayPort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
  ) {}

  async execute(
    command: ReplayReviewInvestigationCommand,
  ): Promise<ReviewInvestigationReadModel> {
    const commandHash = await this.digest.digestUtf8(
      canonicalJson({ operation: "replay_review_investigation", command }),
    );
    const restored = await restoreCommandOrThrow({
      store: this.store,
      commandId: command.commandId,
      commandHash,
    });
    if (restored) return toInvestigationReadModel(restored);

    assertInvestigationScope(command.targetScope);
    assertInvestigationRevision(command.targetRevision);

    const source = await this.requireReplayableSource(command);
    await requireCurrentExecution({
      authority: this.authority,
      investigation: {
        scope: command.targetScope,
        revision: command.targetRevision,
        executionId: command.targetExecutionId,
        workSlotId: command.targetWorkSlotId,
        providerVoteLaneId: source.providerVoteLaneId,
      },
    });
    const obligations = await this.replayObligations(source, command);
    const naturalIdentityHash = await digestCanonical(this.digest, {
      scope: { ...command.targetScope },
      revision: { ...command.targetRevision },
      executionId: command.targetExecutionId,
      workSlotId: command.targetWorkSlotId,
      stableReviewUnitKey: source.stableReviewUnitKey,
      providerVoteLaneId: source.providerVoteLaneId,
      coverageContractVersion: source.contract.coverageContractVersion,
      runtimeProfileVersion: source.contract.runtimeProfileVersion,
    });
    const now = this.clock.now().toISOString();
    let target = createReplayedReviewInvestigation({
      investigationId: `investigation-${naturalIdentityHash.slice(0, 32)}`,
      naturalIdentityHash,
      scope: { ...command.targetScope },
      revision: { ...command.targetRevision },
      executionId: command.targetExecutionId,
      workSlotId: command.targetWorkSlotId,
      stableReviewUnitKey: source.stableReviewUnitKey,
      providerVoteLaneId: source.providerVoteLaneId,
      providerStrategyId: source.providerStrategyId,
      runtimeProfile: source.runtimeProfile,
      contract: { ...source.contract },
      policy: { ...source.policy },
      obligations,
      dossierDigest: "0".repeat(64),
      createdAt: now,
      updatedAt: now,
    });
    target = await withCurrentDossierDigest(this.digest, target);
    const committed = await commitOrThrow({
      store: this.store,
      investigation: target,
      expectedVersion: null,
      commandId: command.commandId,
      commandHash,
      transition: { kind: InvestigationStoreTransitionKind.Opened },
    });
    return toInvestigationReadModel(committed);
  }

  private async requireReplayableSource(
    command: ReplayReviewInvestigationCommand,
  ): Promise<ReviewInvestigation> {
    const source = await this.store.findById(command.sourceInvestigationId);
    if (
      source === null ||
      source.certificate === null ||
      source.certificate.certificateHash !== command.sourceCertificateHash ||
      Date.parse(source.certificate.expiresAt) <= this.clock.now().getTime() ||
      ![
        ReviewInvestigationState.Concluded,
        ReviewInvestigationState.Inconclusive,
      ].includes(source.state) ||
      source.revision.reviewRevisionHash ===
        command.targetRevision.reviewRevisionHash ||
      source.scope.workspaceId !== command.targetScope.workspaceId ||
      source.scope.repositoryConnectionId !==
        command.targetScope.repositoryConnectionId ||
      source.scope.scmRepositoryIdentityId !==
        command.targetScope.scmRepositoryIdentityId ||
      source.scope.pullRequestNumber !==
        command.targetScope.pullRequestNumber ||
      source.scope.trustDomain !== command.targetScope.trustDomain ||
      source.scope.authorizationScopeHash !==
        command.targetScope.authorizationScopeHash
    ) {
      throw new Error("investigation_replay_source_invalid");
    }
    return source;
  }

  private async replayObligations(
    source: ReviewInvestigation,
    command: ReplayReviewInvestigationCommand,
  ): Promise<readonly InvestigationObligation[]> {
    const replayed: InvestigationObligation[] = [];
    for (const obligation of source.obligations) {
      let target = createInvestigationObligation({
        obligationId: obligation.obligationId,
        identity: {
          coverageContractVersion: obligation.coverageContractVersion,
          stableReviewUnitKey: obligation.stableReviewUnitKey,
          kind: obligation.kind,
          canonicalSubject: obligation.canonicalSubject,
          canonicalRequirement: obligation.canonicalRequirement,
        },
        riskPriority: obligation.riskPriority,
        origin: obligation.origin,
      });
      if (
        obligation.kind !== InvestigationObligationKind.ContextCritic &&
        obligation.state === InvestigationObligationState.Satisfied &&
        obligation.receipt !== null &&
        obligation.receipt.acceptedAttestationId !== null &&
        obligation.receipt.acceptedAttestationHash !== null &&
        obligation.receipt.operationReceiptIds.length > 0
      ) {
        const result = await this.replay.replay({
          sourceInvestigationId: source.investigationId,
          sourceCertificateHash: command.sourceCertificateHash,
          obligation,
          sourceReceipt: obligation.receipt,
          targetRevision: command.targetRevision,
          gatewayPolicyVersion: source.contract.gatewayPolicyVersion,
        });
        if (result.verdict === InvestigationReceiptReplayVerdict.Matched) {
          target = satisfyInvestigationObligation({
            obligation: target,
            receipt: result.targetReceipt,
            reviewRevisionHash: command.targetRevision.reviewRevisionHash,
            gatewayPolicyVersion: source.contract.gatewayPolicyVersion,
          });
        }
      }
      replayed.push(target);
    }
    return replayed;
  }
}
