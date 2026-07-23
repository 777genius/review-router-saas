import type {
  ClaimReviewRequestedIntentCommand,
  LinkReviewRequestedAdmissionCommand,
  RecordReviewRequestedDispatchCommand,
  RegisterReviewRequestedIntentCommand,
  ReviewRequestedIntentCommandPort,
  ReviewRequestedIntentQueryPort,
} from "../ports/review-requested-intent-ports";

export class ReviewRequestedIntentService {
  constructor(
    private readonly queries: ReviewRequestedIntentQueryPort,
    private readonly commands: ReviewRequestedIntentCommandPort,
  ) {}

  register(command: RegisterReviewRequestedIntentCommand) {
    return this.commands.registerIntent(command);
  }

  claim(command: ClaimReviewRequestedIntentCommand) {
    return this.commands.claimIntent(command);
  }

  recordDispatch(command: RecordReviewRequestedDispatchCommand) {
    return this.commands.recordDispatch(command);
  }

  linkAdmission(command: LinkReviewRequestedAdmissionCommand) {
    return this.commands.linkAdmission(command);
  }

  listDue(now: Date, limit: number) {
    return this.queries.listDue({ now, limit });
  }
}
