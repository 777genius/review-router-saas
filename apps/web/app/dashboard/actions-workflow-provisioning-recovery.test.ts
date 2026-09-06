import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateConfirmedCodexNamespaceAfterWorkflowMerge: vi.fn(),
  assertDashboardRepositoryMutationAllowed: vi.fn(),
  assertWorkspaceFeatureEntitlement: vi.fn(),
  createGitHubAppInstallationOctokit: vi.fn(),
  getPrisma: vi.fn(),
  recordAuditEvent: vi.fn(),
  isWorkflowSetupAlreadyCurrent: vi.fn(),
  resolveReviewRuntimeEnv: vi.fn(),
}));

vi.mock("../../src/server/workflow-setup-readiness", () => ({
  isWorkflowSetupAlreadyCurrent: mocks.isWorkflowSetupAlreadyCurrent,
}));
vi.mock("@reviewrouter/features-review-config", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@reviewrouter/features-review-config")
  >()),
  resolveReviewRuntimeEnv: mocks.resolveReviewRuntimeEnv,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@reviewrouter/features-audit-log", () => ({
  recordAuditEvent: mocks.recordAuditEvent,
  PrismaAuditLogRepository: class PrismaAuditLogRepository {},
}));
vi.mock("@reviewrouter/features-entitlements", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@reviewrouter/features-entitlements")
  >()),
  assertWorkspaceFeatureEntitlement: mocks.assertWorkspaceFeatureEntitlement,
  PrismaEntitlementRepository: class PrismaEntitlementRepository {},
}));
vi.mock("../../src/server/dashboard-mutations", () => ({
  asDashboardGitHubActor: vi.fn(),
  assertDashboardMutationAllowed: vi.fn(),
  assertDashboardRepositoryConfigMutationAllowed: vi.fn(),
  assertDashboardRepositoryMutationAllowed:
    mocks.assertDashboardRepositoryMutationAllowed,
  createGitHubAppInstallationOctokit: mocks.createGitHubAppInstallationOctokit,
  createGitHubUserOctokit: vi.fn(),
  dashboardMutationAccessAuditMetadata: () => ({}),
  getDashboardSignedInActor: vi.fn(),
  getDashboardWorkspaceScope: vi.fn(),
}));
vi.mock("../../src/server/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("../../src/server/codex-rotating-workflow-activation", () => ({
  activateConfirmedCodexNamespaceAfterWorkflowMerge:
    mocks.activateConfirmedCodexNamespaceAfterWorkflowMerge,
}));
vi.mock("../../src/server/hosted-pool-workflow-activation", () => ({
  activateConfirmedHostedPoolBindingAfterWorkflowMerge: vi.fn(),
}));
vi.mock("../../src/server/hosted-pool-dashboard", () => ({}));
vi.mock("../../src/server/prisma-hosted-pool-mutations", () => ({
  createPrismaHostedPoolDashboardMutationPort: vi.fn(),
}));
vi.mock("../../src/server/workflow-public-api-url", () => ({
  resolveWorkflowPublicApiUrl: () => "https://api.reviewrouter.test",
}));

import { resolveReviewRouterActionRef } from "@reviewrouter/platform-config";
import { renderReviewRouterReusableWorkflow } from "@reviewrouter/features-workflow-provisioning";
import {
  createProvisioningPrisma,
  initialCandidate,
} from "../../../../packages/features/workflow-provisioning/src/tests/provisioning-prisma-fixture";

import { confirmSetupPullRequestMergedClientAction } from "./actions";

const { isWorkflowSetupAlreadyCurrent } = await vi.importActual<
  typeof import("../../src/server/workflow-setup-readiness")
>("../../src/server/workflow-setup-readiness");

function reusableWorkflowResponse() {
  return {
    data: {
      type: "file",
      encoding: "base64",
      content: Buffer.from(
        renderReviewRouterReusableWorkflow({
          actionRef: resolveReviewRouterActionRef(),
          apiUrl: "https://api.reviewrouter.test",
          runtimeConfigMode: "oidc",
          conflictReviewFallbackEnabled: true,
        }),
      ).toString("base64"),
    },
  };
}

describe("dashboard setup PR recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(
      "REVIEW_ROUTER_ACTION_REF",
      `777genius/review-router@${"a".repeat(40)}`,
    );
    vi.stubEnv("REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK", "1");
    vi.stubEnv("REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES", "");
    mocks.assertDashboardRepositoryMutationAllowed.mockResolvedValue({
      actor: "user:maintainer",
    });
    mocks.assertWorkspaceFeatureEntitlement.mockResolvedValue(undefined);
    mocks.createGitHubAppInstallationOctokit.mockResolvedValue({
      request: vi.fn(async (route: string) =>
        route.includes("/contents/")
          ? reusableWorkflowResponse()
          : {
              data: {
                merged: true,
                state: "closed",
                base: { ref: "main" },
                head: { ref: "reviewrouter/setup", sha: "b".repeat(40) },
              },
            },
      ),
    });
    mocks.activateConfirmedCodexNamespaceAfterWorkflowMerge.mockResolvedValue(
      undefined,
    );
    mocks.recordAuditEvent.mockResolvedValue(undefined);
    mocks.isWorkflowSetupAlreadyCurrent.mockImplementation(
      isWorkflowSetupAlreadyCurrent,
    );
    mocks.resolveReviewRuntimeEnv.mockResolvedValue({
      config: {
        providers: [
          { kind: "openrouter", authMode: "api_key", model: "openai/gpt-5" },
        ],
      },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("loads failed provisioning deterministically and confirms a reopened merged PR", async () => {
    let provisioningStatus: "failed" | "configured" = "failed";
    const repositoryFindUnique = vi.fn(async () => ({
      id: "repository_1",
      workspaceId: "workspace_1",
      installationId: "installation_1",
      provider: "github",
      githubRepositoryId: 456n,
      owner: "acme",
      name: "widget",
      fullName: "acme/widget",
      visibility: "private",
      defaultBranch: "main",
      selected: true,
      archived: false,
      installation: { status: "active", githubInstallationId: 123n },
      provisioning: [
        {
          attemptId: "attempt_1",
          revision: 1,
          workflowPath: ".github/workflows/reviewrouter.yml",
          workflowStyle: "reusable",
          actionVersion: resolveReviewRouterActionRef(),
          branch: "reviewrouter/setup",
          pullRequestUrl: "https://github.com/acme/widget/pull/7",
          pullRequestHeadSha: "b".repeat(40),
        },
      ],
    }));
    const workflowProvisioning = {
      findFirst: vi.fn(async () => ({
        id: "provisioning_1",
        workspaceId: "workspace_1",
        repositoryId: "repository_1",
        installationId: "installation_1",
        attemptId: "attempt_1",
        revision: 1,
        workflowPath: ".github/workflows/reviewrouter.yml",
        workflowStyle: "reusable",
        actionVersion: resolveReviewRouterActionRef(),
        status: provisioningStatus,
        branch: "reviewrouter/setup",
        pullRequestUrl: "https://github.com/acme/widget/pull/7",
        pullRequestHeadSha: "b".repeat(40),
        errorMessage:
          provisioningStatus === "failed" ? "setup_pr_closed" : null,
      })),
      updateMany: vi.fn(async () => {
        provisioningStatus = "configured";
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => workflowProvisioning.findFirst()),
    };
    const transactionClient = {
      workflowProvisioning,
      repositoryConnection: {
        findFirst: vi.fn(async () => ({ defaultBranch: "main" })),
      },
    };
    mocks.getPrisma.mockReturnValue({
      repositoryConnection: {
        findUnique: repositoryFindUnique,
        findFirst: transactionClient.repositoryConnection.findFirst,
      },
      hostedCodexRepositoryBinding: { findFirst: vi.fn(async () => null) },
      workflowProvisioning,
      $transaction: vi.fn(
        async (callback: (tx: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    });
    const formData = new FormData();
    formData.set("repositoryId", "repository_1");
    formData.set("workspaceId", "workspace_1");

    await expect(
      confirmSetupPullRequestMergedClientAction(formData),
    ).resolves.toEqual({
      params: {
        notice: "setup_pr_merged",
        repository: "acme/widget",
        workspace: "workspace_1",
        section: "repositories",
      },
    });

    expect(repositoryFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          provisioning: {
            where: {
              workspaceId: "workspace_1",
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 1,
            select: {
              attemptId: true,
              revision: true,
              branch: true,
              pullRequestUrl: true,
              pullRequestHeadSha: true,
            },
          },
        }),
      }),
    );
    expect(workflowProvisioning.updateMany).toHaveBeenCalledTimes(1);

    await expect(
      confirmSetupPullRequestMergedClientAction(formData),
    ).resolves.toMatchObject({ params: { notice: "setup_pr_merged" } });
    expect(workflowProvisioning.updateMany).toHaveBeenCalledTimes(1);
  });
  it.each([
    "verified",
    "workflow_absent",
    "activation_failed",
    "transfer_placeholder",
  ] as const)(
    "handles installed workflow without bound provisioning evidence: %s",
    async (scenario) => {
      const marker =
        scenario === "transfer_placeholder"
          ? {
              ...initialCandidate,
              status: "not_started" as const,
              workflowStyle: "explicit" as const,
              actionVersion: "",
              pullRequestHeadSha: null,
              pullRequestUrl: null,
            }
          : null;
      const state = createProvisioningPrisma(marker);
      const repository = {
        id: "repository_1",
        workspaceId: "workspace_1",
        installationId: "installation_1",
        provider: "github",
        githubRepositoryId: 456n,
        owner: "acme",
        name: "widget",
        fullName: "acme/widget",
        visibility: "private",
        defaultBranch: "main",
        selected: true,
        archived: false,
        installation: { status: "active", githubInstallationId: 123n },
        provisioning: marker ? [marker] : [],
      };
      mocks.getPrisma.mockReturnValue({
        ...state.prisma,
        repositoryConnection: {
          ...state.repositoryConnection,
          findUnique: vi.fn(async () => repository),
        },
        hostedCodexRepositoryBinding: { findFirst: vi.fn(async () => null) },
      });
      const request = vi.fn(async (route: string) =>
        route.includes("/contents/")
          ? reusableWorkflowResponse()
          : { data: {} },
      );
      mocks.createGitHubAppInstallationOctokit.mockResolvedValue({ request });
      if (scenario === "workflow_absent")
        mocks.isWorkflowSetupAlreadyCurrent.mockResolvedValue(false);
      if (scenario === "activation_failed")
        mocks.activateConfirmedCodexNamespaceAfterWorkflowMerge.mockRejectedValueOnce(
          new Error("activation_failed"),
        );
      const form = new FormData();
      form.set("workspaceId", "workspace_1");
      form.set("repositoryId", "repository_1");
      const result = await confirmSetupPullRequestMergedClientAction(form);
      if (scenario === "verified" || scenario === "transfer_placeholder") {
        expect(result).toMatchObject({ params: { notice: "setup_pr_merged" } });
        expect(state.current()).toMatchObject({
          status: "configured",
          pullRequestUrl: null,
          pullRequestHeadSha: null,
          workflowPath: ".github/workflows/reviewrouter.yml",
          workflowStyle: "reusable",
          actionVersion: resolveReviewRouterActionRef(),
        });
        expect(mocks.isWorkflowSetupAlreadyCurrent).toHaveBeenCalledWith(
          expect.objectContaining({
            defaultBranch: "main",
            githubInstallationId: "123",
          }),
          expect.anything(),
        );
        expect(
          mocks.activateConfirmedCodexNamespaceAfterWorkflowMerge,
        ).toHaveBeenCalled();
      } else {
        expect(result.params).not.toHaveProperty("notice");
        expect(state.workflowProvisioning.create).not.toHaveBeenCalled();
      }
      expect(request.mock.calls.flat()).not.toContain(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      );
    },
  );

  it.each([
    "verified",
    "workflow_absent",
    "workflow_wrong_ref",
    "activation_failed",
    "unmerged_wrong_base",
    "stored_head_wrong_base",
    "head_mismatch",
    "wrong_workspace",
    "missing_installation",
    "transfer_during_probe",
    "installation_during_probe",
    "attempt_during_probe",
    "revision_during_probe",
    "head_during_probe",
    "branch_during_probe",
    "url_during_probe",
    "artifact_path",
    "artifact_style",
    "artifact_version",
    "transfer_during_activation",
    "attempt_during_activation",
    "revision_during_activation",
  ] as const)(
    "composes the real inspector, workflow probe and confirmation across master -> main: %s",
    async (scenario) => {
      const historical = {
        ...initialCandidate,
        pullRequestHeadSha:
          scenario === "head_mismatch"
            ? "c".repeat(40)
            : scenario === "stored_head_wrong_base"
              ? "b".repeat(40)
              : null,
        workflowPath:
          scenario === "artifact_path"
            ? ".github/workflows/other.yml"
            : ".github/workflows/reviewrouter.yml",
        workflowStyle:
          scenario === "artifact_style"
            ? ("explicit" as const)
            : ("reusable" as const),
        actionVersion:
          scenario === "artifact_version"
            ? "obsolete"
            : resolveReviewRouterActionRef(),
      };
      const state = createProvisioningPrisma(historical);
      const repository = {
        id: "repository_1",
        workspaceId: "workspace_1",
        installationId:
          scenario === "missing_installation" ? null : "installation_1",
        provider: "github",
        githubRepositoryId: 456n,
        owner: "acme",
        name: "widget",
        fullName: "acme/widget",
        visibility: "private",
        defaultBranch: "main",
        selected: true,
        archived: false,
        installation: { status: "active", githubInstallationId: 123n },
        provisioning: [historical],
      };
      mocks.getPrisma.mockReturnValue({
        ...state.prisma,
        repositoryConnection: {
          ...state.repositoryConnection,
          findUnique: vi.fn(async () => repository),
        },
        hostedCodexRepositoryBinding: { findFirst: vi.fn(async () => null) },
      });
      const events: string[] = [];
      let expectedCurrent = historical;
      function changeAttempt() {
        if (scenario.startsWith("transfer_")) state.transfer();
        if (scenario.startsWith("installation_"))
          state.replace({ ...historical, installationId: "installation_2" });
        if (scenario.startsWith("attempt_"))
          state.replace({ ...historical, attemptId: "new_attempt" });
        if (scenario.startsWith("revision_"))
          state.replace({ ...historical, revision: historical.revision + 1 });
        if (scenario === "head_during_probe")
          state.replace({ ...historical, pullRequestHeadSha: "b".repeat(40) });
        if (scenario === "branch_during_probe")
          state.replace({ ...historical, branch: "reviewrouter/new-setup" });
        if (scenario === "url_during_probe")
          state.replace({
            ...historical,
            pullRequestUrl: "https://github.com/acme/widget/pull/8",
          });
        expectedCurrent = state.current()!;
      }
      const request = vi.fn(
        async (route: string, parameters?: Record<string, unknown>) => {
          if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
            events.push("inspect_pr");
            return {
              data: {
                merged: scenario !== "unmerged_wrong_base",
                state: scenario === "unmerged_wrong_base" ? "open" : "closed",
                base: { ref: scenario === "head_mismatch" ? "main" : "master" },
                head: { ref: historical.branch, sha: "b".repeat(40) },
              },
            };
          }
          if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
            events.push(`workflow:${parameters?.ref}`);
            if (scenario.endsWith("_during_probe")) changeAttempt();
            // Even though master has valid bytes, only current main is authoritative.
            if (parameters?.ref === "main" && scenario === "workflow_absent")
              throw Object.assign(new Error("missing"), { status: 404 });
            const ref =
              parameters?.ref === "main" && scenario === "workflow_wrong_ref"
                ? `777genius/review-router@${"d".repeat(40)}`
                : resolveReviewRouterActionRef();
            return {
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from(
                  renderReviewRouterReusableWorkflow({
                    actionRef: ref,
                    apiUrl: "https://api.reviewrouter.test",
                    runtimeConfigMode: "oidc",
                    conflictReviewFallbackEnabled: true,
                  }),
                ).toString("base64"),
              },
            };
          }
          throw new Error(`unexpected_github_request:${route}`);
        },
      );
      mocks.createGitHubAppInstallationOctokit.mockResolvedValue({ request });
      mocks.isWorkflowSetupAlreadyCurrent.mockImplementation(
        isWorkflowSetupAlreadyCurrent,
      );
      mocks.activateConfirmedCodexNamespaceAfterWorkflowMerge.mockImplementation(
        async () => {
          events.push("activation");
          if (scenario.endsWith("_during_activation")) changeAttempt();
          if (scenario === "activation_failed")
            throw new Error("activation_failed");
        },
      );
      const form = new FormData();
      form.set(
        "workspaceId",
        scenario === "wrong_workspace" ? "workspace_2" : "workspace_1",
      );
      form.set("repositoryId", "repository_1");
      const result = await confirmSetupPullRequestMergedClientAction(form);
      if (scenario === "verified") {
        expect({ params: result.params, events }).toMatchObject({
          params: { notice: "setup_pr_merged" },
          events: ["inspect_pr", "workflow:main", "activation"],
        });
        expect(state.current()).toEqual({
          ...historical,
          status: "configured",
          revision: historical.revision + 1,
        });
        expect(state.workflowProvisioning.updateMany).toHaveBeenCalledTimes(1);
        expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({ source: "workflow" }),
          }),
          expect.anything(),
        );
      } else {
        expect(result.params).not.toHaveProperty("notice");
        expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
        if (
          scenario === "unmerged_wrong_base" ||
          scenario === "stored_head_wrong_base"
        ) {
          expect(result.params.error).toBe("setup_pr_wrong_base_branch");
          expect(events).toEqual(["inspect_pr"]);
          expect(state.current()).toEqual({
            ...historical,
            status: "failed",
            errorMessage: "setup_pr_wrong_base_branch",
            revision: historical.revision + 1,
          });
        } else {
          expect(state.workflowProvisioning.updateMany).not.toHaveBeenCalled();
          expect(state.current()).toEqual(expectedCurrent);
          if (
            scenario === "workflow_absent" ||
            scenario === "workflow_wrong_ref"
          )
            expect(result.params.error).toBe("setup_pr_not_merged");
          if (
            scenario.includes("_during_") ||
            scenario.startsWith("artifact_") ||
            scenario === "head_mismatch"
          )
            expect(result.params.error).toBe("github_operation_failed");
          expect(events).toEqual(
            scenario === "wrong_workspace" ||
              scenario === "missing_installation"
              ? []
              : scenario === "head_mismatch"
                ? ["inspect_pr"]
                : scenario === "activation_failed" ||
                    scenario.endsWith("_during_activation")
                  ? ["inspect_pr", "workflow:main", "activation"]
                  : ["inspect_pr", "workflow:main"],
          );
        }
        if (
          scenario !== "activation_failed" &&
          !scenario.endsWith("_during_activation")
        )
          expect(
            mocks.activateConfirmedCodexNamespaceAfterWorkflowMerge,
          ).not.toHaveBeenCalled();
      }
      expect(state.workflowProvisioning.create).not.toHaveBeenCalled();
      for (const [route, parameters] of request.mock.calls) {
        if (route.includes("/contents/")) {
          expect(parameters).toEqual({
            owner: "acme",
            repo: "widget",
            ref: "main",
            path: ".github/workflows/reviewrouter.yml",
          });
        }
      }
      if (scenario !== "wrong_workspace" && scenario !== "missing_installation")
        expect(mocks.createGitHubAppInstallationOctokit).toHaveBeenCalledWith(
          "123",
        );
    },
  );
});
