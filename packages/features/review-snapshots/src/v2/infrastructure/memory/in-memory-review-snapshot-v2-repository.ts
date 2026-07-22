import {
  ReviewSnapshotV2CommitOutcome,
  assertCommitReviewSnapshotV2Command,
  assertSnapshotCommitReceiptSource,
  type CommitReviewSnapshotV2Command,
  type LegacySnapshotIdentity,
  type ReviewSnapshotCommitReceipt,
  type ReviewSnapshotV2Record,
  type ReviewSnapshotV2Scope,
} from "../../domain/review-snapshot-v2";
import {
  CommitReviewSnapshotV2Status,
  type CommitReviewSnapshotV2Result,
  type ReviewSnapshotCommitReceiptQueryPort,
  type ReviewSnapshotV2CommandPort,
  type ReviewSnapshotV2QueryPort,
} from "../../application/ports/review-snapshot-v2-port";

export class InMemoryReviewSnapshotV2Repository
  implements
    ReviewSnapshotV2CommandPort,
    ReviewSnapshotV2QueryPort,
    ReviewSnapshotCommitReceiptQueryPort
{
  private readonly snapshots = new Map<
    string,
    ReviewSnapshotV2Record | LegacySnapshotIdentity
  >();
  private readonly receipts = new Map<string, ReviewSnapshotCommitReceipt>();

  async commit(
    command: CommitReviewSnapshotV2Command,
  ): Promise<CommitReviewSnapshotV2Result> {
    assertCommitReviewSnapshotV2Command(command);
    const sourceKey = receiptKey(
      command.candidate.sourceExecutionId,
      command.candidate.sourceArtifactHash,
    );
    const existingReceipt = this.receipts.get(sourceKey);
    if (existingReceipt) {
      if (existingReceipt.requestHash !== command.requestHash) {
        return {
          status: CommitReviewSnapshotV2Status.RequestConflict,
          currentVersion: this.currentVersion(command.candidate),
        };
      }
      return {
        status: CommitReviewSnapshotV2Status.Restored,
        receipt: copyReceipt(existingReceipt),
        snapshot: this.currentV2(command.candidate),
      };
    }

    const key = scopeKey(command.candidate);
    const current = this.snapshots.get(key);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== command.expectedSnapshotVersion) {
      return {
        status: CommitReviewSnapshotV2Status.VersionConflict,
        currentVersion,
      };
    }

    const currentGeneration =
      current?.schemaVersion === 2 ? current.sourceExecutionGeneration : 0;
    let outcome: ReviewSnapshotV2CommitOutcome;
    let resultingSnapshot: ReviewSnapshotV2Record | null;
    if (currentGeneration > command.candidate.sourceExecutionGeneration) {
      outcome = ReviewSnapshotV2CommitOutcome.SupersededByHigherGeneration;
      resultingSnapshot = current?.schemaVersion === 2 ? current : null;
    } else if (
      currentGeneration === command.candidate.sourceExecutionGeneration
    ) {
      if (
        current?.schemaVersion !== 2 ||
        current.sourceArtifactHash !== command.candidate.sourceArtifactHash
      ) {
        return {
          status: CommitReviewSnapshotV2Status.InvariantConflict,
          currentVersion,
        };
      }
      outcome = ReviewSnapshotV2CommitOutcome.AlreadyCurrent;
      resultingSnapshot = current;
    } else {
      outcome = ReviewSnapshotV2CommitOutcome.Committed;
      resultingSnapshot = {
        ...command.candidate,
        version: currentVersion + 1,
      };
      this.snapshots.set(key, copySnapshot(resultingSnapshot));
    }

    const receipt: ReviewSnapshotCommitReceipt = {
      receiptId: command.receiptId,
      requestHash: command.requestHash,
      sourceExecutionId: command.candidate.sourceExecutionId,
      sourceExecutionGeneration: command.candidate.sourceExecutionGeneration,
      sourceArtifactHash: command.candidate.sourceArtifactHash,
      sourceReviewRevisionHash: command.candidate.sourceReviewRevisionHash,
      outcome,
      resultingSnapshotVersion: resultingSnapshot?.version ?? currentVersion,
      resultingSnapshotGeneration:
        resultingSnapshot?.sourceExecutionGeneration ?? currentGeneration,
      createdAt: new Date(command.candidate.createdAt),
      retainUntil: new Date(command.receiptRetainUntil),
    };
    this.receipts.set(sourceKey, copyReceipt(receipt));
    return {
      status: CommitReviewSnapshotV2Status.Applied,
      receipt,
      snapshot: resultingSnapshot ? copySnapshot(resultingSnapshot) : null,
    };
  }

  async findCurrent(
    scope: ReviewSnapshotV2Scope,
  ): Promise<ReviewSnapshotV2Record | LegacySnapshotIdentity | null> {
    const snapshot = this.snapshots.get(scopeKey(scope));
    if (!snapshot) return null;
    return snapshot.schemaVersion === 2
      ? copySnapshot(snapshot)
      : { ...snapshot };
  }

  async findBySource(input: {
    readonly sourceExecutionId: string;
    readonly sourceArtifactHash: string;
  }): Promise<ReviewSnapshotCommitReceipt | null> {
    assertSnapshotCommitReceiptSource(input);
    const receipt = this.receipts.get(
      receiptKey(input.sourceExecutionId, input.sourceArtifactHash),
    );
    return receipt ? copyReceipt(receipt) : null;
  }

  seedLegacy(snapshot: LegacySnapshotIdentity): void {
    this.snapshots.set(scopeKey(snapshot), { ...snapshot });
  }

  private currentVersion(scope: ReviewSnapshotV2Scope): number {
    return this.snapshots.get(scopeKey(scope))?.version ?? 0;
  }

  private currentV2(
    scope: ReviewSnapshotV2Scope,
  ): ReviewSnapshotV2Record | null {
    const snapshot = this.snapshots.get(scopeKey(scope));
    return snapshot?.schemaVersion === 2 ? copySnapshot(snapshot) : null;
  }
}

function scopeKey(scope: ReviewSnapshotV2Scope): string {
  return [
    scope.workspaceId,
    scope.repositoryConnectionId,
    scope.scmRepositoryIdentityId,
    scope.pullRequestNumber,
  ].join(":");
}

function receiptKey(
  sourceExecutionId: string,
  sourceArtifactHash: string,
): string {
  return `${sourceExecutionId}:${sourceArtifactHash}`;
}

function copyReceipt(
  receipt: ReviewSnapshotCommitReceipt,
): ReviewSnapshotCommitReceipt {
  return {
    ...receipt,
    createdAt: new Date(receipt.createdAt),
    retainUntil: new Date(receipt.retainUntil),
  };
}

function copySnapshot(
  snapshot: ReviewSnapshotV2Record,
): ReviewSnapshotV2Record {
  return structuredClone(snapshot);
}
