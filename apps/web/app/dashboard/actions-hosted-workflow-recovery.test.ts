import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexRotatingReviewActionV2Mode,
  CodexRotatingT0WorkflowSchemaVersion,
  createVersionedProviderSecretNamespace,
  renderCodexRotatingAdvisoryWorkflow,
  renderCanonicalCodexRotatingInteractionWorkflowV3,
  defaultInteractionWorkflowPath,
  hostedPoolWorkflowSemanticSha256,
  renderCanonicalHostedPoolWorkflowV2,
} from "@reviewrouter/features-workflow-provisioning";
import {
  createProvisioningPrisma,
  initialCandidate,
} from "../../../../packages/features/workflow-provisioning/src/tests/provisioning-prisma-fixture";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  createOctokit: vi.fn(),
  runtime: vi.fn(),
  namespace: vi.fn(),
  audit: vi.fn(),
  activateCodex: vi.fn(),
  switchConfiguration: vi.fn(),
  setRepositorySource: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("../../src/server/hosted-pool-dashboard", () => ({}));
vi.mock("../../src/server/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@reviewrouter/features-review-config", async (original) => ({
  ...(await original<typeof import("@reviewrouter/features-review-config")>()),
  resolveReviewRuntimeEnv: mocks.runtime,
}));
vi.mock("@reviewrouter/features-provider-setup", async (original) => ({
  ...(await original<typeof import("@reviewrouter/features-provider-setup")>()),
  inspectCodexRotatingWorkflowNamespace: mocks.namespace,
}));
vi.mock("@reviewrouter/features-audit-log", () => ({
  recordAuditEvent: mocks.audit,
  PrismaAuditLogRepository: class {},
}));
vi.mock("@reviewrouter/features-entitlements", async (original) => ({
  ...(await original<typeof import("@reviewrouter/features-entitlements")>()),
  assertWorkspaceFeatureEntitlement: vi.fn(),
  PrismaEntitlementRepository: class {},
}));
vi.mock("../../src/server/dashboard-mutations", () => ({
  assertDashboardRepositoryMutationAllowed: async () => ({
    actor: "fake:maintainer",
  }),
  createGitHubAppInstallationOctokit: mocks.createOctokit,
  dashboardMutationAccessAuditMetadata: () => ({}),
}));
vi.mock("../../src/server/codex-rotating-workflow-activation", () => ({
  activateConfirmedCodexNamespaceAfterWorkflowMerge: mocks.activateCodex,
}));
// Observe the real hosted verifier/activation adapter at its first effect.
// Account/configuration internals and all transport remain disposable fakes.
vi.mock("../../src/server/prisma-hosted-pool-mutations", () => ({
  switchRepositoryConfigurationAuthMode: mocks.switchConfiguration,
  createPrismaHostedPoolDashboardMutationPort: () => ({
    setRepositorySource: mocks.setRepositorySource,
  }),
}));
vi.mock("../../src/server/workflow-public-api-url", () => ({
  resolveWorkflowPublicApiUrl: () => "https://api.reviewrouter.test",
}));

import { confirmSetupPullRequestMergedClientAction } from "./actions";

const actionRef = `777genius/review-router@${"a".repeat(40)}`;
const commitSha = "d".repeat(40);
const workflowPath = ".github/workflows/reviewrouter-codex.yml";

function matches(
  actual: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object") {
      if ("in" in expected)
        return (expected.in as unknown[]).includes(actual[key]);
      return (
        actual[key] !== null &&
        typeof actual[key] === "object" &&
        matches(
          actual[key] as Record<string, unknown>,
          expected as Record<string, unknown>,
        )
      );
    }
    return actual[key] === expected;
  });
}

function fixture(baseBranch: "main" | "master", scenario = "valid") {
  const rotating = scenario.startsWith("rotating_");
  const actualActionRef =
    scenario === "trusted_overlap"
      ? `777genius/review-router@${"c".repeat(40)}`
      : actionRef;
  const historical = {
    ...initialCandidate,
    pullRequestHeadSha: scenario.startsWith("stored_")
      ? scenario === "stored_head_mismatch"
        ? "c".repeat(40)
        : "b".repeat(40)
      : null,
    workflowPath:
      scenario === "artifact_path"
        ? ".github/workflows/reviewrouter.yml"
        : workflowPath,
    workflowStyle:
      scenario === "artifact_style"
        ? ("explicit" as const)
        : ("reusable" as const),
    actionVersion:
      scenario === "artifact_version" ? "obsolete" : actualActionRef,
    ...(scenario === "no_history" ? { pullRequestUrl: null } : {}),
  };
  const state = createProvisioningPrisma(
    scenario === "no_history" ? null : historical,
  );
  let repository = {
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
    provisioning: scenario === "no_history" ? [] : [historical],
  };
  if (scenario === "initial_installation")
    repository = {
      ...repository,
      installation: { ...repository.installation, status: "suspended" },
    };
  let binding: Record<string, unknown> | null =
    scenario === "missing_binding" ||
    (rotating && scenario !== "rotating_active_binding")
      ? null
      : {
          id: "binding-1",
          workspaceId:
            scenario === "binding_workspace" ? "workspace_2" : "workspace_1",
          repositoryConnectionId:
            scenario === "binding_repository" ? "repository_2" : "repository_1",
          status:
            scenario === "binding_ineligible"
              ? "draining"
              : scenario === "already_active" ||
                  scenario === "active_attestation_invalid" ||
                  scenario === "rotating_active_binding"
                ? "active"
                : "pending_activation",
          revision: 3n,
          stateVersion: 7n,
          tombstonedAt: scenario === "binding_tombstoned" ? new Date(0) : null,
        };
  const events: string[] = [];
  let source = renderCanonicalHostedPoolWorkflowV2({
    actionRef:
      scenario === "untrusted_ref"
        ? `777genius/review-router@${"c".repeat(40)}`
        : actualActionRef,
    apiUrl:
      scenario === "wrong_api"
        ? "https://other.reviewrouter.test"
        : "https://api.reviewrouter.test",
    providerInstanceId:
      scenario === "wrong_provider"
        ? "hosted-pool:repository:999"
        : "hosted-pool:repository:456",
    bindingId: scenario === "wrong_binding" ? "binding-2" : "binding-1",
    bindingRevision: scenario === "wrong_binding_revision" ? 4 : 3,
  });
  if (scenario === "invalid_workflow")
    source = source.replace("id-token: write", "id-token: read");
  if (scenario === "runtime_ref_mismatch")
    source = source.replace(
      `runtime_ref: "${"a".repeat(40)}"`,
      `runtime_ref: "${"c".repeat(40)}"`,
    );
  if (rotating || scenario === "pending_rotating_config") {
    vi.stubEnv("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH", "1");
    vi.stubEnv("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS", "W".repeat(43));
    mocks.runtime.mockResolvedValue({
      config: {
        providers: [
          {
            kind: "codex",
            authMode: "codex_subscription_oauth_rotating",
            model: "gpt-5.3-codex",
          },
        ],
      },
    });
    const namespace = createVersionedProviderSecretNamespace({
      scope: { repositoryId: "456", providerInstanceId: "codex-rotating:456" },
      namespaceId: `sns_${"a".repeat(32)}`,
      name: `REVIEWROUTER_CODEX_AUTH_JSON_R456_P${createHash("sha256").update("codex-rotating:456").digest("hex").slice(0, 16)}_E4_${"a".repeat(32)}`,
      epoch: 4,
    });
    mocks.namespace.mockResolvedValue({
      source: "confirmed_setup_candidate",
      namespace,
      claimId: "fake_claim",
      attemptId: "fake_attempt",
    });
    if (rotating)
      source = renderCodexRotatingAdvisoryWorkflow({
        actionRef,
        apiUrl: "https://api.reviewrouter.test",
        providerInstanceId: "codex-rotating:456",
        reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
        workflowSchemaVersion:
          CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
        activeSecretNamespace: namespace,
      });
  }
  const blobSha = createHash("sha1")
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest("hex");
  if (binding?.status === "active")
    Object.assign(binding, {
      workflowPath,
      workflowActionRef: actionRef,
      workflowSourceCommitSha: commitSha,
      workflowSourceBlobSha: blobSha,
      workflowSourceSha256: createHash("sha256").update(source).digest("hex"),
      workflowSemanticSha256: hostedPoolWorkflowSemanticSha256(source),
      workflowSourceTrust: "trusted_default_branch_revision",
      attestedBindingRevision:
        scenario === "active_attestation_invalid" ? 2n : 3n,
      attestedGithubRepositoryId: 456n,
    });
  const initialBinding = binding ? { ...binding } : null;
  let expectedCurrent = state.current();
  function race() {
    if (scenario.includes("transfer_"))
      repository = {
        ...repository,
        workspaceId: "workspace_2",
        installationId: "installation_2",
      };
    if (scenario.includes("installation_"))
      repository = { ...repository, installationId: "installation_2" };
    if (scenario === "inactive_during_probe")
      repository = {
        ...repository,
        installation: { ...repository.installation, status: "suspended" },
      };
    if (scenario === "deselected_during_probe")
      repository = { ...repository, selected: false };
    if (scenario === "archived_during_probe")
      repository = { ...repository, archived: true };
    if (scenario === "default_during_probe")
      repository = { ...repository, defaultBranch: "trunk" };
    if (scenario.includes("attempt_"))
      state.replace({ ...historical, attemptId: "replacement" });
    if (scenario.includes("revision_during"))
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
    if (scenario === "artifact_during_activation")
      state.replace({
        ...historical,
        workflowPath: ".github/workflows/other.yml",
      });
    if (scenario === "binding_removed_during_probe") binding = null;
    if (scenario === "binding_changed_during_probe" && binding)
      binding = { ...binding, id: "binding-2" };
    if (scenario === "binding_revised_during_probe" && binding)
      binding = { ...binding, revision: 4n };
    if (scenario === "binding_state_during_probe" && binding)
      binding = { ...binding, stateVersion: 8n };
    if (scenario === "binding_draining_during_probe" && binding)
      binding = { ...binding, status: "draining" };
    expectedCurrent = state.current();
  }
  const scopedRepository = vi.fn(
    async ({ where }: { where: Record<string, unknown> }) =>
      matches(repository, where) ? { ...repository } : null,
  );
  const findBinding = vi.fn(
    async ({ where }: { where: Record<string, unknown> }) => {
      events.push("binding_lookup");
      const result =
        binding && matches({ ...binding, repository }, where)
          ? { ...binding }
          : null;
      if (
        scenario === "binding_replaced_before_verifier" &&
        events.filter((event) => event === "binding_lookup").length === 1 &&
        binding
      )
        binding = { ...binding, id: "binding-2", revision: 4n };
      return result;
    },
  );
  const updateBinding = vi.fn(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      events.push("binding_write");
      if (!binding || !matches({ ...binding, repository }, where))
        return { count: 0 };
      binding = {
        ...binding,
        ...data,
        stateVersion: BigInt(binding.stateVersion as bigint) + 1n,
      };
      if (scenario.endsWith("_during_activation")) race();
      return { count: 1 };
    },
  );
  const hostedCodexRepositoryBinding = {
    findFirst: findBinding,
    updateMany: updateBinding,
  };
  const transaction = {
    ...state.prisma,
    repositoryConnection: { findFirst: scopedRepository },
    hostedCodexRepositoryBinding,
  };
  mocks.getPrisma.mockReturnValue({
    ...transaction,
    repositoryConnection: {
      findFirst: scopedRepository,
      findUnique: vi.fn(async () => ({ ...repository })),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback(transaction),
    ),
  });
  let refCount = 0;
  const request = vi.fn(
    async (route: string, parameters?: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        events.push("inspect_pr");
        return {
          data: {
            merged: scenario !== "unmerged_wrong_base",
            state: scenario === "unmerged_wrong_base" ? "open" : "closed",
            base: { ref: baseBranch },
            head: { ref: historical.branch, sha: "b".repeat(40) },
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}")
        return {
          data: {
            id: scenario === "github_repository_mismatch" ? 999 : 456,
            full_name: "acme/widget",
            default_branch: "main",
          },
        };
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
        events.push(`ref:${parameters?.ref}`);
        refCount += 1;
        // The workflow must be from CURRENT main's immutable revision, never old master.
        if (parameters?.ref !== "heads/main")
          throw new Error("wrong_default_branch");
        return {
          data: {
            object: {
              sha:
                scenario === "default_head_moved" && refCount === 2
                  ? "e".repeat(40)
                  : commitSha,
            },
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        if (rotating) {
          events.push(`workflow:${parameters?.path}:${parameters?.ref}`);
          if (parameters?.ref !== "main") throw new Error("wrong_rotating_ref");
          const interaction =
            parameters.path === defaultInteractionWorkflowPath;
          if (interaction && scenario === "rotating_missing_interaction")
            throw Object.assign(new Error("absent"), { status: 404 });
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(
                interaction
                  ? renderCanonicalCodexRotatingInteractionWorkflowV3({
                      actionRef,
                      apiUrl: "https://api.reviewrouter.test",
                      runtimeConfigMode: "oidc",
                    })
                  : source,
              ).toString("base64"),
            },
          };
        }
        events.push(`workflow:${parameters?.path}:${parameters?.ref}`);
        if (scenario.endsWith("_during_probe")) race();
        if (parameters?.path !== workflowPath || scenario === "workflow_absent")
          throw Object.assign(new Error("absent"), { status: 404 });
        if (parameters.ref !== commitSha)
          throw new Error("workflow_not_pinned_to_current_main");
        return {
          data: {
            type: "file",
            path:
              scenario === "response_path_mismatch"
                ? ".github/workflows/other.yml"
                : workflowPath,
            encoding: "base64",
            content: Buffer.from(source).toString("base64"),
            sha: scenario === "blob_mismatch" ? "f".repeat(40) : blobSha,
          },
        };
      }
      throw new Error(`unexpected_fake_transport:${route}`);
    },
  );
  mocks.createOctokit.mockResolvedValue({ request });
  mocks.switchConfiguration.mockImplementation(async () => {
    events.push("activation_effect");
    return scenario !== "activation_rejected";
  });
  const form = new FormData();
  form.set("repositoryId", "repository_1");
  form.set(
    "workspaceId",
    scenario === "wrong_workspace" ? "workspace_2" : "workspace_1",
  );
  return {
    state,
    historical,
    events,
    request,
    findBinding,
    updateBinding,
    form,
    scopedRepository,
    expectedCurrent: () => expectedCurrent,
    binding: () => binding,
    initialBinding,
  };
}

describe("hosted setup recovery composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REVIEW_ROUTER_ACTION_REF", actionRef);
    vi.stubEnv("REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF", actionRef);
    mocks.runtime.mockResolvedValue({
      config: {
        providers: [
          {
            kind: "codex",
            authMode: "codex_subscription_oauth_hosted_pool",
            model: "gpt-5.3-codex",
          },
        ],
      },
    });
    mocks.activateCodex.mockResolvedValue({ status: "not_configured" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["main", "master"] as const)(
    "recovers historical %s on current main with canonical hosted workflow and no legacy file",
    async (baseBranch) => {
      const f = fixture(baseBranch);
      const result = await confirmSetupPullRequestMergedClientAction(f.form);
      expect({ params: result.params, events: f.events }).toMatchObject({
        params: { notice: "setup_pr_merged" },
        events: [
          "inspect_pr",
          "binding_lookup",
          "binding_lookup",
          "ref:heads/main",
          `workflow:${workflowPath}:${commitSha}`,
          "ref:heads/main",
          "binding_lookup",
          "activation_effect",
          "binding_write",
        ],
      });
      expect(f.state.current()).toEqual({
        ...f.historical,
        status: "configured",
        revision: f.historical.revision + 1,
      });
      expect(f.updateBinding).toHaveBeenCalledTimes(1);
      expect(mocks.switchConfiguration).toHaveBeenCalledTimes(1);
      expect(mocks.activateCodex).not.toHaveBeenCalled();
      expect(mocks.setRepositorySource).not.toHaveBeenCalled();
      expect(f.state.workflowProvisioning.updateMany).toHaveBeenCalledTimes(1);
      expect(f.state.workflowProvisioning.create).not.toHaveBeenCalled();
      expect(
        f.request.mock.calls.filter(([route]) => route.includes("/contents/")),
      ).toEqual([
        [
          "GET /repos/{owner}/{repo}/contents/{path}",
          { owner: "acme", repo: "widget", path: workflowPath, ref: commitSha },
        ],
      ]);
      expect(f.events.indexOf("binding_lookup")).toBeLessThan(
        f.events.findIndex((event) => event.startsWith("workflow:")),
      );
      expect(mocks.createOctokit).toHaveBeenCalledWith("123");
    },
  );
  it.each([
    "workflow_absent",
    "invalid_workflow",
    "untrusted_ref",
    "runtime_ref_mismatch",
    "response_path_mismatch",
    "blob_mismatch",
    "default_head_moved",
    "wrong_binding",
    "wrong_binding_revision",
    "wrong_api",
    "wrong_provider",
    "github_repository_mismatch",
    "missing_binding",
    "binding_workspace",
    "binding_repository",
    "binding_ineligible",
    "binding_tombstoned",
    "binding_replaced_before_verifier",
    "wrong_workspace",
    "initial_installation",
    "transfer_during_probe",
    "installation_during_probe",
    "inactive_during_probe",
    "deselected_during_probe",
    "archived_during_probe",
    "default_during_probe",
    "attempt_during_probe",
    "revision_during_probe",
    "head_during_probe",
    "branch_during_probe",
    "url_during_probe",
    "artifact_path",
    "artifact_style",
    "artifact_version",
    "active_attestation_invalid",
    "binding_removed_during_probe",
    "binding_changed_during_probe",
    "binding_revised_during_probe",
    "binding_state_during_probe",
    "binding_draining_during_probe",
    "stored_head_mismatch",
    "stored_attempt_during_probe",
    "stored_revision_during_probe",
  ])("refuses %s with zero activation or status effects", async (scenario) => {
    const f = fixture(
      scenario.startsWith("stored_") ? "main" : "master",
      scenario,
    );
    const result = await confirmSetupPullRequestMergedClientAction(f.form);
    expect(result.params, f.events.join(", ")).toHaveProperty("error");
    expect(result.params).not.toHaveProperty("notice");
    expect(mocks.switchConfiguration).not.toHaveBeenCalled();
    expect(f.updateBinding).not.toHaveBeenCalled();
    expect(mocks.activateCodex).not.toHaveBeenCalled();
    expect(mocks.setRepositorySource).not.toHaveBeenCalled();
    expect(f.state.workflowProvisioning.updateMany).not.toHaveBeenCalled();
    expect(f.state.workflowProvisioning.create).not.toHaveBeenCalled();
    expect(f.state.current()).toEqual(f.expectedCurrent());
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(["stored_wrong_base", "unmerged_wrong_base"])(
    "retains the scoped failure transition for %s",
    async (scenario) => {
      const f = fixture("master", scenario);
      const result = await confirmSetupPullRequestMergedClientAction(f.form);
      expect(result.params.error).toBe("setup_pr_wrong_base_branch");
      expect(f.events).toEqual(["inspect_pr"]);
      expect(mocks.switchConfiguration).not.toHaveBeenCalled();
      expect(f.updateBinding).not.toHaveBeenCalled();
      expect(mocks.activateCodex).not.toHaveBeenCalled();
      expect(f.state.current()).toMatchObject({
        status: "failed",
        errorMessage: "setup_pr_wrong_base_branch",
        revision: f.historical.revision + 1,
      });
      expect(f.state.workflowProvisioning.updateMany).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "already_active",
    "no_history",
    "stored_merged",
    "pending_generic_config",
    "pending_rotating_config",
    "trusted_overlap",
  ])("preserves sibling hosted recovery: %s", async (scenario) => {
    const f = fixture(
      scenario === "stored_merged" ? "main" : "master",
      scenario,
    );
    if (scenario === "pending_generic_config")
      mocks.runtime.mockResolvedValue({
        config: { providers: [{ kind: "openrouter", authMode: "api_key" }] },
      });
    if (scenario === "trusted_overlap")
      vi.stubEnv(
        "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS",
        `777genius/review-router@${"c".repeat(40)}`,
      );
    const result = await confirmSetupPullRequestMergedClientAction(f.form);
    expect(result.params, f.events.join(", ")).toHaveProperty(
      "notice",
      "setup_pr_merged",
    );
    expect(f.state.current()).toMatchObject({
      status: "configured",
      workflowPath,
      workflowStyle: "reusable",
      actionVersion: f.historical.actionVersion,
    });
    expect(mocks.switchConfiguration).toHaveBeenCalledTimes(
      scenario === "already_active" ? 0 : 1,
    );
    expect(f.updateBinding).toHaveBeenCalledTimes(
      scenario === "already_active" ? 0 : 1,
    );
    expect(mocks.activateCodex).not.toHaveBeenCalled();
    expect(mocks.setRepositorySource).not.toHaveBeenCalled();
    expect(f.findBinding.mock.calls[0]?.[0].where).toMatchObject({
      workspaceId: "workspace_1",
      repositoryConnectionId: "repository_1",
      status: { in: ["pending_activation", "active"] },
      tombstonedAt: null,
      repository: {
        workspaceId: "workspace_1",
        installationId: "installation_1",
        selected: true,
        archived: false,
        installation: { status: "active" },
      },
    });
  });

  it.each([
    "transfer_during_activation",
    "attempt_during_activation",
    "revision_during_activation",
    "artifact_during_activation",
  ])(
    "fences final status after the observed activation boundary: %s",
    async (scenario) => {
      const f = fixture("master", scenario);
      const result = await confirmSetupPullRequestMergedClientAction(f.form);
      expect(result.params).toHaveProperty("error");
      // These are post-effect status tests, not claims of atomic provider effects.
      expect(mocks.switchConfiguration).toHaveBeenCalledTimes(1);
      expect(f.updateBinding).toHaveBeenCalledTimes(1);
      expect(f.state.workflowProvisioning.updateMany).not.toHaveBeenCalled();
      expect(f.state.workflowProvisioning.create).not.toHaveBeenCalled();
      expect(f.state.current()).toEqual(f.expectedCurrent());
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );

  it.each([
    "rotating_valid",
    "rotating_active_binding",
    "rotating_missing_interaction",
  ])("preserves the real rotating readiness route: %s", async (scenario) => {
    const f = fixture("master", scenario);
    const result = await confirmSetupPullRequestMergedClientAction(f.form);
    expect(f.updateBinding).not.toHaveBeenCalled();
    expect(mocks.switchConfiguration).not.toHaveBeenCalled();
    expect(mocks.namespace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        repositoryId: "repository_1",
        githubRepositoryId: "456",
        providerInstanceId: "codex-rotating:456",
      }),
      expect.anything(),
    );
    if (scenario === "rotating_missing_interaction") {
      expect(result.params).toHaveProperty("error", "setup_pr_not_merged");
      expect(mocks.activateCodex).not.toHaveBeenCalled();
      expect(mocks.setRepositorySource).not.toHaveBeenCalled();
      expect(f.state.workflowProvisioning.updateMany).not.toHaveBeenCalled();
    } else {
      expect(result.params, f.events.join(", ")).toHaveProperty(
        "notice",
        "setup_pr_merged",
      );
      expect(mocks.activateCodex).toHaveBeenCalledTimes(1);
      expect(f.state.current()).toMatchObject({
        status: "configured",
        workflowPath,
        actionVersion: actionRef,
      });
      if (scenario === "rotating_active_binding")
        expect(mocks.setRepositorySource).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceId: "workspace_1",
            repositoryId: "repository_1",
            source: "repository_secret",
            expectedVersion: 3,
          }),
        );
      else expect(mocks.setRepositorySource).not.toHaveBeenCalled();
    }
    expect(
      f.request.mock.calls
        .filter(([route]) => route.includes("/contents/"))
        .map(([, parameters]) => parameters?.path),
    ).toEqual([workflowPath, defaultInteractionWorkflowPath]);
  });
});
