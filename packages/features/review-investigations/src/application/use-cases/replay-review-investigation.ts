import { canonicalJson } from "../../domain/canonicalization";
import {
  assertInvestigationRevision,
  assertInvestigationScope,
  canonicalInvestigationScope,
  type ReviewInvestigationRevision,
  type ReviewInvestigationScope,
  type SeedInvestigationObligation,
} from "../../domain/coverage-contract";
import {
  VersionedCoverageSeedPolicy,
  type CoverageSeedPolicy,
} from "../../domain/coverage-policies";
import {
  createInvestigationObligation,
  InvestigationObligationOrigin,
  obligationIdentity,
  satisfyInvestigationObligation,
  type InvestigationEvidenceReceipt,
  type InvestigationObligation,
} from "../../domain/investigation-obligation";
import type { ReviewInvestigationPolicy } from "../../domain/investigation-policy";
import {
  createReplayedReviewInvestigation,
  type ReviewInvestigation,
} from "../../domain/review-investigation";
import {
  evaluateReceiptReplayEligibility,
  isCommittedReplayableObligation,
} from "../../domain/review-investigation-replay-policy";
import {
  InvestigationObligationKind,
  InvestigationObligationState,
  ReviewInvestigationConclusion,
  type ReviewInvestigationRuntimeProfile,
} from "../../domain/review-investigation-types";
import {
  toInvestigationReadModel,
  type ReviewInvestigationReadModel,
} from "../investigation-read-model";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationExecutionAuthorityPort } from "../ports/execution-authority-port";
import type { InvestigationManifestIdentityPort } from "../ports/investigation-manifest-identity-port";
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
  sourceCheckpointHash: string;
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
    private readonly manifestIdentity: InvestigationManifestIdentityPort,
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
            identity: this.manifestIdentity,
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
    const targetObligations = await this.withFindingRevalidationObligations(
      source,
      command,
      seed.obligations,
    );
    const obligations = await this.replayObligations(
      source,
      command,
      targetObligations,
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
    const checkpoint = source?.replayEvidenceCheckpoint ?? null;
    const replayableReceipts = source
      ? source.obligations
          .filter(isCommittedReplayableObligation)
          .map((obligation) => ({
            obligationId: obligation.obligationId,
            receiptId: obligation.receipt.receiptId,
            evidenceDigest: obligation.receipt.evidenceDigest,
            acceptedAttestationId: obligation.receipt.acceptedAttestationId,
            acceptedAttestationHash: obligation.receipt.acceptedAttestationHash,
          }))
          .sort((left, right) =>
            left.obligationId.localeCompare(right.obligationId),
          )
      : [];
    if (
      source === null ||
      checkpoint === null ||
      !evaluateReceiptReplayEligibility(source, this.clock.now().getTime())
        .eligible ||
      checkpoint.checkpointHash !== command.sourceCheckpointHash ||
      checkpoint.scopeHash !==
        (await this.digest.digestUtf8(
          canonicalInvestigationScope(command.targetScope),
        )) ||
      checkpoint.contractHash !==
        (await digestCanonical(this.digest, command.targetContract)) ||
      checkpoint.policyHash !==
        (await digestCanonical(this.digest, command.targetPolicy)) ||
      checkpoint.producerReleaseHash !==
        (await digestCanonical(this.digest, {
          producerReleaseId: command.targetContract.producerReleaseId,
        })) ||
      checkpoint.runtimeProfileHash !==
        (await digestCanonical(this.digest, {
          runtimeProfile: command.targetRuntimeProfile,
          runtimeProfileVersion: command.targetContract.runtimeProfileVersion,
        })) ||
      checkpoint.receiptSetHash !==
        (await digestCanonical(this.digest, replayableReceipts)) ||
      checkpoint.contextAttestationSetHash !==
        (await digestCanonical(
          this.digest,
          replayableReceipts.map((receipt) => ({
            id: receipt.acceptedAttestationId,
            hash: receipt.acceptedAttestationHash,
          })),
        )) ||
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
      checkpoint.reviewRevisionHash !== source.revision.reviewRevisionHash ||
      checkpoint.stableReviewUnitKey !== source.stableReviewUnitKey ||
      checkpoint.providerVoteLaneId !== source.providerVoteLaneId ||
      checkpoint.producerReleaseId !==
        command.targetContract.producerReleaseId ||
      checkpoint.expiresAt <= this.clock.now().toISOString()
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
      if (
        !sourceObligation ||
        !isCommittedReplayableObligation(sourceObligation)
      ) {
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
        isCommittedReplayableObligation(sourceObligation) &&
        proofByObligationId.has(target.obligationId)
      ) {
        const result = await this.replay.replay({
          sourceInvestigationId: source.investigationId,
          sourceCheckpointHash: command.sourceCheckpointHash,
          sourceReceiptId: sourceObligation.receipt.receiptId,
          sourceEvidenceDigest: sourceObligation.receipt.evidenceDigest,
          sourceObligationId: sourceObligation.obligationId,
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

  private async withFindingRevalidationObligations(
    source: ReviewInvestigation,
    command: ReplayReviewInvestigationCommand,
    obligations: readonly InvestigationObligation[],
  ): Promise<readonly InvestigationObligation[]> {
    if (source.conclusion !== ReviewInvestigationConclusion.Findings) {
      return obligations;
    }
    const additions = await Promise.all(
      source.findings.map(async (finding) => {
        const identity = obligationIdentity({
          coverageContractVersion:
            command.targetContract.coverageContractVersion,
          stableReviewUnitKey: command.targetStableReviewUnitKey,
          kind: InvestigationObligationKind.FindingRevalidation,
          canonicalSubject: `finding:${finding.fingerprint}`,
          canonicalRequirement: `revalidate source finding ${finding.fingerprint} on the target revision`,
        });
        return createInvestigationObligation({
          obligationId: await digestCanonical(this.digest, identity),
          identity,
          riskPriority: 100,
          origin: InvestigationObligationOrigin.CoverageContract,
        });
      }),
    );
    return Object.freeze([...obligations, ...additions]);
  }
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
