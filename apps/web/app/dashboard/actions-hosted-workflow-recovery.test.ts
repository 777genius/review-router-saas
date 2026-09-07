import { createHash } from "node:crypto";
import {
  mapConfigToRuntimeEnv,
  parseReviewConfiguration,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexRotatingReviewActionV2Mode,
  CodexRotatingT0WorkflowSchemaVersion,
  createVersionedProviderSecretNamespace,
  renderCodexRotatingAdvisoryWorkflow,
  renderCanonicalCodexRotatingInteractionWorkflowV3,
  defaultInteractionWorkflowPath,
  hostedPoolWorkflowSemanticSha256,
  workflowDocumentSemanticSha256,
  renderReviewRouterReusableWorkflow,
  renderCanonicalHostedPoolWorkflowV2,
  provisionReviewRouterWorkflow,
  PrismaWorkflowProvisioningRepository,
  OctokitWorkflowSetupGateway,
  renderReviewRouterWorkflowFiles,
} from "@reviewrouter/features-workflow-provisioning";
import {
  createProvisioningPrisma,
  initialCandidate,
} from "../../../../packages/features/workflow-provisioning/src/tests/provisioning-prisma-fixture";

import { WorkflowGitHubFixture } from "../../../../packages/features/workflow-provisioning/src/tests/workflow-github-fixture";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  createOctokit: vi.fn(),
  runtime: vi.fn(),
  readiness: vi.fn(),
  namespace: vi.fn(),
  audit: vi.fn(),
  activateCodex: vi.fn(),
  switchConfiguration: vi.fn(),
  setRepositorySource: vi.fn(),
  ledgerActivate: vi.fn(),
  activeAttestation: vi.fn(),
  validateActive: vi.fn(),
  persistReplacement: vi.fn(),
}));
vi.mock("../../src/server/workflow-setup-readiness", async (original) => {
  const actual =
    await original<
      typeof import("../../src/server/workflow-setup-readiness")
    >();
  return {
    ...actual,
    isWorkflowSetupAlreadyCurrent: mocks.readiness.mockImplementation(
      actual.isWorkflowSetupAlreadyCurrent,
    ),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("../../src/server/hosted-pool-dashboard", () => ({}));
vi.mock("../../src/server/prisma", () => ({
  getPrisma: mocks.getPrisma,
  getCodexEffectAuthorityPrisma: mocks.getPrisma,
}));
vi.mock("@reviewrouter/features-review-config", async (original) => ({
  ...(await original<typeof import("@reviewrouter/features-review-config")>()),
  resolveReviewRuntimeEnv: mocks.runtime,
}));
vi.mock("@reviewrouter/features-provider-setup", async (original) => ({
  ...(await original<typeof import("@reviewrouter/features-provider-setup")>()),
  inspectCodexRotatingWorkflowNamespace: mocks.namespace.mockImplementation(
    (await original<typeof import("@reviewrouter/features-provider-setup")>())
      .inspectCodexRotatingWorkflowNamespace,
  ),
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
vi.mock(
  "../../src/server/codex-rotating-workflow-activation",
  async (original) => {
    const actual =
      await original<
        typeof import("../../src/server/codex-rotating-workflow-activation")
      >();
    mocks.activateCodex.mockImplementation(
      actual.activateConfirmedCodexNamespaceAfterWorkflowMerge,
    );
    return {
      ...actual,
      activateConfirmedCodexNamespaceAfterWorkflowMerge: mocks.activateCodex,
    };
  },
);
// Run the production ledger/use cases; stop at the namespace persistence port.
// Generation and provider-transaction qualification belong to the downstream DB lane.
vi.mock("../../src/server/prisma-codex-rotating-setup-payload-claim", () => ({
  PrismaCodexRotatingSetupPayloadClaim: class {
    activate = mocks.ledgerActivate;
    readActiveWorkflowAttestation = mocks.activeAttestation;
    validateActiveWorkflowSource = mocks.validateActive;
    replaceActiveWorkflowSource = mocks.persistReplacement;
  },
}));
// Extract the unchanged production source-switch chain without constructing
// account, credential or KMS adapters. Only that construction boundary is fake;
// the dashboard method, use case, Prisma adapters and configuration writes run.
vi.mock("../../src/server/prisma-hosted-pool-mutations", async () => {
  const { readFileSync } = await import("node:fs");
  const ts = await import("typescript");
  const configuration = await import("@reviewrouter/features-review-config");
  const { switchRepositoryConfigurationAuthMode } =
    await import("@reviewrouter/features-workflow-provisioning");
  const identifiers =
    await import("../../../../packages/features/hosted-account-pool/src/domain/identifiers");
  const useCase =
    await import("../../../../packages/features/hosted-account-pool/src/application/use-cases/switch-repository-auth-mode");
  function evaluate(
    source: string,
    dependencies: Record<string, unknown>,
    names: string[],
  ) {
    const parsed = ts.createSourceFile(
      "production.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const declarations = parsed.statements
      .filter(
        (statement) =>
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement)) &&
          statement.name &&
          names.includes(statement.name.getText(parsed)),
      )
      .map((statement) => statement.getText(parsed))
      .join("\n");
    const js = ts.transpileModule(declarations, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const exports = {};
    return new Function(
      "exports",
      ...Object.keys(dependencies),
      js + `\nreturn { ${names.join(", ")} };`,
    )(exports, ...Object.values(dependencies));
  }
  const adapters = evaluate(
    readFileSync(
      new URL(
        "../../../../packages/features/hosted-account-pool/src/infrastructure/prisma/prisma-hosted-account-pool-adapters.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    identifiers,
    [
      "PrismaHostedPoolBindingRepository",
      "PrismaRepositoryAuthModeSwitch",
      "isEligibleRepository",
      "restoreBinding",
      "bindingStatus",
      "toSafeNumber",
      "ConfigurationAuthorityRejectedError",
      "isPrismaErrorCode",
    ],
  );
  const source = readFileSync(
    new URL(
      "../../src/server/prisma-hosted-pool-mutations.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const start = source.indexOf("  const createAdapters = () => {");
  const end = source.indexOf("\n\n  return {", start);
  if (start < 0 || end < 0)
    throw new Error("production_factory_boundary_missing");
  const real = evaluate(
    source.slice(0, start) +
      "  const createAdapters = () => constructAdapters(input.prisma, createRepositoryConfigurationAuthority());" +
      source.slice(end),
    {
      ...configuration,
      ...identifiers,
      ...useCase,
      switchRepositoryConfigurationAuthMode,
      constructAdapters: (prisma: unknown, authority: unknown) => ({
        bindings: new adapters.PrismaHostedPoolBindingRepository(prisma),
        authModeSwitch: new adapters.PrismaRepositoryAuthModeSwitch(
          prisma,
          authority,
        ),
      }),
    },
    [
      "createPrismaHostedPoolDashboardMutationPort",
      "createRepositoryConfigurationAuthority",
      "switchRepositoryConfigurationAuthMode",
    ],
  );
  mocks.switchConfiguration.mockImplementation(
    real.switchRepositoryConfigurationAuthMode,
  );
  return {
    ...real,
    switchRepositoryConfigurationAuthMode: mocks.switchConfiguration,
    createPrismaHostedPoolDashboardMutationPort: (input: unknown) => {
      const port = real.createPrismaHostedPoolDashboardMutationPort(input);
      mocks.setRepositorySource.mockImplementation(port.setRepositorySource);
      return { ...port, setRepositorySource: mocks.setRepositorySource };
    },
  };
});
vi.mock("../../src/server/workflow-public-api-url", () => ({
  resolveWorkflowPublicApiUrl: () => "https://api.reviewrouter.test",
}));

import { fingerprintDatabaseRecoveryWitness } from "@reviewrouter/features-provider-setup";

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
      if ("is" in expected)
        return matches(
          actual[key] as Record<string, unknown>,
          expected.is as Record<string, unknown>,
        );
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

function fixture(
  baseBranch: "main" | "master",
  scenario = "valid",
  mode?: "stored_active" | "rotating_hosted" | "generic",
) {
  const rotating =
    scenario.startsWith("rotating_") || mode === "rotating_hosted";
  const activeStored =
    scenario.startsWith("stored_active_") || mode === "stored_active";
  const rotatingWithBinding =
    rotating &&
    (mode === "rotating_hosted" ||
      scenario.includes("active_binding") ||
      scenario.includes("hosted_config"));
  const actualActionRef =
    scenario === "trusted_overlap"
      ? `777genius/review-router@${"c".repeat(40)}`
      : actionRef;
  const historical = {
    ...initialCandidate,
    status:
      scenario === "stored_active_configured"
        ? ("configured" as const)
        : initialCandidate.status,
    pullRequestHeadSha:
      activeStored ||
      mode === "rotating_hosted" ||
      scenario.startsWith("stored_") ||
      scenario.includes("stored_head")
        ? scenario === "stored_head_mismatch"
          ? "c".repeat(40)
          : "b".repeat(40)
        : null,
    workflowPath:
      mode === "generic"
        ? ".github/workflows/reviewrouter.yml"
        : scenario === "artifact_path"
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
    installation: {
      workspaceId: "workspace_1",
      status: "active",
      githubInstallationId: 123n,
    },
    provisioning: scenario === "no_history" ? [] : [historical],
  };
  if (scenario === "initial_installation")
    repository = {
      ...repository,
      installation: { ...repository.installation, status: "suspended" },
    };
  let binding: Record<string, unknown> | null =
    mode === "generic" ||
    scenario === "missing_binding" ||
    (rotating && !rotatingWithBinding)
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
              : activeStored ||
                  scenario === "already_active" ||
                  scenario === "active_attestation_invalid" ||
                  rotatingWithBinding
                ? "active"
                : "pending_activation",
          poolId: "pool-1",
          attestedBindingRevision: null,
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
  const namespace = createVersionedProviderSecretNamespace({
    scope: { repositoryId: "456", providerInstanceId: "codex-rotating:456" },
    namespaceId: `sns_${"a".repeat(32)}`,
    name: `REVIEWROUTER_CODEX_AUTH_JSON_R456_P${createHash("sha256").update("codex-rotating:456").digest("hex").slice(0, 16)}_E4_${"a".repeat(32)}`,
    epoch: 4,
  });
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
    if (rotating)
      source = renderCodexRotatingAdvisoryWorkflow({
        actionRef,
        apiUrl: "https://api.reviewrouter.test",
        providerInstanceId: "codex-rotating:456",
        reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
        workflowSchemaVersion: scenario.includes("active_namespace")
          ? CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5
          : CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
        activeSecretNamespace: namespace,
      });
  }
  if (mode === "rotating_hosted" || scenario.includes("hosted_config"))
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
  if (rotating) {
    if (scenario === "invalid_workflow")
      source = source.replace("id-token: write", "id-token: read");
    if (scenario === "untrusted_ref")
      source = source.replaceAll("a".repeat(40), "c".repeat(40));
    if (scenario === "runtime_ref_mismatch")
      source = source.replace(
        `runtime_ref: "${"a".repeat(40)}"`,
        `runtime_ref: "${"c".repeat(40)}"`,
      );
    if (scenario === "wrong_api")
      source = source.replaceAll(
        "https://api.reviewrouter.test",
        "https://other.reviewrouter.test",
      );
    if (scenario === "wrong_provider")
      source = source.replaceAll("codex-rotating:456", "codex-rotating:999");
  }
  if (mode === "generic") {
    vi.stubEnv("REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK", "1");
    vi.stubEnv("REVIEW_ROUTER_CONFLICT_REVIEW_FALLBACK_REPOSITORIES", "");
    mocks.runtime.mockResolvedValue({
      config: { providers: [{ kind: "openrouter", authMode: "api_key" }] },
    });
    source = renderReviewRouterReusableWorkflow({
      actionRef,
      apiUrl: "https://api.reviewrouter.test",
      runtimeConfigMode: "oidc",
      conflictReviewFallbackEnabled: true,
    });
  }
  if (scenario === "source_changed_after_selection")
    vi.stubEnv(
      "REVIEW_ROUTER_CODEX_ROTATING_ALLOWED_ACTION_REFS",
      `777genius/review-router@${"c".repeat(40)}`,
    );
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
      state.replace({ ...historical, pullRequestHeadSha: "e".repeat(40) });
    if (scenario === "branch_during_probe")
      state.replace({ ...historical, branch: "reviewrouter/new-setup" });
    if (scenario === "url_during_probe")
      state.replace({
        ...historical,
        pullRequestUrl: "https://github.com/acme/widget/pull/8",
      });
    if (
      scenario === "artifact_during_activation" ||
      scenario === "artifact_during_probe"
    )
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
    findUnique: findBinding,
    updateMany: updateBinding,
  };
  let configurationVersion: Record<string, unknown> | null = {
    id: "configuration-version-0",
    version: 1,
    schemaVersion: 2,
    providerKind: "codex",
    providerAuthMode:
      rotating && !rotatingWithBinding
        ? "codex_subscription_oauth_rotating"
        : "codex_subscription_oauth_hosted_pool",
    model: "gpt-5.3-codex",
    reasoningEffort: "medium",
    agenticContext: false,
    fastMode: false,
    failOnSeverity: "off",
    inlineMaxComments: 10,
    providerLimit: 1,
    providerMaxParallel: 1,
    inlineMinAgreement: 1,
    targetTokensPerBatch: 8000,
    reviewLanguage: null,
    providers: [],
  };
  const configWrites = vi.fn(
    async ({ data }: { data: Record<string, unknown> }) => {
      events.push(`configuration_write:${data.providerAuthMode}`);
      configurationVersion = {
        ...data,
        id: "configuration-version-1",
        providers: (data.providers as { create: unknown[] }).create,
      };
      return configurationVersion;
    },
  );
  const namespaceCandidate = {
    providerInstanceRowId: "provider_row_1",
    providerWorkspaceId: "workspace_1",
    providerRepositoryId: "repository_1",
    providerInstanceId: "codex-rotating:456",
    providerAuthMode: "codex_subscription_oauth_rotating",
    providerState: "workflow_update_required",
    providerMutationOwner: "setup",
    providerMutationOwnerId: "codex_manifest_workflow_1",
    providerMutationEpoch: 11n,
    providerActiveNamespaceId: null,
    providerActiveNamespaceEpoch: null,
    providerActiveNamespaceName: null,
    retainedActiveNamespaceId: null,
    retainedActiveNamespaceProviderInstanceRowId: null,
    retainedActiveNamespaceGithubRepositoryId: null,
    retainedActiveNamespaceEpoch: null,
    retainedActiveNamespaceSecretName: null,
    retainedActiveNamespaceDatabaseRecoveryWitness: null,
    retainedActiveNamespaceStatus: null,
    retainedActiveNamespacePermanentlyRetired: null,
    retainedActiveNamespaceActivatedAt: null,
    retainedActiveNamespaceRetiredAt: null,
    claimId: "codex_claim_workflow_1",
    claimProviderInstanceRowId: "provider_row_1",
    claimWorkspaceId: "workspace_1",
    claimRepositoryId: "repository_1",
    claimGithubRepositoryId: "456",
    claimManifestId: "codex_manifest_workflow_1",
    claimRecoveryEpoch: 11n,
    claimStatus: "confirmed_candidate",
    claimAccountIdentityAlgorithm: "provider_issuer_subject_account_v1",
    claimDatabaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
      "W".repeat(43),
    ),
    claimConfirmedAttemptId: "codex_attempt_workflow_1",
    claimConfirmedAt: new Date("2026-08-10T00:00:00Z"),
    claimActivatedAt: null,
    claimRecoveryExpiresAt: new Date("2099-01-01T00:00:00Z"),
    attemptId: "codex_attempt_workflow_1",
    attemptClaimId: "codex_claim_workflow_1",
    attemptNamespaceId: namespace.namespaceId,
    attemptStatus: "confirmed",
    attemptDefiniteResponseCode: 204,
    attemptConfirmedAt: new Date("2026-08-10T00:00:00Z"),
    attemptDispatchExpiresAt: new Date("2026-08-10T00:09:00.000Z"),
    namespaceId: namespace.namespaceId,
    namespaceProviderInstanceRowId: "provider_row_1",
    namespaceGithubRepositoryId: "456",
    namespaceEpoch: namespace.epoch,
    namespaceSecretName: namespace.name,
    namespaceDatabaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
      "W".repeat(43),
    ),
    namespaceStatus: "confirmed_candidate",
    namespacePermanentlyRetired: false,
    namespaceConfirmedAt: new Date("2026-08-10T00:00:00Z"),
    namespaceActivatedAt: null,
    manifestId: "codex_manifest_workflow_1",
    manifestProviderInstanceRowId: "provider_row_1",
    manifestWorkspaceId: "workspace_1",
    manifestRepositoryId: "repository_1",
    manifestProviderInstanceId: "codex-rotating:456",
    manifestStatus: "fetched",
    manifestMutationEpoch: 11n,
    manifestDatabaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
      "W".repeat(43),
    ),
    manifestRecoveryExpiresAt: new Date("2099-01-01T00:00:00Z"),
    manifestConsumedAt: null,
  };
  const activeEvidence = {
    providerInstanceRowId: "provider_row_1",
    providerWorkspaceId: "workspace_1",
    providerRepositoryId: "repository_1",
    providerInstanceId: "codex-rotating:456",
    providerAuthMode: "codex_subscription_oauth_rotating",
    providerState: "active",
    providerMutationEpoch: 12n,
    providerLatestGeneration: 1,
    providerActiveNamespaceId: namespace.namespaceId,
    providerActiveNamespaceEpoch: namespace.epoch,
    providerActiveNamespaceName: namespace.name,
    providerActiveAccountIdentityHash: "i".repeat(43),
    providerLatestGenerationHash: "g".repeat(43),
    claimId: "codex_claim_active_1",
    claimProviderInstanceRowId: "provider_row_1",
    claimWorkspaceId: "workspace_1",
    claimRepositoryId: "repository_1",
    claimGithubRepositoryId: "456",
    claimManifestId: "codex_manifest_active_1",
    claimRecoveryEpoch: 11n,
    claimStatus: "active",
    claimGenerationHash: "g".repeat(43),
    claimAccountIdentityHash: "i".repeat(43),
    claimDatabaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
      "W".repeat(43),
    ),
    claimConfirmedAttemptId: "codex_attempt_active_1",
    claimActivatedAt: new Date("2026-08-10T00:00:00Z"),
    attemptId: "codex_attempt_active_1",
    attemptClaimId: "codex_claim_active_1",
    attemptNamespaceId: namespace.namespaceId,
    attemptStatus: "confirmed",
    attemptDefiniteResponseCode: 204,
    attemptConfirmedAt: new Date("2026-08-10T00:00:00Z"),
    setupNamespaceId: namespace.namespaceId,
    setupNamespaceProviderInstanceRowId: "provider_row_1",
    setupNamespaceGithubRepositoryId: "456",
    setupNamespaceEpoch: namespace.epoch,
    setupNamespaceSecretName: namespace.name,
    setupNamespaceDatabaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
      "W".repeat(43),
    ),
    setupNamespaceStatus: "active",
    setupNamespacePermanentlyRetired: false,
    setupNamespaceWorkflowPath: ".github/workflows/reviewrouter-codex.yml",
    setupNamespaceWorkflowSourceCommitSha: commitSha,
    setupNamespaceWorkflowSourceBlobSha: blobSha,
    setupNamespaceWorkflowSourceSha256: createHash("sha256")
      .update(source)
      .digest("hex"),
    setupNamespaceWorkflowSemanticSha256:
      workflowDocumentSemanticSha256(source),
    setupNamespaceWorkflowSourceTrust: "trusted_default_branch_revision",
    setupNamespaceAttestedRepositoryId: "456",
    setupNamespaceActivatedAt: new Date("2026-08-10T00:00:00Z"),
    namespaceId: namespace.namespaceId,
    namespaceProviderInstanceRowId: "provider_row_1",
    namespaceGithubRepositoryId: "456",
    namespaceEpoch: namespace.epoch,
    namespaceSecretName: namespace.name,
    namespaceDatabaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
      "W".repeat(43),
    ),
    namespaceStatus: "active",
    namespacePermanentlyRetired: false,
    namespaceWorkflowPath: ".github/workflows/reviewrouter-codex.yml",
    namespaceWorkflowSourceCommitSha: commitSha,
    namespaceWorkflowSourceBlobSha: blobSha,
    namespaceWorkflowSourceSha256: createHash("sha256")
      .update(source)
      .digest("hex"),
    namespaceWorkflowSemanticSha256: workflowDocumentSemanticSha256(source),
    namespaceWorkflowSourceTrust: "trusted_default_branch_revision",
    namespaceAttestedRepositoryId: "456",
    namespaceActivatedAt: new Date("2026-08-10T00:00:00Z"),
    runtimeIntentId: null,
    runtimeIntentProviderInstanceRowId: null,
    runtimeIntentSecretNamespaceId: null,
    runtimeIntentDispatchAttemptId: null,
    runtimeIntentStatus: null,
    runtimeIntentMutationEpoch: null,
    runtimeIntentGeneration: null,
    runtimeIntentLatestGenerationHash: null,
    runtimeIntentAccountIdentityHash: null,
    runtimeIntentAccountIdentityAlgorithm: null,
    runtimeIntentDatabaseRecoveryWitness: null,
    runtimeIntentProviderResponseCode: null,
    runtimeIntentProviderConfirmedAt: null,
    runtimeIntentCompletedAt: null,
    manifestStatus: "consumed",
    manifestDatabaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
      "W".repeat(43),
    ),
    manifestConsumedAt: new Date("2026-08-10T00:00:00Z"),
  };
  let providerReads = 0;
  const transaction = {
    ...state.prisma,
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const query = Array.from(strings).join("?");
      if (query.includes("FOR UPDATE")) return [{ id: "provider_row_1" }];
      if (query.includes("LIMIT 2")) return [namespaceCandidate];
      return scenario.includes("active_namespace") ? [activeEvidence] : [];
    }),
    repositoryConnection: { findFirst: scopedRepository },
    hostedCodexRepositoryBinding,
    hostedCodexPool: { findFirst: vi.fn(async () => ({ id: "pool-1" })) },
    reviewConfiguration: {
      findUnique: vi.fn(async () =>
        configurationVersion ? { versions: [configurationVersion] } : null,
      ),
      upsert: vi.fn(async () => ({ id: "configuration-1" })),
    },
    reviewConfigurationVersion: {
      findFirst: vi.fn(async () => configurationVersion),
      create: configWrites,
    },
    codexOAuthSecretNamespace: {
      findUnique: vi.fn(async () => ({ workflowSchemaVersion: 5 })),
    },
    codexOAuthProviderInstance: {
      findUnique: vi.fn(async () => {
        providerReads++;
        return rotating &&
          !scenario.includes("absent_provider") &&
          !(scenario.includes("provider_removed") && providerReads >= 2)
          ? { id: "provider_row_1", latestGenerationHash: "a".repeat(64) }
          : null;
      }),
    },
  };
  mocks.getPrisma.mockReturnValue({
    ...transaction,
    repositoryConnection: {
      findFirst: scopedRepository,
      findUnique: vi.fn(async () => ({
        ...repository,
        provisioning: state.current() ? [state.current()] : [],
      })),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback(transaction),
    ),
  });
  let refCount = 0;
  let contentCount = 0;
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
                (scenario === "default_head_moved" && refCount === 2) ||
                (scenario === "default_head_moved_in_adapter" && refCount === 3)
                  ? "e".repeat(40)
                  : commitSha,
            },
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        contentCount++;
        if (mode === "generic") {
          events.push(`workflow:${parameters?.path}:${parameters?.ref}`);
          if (scenario === "workflow_absent")
            throw Object.assign(new Error("absent"), { status: 404 });
          return {
            data: {
              type: "file",
              path: parameters?.path,
              encoding: "base64",
              content: Buffer.from(source).toString("base64"),
              sha: blobSha,
            },
          };
        }
        if (rotating) {
          if (scenario.endsWith("_during_probe")) race();
          if (scenario === "workflow_absent")
            throw Object.assign(new Error("absent"), { status: 404 });
          events.push(`workflow:${parameters?.path}:${parameters?.ref}`);
          if (parameters?.ref !== "main" && parameters?.ref !== commitSha)
            throw new Error("wrong_rotating_ref");
          const interaction =
            parameters.path === defaultInteractionWorkflowPath;
          if (interaction && scenario === "rotating_missing_interaction")
            throw Object.assign(new Error("absent"), { status: 404 });
          const content = interaction
            ? renderCanonicalCodexRotatingInteractionWorkflowV3({
                actionRef,
                apiUrl: "https://api.reviewrouter.test",
                runtimeConfigMode: "oidc",
              })
            : source;
          return {
            data: {
              type: "file",
              path:
                scenario === "response_path_mismatch"
                  ? ".github/workflows/other.yml"
                  : parameters.path,
              encoding: "base64",
              content: Buffer.from(content).toString("base64"),
              sha:
                scenario === "blob_mismatch"
                  ? "f".repeat(40)
                  : createHash("sha1")
                      .update(`blob ${Buffer.byteLength(content)}\0`)
                      .update(content)
                      .digest("hex"),
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
            content: Buffer.from(
              scenario === "source_changed_after_selection" && contentCount > 1
                ? source.replaceAll("a".repeat(40), "c".repeat(40))
                : source,
            ).toString("base64"),
            sha:
              scenario === "blob_mismatch"
                ? "f".repeat(40)
                : scenario === "source_changed_after_selection" &&
                    contentCount > 1
                  ? createHash("sha1")
                      .update(`blob ${Buffer.byteLength(source)}\0`)
                      .update(source.replaceAll("a".repeat(40), "c".repeat(40)))
                      .digest("hex")
                  : blobSha,
          },
        };
      }
      throw new Error(`unexpected_fake_transport:${route}`);
    },
  );
  mocks.createOctokit.mockResolvedValue({ request });
  mocks.ledgerActivate.mockImplementation(async () => {
    events.push("rotating_namespace_activation");
    if (scenario.endsWith("_during_activation")) race();
    return { status: "activated" };
  });
  mocks.activeAttestation.mockResolvedValue({
    repositoryId: "456",
    workflowPath,
    workflowSourceCommitSha: commitSha,
    workflowSourceBlobSha: blobSha,
    workflowSourceSha256: createHash("sha256").update(source).digest("hex"),
    workflowSemanticSha256: workflowDocumentSemanticSha256(source),
    workflowSchemaVersion: 5,
    sourceTrust: "trusted_default_branch_revision",
    secretNamespace: namespace,
  });
  mocks.validateActive.mockImplementation(async () => {
    events.push("rotating_namespace_validation");
    return { status: "active" };
  });
  mocks.persistReplacement.mockImplementation(async () => {
    throw new Error("unexpected_reattestation_write");
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
    configWrites,
    configuration: () => configurationVersion,
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
    mocks.ledgerActivate.mockResolvedValue({ status: "activated" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["explicit", "matching"],
    ["reusable", "matching"],
    ["explicit", "recorded_style_mismatch"],
    ["reusable", "recorded_style_mismatch"],
    ["explicit", "wrong_action_ref"],
    ["explicit", "ambiguous_style"],
  ] as const)(
    "confirms rendered generic %s with %s evidence",
    async (workflowStyle, scenario) => {
      const f = fixture("main", "valid", "generic");
      vi.stubEnv("REVIEW_ROUTER_ENABLE_CONFLICT_REVIEW_FALLBACK", "0");
      f.state.replace(null);
      const remote = new WorkflowGitHubFixture();
      const config = parseReviewConfiguration({
        ...safeDefaultReviewConfiguration,
        providers: [
          {
            kind: "openrouter" as const,
            authMode: "openrouter_api_key" as const,
            model: "openai/gpt-5",
          },
        ],
      });
      mocks.runtime.mockResolvedValue({ config });
      const staticRuntimeEnv = mapConfigToRuntimeEnv(config);
      const setup = await provisionReviewRouterWorkflow(
        {
          workspaceId: "workspace_1",
          repositoryId: "repository_1",
          installationId: "installation_1",
          owner: "acme",
          name: "widget",
          defaultBranch: "main",
          workflowStyle,
          actionRef,
          apiUrl: "https://api.reviewrouter.test",
          runtimeConfigMode: "oidc",
          conflictReviewFallbackEnabled: false,
          staticRuntimeEnv,
        },
        {
          provisioning: new PrismaWorkflowProvisioningRepository(
            f.state.prisma as never,
          ),
          setupGateway: new OctokitWorkflowSetupGateway(remote),
        },
      );
      const provisioned = { ...f.state.current()! };
      expect(provisioned).toMatchObject({
        status: "setup_pr_open",
        revision: 1,
        workflowStyle,
        pullRequestHeadSha: setup.headSha,
      });
      remote.branches.set("main", setup.headSha);
      if (scenario === "recorded_style_mismatch")
        f.state.replace({
          ...provisioned,
          workflowStyle: workflowStyle === "explicit" ? "reusable" : "explicit",
        });
      const before = { ...f.state.current()! };
      const reads: { path: unknown; ref: unknown; source: string }[] = [];
      const request = vi.fn(
        async (route: string, parameters?: Record<string, unknown>) => {
          if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}")
            return {
              data: {
                merged: true,
                state: "closed",
                base: { ref: "main" },
                head: { ref: setup.branch, sha: setup.headSha },
              },
            };
          const response = await remote.request(route, parameters);
          if (route !== "GET /repos/{owner}/{repo}/contents/{path}")
            return response;
          let source = Buffer.from(
            (response.data as { content: string }).content,
            "base64",
          ).toString("utf8");
          if (scenario === "wrong_action_ref")
            source = source.replaceAll(
              actionRef,
              `777genius/review-router@${"c".repeat(40)}`,
            );
          if (scenario === "ambiguous_style")
            source += `\n  duplicate:\n    uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@${"a".repeat(40)}\n`;
          reads.push({ path: parameters?.path, ref: parameters?.ref, source });
          return {
            data: {
              type: "file",
              encoding: "base64",
              path: parameters?.path,
              content: Buffer.from(source).toString("base64"),
              sha: createHash("sha1")
                .update(`blob ${Buffer.byteLength(source)}\0`)
                .update(source)
                .digest("hex"),
            },
          };
        },
      );
      mocks.createOctokit.mockResolvedValue({ request });
      f.state.workflowProvisioning.updateMany.mockClear();
      f.state.workflowProvisioning.create.mockClear();
      const result = await confirmSetupPullRequestMergedClientAction(f.form);
      const ready = await mocks.readiness.mock.results[0]!.value;
      console.info(
        "actual-generic-style-effect",
        JSON.stringify({
          workflowStyle,
          scenario,
          result,
          ready,
          before,
          after: f.state.current(),
          reads: reads.map(({ source, ...read }) => ({
            ...read,
            sha256: createHash("sha256").update(source).digest("hex"),
          })),
        }),
      );
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({
        path: provisioned.workflowPath,
        ref: "main",
      });
      if (scenario === "matching" || scenario === "recorded_style_mismatch") {
        const rendered = renderReviewRouterWorkflowFiles({
          actionRef,
          apiUrl: "https://api.reviewrouter.test",
          runtimeConfigMode: "oidc",
          workflowStyle,
          conflictReviewFallbackEnabled: false,
          staticRuntimeEnv,
        });
        const workflow = rendered.find(
          (file) => file.path === provisioned.workflowPath,
        );
        expect(workflow && "content" in workflow && workflow.content).toBe(
          reads[0]!.source,
        );
        expect(ready).toBe(true);
      } else expect(ready).toBe(false);
      if (scenario === "matching") {
        expect(result.params).toHaveProperty("notice", "setup_pr_merged");
        expect(f.state.current()).toEqual({
          ...before,
          status: "configured",
          revision: 2,
        });
        expect(f.state.workflowProvisioning.updateMany).toHaveBeenCalledTimes(
          1,
        );
        expect(await mocks.activateCodex.mock.results[0]!.value).toEqual({
          status: "not_configured",
        });
      } else {
        expect(result.params).toHaveProperty(
          "error",
          scenario === "recorded_style_mismatch"
            ? "github_operation_failed"
            : "setup_pr_not_merged",
        );
        expect(f.state.current()).toEqual(before);
        expect(f.state.workflowProvisioning.updateMany).not.toHaveBeenCalled();
        expect(mocks.activateCodex).not.toHaveBeenCalled();
        expect(mocks.audit).not.toHaveBeenCalled();
      }
      expect(f.state.workflowProvisioning.create).not.toHaveBeenCalled();
      expect(f.updateBinding).not.toHaveBeenCalled();
      expect(f.configWrites).not.toHaveBeenCalled();
      expect(mocks.setRepositorySource).not.toHaveBeenCalled();
      expect(mocks.ledgerActivate).not.toHaveBeenCalled();
    },
  );

  it.each(["stored_active_configured", "stored_active_setup_pr_open"])(
    "reconfirms the active hosted stored-head workflow without changing authentication: %s",
    async (scenario) => {
      const f = fixture("main", scenario);
      const result = await confirmSetupPullRequestMergedClientAction(f.form);
      console.info(
        "actual-routing-effect",
        JSON.stringify({
          scenario,
          result,
          events: f.events,
          authMode: f.configuration()?.providerAuthMode,
          bindingStatus: f.binding()?.status,
          bindingRevision: String(f.binding()?.revision),
        }),
      );
      expect(result.params, f.events.join(", ")).toHaveProperty(
        "notice",
        "setup_pr_merged",
      );
      expect(f.binding()).toEqual(f.initialBinding);
      expect(f.configuration()?.providerAuthMode).toBe(
        "codex_subscription_oauth_hosted_pool",
      );
      expect(f.configWrites).not.toHaveBeenCalled();
      expect(mocks.activateCodex).not.toHaveBeenCalled();
      expect(mocks.setRepositorySource).not.toHaveBeenCalled();
      expect(
        f.request.mock.calls.some(([route]) => route.includes("/contents/")),
      ).toBe(true);
      const afterFirst = f.state.current();
      const second = await confirmSetupPullRequestMergedClientAction(f.form);
      expect(second.params).toHaveProperty("notice", "setup_pr_merged");
      expect(f.state.current()).toEqual(afterFirst);
      expect(f.binding()).toEqual(f.initialBinding);
      expect(f.configWrites).not.toHaveBeenCalled();
      expect(mocks.setRepositorySource).not.toHaveBeenCalled();
    },
  );

  describe.each(["stored_active", "rotating_hosted"] as const)(
    "refuses stale or invalid %s routing evidence before configuration, binding or status effects",
    (mode) => {
      const scenarios = [
        "workflow_absent",
        "invalid_workflow",
        "untrusted_ref",
        "runtime_ref_mismatch",
        "response_path_mismatch",
        "blob_mismatch",
        "default_head_moved",
        "default_head_moved_in_adapter",
        "wrong_api",
        "wrong_provider",
        "github_repository_mismatch",
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
        "artifact_during_probe",
        "artifact_path",
        "artifact_style",
        "artifact_version",
        "binding_removed_during_probe",
        "binding_changed_during_probe",
        "binding_revised_during_probe",
        "binding_state_during_probe",
        "binding_draining_during_probe",
        ...(mode === "stored_active"
          ? [
              "source_changed_after_selection",
              "wrong_binding",
              "wrong_binding_revision",
              "active_attestation_invalid",
            ]
          : []),
      ];
      it.each(scenarios)("refuses %s before effects", async (scenario) => {
        const f = fixture("main", scenario, mode);
        const result = await confirmSetupPullRequestMergedClientAction(f.form);
        const context = `${mode}:${scenario}:${JSON.stringify(result)}:${f.events.join(",")}`;
        console.info(
          "actual-refusal-effect",
          JSON.stringify({
            mode,
            scenario,
            result,
            events: f.events,
            configWrites: f.configWrites.mock.calls.length,
            bindingWrites: f.updateBinding.mock.calls.length,
            namespaceEffects: mocks.ledgerActivate.mock.calls.length,
            statusWrites:
              f.state.workflowProvisioning.updateMany.mock.calls.length,
          }),
        );
        expect(result.params, context).toHaveProperty("error");
        expect(f.configWrites, context).not.toHaveBeenCalled();
        expect(f.updateBinding, context).not.toHaveBeenCalled();
        expect(mocks.ledgerActivate, context).not.toHaveBeenCalled();
        expect(mocks.setRepositorySource, context).not.toHaveBeenCalled();
        expect(
          f.state.workflowProvisioning.updateMany,
          context,
        ).not.toHaveBeenCalled();
        expect(
          f.state.workflowProvisioning.create,
          context,
        ).not.toHaveBeenCalled();
      });
    },
  );

  it("refuses not_configured from the real rotating activation when its provider disappears after readiness", async () => {
    const f = fixture(
      "main",
      "rotating_hosted_config_provider_removed_stored_head",
    );
    const result = await confirmSetupPullRequestMergedClientAction(f.form);
    console.info(
      "actual-not-configured-effect",
      JSON.stringify({ result, events: f.events }),
    );
    expect(result.params).toHaveProperty("error");
    expect(mocks.activateCodex).toHaveBeenCalledTimes(1);
    expect(await mocks.activateCodex.mock.results[0]!.value).toEqual({
      status: "not_configured",
    });
    expect(mocks.ledgerActivate).not.toHaveBeenCalled();
    expect(f.configWrites).not.toHaveBeenCalled();
    expect(f.binding()).toEqual(f.initialBinding);
    expect(mocks.setRepositorySource).not.toHaveBeenCalled();
    expect(f.state.workflowProvisioning.updateMany).not.toHaveBeenCalled();
  });

  it.each(["valid", "workflow_absent"])(
    "retains generic readiness through the real Codex absence adapter: %s",
    async (scenario) => {
      const f = fixture("master", scenario, "generic");
      const result = await confirmSetupPullRequestMergedClientAction(f.form);
      expect(f.configWrites).not.toHaveBeenCalled();
      expect(mocks.setRepositorySource).not.toHaveBeenCalled();
      expect(f.updateBinding).not.toHaveBeenCalled();
      if (scenario === "valid") {
        expect(result.params).toHaveProperty("notice", "setup_pr_merged");
        expect(await mocks.activateCodex.mock.results[0]!.value).toEqual({
          status: "not_configured",
        });
        expect(f.state.current()).toMatchObject({
          status: "configured",
          workflowPath: ".github/workflows/reviewrouter.yml",
        });
      } else {
        expect(result.params).toHaveProperty("error");
        expect(mocks.activateCodex).not.toHaveBeenCalled();
        expect(f.state.workflowProvisioning.updateMany).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    "transfer_during_activation",
    "attempt_during_activation",
    "revision_during_activation",
    "artifact_during_activation",
  ])(
    "fences the source switch and final status after the rotating activation boundary: %s",
    async (scenario) => {
      const f = fixture("main", scenario, "rotating_hosted");
      const result = await confirmSetupPullRequestMergedClientAction(f.form);
      expect(result.params).toHaveProperty("error");
      expect(mocks.ledgerActivate).toHaveBeenCalledTimes(1);
      expect(mocks.setRepositorySource).not.toHaveBeenCalled();
      expect(f.configWrites).not.toHaveBeenCalled();
      expect(f.updateBinding).not.toHaveBeenCalled();
      expect(f.state.workflowProvisioning.updateMany).not.toHaveBeenCalled();
      console.info(
        "post-rotating-activation-status-fence",
        JSON.stringify({ scenario, result, events: f.events }),
      );
    },
  );

  it.each(["main", "master"] as const)(
    "recovers historical %s on current main with canonical hosted workflow and no legacy file",
    async (baseBranch) => {
      const f = fixture(baseBranch);
      const result = await confirmSetupPullRequestMergedClientAction(f.form);
      expect({ params: result.params, events: f.events }).toMatchObject({
        params: { notice: "setup_pr_merged" },
        events: expect.arrayContaining([
          "inspect_pr",
          "binding_lookup",
          `workflow:${workflowPath}:${commitSha}`,
          "configuration_write:codex_subscription_oauth_hosted_pool",
          "binding_write",
        ]),
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
      const contentReads = f.request.mock.calls.filter(([route]) =>
        route.includes("/contents/"),
      );
      expect(contentReads.length).toBeGreaterThan(0);
      for (const [, parameters] of contentReads)
        expect(parameters).toEqual({
          owner: "acme",
          repo: "widget",
          path: workflowPath,
          ref: commitSha,
        });
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
    "rotating_hosted_config",
    "rotating_hosted_config_stored_head",
    "rotating_hosted_config_active_namespace_stored_head",
    "rotating_hosted_config_absent_provider",
  ])("preserves the real rotating readiness route: %s", async (scenario) => {
    const f = fixture(
      scenario.includes("stored_head") ? "main" : "master",
      scenario,
    );
    const result = await confirmSetupPullRequestMergedClientAction(f.form);
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
    if (
      scenario === "rotating_missing_interaction" ||
      scenario.includes("absent_provider")
    ) {
      expect(result.params).toHaveProperty("error");
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
      if (
        scenario === "rotating_active_binding" ||
        scenario.includes("hosted_config")
      )
        expect(mocks.setRepositorySource).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceId: "workspace_1",
            repositoryId: "repository_1",
            source: "repository_secret",
            expectedVersion: 3,
          }),
        );
      else expect(mocks.setRepositorySource).not.toHaveBeenCalled();
      if (
        scenario === "rotating_active_binding" ||
        scenario.includes("hosted_config")
      ) {
        expect(f.configWrites).toHaveBeenCalledTimes(1);
        expect(f.configuration()?.providerAuthMode).toBe(
          "codex_subscription_oauth_rotating",
        );
        expect(f.binding()).toMatchObject({
          status: "draining",
          revision: 4n,
          stateVersion: 8n,
        });
        const verifiedEffect = f.events.findIndex(
          (event) =>
            event === "rotating_namespace_activation" ||
            event === "rotating_namespace_validation",
        );
        expect(verifiedEffect).toBeGreaterThanOrEqual(0);
        expect(verifiedEffect).toBeLessThan(
          f.events.indexOf(
            "configuration_write:codex_subscription_oauth_rotating",
          ),
        );
        expect(await mocks.activateCodex.mock.results[0]!.value).toMatchObject({
          status: scenario.includes("active_namespace")
            ? "already_active"
            : "activated",
          workflowSourceCommitSha: commitSha,
        });
      }
    }
    expect(
      f.request.mock.calls
        .filter(([route]) => route.includes("/contents/"))
        .map(([, parameters]) => parameters?.path),
    ).toEqual(expect.arrayContaining([workflowPath]));
    console.info(
      "actual-rotating-effect",
      JSON.stringify({
        scenario,
        result,
        events: f.events,
        authMode: f.configuration()?.providerAuthMode,
        bindingStatus: f.binding()?.status,
        bindingRevision: String(f.binding()?.revision),
      }),
    );
  });
});
