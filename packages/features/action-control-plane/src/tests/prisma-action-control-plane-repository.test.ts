import { describe, expect, it } from "vitest";
import { orgRulesetTargetsRepository } from "../infrastructure/prisma/prisma-action-control-plane-repository.js";

describe("PrismaActionControlPlaneRepository helpers", () => {
  it("does not trust org ruleset workflows for the source repository itself", () => {
    expect(
      orgRulesetTargetsRepository({
        scope: "all_repositories",
        sourceGithubRepositoryId: "1999",
        targetRepositoryIds: ["1001", "1002"],
        githubRepositoryId: "1999",
      }),
    ).toBe(false);
  });

  it("trusts org ruleset workflows for selected target repositories only", () => {
    expect(
      orgRulesetTargetsRepository({
        scope: "selected_repositories",
        sourceGithubRepositoryId: "1999",
        targetRepositoryIds: ["1001", "1002"],
        githubRepositoryId: "1001",
      }),
    ).toBe(true);
    expect(
      orgRulesetTargetsRepository({
        scope: "selected_repositories",
        sourceGithubRepositoryId: "1999",
        targetRepositoryIds: ["1001", "1002"],
        githubRepositoryId: "1003",
      }),
    ).toBe(false);
  });
});
