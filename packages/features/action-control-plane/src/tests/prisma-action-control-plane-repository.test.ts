import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  orgRulesetTargetsRepository,
  PrismaActionControlPlaneRepository,
} from "../infrastructure/prisma/prisma-action-control-plane-repository.js";

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

  it("hydrates Claude Code provider records without falling back to Codex", async () => {
    const prisma = {
      reviewConfiguration: {
        findUnique: vi.fn().mockResolvedValue({
          versions: [
            {
              version: 11,
              schemaVersion: 2,
              providerKind: "codex",
              providerAuthMode: "codex_subscription_oauth",
              model: "gpt-5.5",
              reasoningEffort: "medium",
              agenticContext: true,
              fastMode: false,
              failOnSeverity: "critical",
              inlineMaxComments: 5,
              providerLimit: 1,
              providerMaxParallel: 1,
              inlineMinAgreement: 1,
              targetTokensPerBatch: 50000,
              providers: [
                {
                  providerKind: "claude",
                  providerAuthMode: "claude_code_oauth",
                  model: "sonnet",
                  reasoningEffort: "medium",
                  agenticContext: true,
                  fastMode: false,
                },
              ],
            },
          ],
        }),
      },
    } as unknown as PrismaClient;
    const repository = new PrismaActionControlPlaneRepository(prisma);

    const record = await repository.findRuntimeReviewConfiguration({
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
    });

    expect(record?.config.provider).toMatchObject({
      kind: "claude",
      authMode: "claude_code_oauth",
      model: "sonnet",
    });
    expect(record?.config.providers).toHaveLength(1);
  });
});
