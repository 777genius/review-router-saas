import type {
  AcquireReviewInvocationLeaseCommand,
  ReviewExecutionCommandPort,
  ReviewExecutionQueryPort,
} from "./review-execution-ports";
import type { InvocationFlight } from "../../domain/invocation-flight";

export interface InvocationFlightQueryPort {
  observeActiveInvocationFlightByLane(input: {
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
