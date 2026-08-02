import type {
  ReviewInvestigationRevision,
  ReviewInvestigationScope,
} from "../../domain/coverage-contract";

export enum InvestigationExecutionAuthorityVerdict {
  Current = "current",
  Superseded = "superseded",
  Missing = "missing",
  Unauthorized = "unauthorized",
}

export interface InvestigationExecutionAuthorityPort {
  check(input: {
    readonly scope: ReviewInvestigationScope;
    readonly revision: ReviewInvestigationRevision;
    readonly executionId: string;
    readonly workSlotId: string;
    readonly providerVoteLaneId: string;
  }): Promise<InvestigationExecutionAuthorityVerdict>;
}
