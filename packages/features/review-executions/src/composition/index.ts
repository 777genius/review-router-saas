import type {
  ClockPort,
  CurrentReviewRevisionPort,
  ReviewExecutionAuthorizationFactsPort,
  ReviewExecutionCommandPort,
  ReviewExecutionQueryPort,
  Sha256DigestPort,
} from "../application/ports/review-execution-ports";
import type { InvocationFlightQueryPort } from "../application/ports/invocation-flight-ports";
import type {
  ReviewRequestedIntentCommandPort,
  ReviewRequestedIntentQueryPort,
} from "../application/ports/review-requested-intent-ports";
import { AcquireOrJoinInvocationFlight } from "../application/use-cases/acquire-or-join-invocation-flight";
import {
  FinalizeReviewExecution,
  ReviewExecutionLifecycleService,
  ReviewInvocationLeaseService,
  ReviewObservationAttachmentService,
} from "../application/use-cases/review-execution-application-services";
import { ReviewRequestedIntentService } from "../application/use-cases/review-requested-intent-service";
import { StartReviewExecution } from "../application/use-cases/start-review-execution";
import { CheckCurrentReviewExecutionRevision } from "../application/use-cases/check-current-review-execution-revision";

export type ReviewExecutionsCompositionDependencies = Readonly<{
  authorizationFacts: ReviewExecutionAuthorizationFactsPort;
  currentRevision: CurrentReviewRevisionPort;
  executionQueries: ReviewExecutionQueryPort;
  executionCommands: ReviewExecutionCommandPort;
  invocationFlightQueries: InvocationFlightQueryPort;
  requestedIntentQueries: ReviewRequestedIntentQueryPort;
  requestedIntentCommands: ReviewRequestedIntentCommandPort;
  digest: Sha256DigestPort;
  clock: ClockPort;
  requestedIntentAdmissionRequired?: boolean;
}>;

export type ReviewExecutionsComposition = Readonly<{
  startReviewExecution: StartReviewExecution;
  invocationFlights: AcquireOrJoinInvocationFlight;
  invocationLeases: ReviewInvocationLeaseService;
  observationAttachments: ReviewObservationAttachmentService;
  finalizeReviewExecution: FinalizeReviewExecution;
  executionLifecycle: ReviewExecutionLifecycleService;
  requestedIntents: ReviewRequestedIntentService;
  currentRevision: CheckCurrentReviewExecutionRevision;
}>;

export function createReviewExecutionsUseCases(
  dependencies: ReviewExecutionsCompositionDependencies,
): ReviewExecutionsComposition {
  return Object.freeze({
    startReviewExecution: new StartReviewExecution(
      dependencies.authorizationFacts,
      dependencies.currentRevision,
      dependencies.executionQueries,
      dependencies.executionCommands,
      dependencies.digest,
      dependencies.clock,
      {
        queries: dependencies.requestedIntentQueries,
        commands: dependencies.requestedIntentCommands,
        required: dependencies.requestedIntentAdmissionRequired === true,
      },
    ),
    invocationFlights: new AcquireOrJoinInvocationFlight(
      dependencies.invocationFlightQueries,
      dependencies.executionQueries,
      dependencies.executionCommands,
    ),
    invocationLeases: new ReviewInvocationLeaseService(
      dependencies.executionCommands,
    ),
    observationAttachments: new ReviewObservationAttachmentService(
      dependencies.executionCommands,
    ),
    finalizeReviewExecution: new FinalizeReviewExecution(
      dependencies.executionCommands,
    ),
    executionLifecycle: new ReviewExecutionLifecycleService(
      dependencies.executionCommands,
    ),
    requestedIntents: new ReviewRequestedIntentService(
      dependencies.requestedIntentQueries,
      dependencies.requestedIntentCommands,
    ),
    currentRevision: new CheckCurrentReviewExecutionRevision(
      dependencies.currentRevision,
      dependencies.executionQueries,
    ),
  });
}

export * from "../infrastructure/prisma/prisma-review-execution-store";
export * from "../infrastructure/prisma/prisma-review-requested-intent-store";

export { PrismaReviewExecutionStore } from "../infrastructure/prisma/prisma-review-execution-store";
export { PrismaReviewRequestedIntentStore } from "../infrastructure/prisma/prisma-review-requested-intent-store";
