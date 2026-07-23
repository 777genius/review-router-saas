import {
  ReviewRequestIngressCommandKind,
  ReviewRequestedRegisterStatus,
  ReviewRequestedIntentService,
  parseReviewRequestIngressPayload,
  reviewRequestIngressEventType,
  reviewRequestIngressEventVersion,
  type ReviewRequestIngressPayload,
} from "@reviewrouter/features-review-executions";
import {
  CanonicalReviewRevisionResolutionStatus,
  canonicalJson,
  type CanonicalReviewRevisionResolverPort,
} from "@reviewrouter/features-review-run-control";
import {
  OutboxHandlerError,
  type OutboxEvent,
  type OutboxHandler,
} from "@reviewrouter/features-outbox";

export enum ReviewRequestEligibilityStatus {
  Current = "current",
  Missing = "missing",
  Unavailable = "unavailable",
}

export type ReviewRequestEligibility =
  | {
      readonly status: ReviewRequestEligibilityStatus.Current;
      readonly state: "open" | "closed";
      readonly draft: boolean;
      readonly baseSha: string;
      readonly headSha: string;
      readonly headRepositoryFullName: string;
      readonly authorType: string;
    }
  | {
      readonly status:
        | ReviewRequestEligibilityStatus.Missing
        | ReviewRequestEligibilityStatus.Unavailable;
    };

export interface ReviewRequestEligibilityPort {
  load(input: {
    readonly githubInstallationId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
  }): Promise<ReviewRequestEligibility>;
}

export type ReviewRequestIngressApplicationDependencies = Readonly<{
  intents: ReviewRequestedIntentService;
  revisions: CanonicalReviewRevisionResolverPort;
  eligibility: ReviewRequestEligibilityPort;
  digest: { digestUtf8(value: string): Promise<string> };
  clock: { now(): Date };
  reviewDrafts: (repositoryFullName: string) => boolean;
}>;

export class ReviewRequestIngressApplicationService {
  constructor(
    private readonly dependencies: ReviewRequestIngressApplicationDependencies,
  ) {}

  async execute(input: {
    readonly payload: ReviewRequestIngressPayload;
    readonly occurredAt: Date;
  }): Promise<void> {
    const payload = input.payload;
    if (payload.commandKind === ReviewRequestIngressCommandKind.Cancel) {
      await this.dependencies.intents.cancelPreAdmission({
        ...payload,
        now: this.dependencies.clock.now(),
      });
      return;
    }

    const current = await this.dependencies.eligibility.load(payload);
    if (current.status === ReviewRequestEligibilityStatus.Unavailable) {
      throw retryable("review_request_eligibility_unavailable");
    }
    if (current.status !== ReviewRequestEligibilityStatus.Current) {
      await this.dependencies.intents.cancelPreAdmission({
        ...payload,
        now: this.dependencies.clock.now(),
      });
      return;
    }
    if (
      current.state === "closed" ||
      current.authorType === "Bot" ||
      current.headRepositoryFullName.toLowerCase() !==
        payload.repositoryFullName.toLowerCase() ||
      (current.draft &&
        !this.dependencies.reviewDrafts(payload.repositoryFullName))
    ) {
      await this.dependencies.intents.cancelPreAdmission({
        ...payload,
        now: this.dependencies.clock.now(),
      });
      return;
    }
    if (
      current.headSha !== payload.expectedHeadSha ||
      (payload.expectedBaseSha !== null &&
        current.baseSha !== payload.expectedBaseSha)
    ) {
      return;
    }

    const [owner, repo] = splitRepository(payload.repositoryFullName);
    const revision = await this.dependencies.revisions.resolve({
      workspaceId: payload.workspaceId,
      repositoryConnectionId: payload.repositoryConnectionId,
      scmRepositoryIdentityId: payload.scmRepositoryIdentityId,
      githubInstallationId: payload.githubInstallationId,
      owner,
      repo,
      sourceRunId: null,
      pullRequestNumberHint: payload.pullRequestNumber,
    });
    if (revision.status !== CanonicalReviewRevisionResolutionStatus.Resolved) {
      throw retryable(`review_request_revision_${revision.status}`);
    }
    if (
      revision.baseSha !== current.baseSha ||
      revision.headSha !== current.headSha
    ) {
      throw retryable("review_request_revision_moved");
    }
    const createdAt = input.occurredAt;
    const normalizedRevision = {
      baseSha: revision.baseSha,
      mergeBaseSha: revision.mergeBaseSha,
      headSha: revision.headSha,
      reviewRevisionHash: revision.reviewRevisionHash,
    } as const;
    const canonicalRequestHash = await this.dependencies.digest.digestUtf8(
      canonicalJson({
        scope: {
          workspaceId: payload.workspaceId,
          repositoryConnectionId: payload.repositoryConnectionId,
          scmRepositoryIdentityId: payload.scmRepositoryIdentityId,
          pullRequestNumber: payload.pullRequestNumber,
        },
        revision: normalizedRevision,
        triggerKind: payload.triggerKind,
        deliveryIdentityHash: payload.deliveryIdentityHash,
      }),
    );
    const result = await this.dependencies.intents.register({
      candidate: {
        workspaceId: payload.workspaceId,
        repositoryConnectionId: payload.repositoryConnectionId,
        scmRepositoryIdentityId: payload.scmRepositoryIdentityId,
        pullRequestNumber: payload.pullRequestNumber,
        requestId: payload.requestId,
        revision: normalizedRevision,
        triggerKind: payload.triggerKind,
        deliveryIdentityHash: payload.deliveryIdentityHash,
        canonicalRequestHash,
        notBefore: new Date(createdAt.getTime() + payload.quietPeriodMs),
        createdAt,
        retainUntil: new Date(createdAt.getTime() + payload.retentionMs),
      },
    });
    if (result.status === ReviewRequestedRegisterStatus.IdempotencyConflict) {
      throw new OutboxHandlerError(
        "Review request ingress identity conflicts with persisted intent",
        "review_request_ingress_idempotency_conflict",
        false,
      );
    }
  }
}

export function createReviewRequestIngressHandler(
  dependencies: ReviewRequestIngressApplicationDependencies,
): OutboxHandler {
  const application = new ReviewRequestIngressApplicationService(dependencies);
  return {
    type: reviewRequestIngressEventType,
    version: reviewRequestIngressEventVersion,
    async handle(event: OutboxEvent) {
      const payload = parseReviewRequestIngressPayload(event.payload);
      assertEventScope(event, payload);
      await application.execute({ payload, occurredAt: event.occurredAt });
    },
  };
}

function assertEventScope(
  event: OutboxEvent,
  payload: ReturnType<typeof parseReviewRequestIngressPayload>,
): void {
  if (
    event.type !== reviewRequestIngressEventType ||
    event.version !== reviewRequestIngressEventVersion ||
    event.workspaceId !== payload.workspaceId ||
    event.repositoryId !== payload.repositoryConnectionId
  ) {
    throw new OutboxHandlerError(
      "Review request ingress envelope does not match its payload",
      "review_request_ingress_envelope_invalid",
      false,
    );
  }
}

function splitRepository(fullName: string): readonly [string, string] {
  const [owner, repo, ...extra] = fullName.split("/");
  if (!owner || !repo || extra.length > 0) {
    throw new OutboxHandlerError(
      "Review request repository identity is invalid",
      "review_request_repository_invalid",
      false,
    );
  }
  return [owner, repo];
}

export function retryableReviewRequestIngressError(
  code: string,
): OutboxHandlerError {
  return retryable(code);
}

function retryable(code: string): OutboxHandlerError {
  return new OutboxHandlerError(
    "Current review request facts are temporarily unavailable",
    code,
    true,
  );
}
