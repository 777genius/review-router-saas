import { createHash } from "node:crypto";
import {
  formatGithubProgressComment,
  githubProgressCommentMarker,
  type ProgressSnapshot,
} from "@reviewrouter/features-review-progress";
import type { Clock } from "@reviewrouter/shared";
import {
  ReviewProgressGitHubError,
  ReviewProgressGitHubGateway,
  type ReviewProgressGitHubRequester,
} from "./review-progress-github-gateway";
import {
  PrismaReviewProgressPublicationStore,
  type ClaimedReviewProgress,
} from "./review-progress-store";

export const hostedProgressCommentWritesEnv =
  "REVIEW_ROUTER_HOSTED_PROGRESS_COMMENT_WRITES";

export type ReviewProgressInstallationRequesterFactory = (
  installationId: bigint,
) => Promise<
  Readonly<{
    request: ReviewProgressGitHubRequester;
    botLogin: string;
  }>
>;

export type ReviewProgressPublicationStore = Pick<
  PrismaReviewProgressPublicationStore,
  | "claimNext"
  | "reserveInstallationMutation"
  | "complete"
  | "retry"
  | "suppress"
>;

export type ReviewProgressPublisherResult = Readonly<{
  claimed: number;
  published: number;
  deferred: number;
  suppressed: number;
  failed: number;
}>;

export class ReviewProgressPublisher {
  constructor(
    private readonly store: ReviewProgressPublicationStore,
    private readonly requestForInstallation: ReviewProgressInstallationRequesterFactory,
    private readonly clock: Clock,
    private readonly ownerIdHash: string,
    private readonly options: Readonly<{
      limit: number;
      claimDurationMs: number;
      minimumMutationIntervalMs: number;
      retryDelayMs: number;
      maxCommentPages: number;
    }>,
  ) {
    assertPositive(options.limit, "review_progress_publish_limit_invalid");
    assertPositive(options.claimDurationMs, "review_progress_claim_ms_invalid");
    assertPositive(
      options.minimumMutationIntervalMs,
      "review_progress_mutation_interval_ms_invalid",
    );
    assertPositive(options.retryDelayMs, "review_progress_retry_ms_invalid");
    assertPositive(
      options.maxCommentPages,
      "review_progress_comment_pages_invalid",
    );
  }

  async runMaintenance(): Promise<ReviewProgressPublisherResult> {
    const result = {
      claimed: 0,
      published: 0,
      deferred: 0,
      suppressed: 0,
      failed: 0,
    };
    for (let index = 0; index < this.options.limit; index += 1) {
      const publication = await this.store.claimNext({
        ownerIdHash: this.ownerIdHash,
        now: this.clock.now(),
        claimDurationMs: this.options.claimDurationMs,
      });
      if (!publication) break;
      result.claimed += 1;
      await this.publishOne(publication, result);
    }
    return result;
  }

  private async publishOne(
    publication: ClaimedReviewProgress,
    result: {
      published: number;
      deferred: number;
      suppressed: number;
      failed: number;
    },
  ): Promise<void> {
    const now = this.clock.now();
    let body: string;
    try {
      body = formatGithubProgressComment(parseSnapshot(publication.snapshot));
    } catch {
      await this.store.suppress({
        publication,
        safeCode: "review_progress_snapshot_invalid",
        now,
      });
      result.suppressed += 1;
      return;
    }
    const bodyHash = sha256(body);
    const reservation = await this.store.reserveInstallationMutation({
      publication,
      now,
      minimumIntervalMs: Math.max(
        1_000,
        this.options.minimumMutationIntervalMs,
      ),
    });
    if (!reservation.allowed) {
      await this.store.retry({
        publication,
        safeCode: "review_progress_installation_budget_wait",
        retryAt: reservation.retryAt,
        now,
      });
      result.deferred += 1;
      return;
    }
    try {
      const installation = await this.requestForInstallation(
        publication.repository.githubInstallationId,
      );
      const gateway = new ReviewProgressGitHubGateway(installation.request, {
        maxCommentPages: this.options.maxCommentPages,
        now: () => this.clock.now(),
      });
      const published = await gateway.upsert({
        owner: publication.repository.owner,
        repo: publication.repository.name,
        pullNumber: publication.scope.pullRequestNumber,
        expectedHeadSha: publication.headSha,
        expectedBotLogin: installation.botLogin,
        ...(publication.commentId === null
          ? {}
          : { knownCommentId: Number(publication.commentId) }),
        marker: githubProgressCommentMarker,
        body,
      });
      if (published.duplicateCommentIds.length > 0) {
        await this.store.retry({
          publication,
          safeCode: "review_progress_duplicate_cleanup_pending",
          retryAt: new Date(
            this.clock.now().getTime() +
              Math.max(1_000, this.options.minimumMutationIntervalMs),
          ),
          now: this.clock.now(),
        });
        result.deferred += 1;
        return;
      }
      await this.store.complete({
        publication,
        commentId: BigInt(published.commentId),
        bodyHash,
        now: this.clock.now(),
      });
      result.published += 1;
    } catch (error) {
      if (
        error instanceof ReviewProgressGitHubError &&
        !error.metadata.retryable
      ) {
        await this.store.suppress({
          publication,
          safeCode: `review_progress_${error.kind}`,
          now: this.clock.now(),
        });
        result.suppressed += 1;
        return;
      }
      const githubError =
        error instanceof ReviewProgressGitHubError ? error : null;
      const retryAt =
        githubError?.metadata.retryAt ??
        new Date(this.clock.now().getTime() + this.options.retryDelayMs);
      await this.store.retry({
        publication,
        safeCode: githubError
          ? `review_progress_${githubError.kind}`
          : "review_progress_publish_failed",
        retryAt,
        ...(githubError?.kind === "rate_limited"
          ? { installationCooldownUntil: retryAt }
          : {}),
        now: this.clock.now(),
      });
      result.failed += 1;
    }
  }
}

function parseSnapshot(value: unknown): ProgressSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("review_progress_snapshot_invalid");
  }
  const counts = value.counts;
  const fileCoverage = value.fileCoverage;
  if (
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    !isPhase(value.phase) ||
    !isTerminal(value.terminal) ||
    typeof value.updatedAt !== "string" ||
    !isRecord(counts) ||
    !validCounts(counts) ||
    !validCoverage(fileCoverage)
  )
    throw new Error("review_progress_snapshot_invalid");
  return value as unknown as ProgressSnapshot;
}

function validCounts(value: Record<string, unknown>): boolean {
  return [
    "total",
    "completed",
    "exhausted",
    "cancelled",
    "running",
    "pending",
    "retrying",
    "recovered",
    "requiredTotal",
    "requiredCompleted",
    "requiredExhausted",
    "requiredCancelled",
    "optionalTotal",
    "optionalCompleted",
  ].every(
    (key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0,
  );
}

function validCoverage(value: unknown): boolean {
  if (!isRecord(value) || typeof value.valid !== "boolean") return false;
  return (
    value.valid === false ||
    (Number.isSafeInteger(value.total) &&
      Number.isSafeInteger(value.covered) &&
      Number.isSafeInteger(value.uncovered) &&
      Number.isSafeInteger(value.excluded))
  );
}

function isPhase(value: unknown): value is ProgressSnapshot["phase"] {
  return [
    "preparing",
    "reviewing",
    "assembling",
    "publishing",
    "terminal",
  ].includes(String(value));
}

function isTerminal(value: unknown): value is ProgressSnapshot["terminal"] {
  return [
    "none",
    "complete",
    "complete_with_gaps",
    "failed",
    "cancelled",
    "superseded",
  ].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertPositive(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
}
