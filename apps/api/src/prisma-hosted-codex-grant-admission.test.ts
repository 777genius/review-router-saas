import { describe, expect, it } from "vitest";
import { assertHostedReviewIdentity } from "./prisma-hosted-codex-grant-admission.js";

const admittedRevision = {
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-1",
  scmRepositoryIdentityId: "scm-repository-1",
  pullRequestNumber: 42,
  baseSha: "a".repeat(40),
  mergeBaseSha: "b".repeat(40),
  headSha: "c".repeat(40),
} as const;
const reviewRevisionHash =
  "85a7e4b1cd462169190e04a3ebe52db65c404305060dd97199f9c7c70be03d88";

describe("hosted Codex admitted review identity", () => {
  it("accepts the exact admitted V2 pull request revision", () => {
    expect(
      assertHostedReviewIdentity({ ...admittedRevision, reviewRevisionHash }),
    ).toEqual({
      headSha: admittedRevision.headSha,
      reviewRevisionHash,
    });
  });

  it.each([
    ["pull request", { pullRequestNumber: 41 }],
    ["head", { headSha: "d".repeat(40) }],
    ["repository", { repositoryConnectionId: "repository-2" }],
    [
      "SCM repository identity",
      { scmRepositoryIdentityId: "scm-repository-2" },
    ],
    ["revision hash", { reviewRevisionHash: "e".repeat(64) }],
  ] as const)("rejects a mismatched admitted %s", (_name, override) => {
    expect(() =>
      assertHostedReviewIdentity({
        ...admittedRevision,
        reviewRevisionHash,
        ...override,
      }),
    ).toThrow("hosted_review_revision_mismatch");
  });
});
