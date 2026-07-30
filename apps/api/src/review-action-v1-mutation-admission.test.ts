import { describe, expect, it } from "vitest";
import {
  type GitHubActionsOidcClaims,
  LegacyReviewMutationOperation,
} from "@reviewrouter/features-action-control-plane";
import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
  ScmProvider,
  type ReviewMutationAuthority,
  type ScmRepositoryIdentity,
} from "@reviewrouter/features-review-run-control";
import { ReviewRunControlLegacyMutationAdmission } from "./review-action-v1-mutation-admission";

describe("ReviewRunControlLegacyMutationAdmission", () => {
  const workflowSha = "a".repeat(40);

  it("fails closed until the repository has a durable SCM identity", async () => {
    const admission = new ReviewRunControlLegacyMutationAdmission({
      repositoryIdentities: {
        findScmRepositoryIdentityById: async () => null,
        findScmRepositoryIdentityByExternalIdentity: async () => null,
      },
      legacyAuthorityAdmission: {
        admit: async () => {
          throw new Error("unexpected_admission");
        },
      },
    });

    await expect(
      admission.assertLegacyReviewMutationAllowed(
        sessionExchangeInput(
          "pull_request",
          ".github/workflows/reviewrouter.yml",
        ),
      ),
    ).rejects.toThrow("legacy_review_mutation_identity_unavailable");
  });

  it.each([
    ReviewMutationMode.V1Draining,
    ReviewMutationMode.V2Active,
    ReviewMutationMode.Paused,
  ])("blocks new legacy mutation capability in %s", async (mode) => {
    const admission = createAdmission(mode);

    await expect(
      admission.assertLegacyReviewMutationAllowed({
        operation: LegacyReviewMutationOperation.CommentToken,
        githubRepositoryId: "123",
        repositoryFullName: "777genius/example",
      }),
    ).rejects.toThrow(`legacy_review_mutation_blocked:${mode}`);
  });

  it.each([ReviewMutationMode.V1Draining, ReviewMutationMode.V2Active])(
    "allows managed v2 session-derived comment tokens in %s",
    async (mode) => {
      for (const input of [
        commentTokenInput(
          "workflow_dispatch",
          ".github/workflows/reviewrouter-codex.yml",
        ),
        commentTokenInput(
          "pull_request",
          ".github/workflows/reviewrouter-codex.yml",
        ),
        commentTokenInput(
          "issue_comment",
          ".github/workflows/reviewrouter-interaction.yml",
        ),
      ]) {
        await expect(
          createAdmission(mode).assertLegacyReviewMutationAllowed(input),
        ).resolves.toBeUndefined();
      }
    },
  );

  it("keeps session-derived comment tokens fail-closed while paused", async () => {
    await expect(
      createAdmission(
        ReviewMutationMode.Paused,
      ).assertLegacyReviewMutationAllowed(
        commentTokenInput(
          "workflow_dispatch",
          ".github/workflows/reviewrouter-codex.yml",
        ),
      ),
    ).rejects.toThrow(
      `legacy_review_mutation_blocked:${ReviewMutationMode.Paused}`,
    );
  });

  it("blocks unmanaged session-derived comment tokens", async () => {
    await expect(
      createAdmission(
        ReviewMutationMode.V2Active,
      ).assertLegacyReviewMutationAllowed(
        commentTokenInput("pull_request", ".github/workflows/reviewrouter.yml"),
      ),
    ).rejects.toThrow(
      `legacy_review_mutation_blocked:${ReviewMutationMode.V2Active}`,
    );
  });

  it("allows legacy mutation only after the durable V1 fence is established", async () => {
    await expect(
      createAdmission(null).assertLegacyReviewMutationAllowed(
        sessionExchangeInput(
          "pull_request",
          ".github/workflows/reviewrouter.yml",
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(
      createAdmission(
        ReviewMutationMode.V1Open,
      ).assertLegacyReviewMutationAllowed(
        sessionExchangeInput(
          "pull_request",
          ".github/workflows/reviewrouter.yml",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["workflow_dispatch", ".github/workflows/reviewrouter-codex.yml"] as const,
    ["pull_request", ".github/workflows/reviewrouter-codex.yml"] as const,
    [
      "issue_comment",
      ".github/workflows/reviewrouter-interaction.yml",
    ] as const,
    [
      "pull_request_review_comment",
      ".github/workflows/reviewrouter-interaction.yml",
    ] as const,
    [
      "workflow_dispatch",
      ".github/workflows/reviewrouter-interaction.yml",
    ] as const,
  ])(
    "allows managed v2 session bootstrap for %s from %s",
    async (eventName, workflowPath) => {
      for (const mode of [
        ReviewMutationMode.V1Draining,
        ReviewMutationMode.V2Active,
      ]) {
        await expect(
          createAdmission(mode).assertLegacyReviewMutationAllowed(
            sessionExchangeInput(eventName, workflowPath),
          ),
        ).resolves.toBeUndefined();
      }
    },
  );

  it.each([
    ["workflow_dispatch", ".github/workflows/untrusted.yml"] as const,
    ["issue_comment", ".github/workflows/reviewrouter-codex.yml"] as const,
    ["pull_request", ".github/workflows/untrusted.yml"] as const,
  ])(
    "blocks unmanaged session bootstrap for %s from %s",
    async (eventName, workflowPath) => {
      for (const mode of [
        ReviewMutationMode.V1Draining,
        ReviewMutationMode.V2Active,
      ]) {
        await expect(
          createAdmission(mode).assertLegacyReviewMutationAllowed(
            sessionExchangeInput(eventName, workflowPath),
          ),
        ).rejects.toThrow(`legacy_review_mutation_blocked:${mode}`);
      }
    },
  );

  it("keeps the repository kill switch closed for managed session bootstrap", async () => {
    await expect(
      createAdmission(
        ReviewMutationMode.Paused,
      ).assertLegacyReviewMutationAllowed(
        sessionExchangeInput(
          "issue_comment",
          ".github/workflows/reviewrouter-interaction.yml",
        ),
      ),
    ).rejects.toThrow(
      `legacy_review_mutation_blocked:${ReviewMutationMode.Paused}`,
    );
  });

  it("verifies the claimed workflow revision instead of the moving default branch", async () => {
    const observed: unknown[] = [];
    await expect(
      createAdmission(ReviewMutationMode.V2Active, {
        compatible: true,
        observe: (input) => observed.push(input),
      }).assertLegacyReviewMutationAllowed(
        sessionExchangeInput(
          "issue_comment",
          ".github/workflows/reviewrouter-interaction.yml",
          "b".repeat(40),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(observed).toEqual([
      expect.objectContaining({
        workflowPath: ".github/workflows/reviewrouter-interaction.yml",
        workflowSha: "b".repeat(40),
      }),
    ]);
  });

  it.each([
    {
      name: "incompatible workflow source",
      inputSha: workflowSha,
      verification: {
        compatible: false,
      },
    },
    {
      name: "missing source verifier",
      inputSha: workflowSha,
      verification: null,
    },
    {
      name: "missing workflow commit claim",
      inputSha: null,
      verification: {
        compatible: true,
      },
    },
  ])("blocks $name", async ({ inputSha, verification }) => {
    await expect(
      createAdmission(
        ReviewMutationMode.V2Active,
        verification,
      ).assertLegacyReviewMutationAllowed(
        sessionExchangeInput(
          "issue_comment",
          ".github/workflows/reviewrouter-interaction.yml",
          inputSha,
        ),
      ),
    ).rejects.toThrow(
      `legacy_review_mutation_blocked:${ReviewMutationMode.V2Active}`,
    );
  });
});

function sessionExchangeInput(
  eventName: GitHubActionsOidcClaims["event_name"],
  workflowPath: string,
  workflowSha: string | null = "a".repeat(40),
) {
  return {
    operation: LegacyReviewMutationOperation.SessionExchange,
    githubRepositoryId: "123",
    githubInstallationId: "456",
    repositoryFullName: "777genius/example",
    repositoryOwner: "777genius",
    eventName,
    workflowPath,
    workflowSha,
  } as const;
}

function commentTokenInput(
  eventName: GitHubActionsOidcClaims["event_name"],
  workflowPath: string,
) {
  return {
    operation: LegacyReviewMutationOperation.CommentToken,
    githubRepositoryId: "123",
    repositoryFullName: "777genius/example",
    eventName,
    workflowPath,
  } as const;
}

function createAdmission(
  mode: ReviewMutationMode | null,
  verification: {
    readonly compatible: boolean;
    readonly observe?: (input: unknown) => void;
  } | null = {
    compatible: true,
  },
) {
  const identity: ScmRepositoryIdentity = {
    scmRepositoryIdentityId: "identity-1",
    provider: ScmProvider.GitHub,
    normalizedSourceBaseUrl: "https://github.com",
    externalRepositoryId: "123",
    version: 1,
    currentWorkspaceId: "workspace-1",
    currentRepositoryConnectionId: "repository-1",
    createdAt: new Date("2026-07-22T00:00:00.000Z"),
    boundAt: new Date("2026-07-22T00:00:00.000Z"),
    unboundAt: null,
  };
  const authority: ReviewMutationAuthority | null = mode
    ? {
        scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
        laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
        mode,
        epoch: 1n,
        version: 1,
        drainPolicyVersion: null,
        activationSafetyDecisionHash: null,
        drainStartedAt: null,
        v1AdmissionClosedAt: null,
        drainNotBefore: null,
        managedWorkflowInventoryHash: null,
        initializedAt: new Date("2026-07-22T00:00:00.000Z"),
        activatedAt: null,
        pausedAt: null,
      }
    : null;
  return new ReviewRunControlLegacyMutationAdmission({
    repositoryIdentities: {
      findScmRepositoryIdentityById: async () => identity,
      findScmRepositoryIdentityByExternalIdentity: async () => identity,
    },
    legacyAuthorityAdmission: {
      admit: async () =>
        authority ?? {
          scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
          laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
          mode: ReviewMutationMode.V1Open,
          epoch: 0n,
          version: 1,
          drainPolicyVersion: null,
          activationSafetyDecisionHash: null,
          drainStartedAt: null,
          v1AdmissionClosedAt: null,
          drainNotBefore: null,
          managedWorkflowInventoryHash: null,
          initializedAt: new Date("2026-07-22T00:00:00.000Z"),
          activatedAt: null,
          pausedAt: null,
        },
    },
    ...(verification
      ? {
          workflowSourceVerifier: {
            verifyManagedV2SessionBootstrapSource: async (input: unknown) => {
              verification.observe?.(input);
              return { compatible: verification.compatible };
            },
          },
        }
      : {}),
  });
}
