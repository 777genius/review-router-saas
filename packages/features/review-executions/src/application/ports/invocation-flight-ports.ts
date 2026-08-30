import type {
  AcquireReviewInvocationLeaseCommand,
  ReviewExecutionCommandPort,
  ReviewExecutionQueryPort,
} from "./review-execution-ports";
import type { InvocationFlight } from "../../domain/invocation-flight";
import type { ReviewExecutionScope } from "../../domain/review-execution";

export interface InvocationFlightQueryPort {
  observeActiveInvocationFlight(input: {
    readonly scope: ReviewExecutionScope;
    readonly providerInvocationKey: string;
    readonly providerVoteIdentityHash: string;
    readonly requestedAt: Date;
  }): Promise<
    Readonly<{
      flight: InvocationFlight | null;
      observedAt: Date;
    }>
  >;
}

export type InvocationFlightPersistencePorts = Readonly<{
  flights: InvocationFlightQueryPort;
  executions: ReviewExecutionQueryPort;
  commands: ReviewExecutionCommandPort;
}>;

export type AcquireOrJoinInvocationFlightInput =
  AcquireReviewInvocationLeaseCommand;
