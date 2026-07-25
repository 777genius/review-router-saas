import type { ActionRepositoryContext } from "../../domain/action-control-plane.js";

export type HostedReviewPreleaseGateDecision =
  | { readonly status: "not_applicable" }
  | { readonly status: "admitted"; readonly decisionHash: string }
  | {
      readonly status: "skipped";
      readonly reason: "max_changed_lines_exceeded";
      readonly changedLines: number;
      readonly maxChangedLines: number;
      readonly decisionHash: string;
    };

export interface HostedReviewPreleaseGatePort {
  evaluate(input: {
    readonly repository: ActionRepositoryContext;
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
    readonly intentRequired: boolean;
    readonly now: Date;
  }): Promise<HostedReviewPreleaseGateDecision>;
}
