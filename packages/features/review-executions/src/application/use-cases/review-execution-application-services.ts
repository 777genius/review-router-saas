import type {
  AcquireReviewInvocationLeaseCommand,
  AdoptAcceptedReviewObservationCommand,
  AttachReusableReviewObservationCommand,
  AttachReviewObservationCommand,
  FinalizeReviewExecutionCommand,
  FailAbandonedPreparedExecutionCommand,
  ReleaseReviewInvocationLeaseCommand,
  RenewReviewInvocationLeaseCommand,
  ReviewExecutionCommandPort,
  SupersedeReviewExecutionCommand,
} from "../ports/review-execution-ports";

export class ReviewInvocationLeaseService {
  constructor(private readonly commands: ReviewExecutionCommandPort) {}

  acquire(command: AcquireReviewInvocationLeaseCommand) {
    return this.commands.acquireLease(command);
  }

  renew(command: RenewReviewInvocationLeaseCommand) {
    return this.commands.renewLease(command);
  }

  release(command: ReleaseReviewInvocationLeaseCommand) {
    return this.commands.releaseLease(command);
  }
}

export class ReviewObservationAttachmentService {
  constructor(private readonly commands: ReviewExecutionCommandPort) {}

  attachFresh(command: AttachReviewObservationCommand) {
    return this.commands.attachObservation(command);
  }

  attachReusable(command: AttachReusableReviewObservationCommand) {
    return this.commands.attachReusableObservation(command);
  }

  adoptAccepted(command: AdoptAcceptedReviewObservationCommand) {
    return this.commands.adoptObservation(command);
  }
}

export class FinalizeReviewExecution {
  constructor(private readonly commands: ReviewExecutionCommandPort) {}

  execute(command: FinalizeReviewExecutionCommand) {
    return this.commands.finalizeExecution(command);
  }
}

export class ReviewExecutionLifecycleService {
  constructor(private readonly commands: ReviewExecutionCommandPort) {}

  supersede(command: SupersedeReviewExecutionCommand) {
    return this.commands.supersedeExecution(command);
  }

  failAbandonedPrepared(command: FailAbandonedPreparedExecutionCommand) {
    return this.commands.failAbandonedPreparedExecution(command);
  }
}
