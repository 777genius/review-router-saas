import {
  reviewRevisionsEqual,
  type ReviewExecutionScope,
} from "../../domain/review-execution";
import {
  CurrentReviewRevisionStatus,
  type CurrentReviewRevisionPort,
  type ReviewExecutionQueryPort,
} from "../ports/review-execution-ports";

export enum CurrentReviewExecutionRevisionStatus {
  Current = "current",
  Stale = "stale",
  Missing = "missing",
  Unavailable = "unavailable",
}

export class CheckCurrentReviewExecutionRevision {
  constructor(
    private readonly currentRevision: CurrentReviewRevisionPort,
    private readonly executions: ReviewExecutionQueryPort,
  ) {}

  async execute(input: {
    readonly scope: ReviewExecutionScope;
    readonly executionId: string;
  }): Promise<CurrentReviewExecutionRevisionStatus> {
    try {
      const snapshot = await this.executions.findExecution(input.executionId);
      if (snapshot === null || !sameScope(snapshot.stream, input.scope)) {
        return CurrentReviewExecutionRevisionStatus.Missing;
      }
      const current = await this.currentRevision.resolve(input.scope);
      if (current.status === CurrentReviewRevisionStatus.Unavailable) {
        return CurrentReviewExecutionRevisionStatus.Unavailable;
      }
      return reviewRevisionsEqual(current.revision, snapshot.execution.revision)
        ? CurrentReviewExecutionRevisionStatus.Current
        : CurrentReviewExecutionRevisionStatus.Stale;
    } catch {
      return CurrentReviewExecutionRevisionStatus.Unavailable;
    }
  }
}

function sameScope(
  left: ReviewExecutionScope,
  right: ReviewExecutionScope,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.repositoryConnectionId === right.repositoryConnectionId &&
    left.scmRepositoryIdentityId === right.scmRepositoryIdentityId &&
    left.pullRequestNumber === right.pullRequestNumber
  );
}
