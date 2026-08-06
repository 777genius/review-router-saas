import {
  InvestigationExecutionAuthorityVerdict,
  type InvestigationExecutionAuthorityPort,
} from "@reviewrouter/features-review-investigations";
import {
  ReviewExecutionState,
  type ReviewExecutionQueryPort,
} from "@reviewrouter/features-review-executions";
import type { ReviewRunAuthorizationQueryPort } from "@reviewrouter/features-review-run-control";

export class WorkerInvestigationExecutionAuthority implements InvestigationExecutionAuthorityPort {
  constructor(
    private readonly executions: ReviewExecutionQueryPort,
    private readonly authorizations: ReviewRunAuthorizationQueryPort,
  ) {}

  async check(
    input: Parameters<InvestigationExecutionAuthorityPort["check"]>[0],
  ): Promise<InvestigationExecutionAuthorityVerdict> {
    const snapshot = await this.executions.findExecution(input.executionId);
    if (!snapshot) return InvestigationExecutionAuthorityVerdict.Missing;
    const execution = snapshot.execution;
    const authorization =
      await this.authorizations.findReviewRunAuthorizationById(
        execution.authorizationId,
      );
    if (
      !authorization ||
      execution.workspaceId !== input.scope.workspaceId ||
      execution.repositoryConnectionId !== input.scope.repositoryConnectionId ||
      execution.scmRepositoryIdentityId !==
        input.scope.scmRepositoryIdentityId ||
      execution.pullRequestNumber !== input.scope.pullRequestNumber ||
      authorization.trustDomain !== input.scope.trustDomain ||
      !execution.workSlots.some(
        (slot) =>
          slot.workSlotId === input.workSlotId &&
          slot.providerVoteIdentityHash === input.providerVoteLaneId,
      )
    ) {
      return InvestigationExecutionAuthorityVerdict.Unauthorized;
    }
    if (
      execution.state !== ReviewExecutionState.Running ||
      snapshot.stream.activeExecutionId !== execution.executionId ||
      snapshot.stream.currentRevision?.reviewRevisionHash !==
        input.revision.reviewRevisionHash ||
      execution.revision.reviewRevisionHash !==
        input.revision.reviewRevisionHash ||
      execution.revision.headSha !== input.revision.headSha
    ) {
      return InvestigationExecutionAuthorityVerdict.Superseded;
    }
    return InvestigationExecutionAuthorityVerdict.Current;
  }
}
