import { describe, expect, it } from "vitest";
import {
  CurrentReviewRevisionStatus,
  type CurrentReviewRevisionPort,
  type ReviewExecutionQueryPort,
} from "../application/ports/review-execution-ports";
import {
  CheckCurrentReviewExecutionRevision,
  CurrentReviewExecutionRevisionStatus,
} from "../application/use-cases/check-current-review-execution-revision";
import type {
  ReviewExecutionSnapshot,
  ReviewExecutionScope,
  ReviewRevision,
} from "../domain/review-execution";

const scope: ReviewExecutionScope = {
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-1",
  scmRepositoryIdentityId: "identity-1",
  pullRequestNumber: 42,
};
const revision: ReviewRevision = {
  baseSha: "a".repeat(40),
  mergeBaseSha: "b".repeat(40),
  headSha: "c".repeat(40),
  reviewRevisionHash: "d".repeat(64),
};

describe("CheckCurrentReviewExecutionRevision", () => {
  it("accepts only the complete live revision bound to the execution", async () => {
    const result = await useCase().execute({
      scope,
      executionId: "execution-1",
    });

    expect(result).toBe(CurrentReviewExecutionRevisionStatus.Current);
  });

  it("rejects base or merge-base movement even when head is unchanged", async () => {
    const result = await useCase({
      liveRevision: { ...revision, mergeBaseSha: "e".repeat(40) },
    }).execute({ scope, executionId: "execution-1" });

    expect(result).toBe(CurrentReviewExecutionRevisionStatus.Stale);
  });

  it("distinguishes missing execution and unavailable SCM facts", async () => {
    const missing = await useCase({ snapshot: null }).execute({
      scope,
      executionId: "execution-1",
    });
    const unavailable = await useCase({ unavailable: true }).execute({
      scope,
      executionId: "execution-1",
    });

    expect(missing).toBe(CurrentReviewExecutionRevisionStatus.Missing);
    expect(unavailable).toBe(CurrentReviewExecutionRevisionStatus.Unavailable);
  });

  it("normalizes thrown SCM failures to unavailable", async () => {
    const result = await useCase({ throws: true }).execute({
      scope,
      executionId: "execution-1",
    });

    expect(result).toBe(CurrentReviewExecutionRevisionStatus.Unavailable);
  });
});

function useCase(overrides?: {
  readonly snapshot?: ReviewExecutionSnapshot | null;
  readonly liveRevision?: ReviewRevision;
  readonly unavailable?: boolean;
  readonly throws?: boolean;
}) {
  const snapshot =
    overrides && "snapshot" in overrides
      ? overrides.snapshot
      : ({
          stream: scope,
          execution: { revision },
        } as ReviewExecutionSnapshot);
  const executions = {
    async findExecution() {
      return snapshot ?? null;
    },
  } as unknown as ReviewExecutionQueryPort;
  const currentRevision: CurrentReviewRevisionPort = {
    async resolve() {
      if (overrides?.throws) throw new Error("github_unavailable");
      return overrides?.unavailable
        ? { status: CurrentReviewRevisionStatus.Unavailable }
        : {
            status: CurrentReviewRevisionStatus.Found,
            revision: overrides?.liveRevision ?? revision,
          };
    },
  };
  return new CheckCurrentReviewExecutionRevision(currentRevision, executions);
}
