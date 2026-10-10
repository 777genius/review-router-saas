import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildProviderRuntimePlan } from "@reviewrouter/features-review-providers";
import {
  areWorkflowDocumentsSemanticallyEqual,
  CodexRotatingReviewActionV2Mode,
  CodexRotatingT0WorkflowSchemaVersion,
  createVersionedProviderSecretNamespace,
  isolatedQualityWorkflowPath,
  workflowDocumentSemanticSha256,
  readCanonicalCodexRotatingT0WorkflowSourceMetadata,
  renderCanonicalAccountGatewayWorkflow,
} from "@reviewrouter/features-codex-oauth-rotating";
import {
  analyzeConflictReviewWorkflowCapability,
  analyzeWorkflowProviderCompatibility,
  codexRotatingProviderSecretInputsForRuntimeEnv,
  defaultCodexRotatingWorkflowPath,
  defaultInteractionWorkflowPath,
  defaultRequiredWorkflowPath,
  defaultWorkflowPath,
  getCodexRotatingWorkflowSetupContentMarkerGroups,
  getWorkflowProviderContentMarkerGroups,
  getWorkflowSetupContentMarkerGroups,
  renderReviewRouterInteractionWorkflow,
  renderReviewRouterReusableInteractionWorkflow,
  renderReviewRouterReusableWorkflow,
  renderReviewRouterRequiredWorkflow,
  renderReviewRouterWorkflow,
  renderReviewRouterWorkflowFiles,
  renderAccountGatewayWorkflow,
  reusableReviewWorkflowPath,
  renderCodexRotatingAdvisoryWorkflow,
  renderCanonicalCodexRotatingInteractionWorkflowV1,
  renderCanonicalCodexRotatingInteractionWorkflowV2,
  renderCanonicalCodexRotatingInteractionWorkflowV3,
  renderCodexRotatingInteractionWorkflow,
  scanCodexRotatingAdvisoryWorkflow,
  workflowChecksOutReviewRouterRuntime,
} from "../domain/workflow-template";
import {
  renderCodexRotatingAdvisoryWorkflow as renderExportedCodexRotatingAdvisoryWorkflow,
  scanCodexRotatingAdvisoryWorkflow as scanExportedCodexRotatingAdvisoryWorkflow,
} from "../index";

it("emits the immutable schema2 keyless PR caller contract", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const file = renderAccountGatewayWorkflow({
    actionRef: `777genius/review-router@${sha}`,
    apiUrl: "https://app.reviewrouter.dev",
    githubRepositoryId: "123456",
  });
  const document = parse(file.content);
  expect(file.path).toBe(".github/workflows/reviewrouter-codex.yml");
  expect(Object.keys(document.on)).toEqual(["pull_request"]);
  expect(document.permissions).toEqual({});
  expect(Object.keys(document.jobs)).toEqual(["codex-review"]);
  const job = document.jobs["codex-review"];
  expect(job.uses).toBe(
    `777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@${sha}`,
  );
  expect(job.permissions).toEqual({
    contents: "read",
    "pull-requests": "read",
    "id-token": "write",
  });
  expect(job.with).toMatchObject({
    runtime_ref: sha,
    api_url: "https://app.reviewrouter.dev",
    runtime_config_mode: "oidc",
    provider_instance_id: "codex-rotating:123456",
    workflow_schema_version: 2,
    codex_session_mode: "account-gateway",
  });
  expect(job.with.pr_number).toContain("github.event.pull_request.number");
  expect(job.with.review_head_sha).toContain(
    "github.event.pull_request.head.sha",
  );
  expect(job.secrets).toBeUndefined();
  expect(job.steps).toBeUndefined();
  expect(file.content).not.toMatch(
    /AUTH_JSON|namespace|lease|writeback|hosted-pool|gateway_binding|gateway_profile/,
  );
});

it.each(["", "0", "01", "not-a-number"])(
  "rejects invalid repository identity %s",
  (githubRepositoryId) => {
    expect(() =>
      renderAccountGatewayWorkflow({
        githubRepositoryId,
        apiUrl: "https://app.reviewrouter.dev",
        actionRef: `777genius/review-router@${"a".repeat(40)}`,
      }),
    ).toThrow();
  },
);

const workflowOptions = {
  actionRef: "777genius/review-router@v1",
  apiUrl: "https://app.reviewrouter.dev",
  runtimeConfigMode: "oidc" as const,
  conflictReviewFallbackEnabled: true,
  staticRuntimeEnv: {
    REVIEW_AUTH_MODE: "codex-oauth",
    CODEX_MODEL: "gpt-5.5",
  },
};

type ParsedWorkflow = {
  readonly jobs: Record<
    string,
    {
      readonly steps: readonly (Record<string, unknown> & {
        readonly name?: string;
        readonly if?: string;
        readonly run?: string;
      })[];
    }
  >;
};

function parseWorkflowSteps(workflow: string) {
  const parsed = parse(workflow) as ParsedWorkflow;
  return parsed.jobs.review?.steps ?? [];
}

function workflowStep(workflow: string, name: string) {
  return parseWorkflowSteps(workflow).find((step) => step.name === name);
}

function getWorkflowJobSection(workflow: string, jobId: string): string {
  const startMatch = new RegExp(`^ {2}${jobId}:\\s*$`, "m").exec(workflow);
  if (!startMatch) {
    throw new Error(`missing job ${jobId}`);
  }
  const start = startMatch.index;
  const afterStart = start + startMatch[0].length;
  const remainder = workflow.slice(afterStart);
  const nextJobMatch = /^ {2}[A-Za-z0-9_-]+:\s*$/m.exec(remainder);
  const end = nextJobMatch ? afterStart + nextJobMatch.index : workflow.length;
  return workflow.slice(start, end);
}

describe("renderReviewRouterWorkflow", () => {
  it("recognizes the pinned checkout and execution in a generated explicit review job", () => {
    const actionRef =
      "777genius/review-router@0123456789abcdef0123456789abcdef01234567";
    const workflow = renderReviewRouterWorkflow({
      actionRef,
      apiUrl: "https://reviewrouter.site",
      runtimeConfigMode: "static",
    });
    expect(workflowChecksOutReviewRouterRuntime(workflow, actionRef)).toBe(
      true,
    );
    for (const invalidWorkflow of [
      workflow.replace(
        "ref: 0123456789abcdef0123456789abcdef01234567",
        "ref: main",
      ),
      workflow.replace(
        "run: node .reviewrouter-runtime/dist/index.js",
        "run: echo skipped",
      ),
      workflow.replace("path: .reviewrouter-runtime", "path: other-runtime"),
      workflow.replace("  review:", "  unrelated:"),
      workflow.replace("          repository:", "          # repository:"),
    ]) {
      expect(
        workflowChecksOutReviewRouterRuntime(invalidWorkflow, actionRef),
      ).toBe(false);
    }
  });

  it("rejects unreachable runtime checkout, execution, and review job guards", () => {
    const actionRef =
      "777genius/review-router@0123456789abcdef0123456789abcdef01234567";
    const workflow = renderReviewRouterWorkflow({
      actionRef,
      apiUrl: "https://reviewrouter.site",
      runtimeConfigMode: "static",
    });
    for (const invalid of [
      workflow.replace(
        /(- name: Checkout ReviewRouter runtime\n {8}if:) [^\n]+/,
        "$1 ${{ false }}",
      ),
      workflow.replace(
        /(- name: Run ReviewRouter\n {8}if:) [^\n]+/,
        "$1 ${{ false }}",
      ),
      workflow.replace(/^ {4}if: [^\n]+/m, "    if: ${{ false }}"),
    ]) {
      expect(workflowChecksOutReviewRouterRuntime(invalid, actionRef)).toBe(
        false,
      );
    }
  });

  it("does not accept runtime refs in comments when the checkout targets another ref", () => {
    const actionRef =
      "777genius/review-router@0123456789abcdef0123456789abcdef01234567";
    const workflow =
      renderReviewRouterWorkflow({
        actionRef,
        apiUrl: "https://reviewrouter.site",
        runtimeConfigMode: "static",
      }).replace(
        "ref: 0123456789abcdef0123456789abcdef01234567",
        "ref: old-runtime",
      ) +
      "\n# repository: 777genius/review-router\n# ref: 0123456789abcdef0123456789abcdef01234567\n";
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: workflow,
        providerKind: "openrouter",
        workflowStyle: "explicit",
        expectedActionRef: actionRef,
      }).missingRequirements,
    ).toContain("action_ref_supports_provider");
  });

  it.each(["openrouter-api", "mimo-token-plan-api"])(
    "gives %s generated workflows a bounded paid-provider budget",
    (authMode) => {
      const options = {
        actionRef:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
        apiUrl: "https://reviewrouter.site",
        runtimeConfigMode: "static" as const,
        staticRuntimeEnv: { REVIEW_AUTH_MODE: authMode },
      };

      expect(renderReviewRouterWorkflow(options)).toContain(
        'BUDGET_MAX_USD: "1"',
      );
      expect(renderReviewRouterReusableWorkflow(options)).toContain(
        '"BUDGET_MAX_USD": "1"',
      );
      expect(
        renderReviewRouterWorkflow({
          ...options,
          staticRuntimeEnv: {
            ...options.staticRuntimeEnv,
            BUDGET_MAX_USD: "0.25",
          },
        }),
      ).toContain('BUDGET_MAX_USD: "0.25"');
    },
  );

  it("exports a dedicated advisory-only rotating Codex OAuth workflow", () => {
    const workflow = renderExportedCodexRotatingAdvisoryWorkflow({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      providerInstanceId: "codex-rotating:777genius/agent-teams-ai",
    });

    expect(workflow).toContain("name: ReviewRouter Codex OAuth");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("permissions: {}\n\njobs:");
    expect(workflow).toContain("    permissions:\n      id-token: write");
    expect(workflow).toContain("mode: codex-oauth-rotating");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("codex-refresh:");
    expect(workflow).toContain("mode: codex-oauth-refresh");
    expect(workflow).toContain(
      "group: reviewrouter-codex-oauth-${{ github.repository_id }}-codex-rotating-777genius-agent-teams-ai",
    );
    expect(workflow).not.toMatch(/^\s+queue:/m);
    expect(workflow).toContain(
      "auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
    );
    expect(workflow).not.toContain("merge_group:");
    expect(workflow).not.toContain("actions/checkout");
    expect(scanExportedCodexRotatingAdvisoryWorkflow(workflow)).toEqual({
      valid: true,
      errors: [],
    });
    expect(renderCodexRotatingAdvisoryWorkflow).toBe(
      renderExportedCodexRotatingAdvisoryWorkflow,
    );
    expect(scanCodexRotatingAdvisoryWorkflow).toBe(
      scanExportedCodexRotatingAdvisoryWorkflow,
    );
  });

  it("renders the dedicated rotating Codex workflow and trusted legacy cleanup operations when rotating provider setup is requested", () => {
    const files = renderReviewRouterWorkflowFiles({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      runtimeConfigMode: "oidc",
      workflowStyle: "reusable",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth-rotating",
      },
      codexRotatingProviderInstanceId: "codex-rotating:123456",
    });

    expect(files).toHaveLength(3);
    const codexWorkflow = files[0];
    const interactionWorkflow = files[2];
    expect(codexWorkflow?.path).toBe(defaultCodexRotatingWorkflowPath);
    expect(codexWorkflow?.operation).not.toBe("delete");
    expect(files[1]).toMatchObject({
      path: ".github/workflows/reviewrouter.yml",
      operation: "delete",
    });
    expect(interactionWorkflow?.path).toBe(defaultInteractionWorkflowPath);
    expect(interactionWorkflow?.operation).not.toBe("delete");
    const codexWorkflowContent =
      codexWorkflow && codexWorkflow.operation !== "delete"
        ? codexWorkflow.content
        : "";
    const interactionWorkflowContent =
      interactionWorkflow && interactionWorkflow.operation !== "delete"
        ? interactionWorkflow.content
        : "";
    expect(codexWorkflowContent).toContain("name: ReviewRouter Codex OAuth");
    expect(codexWorkflowContent).toContain(
      'provider-instance-id: "codex-rotating:123456"',
    );
    expect(codexWorkflowContent).not.toContain("reviewrouter-interaction.yml");
    expect(codexWorkflowContent).toContain("workflow_dispatch:");
    expect(codexWorkflowContent).toContain("schedule:");
    expect(codexWorkflowContent).toContain("codex-refresh:");
    expect(codexWorkflowContent).toContain("mode: codex-oauth-refresh");
    expect(scanCodexRotatingAdvisoryWorkflow(codexWorkflowContent)).toEqual({
      valid: true,
      errors: [],
    });
    expect(interactionWorkflowContent).toContain(
      "name: ReviewRouter Interaction",
    );
    expect(interactionWorkflowContent).toContain(
      "pull_request_review_comment:",
    );
    expect(interactionWorkflowContent).toContain("issue_comment:");
    expect(interactionWorkflowContent).toContain("runs-on: ubuntu-24.04");
    expect(interactionWorkflowContent).toContain(
      "repository: 777genius/review-router",
    );
    expect(interactionWorkflowContent).toContain(
      "run: node .reviewrouter-runtime/dist/index.js",
    );
    expect(interactionWorkflowContent).toContain(
      "CODEX_AUTH_JSON_PRESENT: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON != '' && '1' || '0' }}",
    );
    expect(interactionWorkflowContent).toContain(
      'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: "reviewrouter-codex.yml"',
    );
    expect(interactionWorkflowContent).toContain(
      'REVIEW_ROUTER_MODE: "interaction-preflight"',
    );
    expect(interactionWorkflowContent).toContain(
      'REVIEW_ROUTER_MODE: "interaction"',
    );
    expect(interactionWorkflowContent).not.toContain(
      "uses: 777genius/review-router@",
    );
    expect(interactionWorkflowContent).not.toContain("provider-instance-id:");
    expect(interactionWorkflowContent).not.toContain("auth-json:");
    expect(interactionWorkflowContent).not.toContain("secrets.CODEX_AUTH_JSON");
    expect(interactionWorkflowContent).not.toContain("OPENAI_API_KEY");
  });

  it.each([
    [
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
      true,
    ],
    [
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5,
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
      true,
    ],
    [
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5,
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5,
      true,
    ],
    [
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5,
      false,
    ],
  ])(
    "selected T0 schema v%s trusts existing schema v%s deletion: %s",
    (selectedSchemaVersion, existingSchemaVersion, trusted) => {
      const namespace = createVersionedProviderSecretNamespace({
        scope: {
          repositoryId: "1228051727",
          providerInstanceId: "codex-rotating:1228051727",
        },
        namespaceId: "sns_e9c2956ba412321fa27816e6cee3bd06",
        epoch: 2n,
        name: "REVIEWROUTER_CODEX_AUTH_JSON_R1228051727_P01cfca27f31e5f85_E2_e9c2956ba412321fa27816e6cee3bd06",
      });
      const options = {
        actionRef:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
        apiUrl: "https://api.reviewrouter.site",
        runtimeConfigMode: "oidc" as const,
        codexRotatingProviderInstanceId: "codex-rotating:1228051727",
        codexRotatingWorkflowPath: isolatedQualityWorkflowPath,
        codexRotatingActiveSecretNamespace: namespace,
        codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
        codexRotatingWorkflowSchemaVersion: selectedSchemaVersion,
      };

      const files = renderReviewRouterWorkflowFiles(options);
      expect(files.map(({ path, operation }) => ({ path, operation }))).toEqual(
        [
          { path: isolatedQualityWorkflowPath, operation: undefined },
          { path: defaultWorkflowPath, operation: "delete" },
          { path: defaultCodexRotatingWorkflowPath, operation: "delete" },
          { path: defaultInteractionWorkflowPath, operation: undefined },
        ],
      );
      expect(renderReviewRouterWorkflowFiles(options)).toEqual(files);

      const deletion = files.find(
        (file) =>
          file.path === defaultCodexRotatingWorkflowPath &&
          file.operation === "delete",
      );
      if (!deletion || deletion.operation !== "delete") {
        throw new Error("managed workflow deletion missing");
      }
      const previousWorkflow = renderCodexRotatingAdvisoryWorkflow({
        actionRef: options.actionRef,
        apiUrl: options.apiUrl,
        providerInstanceId: options.codexRotatingProviderInstanceId,
        activeSecretNamespace: namespace,
        reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
        workflowSchemaVersion: existingSchemaVersion,
      });
      expect(
        deletion.markerGroups.some((group) =>
          group.every((marker) => previousWorkflow.includes(marker)),
        ),
      ).toBe(trusted);
      expect(
        deletion.markerGroups.some((group) =>
          group.every((marker) => "name: unrelated workflow".includes(marker)),
        ),
      ).toBe(false);
    },
  );

  it("keeps the managed interaction workflow installed in T0 mode", () => {
    const files = renderReviewRouterWorkflowFiles({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://api.reviewrouter.site",
      runtimeConfigMode: "oidc",
      codexRotatingProviderInstanceId: "codex-rotating:123456",
      codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
    });

    const interactionWorkflow = files.find(
      (file) => file.path === defaultInteractionWorkflowPath,
    );
    expect(interactionWorkflow).toMatchObject({
      path: defaultInteractionWorkflowPath,
    });
    expect(interactionWorkflow?.operation).not.toBe("delete");
  });

  it("provisions the client-triggered T0 schema when explicitly selected", () => {
    const files = renderReviewRouterWorkflowFiles({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://api.reviewrouter.site",
      runtimeConfigMode: "oidc",
      codexRotatingProviderInstanceId: "codex-rotating:123456",
      codexRotatingReviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      codexRotatingWorkflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2,
    });

    const codexWorkflow = files.find(
      (file) => file.path === defaultCodexRotatingWorkflowPath,
    );
    const content =
      codexWorkflow && codexWorkflow.operation !== "delete"
        ? codexWorkflow.content
        : "";
    expect(content).toContain("  pull_request:");
    expect(content).toContain("workflow_schema_version: 2");
    expect(content).toContain(
      "review_timeout_minutes: ${{ fromJSON(vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '60') }}",
    );
    expect(scanCodexRotatingAdvisoryWorkflow(content)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("renders optional hybrid provider secret inputs only when configured for rotating Codex workflow", () => {
    const files = renderReviewRouterWorkflowFiles({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      runtimeConfigMode: "oidc",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth-rotating",
        REVIEW_PROVIDERS:
          "codex/gpt-5.5,claude/sonnet,openrouter/openai/gpt-5.3-codex",
      },
      codexRotatingProviderInstanceId: "codex-rotating:123456",
    });

    const codexWorkflow = files[0];
    const content =
      codexWorkflow && codexWorkflow.operation !== "delete"
        ? codexWorkflow.content
        : "";
    expect(content).toContain(
      "auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
    );
    expect(content).toContain(
      "claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(content).toContain(
      "openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}",
    );
    expect(scanCodexRotatingAdvisoryWorkflow(content)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("wires the selected MiMo secret through rotating provider callers and readiness markers", () => {
    expect(
      codexRotatingProviderSecretInputsForRuntimeEnv({
        REVIEW_PROVIDERS: "codex-mimo/mimo-v2.6-pro",
      }),
    ).toEqual({
      claudeCodeOAuthTokenSecret: false,
      openRouterApiKeySecret: false,
      mimoTokenPlanApiKeySecret: true,
    });

    const t0Markers = getCodexRotatingWorkflowSetupContentMarkerGroups({
      providerInstanceId: "codex-rotating:123456",
      mimoTokenPlanApiKeySecret: true,
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      workflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2,
    });
    expect(t0Markers[0]).toContain(
      "MIMO_TOKEN_PLAN_API_KEY: ${{ secrets.MIMO_TOKEN_PLAN_API_KEY }}",
    );

    const actionMarkers = getCodexRotatingWorkflowSetupContentMarkerGroups({
      providerInstanceId: "codex-rotating:123456",
      mimoTokenPlanApiKeySecret: true,
    });
    expect(actionMarkers[0]).toContain(
      "mimo-token-plan-api-key: ${{ secrets.MIMO_TOKEN_PLAN_API_KEY }}",
    );
  });

  it("routes MiMo-only setup through the pinned reusable runtime with scoped key forwarding", () => {
    const files = renderReviewRouterWorkflowFiles({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      runtimeConfigMode: "oidc",
      workflowStyle: "reusable",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "mimo-token-plan-api",
        REVIEW_PROVIDERS: "codex-mimo/mimo-v2.6-pro",
      },
    });

    expect(files.map((file) => file.path)).toEqual([
      defaultWorkflowPath,
      defaultInteractionWorkflowPath,
    ]);
    const workflow = workflowFileContent(files[0]);
    expect(workflow).toContain(reusableReviewWorkflowPath);
    expect(workflow).toContain(
      '"REVIEW_PROVIDERS": "codex-mimo/mimo-v2.6-pro"',
    );
    expect(workflow).toContain(
      "MIMO_TOKEN_PLAN_API_KEY: ${{ secrets.MIMO_TOKEN_PLAN_API_KEY }}",
    );
    expect(workflow).not.toContain("mimo-token-plan-api-key:");
    expect(workflow).not.toContain(
      "OPENROUTER_API_KEY: ${{ secrets.MIMO_TOKEN_PLAN_API_KEY }}",
    );
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: workflow,
        providerKind: "codex-mimo",
        workflowStyle: "reusable",
        expectedActionRef:
          "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      }),
    ).toEqual({
      providerKind: "codex-mimo",
      supported: true,
      missingRequirements: [],
    });
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: workflow.replace(
          "MIMO_TOKEN_PLAN_API_KEY: ${{ secrets.MIMO_TOKEN_PLAN_API_KEY }}",
          "",
        ),
        providerKind: "codex-mimo",
        workflowStyle: "reusable",
      }),
    ).toMatchObject({
      supported: false,
      missingRequirements: ["secret_pass_through"],
    });
  });

  it.each(["mimo-token-plan-api", "codex-oauth"])(
    "scopes reusable conflict and interaction secrets to selected auth mode %s",
    (authMode) => {
      const options = {
        ...workflowOptions,
        workflowStyle: "reusable" as const,
        conflictReviewFallbackEnabled: true,
        staticRuntimeEnv: { REVIEW_AUTH_MODE: authMode },
      };
      const review = parse(renderReviewRouterReusableWorkflow(options));
      const interaction = parse(
        renderReviewRouterReusableInteractionWorkflow(options),
      );
      if (authMode === "mimo-token-plan-api") {
        expect(interaction.jobs.interaction.with.discussion_auth_mode).toBe(
          "mimo-token-plan-api",
        );
        expect(interaction.jobs.interaction.with.discussion_model).toBe(
          "${{ vars.REVIEW_CODEX_MODEL || 'mimo-v2.6-pro' }}",
        );
      } else {
        expect(interaction.jobs.interaction.with).not.toHaveProperty(
          "discussion_auth_mode",
        );
        expect(interaction.jobs.interaction.with.discussion_model).toBe(
          "${{ vars.REVIEW_CODEX_MODEL || 'gpt-5.6-sol' }}",
        );
      }
      for (const job of [
        review.jobs.review,
        review.jobs["conflict-review"],
        interaction.jobs.interaction,
      ]) {
        expect(job).toBeDefined();
        if (authMode === "mimo-token-plan-api") {
          expect(job.secrets.MIMO_TOKEN_PLAN_API_KEY).toBe(
            "${{ secrets.MIMO_TOKEN_PLAN_API_KEY }}",
          );
        } else {
          expect(job.secrets).not.toHaveProperty("MIMO_TOKEN_PLAN_API_KEY");
        }
      }
    },
  );

  it("keeps stale Codex auth inert for a MiMo-only explicit workflow", () => {
    const workflow = renderReviewRouterWorkflow({
      ...workflowOptions,
      conflictReviewFallbackEnabled: false,
      workflowStyle: "explicit",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "mimo-token-plan-api",
        REVIEW_PROVIDERS: "codex-mimo/mimo-v2.6-pro",
      },
    });

    expect(workflowStep(workflow, "Install Codex CLI")?.run).toContain(
      "@openai/codex@0.147.0",
    );
    expect(
      workflowStep(workflow, "Restore Codex subscription auth")?.if,
    ).toContain("env.CODEX_AUTH_JSON_PRESENT == '1' && false");
    expect(
      workflowStep(workflow, "Require MiMo Token Plan API key")?.if,
    ).toContain("env.MIMO_TOKEN_PLAN_API_KEY_PRESENT != '1'");
    expect(workflow).toContain(
      "MIMO_TOKEN_PLAN_API_KEY: ${{ secrets.MIMO_TOKEN_PLAN_API_KEY }}",
    );
    expect(workflow).toContain("run: node .reviewrouter-runtime/dist/index.js");
  });

  it("does not provision MiMo prerequisites for a Claude-only explicit workflow", () => {
    const workflow = renderReviewRouterWorkflow({
      ...workflowOptions,
      conflictReviewFallbackEnabled: false,
      workflowStyle: "explicit",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "claude-oauth",
        REVIEW_PROVIDERS: "claude/sonnet",
      },
    });

    expect(workflowStep(workflow, "Install Codex CLI")?.if).toContain(
      "env.MIMO_TOKEN_PLAN_API_KEY_PRESENT == '1' && false",
    );
    expect(
      workflowStep(workflow, "Restore Codex subscription auth")?.if,
    ).toContain("env.CODEX_AUTH_JSON_PRESENT == '1' && false");
    expect(
      workflowStep(workflow, "Require MiMo Token Plan API key"),
    ).toBeUndefined();
    expect(workflowStep(workflow, "Install Claude Code CLI")?.if).toContain(
      "env.CLAUDE_CODE_OAUTH_TOKEN_PRESENT == '1'",
    );
    expect(workflow).not.toContain(
      "MIMO_TOKEN_PLAN_API_KEY: ${{ secrets.MIMO_TOKEN_PLAN_API_KEY }}",
    );
  });

  it.each([undefined, {}])(
    "forwards MiMo credentials when OIDC selects the provider without a static selection (%j)",
    (staticRuntimeEnv) => {
      const options = {
        actionRef: workflowOptions.actionRef,
        apiUrl: workflowOptions.apiUrl,
        runtimeConfigMode: workflowOptions.runtimeConfigMode,
        conflictReviewFallbackEnabled: false,
        workflowStyle: "explicit" as const,
      };
      const workflow = renderReviewRouterWorkflow(
        staticRuntimeEnv === undefined
          ? options
          : { ...options, staticRuntimeEnv },
      );
      expect(workflowStep(workflow, "Install Codex CLI")?.if).toContain(
        "env.MIMO_TOKEN_PLAN_API_KEY_PRESENT == '1'",
      );
      const runtimeStep = parseWorkflowSteps(workflow).find(
        (step) => step.run === "node .reviewrouter-runtime/dist/index.js",
      );
      expect(runtimeStep?.env).toMatchObject({
        MIMO_TOKEN_PLAN_API_KEY: "${{ secrets.MIMO_TOKEN_PLAN_API_KEY }}",
      });
      expect(
        workflowStep(workflow, "Require MiMo Token Plan API key"),
      ).toBeUndefined();
    },
  );

  it("includes configured fallback and synthesis providers in runtime prerequisite selection", () => {
    const fallbackRuntime = buildProviderRuntimePlan({
      schemaVersion: 2,
      providers: [
        {
          kind: "claude",
          authMode: "claude_code_oauth",
          model: "sonnet",
          reasoningEffort: "high",
          agenticContext: true,
          fastMode: false,
        },
        {
          kind: "codex-mimo",
          authMode: "mimo_token_plan_api_key",
          model: "mimo-v2.6-pro",
          reasoningEffort: "high",
          agenticContext: true,
          fastMode: false,
        },
      ],
      execution: {
        providerLimit: 2,
        providerMaxParallel: 2,
        inlineMinAgreement: 1,
      },
      blockingPolicy: { failOnSeverity: "major" },
      limits: { inlineMaxComments: 20, targetTokensPerBatch: 60000 },
    });

    expect(fallbackRuntime.synthesisModel).toBe("claude/sonnet");
    expect(
      codexRotatingProviderSecretInputsForRuntimeEnv(
        fallbackRuntime.runtimeEnv,
      ),
    ).toEqual({
      claudeCodeOAuthTokenSecret: true,
      openRouterApiKeySecret: false,
      mimoTokenPlanApiKeySecret: true,
    });

    expect(
      codexRotatingProviderSecretInputsForRuntimeEnv({
        REVIEW_PROVIDERS: "claude/sonnet",
        SYNTHESIS_MODEL: "codex-mimo/mimo-v2.6-pro",
      }),
    ).toEqual({
      claudeCodeOAuthTokenSecret: true,
      openRouterApiKeySecret: false,
      mimoTokenPlanApiKeySecret: true,
    });

    expect(
      codexRotatingProviderSecretInputsForRuntimeEnv({
        REVIEW_PROVIDERS:
          "codex/gpt-5.6-sol,claude/sonnet,openrouter/openai/gpt-5.3-codex",
        SYNTHESIS_MODEL: "codex-mimo/mimo-v2.6-pro",
      }),
    ).toEqual({
      claudeCodeOAuthTokenSecret: true,
      openRouterApiKeySecret: true,
      mimoTokenPlanApiKeySecret: true,
    });
  });

  it("uses an explicitly selected auth mode when provider ids are not materialized", () => {
    expect(
      codexRotatingProviderSecretInputsForRuntimeEnv({
        REVIEW_AUTH_MODE: "mimo-token-plan-api",
      }),
    ).toEqual({
      claudeCodeOAuthTokenSecret: false,
      openRouterApiKeySecret: false,
      mimoTokenPlanApiKeySecret: true,
    });
  });

  it("adds fork agentic sandbox as an opt-in job inside the rotating Codex workflow", () => {
    const files = renderReviewRouterWorkflowFiles({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      runtimeConfigMode: "oidc",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "codex-oauth-rotating",
        REVIEW_PROVIDERS:
          "codex/gpt-5.5,claude/sonnet,openrouter/openai/gpt-5.3-codex",
      },
      codexRotatingProviderInstanceId: "codex-rotating:123456",
      forkAgenticSandboxEnabled: true,
    });

    expect(files.map((file) => file.path)).toEqual([
      defaultCodexRotatingWorkflowPath,
      defaultWorkflowPath,
      defaultInteractionWorkflowPath,
    ]);
    const codexWorkflow = workflowFileContent(files[0]);
    expect(codexWorkflow).toContain("pull_request_target:");
    expect(codexWorkflow).toContain("fork-sandbox-review:");
    expect(codexWorkflow).toContain(
      "vars.REVIEW_ROUTER_FORK_AGENTIC_SANDBOX == 'certified'",
    );
    expect(codexWorkflow).toContain(
      "repository: ${{ github.event.pull_request.head.repo.full_name }}",
    );
    expect(codexWorkflow).toContain("path: safe-workspace");
    expect(codexWorkflow).toContain("persist-credentials: false");
    expect(codexWorkflow).toContain("fetch-depth: 0");
    expect(codexWorkflow).toContain(
      "git -C safe-workspace config --local --get-regexp",
    );
    expect(codexWorkflow).toContain("find safe-workspace -type l -print -quit");
    expect(codexWorkflow).toContain("mode: fork-agentic-sandbox");
    expect(codexWorkflow).toContain(
      "REVIEW_ROUTER_PR_WORKSPACE: ${{ github.workspace }}/safe-workspace",
    );
    expect(codexWorkflow).toContain(
      "auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
    );
    expect(codexWorkflow).toContain(
      "claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(codexWorkflow).toContain(
      "openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}",
    );
    expect(scanCodexRotatingAdvisoryWorkflow(codexWorkflow)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("renders the dedicated rotating Codex interaction workflow", () => {
    const workflow = renderCodexRotatingInteractionWorkflow({
      actionRef:
        "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
      apiUrl: "https://reviewrouter.site",
      runtimeConfigMode: "oidc",
    });

    expect(workflow).toContain("name: ReviewRouter Interaction");
    expect(workflow).toContain("pull_request_review_comment:");
    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("permissions: {}\n\njobs:");
    expect(workflow).toContain(
      "    permissions:\n      actions: write\n      contents: read\n      issues: read\n      pull-requests: read\n      id-token: write",
    );
    expect(workflow).toContain("actions: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toContain("issues: write");
    expect(workflow).toContain("repository: 777genius/review-router");
    expect(workflow).toContain(
      "uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    );
    expect(workflow).toContain(
      "uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    );
    expect(workflow).not.toContain("actions/checkout@v6");
    expect(workflow).not.toContain("actions/setup-node@v6");
    expect(workflow).toContain("run: node .reviewrouter-runtime/dist/index.js");
    expect(workflow).toContain(
      "CODEX_AUTH_JSON_PRESENT: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON != '' && '1' || '0' }}",
    );
    expect(workflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
    );
    expect(workflow).toContain(
      'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: "reviewrouter-codex.yml"',
    );
    expect(workflow).toContain('REVIEW_ROUTER_MODE: "interaction-preflight"');
    expect(workflow).toContain('REVIEW_ROUTER_MODE: "interaction"');
    expect(workflow).not.toContain("uses: 777genius/review-router@");
    expect(workflow).not.toContain("provider-instance-id:");
    expect(workflow).not.toContain("auth-json:");
    expect(workflow).not.toContain("secrets.CODEX_AUTH_JSON");
    expect(workflow).not.toContain("OPENAI_API_KEY");
    expect(
      workflowDocumentSemanticSha256(
        renderCanonicalCodexRotatingInteractionWorkflowV3({
          actionRef:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          apiUrl: "https://reviewrouter.site",
          runtimeConfigMode: "oidc",
        }),
      ),
    ).toBe("0d58d9a498409fad2b20c65d3ea09ed5c180c6b04d3e3b17faa58e20a031448f");
    expect(
      workflowDocumentSemanticSha256(
        renderCanonicalCodexRotatingInteractionWorkflowV2({
          actionRef:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          apiUrl: "https://reviewrouter.site",
          runtimeConfigMode: "oidc",
        }),
      ),
    ).toBe("84a2d9bf1a7df8902e286fbf107f334bb314f7d163bfb05dbe6eeb71f29142b3");
    expect(
      workflowDocumentSemanticSha256(
        renderCanonicalCodexRotatingInteractionWorkflowV1({
          actionRef:
            "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
          apiUrl: "https://reviewrouter.site",
          runtimeConfigMode: "oidc",
        }),
      ),
    ).toBe("fb84012531a80de8ebe881b11fc7de6deb1b9074916b13e5c5d113d888bce865");
    expect(
      areWorkflowDocumentsSemanticallyEqual(
        workflow,
        workflow.replace("  workflow_dispatch:", "  workflow_dispatch: .nan"),
      ),
    ).toBe(false);
  });

  it.each(["main", "v1", "v1.2.3"])(
    "rejects mutable %s runtime refs before granting app-first rerun authority",
    (runtimeRef) => {
      const options = {
        actionRef: `777genius/review-router@${runtimeRef}`,
        apiUrl: "https://reviewrouter.site",
        runtimeConfigMode: "oidc" as const,
      };

      expect(() =>
        renderCanonicalCodexRotatingInteractionWorkflowV3(options),
      ).toThrow("invalid_app_first_interaction_reusable_workflow_runtime_ref");
      expect(() => renderCodexRotatingInteractionWorkflow(options)).toThrow(
        "invalid_app_first_interaction_reusable_workflow_runtime_ref",
      );
      expect(() =>
        renderCanonicalCodexRotatingInteractionWorkflowV2(options),
      ).not.toThrow();
      expect(() =>
        renderCanonicalCodexRotatingInteractionWorkflowV1(options),
      ).not.toThrow();
    },
  );

  it.each(["a".repeat(39), "a".repeat(41), `${"a".repeat(39)}z`])(
    "rejects malformed %s runtime refs before granting app-first rerun authority",
    (runtimeRef) => {
      expect(() =>
        renderCodexRotatingInteractionWorkflow({
          actionRef: `777genius/review-router@${runtimeRef}`,
          apiUrl: "https://reviewrouter.site",
          runtimeConfigMode: "oidc",
        }),
      ).toThrow("invalid_reusable_workflow_runtime_ref");
    },
  );

  it("accepts an uppercase immutable runtime SHA", () => {
    expect(() =>
      renderCodexRotatingInteractionWorkflow({
        actionRef: `777genius/review-router@${"A".repeat(40)}`,
        apiUrl: "https://reviewrouter.site",
        runtimeConfigMode: "oidc",
      }),
    ).not.toThrow();
  });

  it("exports readiness markers for the dedicated rotating Codex workflow", () => {
    expect(
      getCodexRotatingWorkflowSetupContentMarkerGroups({
        providerInstanceId: "codex-rotating:123456",
        claudeCodeOAuthTokenSecret: true,
        openRouterApiKeySecret: true,
      }),
    ).toEqual([
      [
        "name: ReviewRouter Codex OAuth",
        "permissions: {}\n\njobs:",
        "pull_request_target:",
        "    permissions:\n      id-token: write",
        "mode: codex-oauth-rotating",
        "vars.REVIEW_ROUTER_REVIEW_DRAFTS == 'true'",
        "review-drafts: ${{ vars.REVIEW_ROUTER_REVIEW_DRAFTS == 'true' }}",
        "max-changed-lines: ${{ vars.REVIEW_ROUTER_MAX_CHANGED_LINES }}",
        "timeout-minutes: ${{ fromJSON(vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '60') }}",
        "review-timeout-minutes: ${{ vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '60' }}",
        'provider-instance-id: "codex-rotating:123456"',
        "auth-json: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
        "claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
        "openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}",
      ],
    ]);
  });

  it("exports distinct readiness markers for client-triggered T0 schema v2", () => {
    const markers = getCodexRotatingWorkflowSetupContentMarkerGroups({
      providerInstanceId: "codex-rotating:123456",
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      workflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2,
    });

    expect(markers).toEqual([
      expect.arrayContaining([
        "pull_request:",
        ".github/workflows/reviewrouter-t0-reusable.yml@",
        'provider_instance_id: "codex-rotating:123456"',
        "workflow_schema_version: 2",
        "review_timeout_minutes: ${{ fromJSON(vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '60') }}",
        "CODEX_AUTH_JSON: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
      ]),
    ]);
    expect(markers[0]).not.toContain("pull_request_target:");
    expect(markers[0]).not.toContain("mode: codex-oauth-rotating");
  });

  it("exports the lifecycle timeout only for client-triggered T0 schema v3", () => {
    const markers = getCodexRotatingWorkflowSetupContentMarkerGroups({
      providerInstanceId: "codex-rotating:123456",
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      workflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredLifecycleV3,
    });

    expect(markers).toEqual([
      expect.arrayContaining([
        "pull_request:",
        "workflow_schema_version: 3",
        "review_timeout_minutes: ${{ fromJSON(vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '240') }}",
      ]),
    ]);
    expect(markers[0]).not.toContain("workflow_schema_version: 2");
    expect(markers[0]).toContain("pull_request:");
    expect(markers[0]).toContain("github.event_name == 'pull_request'");
    expect(markers[0]).not.toContain("pull_request_target:");
  });

  it("exports trusted default-branch trigger markers for schema v4", () => {
    const markers = getCodexRotatingWorkflowSetupContentMarkerGroups({
      providerInstanceId: "codex-rotating:123456",
      reviewActionV2Mode: CodexRotatingReviewActionV2Mode.T0,
      workflowSchemaVersion:
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4,
      activeSecretNamespace: createVersionedProviderSecretNamespace({
        scope: {
          repositoryId: "123456",
          providerInstanceId: "codex-rotating:123456",
        },
        namespaceId: "sns_0123456789abcdef0123456789abcdef",
        epoch: 4,
        name: "REVIEWROUTER_CODEX_AUTH_JSON_R123456_Pb3d5f6be619a10be_E4_0123456789abcdef0123456789abcdef",
      }),
    });

    expect(markers[0]).toEqual(
      expect.arrayContaining([
        "pull_request_target:",
        "github.event_name == 'pull_request_target'",
        "workflow_schema_version: 4",
      ]),
    );
    expect(markers[0]).not.toContain("pull_request:");
    expect(markers[0]).not.toContain("github.event_name == 'pull_request'");
  });

  it("renders a review-only pull request workflow", () => {
    const workflow = renderReviewRouterWorkflow({
      ...workflowOptions,
      conflictReviewFallbackEnabled: false,
    });

    expect(workflow).toContain("name: ReviewRouter");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request_review_comment:");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toContain("name: interaction");
    expect(workflow).not.toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(
      "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository",
    );
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false",
    );
    expect(workflow).toContain("repository: 777genius/review-router");
    expect(workflow).toContain("ref: v1");
    expect(workflow).toContain("run: node .reviewrouter-runtime/dist/index.js");
    expect(workflow).toContain("uses: actions/setup-node@v6");
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("npm install -g @openai/codex@0.147.0");
    expect(workflow).toContain("env.OPENROUTER_API_KEY_PRESENT == '1'");
    expect(workflow).toContain("github.event.pull_request.user.type != 'Bot'");
    expect(workflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(workflow).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
    expect(workflow).toContain(
      "OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}",
    );
    expect(workflow).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN_PRESENT: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' && '1' || '0' }}",
    );
    expect(workflow).toContain("Install Claude Code CLI");
    expect(workflow).toContain("bash -s stable");
    expect(workflow).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(workflow).toContain(
      "CODEX_AUTH_JSON secret is missing. reseed auth.json",
    );
    expect(workflow).toContain(
      'REVIEWROUTER_API_URL: "https://app.reviewrouter.dev"',
    );
    expect(workflow).toContain('REVIEWROUTER_ACTION_VERSION: "v1"');
    expect(workflow).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(workflow).toContain(
      "PR_NUMBER: ${{ github.event.pull_request.number }}",
    );
    expect(workflow).toContain('REVIEWROUTER_OIDC_AUDIENCE: "reviewrouter"');
    expect(workflow).toContain('REVIEWROUTER_RUNTIME_CONFIG_MODE: "oidc"');
    expect(workflow).toContain('REVIEWROUTER_COMMENT_TOKEN_MODE: "app-oidc"');
    expect(workflow).toContain('REVIEW_ROUTER_MEMORY_ENABLED: "true"');
    expect(workflow).toContain(
      'REVIEW_ROUTER_MEMORY_BUNDLE_ENDPOINT: "/api/action/v1/memory"',
    );
    expect(workflow).not.toContain("REVIEW_ROUTER_MEMORY_COMMAND_ENDPOINT");
    expect(workflow).toContain('REVIEW_AUTH_MODE: "codex-oauth"');
    expect(workflow).toContain('CODEX_MODEL: "gpt-5.5"');
  });

  it("requires rotating Codex setup before fork agentic sandbox can be provisioned", () => {
    expect(() =>
      renderReviewRouterWorkflowFiles({
        ...workflowOptions,
        forkAgenticSandboxEnabled: true,
      }),
    ).toThrow("fork_agentic_sandbox_requires_codex_rotating");
  });

  it("renders a separate interaction workflow for /rr commands", () => {
    const workflow = renderReviewRouterInteractionWorkflow(workflowOptions);

    expect(workflow).toContain("name: ReviewRouter Interaction");
    expect(workflow).toContain("pull_request_review_comment:");
    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("types: [created, edited]");
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot')",
    );
    expect(workflow).not.toContain("pull_request:\n");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("github.event.comment.user.type != 'Bot'");
    expect(workflow).not.toContain(
      "startsWith(github.event.comment.body, '/rr ')",
    );
    expect(workflow).toContain("Preflight ReviewRouter interaction");
    expect(workflow).toContain("mode: interaction-preflight");
    expect(workflow).toContain('api-url: "https://app.reviewrouter.dev"');
    expect(workflow).toContain('REVIEW_ROUTER_MODE: "interaction-preflight"');
    expect(workflow).toContain(
      "REVIEW_ROUTER_DISCUSSION_MODE: ${{ vars.REVIEW_ROUTER_DISCUSSION_MODE || 'off' }}",
    );
    expect(workflow).toContain(
      "steps.preflight.outputs.needs_discussion == 'true'",
    );
    expect(workflow).toContain("Install Codex CLI for discussion replies");
    expect(workflow).toContain(
      "Restore Codex subscription auth for discussion replies",
    );
    expect(workflow).toContain("CODEX_AUTH_JSON_PRESENT");
    expect(workflow).toContain("OPENAI_API_KEY_PRESENT");
    expect(workflow).toContain("steps.preflight.outputs.should_run == 'true'");
    expect(workflow).toContain("mode: interaction");
    expect(workflow).toContain('REVIEW_ROUTER_MODE: "interaction"');
    expect(workflow).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
    expect(workflow).toContain(
      "CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL || 'gpt-5.6-sol' }}",
    );
    expect(workflow).toContain(
      "CODEX_REASONING_EFFORT: ${{ vars.REVIEW_CODEX_EFFORT || 'xhigh' }}",
    );
    expect(workflow).not.toContain("REVIEW_ROUTER_THREAD_RESOLVE_TOKEN");
    expect(workflow).toContain(
      'REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: "reviewrouter.yml"',
    );
    expect(workflow).toContain('REVIEWROUTER_COMMENT_TOKEN_MODE: "app-oidc"');
    expect(workflow).toContain('REVIEW_ROUTER_MEMORY_ENABLED: "true"');
    expect(workflow).toContain(
      'REVIEW_ROUTER_MEMORY_CANDIDATE_ENDPOINT: "/api/action/v1/memory-candidates"',
    );
    expect(workflow).toContain(
      'REVIEW_ROUTER_MEMORY_COMMAND_ENDPOINT: "/api/action/v1/memory-commands"',
    );
  });

  it("returns both workflow files for setup PR provisioning", () => {
    const files = renderReviewRouterWorkflowFiles(workflowOptions);

    expect(files.map((file) => file.path)).toEqual([
      defaultWorkflowPath,
      defaultInteractionWorkflowPath,
    ]);
    const [reviewWorkflow, interactionWorkflow] = files;
    const reviewWorkflowContent = workflowFileContent(reviewWorkflow);
    const interactionWorkflowContent = workflowFileContent(interactionWorkflow);
    expect(reviewWorkflowContent).toContain("name: ReviewRouter");
    expect(reviewWorkflowContent).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1",
    );
    expect(reviewWorkflowContent).not.toContain("pull_request_review_comment:");
    expect(interactionWorkflowContent).toContain(
      "name: ReviewRouter Interaction",
    );
    expect(interactionWorkflowContent).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@v1",
    );
    expect(interactionWorkflowContent).toContain(
      "review_workflow_file: reviewrouter.yml",
    );
    expect(interactionWorkflowContent).toContain(
      "discussion_mode: ${{ vars.REVIEW_ROUTER_DISCUSSION_MODE || 'off' }}",
    );
    expect(interactionWorkflowContent).toContain(
      "discussion_model: ${{ vars.REVIEW_CODEX_MODEL || 'gpt-5.6-sol' }}",
    );
    expect(interactionWorkflowContent).toContain(
      "discussion_reasoning_effort: ${{ vars.REVIEW_CODEX_EFFORT || 'xhigh' }}",
    );
    expect(interactionWorkflowContent).toContain(
      "discussion_max_per_pr: ${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_PR || '20' }}",
    );
    expect(interactionWorkflowContent).toContain(
      "pull_request_review_comment:",
    );
    expect(interactionWorkflowContent).toContain("issue_comment:");
    expect(interactionWorkflowContent).toContain(
      "github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot')",
    );
  });

  it("can opt setup PR interaction workflows into suggest-only discussion replies", () => {
    const files = renderReviewRouterWorkflowFiles({
      ...workflowOptions,
      discussionMode: "suggest",
    });
    const interactionWorkflowContent = workflowFileContent(
      files.find((file) => file.path === defaultInteractionWorkflowPath),
    );

    expect(interactionWorkflowContent).toContain(
      "discussion_mode: ${{ vars.REVIEW_ROUTER_DISCUSSION_MODE || 'suggest' }}",
    );
  });

  it("does not render conflict fallback trigger or inputs unless enabled", () => {
    const workflow = renderReviewRouterReusableWorkflow({
      ...workflowOptions,
      conflictReviewFallbackEnabled: false,
    });

    expect(workflow).not.toContain("repository_dispatch:");
    expect(workflow).not.toContain("github.event.client_payload");
    expect(workflow).not.toContain("review_kind:");
    expect(workflow).not.toContain("conflict_dispatch_id:");
  });

  it("rejects mutable reusable workflow refs when conflict fallback is enabled", () => {
    expect(() =>
      renderReviewRouterReusableWorkflow({
        ...workflowOptions,
        actionRef: "777genius/review-router@main",
      }),
    ).toThrow("invalid_conflict_review_reusable_workflow_runtime_ref");

    expect(() =>
      renderReviewRouterReusableWorkflow({
        ...workflowOptions,
        actionRef: "777genius/review-router@main",
        conflictReviewFallbackEnabled: false,
      }),
    ).not.toThrow();
  });

  it("renders compact reusable caller workflows with conflict fallback enabled", () => {
    const reviewWorkflow = renderReviewRouterReusableWorkflow(workflowOptions);
    const interactionWorkflow =
      renderReviewRouterReusableInteractionWorkflow(workflowOptions);
    const reviewJob = getWorkflowJobSection(reviewWorkflow, "review");
    const conflictReviewJob = getWorkflowJobSection(
      reviewWorkflow,
      "conflict-review",
    );

    expect(reviewWorkflow).toContain("pull_request:");
    expect(reviewWorkflow).toContain("merge_group:");
    expect(reviewWorkflow).toContain("repository_dispatch:");
    expect(reviewWorkflow).toContain("types: [reviewrouter_conflict_review]");
    expect(reviewWorkflow).toContain("workflow_dispatch:");
    expect(reviewWorkflow).toContain("permissions: {}\n\nconcurrency:");
    expect(reviewWorkflow).toContain("concurrency:");
    expect(reviewWorkflow).toContain(
      "group: reviewrouter-conflict-${{ github.repository }}-${{ github.workflow }}-${{ github.run_id }}",
    );
    expect(reviewWorkflow).toContain("cancel-in-progress: false");
    expect(reviewJob).toContain(
      "if: ${{ github.event_name != 'repository_dispatch' }}",
    );
    expect(reviewJob).toContain("pull-requests: write");
    expect(reviewJob).toContain("issues: write");
    expect(reviewJob).not.toContain("github.event.client_payload");
    expect(reviewJob).not.toContain("review_kind:");
    expect(conflictReviewJob).toContain("name: conflict review");
    expect(conflictReviewJob).toContain(
      "github.event_name == 'repository_dispatch' && github.event.action == 'reviewrouter_conflict_review'",
    );
    expect(conflictReviewJob).toContain("contents: read");
    expect(conflictReviewJob).toContain("id-token: write");
    expect(conflictReviewJob).not.toContain("pull-requests: write");
    expect(conflictReviewJob).not.toContain("issues: write");
    expect(conflictReviewJob).not.toContain("write-all");
    expect(conflictReviewJob).not.toContain("read-all");
    expect(reviewJob).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1",
    );
    expect(conflictReviewJob).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@v1",
    );
    expect(reviewWorkflow).toContain("runtime_ref: v1");
    expect(reviewWorkflow).toContain('api_url: "https://app.reviewrouter.dev"');
    expect(reviewWorkflow).toContain("runtime_config_mode: oidc");
    expect(reviewJob).toContain(
      "pr_number: ${{ github.event.pull_request.number || inputs.pr_number }}",
    );
    expect(conflictReviewJob).toContain(
      "pr_number: ${{ github.event.client_payload.pr_number }}",
    );
    expect(conflictReviewJob).toContain("review_kind: conflict-head");
    expect(conflictReviewJob).toContain("conflict_repository_id:");
    expect(conflictReviewJob).toContain("conflict_dispatch_event_type:");
    expect(conflictReviewJob).toContain("conflict_dispatch_id:");
    expect(conflictReviewJob).toContain("conflict_dispatch_nonce:");
    expect(conflictReviewJob).toContain("conflict_head_sha:");
    expect(conflictReviewJob).toContain("conflict_base_ref:");
    expect(conflictReviewJob).toContain("conflict_base_sha:");
    const staticRuntimeEnvJsonBlock = [
      "static_runtime_env_json: |-",
      "        {",
      '          "REVIEW_AUTH_MODE": "codex-oauth",',
      '          "CODEX_MODEL": "gpt-5.5"',
      "        }",
    ].join("\n");
    expect(reviewJob).toContain(staticRuntimeEnvJsonBlock);
    expect(conflictReviewJob).not.toContain("static_runtime_env_json:");
    expect(conflictReviewJob).not.toContain('"REVIEW_AUTH_MODE"');
    expect(conflictReviewJob).not.toContain('"CODEX_MODEL"');
    expect(reviewWorkflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(reviewWorkflow).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(reviewWorkflow).toContain(
      "REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}",
    );
    expect(conflictReviewJob).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(conflictReviewJob).toContain(
      "OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
    );
    expect(conflictReviewJob).not.toContain("REVIEW_ROUTER_LEDGER_KEY");
    expect(conflictReviewJob).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(conflictReviewJob).not.toContain("OPENROUTER_API_KEY");
    expect(reviewWorkflow).not.toContain("pull_request_target");
    expect(reviewWorkflow).not.toContain("actions/setup-node@v6");

    expect(interactionWorkflow).toContain("pull_request_review_comment:");
    expect(interactionWorkflow).toContain("issue_comment:");
    expect(interactionWorkflow).toContain("types: [created, edited]");
    expect(interactionWorkflow).toContain(
      "github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot')",
    );
    expect(interactionWorkflow).toContain("actions: write");
    expect(interactionWorkflow).toContain(
      "uses: 777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@v1",
    );
    expect(interactionWorkflow).toContain(
      "REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}",
    );
    expect(interactionWorkflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(interactionWorkflow).toContain(
      "CODEX_CONFIG_TOML: ${{ secrets.CODEX_CONFIG_TOML }}",
    );
    expect(interactionWorkflow).toContain(
      "OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
    );
    expect(interactionWorkflow).not.toContain("pull_request_target");
  });

  it("keeps explicit workflow rendering available for debug fallback", () => {
    const files = renderReviewRouterWorkflowFiles({
      ...workflowOptions,
      workflowStyle: "explicit",
      conflictReviewFallbackEnabled: false,
    });

    const workflow = files[0];
    const workflowContent =
      workflow && workflow.operation !== "delete" ? workflow.content : "";
    expect(workflowContent).toContain("repository: 777genius/review-router");
    expect(workflowContent).toContain("ref: v1");
    expect(workflowContent).toContain(
      "run: node .reviewrouter-runtime/dist/index.js",
    );
    expect(workflowContent).toContain("actions/setup-node@v6");
    expect(workflowContent).not.toContain(
      ".github/workflows/reviewrouter-reusable.yml",
    );
  });

  it("rejects conflict fallback on explicit workflows", () => {
    expect(() =>
      renderReviewRouterWorkflowFiles({
        ...workflowOptions,
        workflowStyle: "explicit",
      }),
    ).toThrow("conflict_review_explicit_workflow_unsupported");
    expect(() => renderReviewRouterWorkflow(workflowOptions)).toThrow(
      "conflict_review_explicit_workflow_unsupported",
    );
  });

  it("renders a required ruleset workflow without pull_request_target", () => {
    const workflow = renderReviewRouterRequiredWorkflow(workflowOptions);

    expect(defaultRequiredWorkflowPath).toBe(
      ".github/workflows/reviewrouter-required.yml",
    );
    expect(workflow).toContain("name: ReviewRouter Required");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("merge_group:");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("repository_dispatch:");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("ReviewRouter merge queue check passed");
    expect(workflow).toContain("uses: 777genius/review-router@v1");
    expect(workflow).toContain("github.event_name != 'merge_group'");
    expect(workflow).toContain(
      "github.event_name != 'merge_group' && (github.event_name != 'pull_request'",
    );
    expect(workflow).toContain('REVIEWROUTER_COMMENT_TOKEN_MODE: "app-oidc"');
    expect(workflow).toContain(
      'REVIEW_ROUTER_MEMORY_BUNDLE_ENDPOINT: "/api/action/v1/memory"',
    );
    expect(workflow).toContain(
      "CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
    );
    expect(workflow).toContain(
      "CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(workflow).toContain("Install Claude Code CLI");
    expect(workflow).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
  });

  it("detects Claude workflow compatibility for generated and old workflows", () => {
    const reusableWorkflow =
      renderReviewRouterReusableWorkflow(workflowOptions);
    const explicitWorkflow = renderReviewRouterWorkflow({
      ...workflowOptions,
      workflowStyle: "explicit",
      conflictReviewFallbackEnabled: false,
    });

    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: reusableWorkflow,
        providerKind: "claude",
        workflowStyle: "reusable",
      }),
    ).toEqual({
      providerKind: "claude",
      supported: true,
      missingRequirements: [],
    });
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: explicitWorkflow,
        providerKind: "claude",
        workflowStyle: "explicit",
      }),
    ).toEqual({
      providerKind: "claude",
      supported: true,
      missingRequirements: [],
    });
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: reusableWorkflow.replaceAll(
          "CLAUDE_CODE_OAUTH_TOKEN",
          "OLD_SECRET",
        ),
        providerKind: "claude",
        workflowStyle: "reusable",
      }),
    ).toMatchObject({
      supported: false,
      missingRequirements: ["secret_pass_through"],
    });
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: explicitWorkflow.replace("Install Claude Code CLI", ""),
        providerKind: "claude",
        workflowStyle: "explicit",
      }),
    ).toMatchObject({
      supported: false,
      missingRequirements: ["cli_install_step"],
    });
  });

  it("detects OpenRouter workflow compatibility for generated and old workflows", () => {
    const reusableWorkflow =
      renderReviewRouterReusableWorkflow(workflowOptions);
    const explicitWorkflow = renderReviewRouterWorkflow({
      ...workflowOptions,
      workflowStyle: "explicit",
      conflictReviewFallbackEnabled: false,
    });

    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: reusableWorkflow,
        providerKind: "openrouter",
        workflowStyle: "reusable",
      }),
    ).toEqual({
      providerKind: "openrouter",
      supported: true,
      missingRequirements: [],
    });
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: explicitWorkflow,
        providerKind: "openrouter",
        workflowStyle: "explicit",
      }),
    ).toEqual({
      providerKind: "openrouter",
      supported: true,
      missingRequirements: [],
    });
    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: explicitWorkflow.replace("Install Codex CLI", ""),
        providerKind: "openrouter",
        workflowStyle: "explicit",
      }),
    ).toMatchObject({
      supported: false,
      missingRequirements: ["cli_install_step"],
    });
  });

  it("rejects a MiMo workflow without a clear missing-secret fail-fast gate", () => {
    const workflow = renderReviewRouterWorkflow({
      ...workflowOptions,
      conflictReviewFallbackEnabled: false,
      workflowStyle: "explicit",
      staticRuntimeEnv: {
        REVIEW_AUTH_MODE: "mimo-token-plan-api",
        REVIEW_PROVIDERS: "codex-mimo/mimo-v2.6-pro",
      },
    });
    const workflowWithoutGate = workflow
      .replace("Require MiMo Token Plan API key", "Check MiMo credential")
      .replace(
        "MIMO_TOKEN_PLAN_API_KEY is missing.",
        "MiMo credential check completed.",
      );

    expect(
      analyzeWorkflowProviderCompatibility({
        workflowYaml: workflowWithoutGate,
        providerKind: "codex-mimo",
        workflowStyle: "explicit",
      }),
    ).toMatchObject({
      supported: false,
      missingRequirements: ["secret_fail_fast"],
    });
  });

  it("exports provider workflow marker groups for readiness probes", () => {
    expect(
      getWorkflowProviderContentMarkerGroups({ providerKind: "claude" }),
    ).toEqual([
      [
        ".github/workflows/reviewrouter-reusable.yml",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ],
      [
        "Install Claude Code CLI",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "Skip fork pull requests",
      ],
    ]);
    expect(
      getWorkflowProviderContentMarkerGroups({ providerKind: "openrouter" }),
    ).toEqual([
      [".github/workflows/reviewrouter-reusable.yml", "OPENROUTER_API_KEY"],
      ["Install Codex CLI", "OPENROUTER_API_KEY", "Skip fork pull requests"],
    ]);
    expect(
      getWorkflowProviderContentMarkerGroups({ providerKind: "codex" }),
    ).toEqual([]);
  });

  it("exports combined conflict fallback marker groups for setup readiness probes", () => {
    expect(
      getWorkflowSetupContentMarkerGroups({
        conflictReviewFallbackEnabled: true,
      }),
    ).toEqual([
      [
        ".github/workflows/reviewrouter-reusable.yml",
        ".github/workflows/reviewrouter-conflict-reusable.yml",
        "repository_dispatch:",
        "types: [reviewrouter_conflict_review]",
        "conflict-review:",
        "github.event_name == 'repository_dispatch'",
        "github.event.action == 'reviewrouter_conflict_review'",
        "review_kind: conflict-head",
        "conflict_repository_id:",
        "conflict_dispatch_event_type:",
        "conflict_dispatch_id:",
      ],
    ]);

    expect(
      getWorkflowSetupContentMarkerGroups({
        providerKind: "claude",
        conflictReviewFallbackEnabled: true,
      }),
    ).toEqual([
      [
        ".github/workflows/reviewrouter-reusable.yml",
        "CLAUDE_CODE_OAUTH_TOKEN",
        ".github/workflows/reviewrouter-conflict-reusable.yml",
        "repository_dispatch:",
        "types: [reviewrouter_conflict_review]",
        "conflict-review:",
        "github.event_name == 'repository_dispatch'",
        "github.event.action == 'reviewrouter_conflict_review'",
        "review_kind: conflict-head",
        "conflict_repository_id:",
        "conflict_dispatch_event_type:",
        "conflict_dispatch_id:",
      ],
    ]);
  });

  it("detects conflict review capability only on the reusable review workflow", () => {
    const reviewWorkflow = renderReviewRouterReusableWorkflow(workflowOptions);
    const explicitWorkflow = renderReviewRouterWorkflow({
      ...workflowOptions,
      workflowStyle: "explicit",
      conflictReviewFallbackEnabled: false,
    });
    const requiredWorkflow =
      renderReviewRouterRequiredWorkflow(workflowOptions);

    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow,
      }),
    ).toEqual({ supported: true });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: explicitWorkflow,
      }),
    ).toEqual({
      supported: false,
      reason: "repository_dispatch_missing",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: requiredWorkflow,
      }),
    ).toEqual({
      supported: false,
      reason: "repository_dispatch_missing",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow
          .replace("  repository_dispatch:", "  # repository_dispatch:")
          .replace(
            "    types: [reviewrouter_conflict_review]",
            "    # types: [reviewrouter_conflict_review]",
          ),
      }),
    ).toEqual({
      supported: false,
      reason: "repository_dispatch_missing",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow.replace("conflict_dispatch_id:", ""),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_dispatch_inputs_missing",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: [
          reviewWorkflow,
          "  unsafe:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo unsafe",
        ].join("\n"),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_fallback_workflow_shape_untrusted",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: [
          reviewWorkflow,
          "  unsafe:",
          "    uses: attacker/workflows/.github/workflows/review.yml@main",
        ].join("\n"),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_fallback_workflow_shape_untrusted",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow.replace(
          ".github/workflows/reviewrouter-conflict-reusable.yml@v1",
          ".github/workflows/reviewrouter-conflict-reusable.yml@main",
        ),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_reusable_workflow_ref_untrusted",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow.replace(
          "github.run_id",
          "github.event.client_payload.dispatch_id",
        ),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_concurrency_missing",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow.replace(
          [
            "    permissions:",
            "      contents: read",
            "      id-token: write",
            "    uses: 777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@v1",
          ].join("\n"),
          [
            "    permissions:",
            "      contents: read",
            "      pull-requests: write",
            "      id-token: write",
            "    uses: 777genius/review-router/.github/workflows/reviewrouter-conflict-reusable.yml@v1",
          ].join("\n"),
        ),
      }),
    ).toEqual({
      supported: false,
      reason: "conflict_workflow_write_permissions_forbidden",
    });
    expect(
      analyzeConflictReviewWorkflowCapability({
        workflowYaml: reviewWorkflow.replace(
          "permissions: {}\n\nconcurrency:",
          [
            "permissions:",
            "  contents: read",
            "  pull-requests: write",
            "  issues: write",
            "  id-token: write",
            "",
            "concurrency:",
          ].join("\n"),
        ),
      }),
    ).toEqual({
      supported: false,
      reason: "workflow_write_permissions_forbidden",
    });
  });

  it("uses github-actions comment identity when runtime config is static", () => {
    const reviewWorkflow = renderReviewRouterWorkflow({
      actionRef: "777genius/review-router@v1",
      apiUrl: "https://app.reviewrouter.dev",
      runtimeConfigMode: "static",
    });
    const interactionWorkflow = renderReviewRouterInteractionWorkflow({
      actionRef: "777genius/review-router@v1",
      apiUrl: "https://app.reviewrouter.dev",
      runtimeConfigMode: "static",
    });

    expect(reviewWorkflow).toContain(
      'REVIEWROUTER_COMMENT_TOKEN_MODE: "github-token"',
    );
    expect(interactionWorkflow).toContain(
      'REVIEWROUTER_COMMENT_TOKEN_MODE: "github-token"',
    );
  });

  it("allows local http for development workflow provisioning only", () => {
    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "http://localhost:4000",
        runtimeConfigMode: "oidc",
      }),
    ).not.toThrow();
    expect(() =>
      renderReviewRouterInteractionWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "http://127.0.0.1:4000",
        runtimeConfigMode: "oidc",
      }),
    ).not.toThrow();
    expect(() =>
      renderReviewRouterInteractionWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "http://[::1]:4000",
        runtimeConfigMode: "oidc",
      }),
    ).not.toThrow();
  });

  it("rejects HTTPS loopback origins during workflow-domain validation", () => {
    for (const origin of [
      "https://localhost",
      "https://127.0.0.1",
      "https://127.1",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:7f00:1]",
    ]) {
      expect(
        () =>
          renderReviewRouterWorkflow({
            actionRef: "777genius/review-router@v1",
            apiUrl: origin,
            runtimeConfigMode: "oidc",
          }),
        origin,
      ).toThrow("invalid_workflow_api_url");
    }
  });

  it("rejects unsafe workflow template inputs before rendering YAML", () => {
    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1\nrun: evil",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_action_ref");

    expect(() =>
      renderReviewRouterInteractionWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "javascript:alert(1)",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterRequiredWorkflow({
        actionRef: "777genius/review-router@v1\nrun: evil",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_action_ref");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "http://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://token@example.com",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev?target=evil",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev/base-path",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_workflow_api_url");

    expect(() =>
      renderReviewRouterWorkflow({
        actionRef: "777genius/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "static",
        staticRuntimeEnv: {
          "BAD_KEY:\n          RUN": "evil",
        },
      }),
    ).toThrow("invalid_workflow_env_key");

    expect(() =>
      renderReviewRouterReusableWorkflow({
        actionRef: "evil/review-router@v1",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_reusable_workflow_action_ref");

    expect(() =>
      renderReviewRouterReusableWorkflow({
        actionRef: "777genius/review-router@feature/evil",
        apiUrl: "https://app.reviewrouter.dev",
        runtimeConfigMode: "oidc",
      }),
    ).toThrow("invalid_reusable_workflow_runtime_ref");
  });
});

function workflowFileContent(
  file: ReturnType<typeof renderReviewRouterWorkflowFiles>[number] | undefined,
): string {
  return file && file.operation !== "delete" ? file.content : "";
}

it("delegates gateway production rendering to the single canonical domain representation", () => {
  const options = {
    actionRef:
      "777genius/review-router@9d30879b333c6474d104f5911f548419702b758b",
    apiUrl: "https://aberdeen-say-beverages-testimony.trycloudflare.com",
    githubRepositoryId: "1317214237",
    reviewTimeoutMinutes: 15,
  };
  const file = renderAccountGatewayWorkflow(options);
  expect(file.content).toBe(renderCanonicalAccountGatewayWorkflow(options));
  expect(file.content).toContain("review_timeout_minutes: 15");
  expect(
    readCanonicalCodexRotatingT0WorkflowSourceMetadata(file.content),
  ).toMatchObject({
    actionRef: options.actionRef,
    apiUrl: options.apiUrl,
    providerInstanceId: `codex-rotating:${options.githubRepositoryId}`,
    workflowSchemaVersion: 2,
    codexSessionMode: "account-gateway",
  });
  expect(scanCodexRotatingAdvisoryWorkflow(file.content)).toEqual({
    valid: true,
    errors: [],
  });
  expect(() =>
    renderAccountGatewayWorkflow({
      ...options,
      githubRepositoryId: "1228051727",
    }),
  ).toThrow("account_gateway_workflow_path_not_supported");
});

it.each([
  "777genius/review-router@v1",
  `attacker/runtime@${"a".repeat(40)}`,
  `777genius/review-router@${"a".repeat(39)}`,
])(
  "preserves immutable canonical gateway action validation for %s",
  (actionRef) => {
    expect(() =>
      renderAccountGatewayWorkflow({
        actionRef,
        apiUrl: "https://api.reviewrouter.site",
        githubRepositoryId: "123456",
      }),
    ).toThrow("account_gateway_requires_immutable_action_ref");
  },
);
