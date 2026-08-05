import { canonicalJson } from "../../domain/canonicalization";
import {
  assertInvestigationRevision,
  assertInvestigationScope,
  type ReviewInvestigationRevision,
  type ReviewInvestigationScope,
  type SeedInvestigationObligation,
} from "../../domain/coverage-contract";
import {
  VersionedCoverageSeedPolicy,
  type CoverageSeedPolicy,
} from "../../domain/coverage-policies";
import {
  satisfyInvestigationObligation,
  type InvestigationEvidenceReceipt,
  type InvestigationObligation,
} from "../../domain/investigation-obligation";
import type { ReviewInvestigationPolicy } from "../../domain/investigation-policy";
import {
  createReplayedReviewInvestigation,
  type ReviewInvestigation,
} from "../../domain/review-investigation";
import { isVerifiedCleanReplaySource } from "../../domain/review-investigation-replay-policy";
import {
  InvestigationObligationKind,
  InvestigationObligationState,
  type ReviewInvestigationRuntimeProfile,
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
import type { PrepareInvestigationSearchQueryPrivateMaterial } from "./prepare-investigation-search-query-private-material";

export type ReplayReviewInvestigationCommand = Readonly<{
  commandId: string;
  sourceInvestigationId: string;
  sourceCertificateHash: string;
  targetScope: ReviewInvestigationScope;
  targetRevision: ReviewInvestigationRevision;
  targetExecutionId: string;
  targetWorkSlotId: string;
  targetStableReviewUnitKey: string;
  targetProviderVoteLaneId: string;
  targetProviderStrategyId: string;
  targetInvestigationManifestCanonicalJson?: string;
  targetInvestigationManifestHash?: string;
  targetRuntimeProfile: ReviewInvestigationRuntimeProfile;
  targetContract: ReviewInvestigation["contract"];
  targetPolicy: ReviewInvestigationPolicy;
  targetSeedObligations: readonly SeedInvestigationObligation[];
  targetInitialReceipts: readonly InvestigationEvidenceReceipt[];
  replayProofs: readonly Readonly<{
    obligationId: string;
    replayProofId: string;
  }>[];
}>;

export class ReplayReviewInvestigation {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly replay: InvestigationReceiptReplayPort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
    private readonly coverageSeedPolicy: CoverageSeedPolicy = new VersionedCoverageSeedPolicy(),
    private readonly privateMaterial?: PrepareInvestigationSearchQueryPrivateMaterial,
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
    const admittedManifest =
      command.targetInvestigationManifestCanonicalJson === undefined &&
      command.targetInvestigationManifestHash === undefined
        ? null
        : await admitInvestigationManifest({
            canonicalJson:
              command.targetInvestigationManifestCanonicalJson ?? "",
            hash: command.targetInvestigationManifestHash ?? "",
            digest: this.digest,
          });

    await requireCurrentExecution({
      authority: this.authority,
      investigation: {
        scope: command.targetScope,
        revision: command.targetRevision,
        executionId: command.targetExecutionId,
        workSlotId: command.targetWorkSlotId,
        providerVoteLaneId: command.targetProviderVoteLaneId,
      },
    });
    const source = await this.requireReplayableSource(command);
    const seed = await prepareInvestigationSeed({
      contract: command.targetContract,
      revision: command.targetRevision,
      stableReviewUnitKey: command.targetStableReviewUnitKey,
      seedObligations: command.targetSeedObligations,
      initialReceipts: command.targetInitialReceipts,
      coverageSeedPolicy: this.coverageSeedPolicy,
      digest: this.digest,
    });
    const obligations = await this.replayObligations(
      source,
      command,
      seed.obligations,
    );
    const naturalIdentityHash = await digestCanonical(this.digest, {
      scope: { ...command.targetScope },
      revision: { ...command.targetRevision },
      executionId: command.targetExecutionId,
      workSlotId: command.targetWorkSlotId,
      stableReviewUnitKey: command.targetStableReviewUnitKey,
      providerVoteLaneId: command.targetProviderVoteLaneId,
      coverageContractVersion: command.targetContract.coverageContractVersion,
      runtimeProfileVersion: command.targetContract.runtimeProfileVersion,
    });
    const now = this.clock.now().toISOString();
    let target = createReplayedReviewInvestigation(
      {
        investigationId: `investigation-${naturalIdentityHash.slice(0, 32)}`,
        naturalIdentityHash,
        scope: { ...command.targetScope },
        revision: { ...command.targetRevision },
        executionId: command.targetExecutionId,
        workSlotId: command.targetWorkSlotId,
        stableReviewUnitKey: command.targetStableReviewUnitKey,
        providerVoteLaneId: command.targetProviderVoteLaneId,
        providerStrategyId: command.targetProviderStrategyId,
        runtimeProfile: command.targetRuntimeProfile,
        contract: { ...command.targetContract },
        policy: { ...command.targetPolicy },
        obligations,
        dossierDigest: "0".repeat(64),
        createdAt: now,
        updatedAt: now,
      },
      admittedManifest,
    );
    target = await withCurrentDossierDigest(this.digest, target);
    const privateMaterials = await prepareInvestigationSeedPrivateMaterials({
      investigation: target,
      privateQueries: seed.privateQueries,
      preparer: this.privateMaterial,
    });
    const committed = await commitOrThrow({
      store: this.store,
      investigation: target,
      expectedVersion: null,
      commandId: command.commandId,
      commandHash,
      transition: { kind: InvestigationStoreTransitionKind.Opened },
      privateMaterials,
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
      !isVerifiedCleanReplaySource(source, this.clock.now().getTime()) ||
      source.certificate.certificateHash !== command.sourceCertificateHash ||
      source.revision.reviewRevisionHash ===
        command.targetRevision.reviewRevisionHash ||
      source.stableReviewUnitKey !== command.targetStableReviewUnitKey ||
      source.providerVoteLaneId !== command.targetProviderVoteLaneId ||
      source.runtimeProfile !== command.targetRuntimeProfile ||
      canonicalJson(source.contract) !==
        canonicalJson(command.targetContract) ||
      canonicalJson(source.policy) !== canonicalJson(command.targetPolicy) ||
      source.scope.workspaceId !== command.targetScope.workspaceId ||
      source.scope.repositoryConnectionId !==
        command.targetScope.repositoryConnectionId ||
      source.scope.scmRepositoryIdentityId !==
        command.targetScope.scmRepositoryIdentityId ||
      source.scope.pullRequestNumber !==
        command.targetScope.pullRequestNumber ||
      source.scope.trustDomain !== command.targetScope.trustDomain ||
      source.scope.authorizationScopeHash !==
        command.targetScope.authorizationScopeHash ||
      source.certificate.reviewRevisionHash !==
        source.revision.reviewRevisionHash ||
      source.certificate.stableReviewUnitKey !== source.stableReviewUnitKey ||
      source.certificate.providerVoteLaneId !== source.providerVoteLaneId ||
      source.certificate.producerReleaseId !==
        command.targetContract.producerReleaseId ||
      source.certificate.coverageContractVersion !==
        command.targetContract.coverageContractVersion ||
      source.certificate.expansionRulesVersion !==
        command.targetContract.expansionRulesVersion ||
      source.certificate.criticPolicyVersion !==
        command.targetContract.criticPolicyVersion ||
      source.certificate.gatewayPolicyVersion !==
        command.targetContract.gatewayPolicyVersion ||
      source.certificate.runtimeProfileVersion !==
        command.targetContract.runtimeProfileVersion
    ) {
      throw new Error("investigation_replay_source_invalid");
    }
    return source;
  }

  private async replayObligations(
    source: ReviewInvestigation,
    command: ReplayReviewInvestigationCommand,
    targetObligations: readonly InvestigationObligation[],
  ): Promise<readonly InvestigationObligation[]> {
    const sourceByObligationId = new Map(
      source.obligations.map((obligation) => [
        obligation.obligationId,
        obligation,
      ]),
    );
    const proofByObligationId = new Map<string, string>();
    for (const proof of command.replayProofs) {
      if (proofByObligationId.has(proof.obligationId)) {
        throw new Error("investigation_replay_proof_duplicate");
      }
      const sourceObligation = sourceByObligationId.get(proof.obligationId);
      if (!sourceObligation || !isReceiptReplayable(sourceObligation)) {
        throw new Error("investigation_replay_proof_obligation_invalid");
      }
      proofByObligationId.set(proof.obligationId, proof.replayProofId);
    }
    const replayed: InvestigationObligation[] = [];
    for (let target of targetObligations) {
      const sourceObligation = sourceByObligationId.get(target.obligationId);
      if (
        sourceObligation &&
        !hasSameStableIdentity(sourceObligation, target)
      ) {
        throw new Error("investigation_replay_obligation_identity_mismatch");
      }
      if (
        target.state === InvestigationObligationState.Open &&
        sourceObligation &&
        isReceiptReplayable(sourceObligation) &&
        proofByObligationId.has(target.obligationId)
      ) {
        const result = await this.replay.replay({
          sourceInvestigationId: source.investigationId,
          sourceCertificateHash: command.sourceCertificateHash,
          replayProofId: proofByObligationId.get(target.obligationId)!,
          targetExecutionId: command.targetExecutionId,
          targetWorkSlotId: command.targetWorkSlotId,
          targetProviderVoteLaneId: command.targetProviderVoteLaneId,
          producerReleaseId: command.targetContract.producerReleaseId,
          obligation: target,
          sourceReceipt: sourceObligation.receipt,
          targetRevision: command.targetRevision,
          gatewayPolicyVersion: command.targetContract.gatewayPolicyVersion,
        });
        if (result.verdict === InvestigationReceiptReplayVerdict.Matched) {
          target = satisfyInvestigationObligation({
            obligation: target,
            receipt: result.targetReceipt,
            reviewRevisionHash: command.targetRevision.reviewRevisionHash,
            gatewayPolicyVersion: command.targetContract.gatewayPolicyVersion,
          });
        }
      }
      replayed.push(target);
    }
    return replayed;
  }
}

function isReceiptReplayable(
  obligation: InvestigationObligation,
): obligation is InvestigationObligation & {
  readonly receipt: InvestigationEvidenceReceipt;
} {
  return (
    obligation.kind !== InvestigationObligationKind.ContextCritic &&
    obligation.state === InvestigationObligationState.Satisfied &&
    obligation.receipt !== null &&
    obligation.receipt.acceptedAttestationId !== null &&
    obligation.receipt.acceptedAttestationHash !== null &&
    obligation.receipt.operationReceiptIds.length > 0
  );
}

function hasSameStableIdentity(
  source: InvestigationObligation,
  target: InvestigationObligation,
): boolean {
  return (
    source.coverageContractVersion === target.coverageContractVersion &&
    source.stableReviewUnitKey === target.stableReviewUnitKey &&
    source.kind === target.kind &&
    source.canonicalSubject === target.canonicalSubject &&
    source.canonicalRequirement === target.canonicalRequirement
  );
}
