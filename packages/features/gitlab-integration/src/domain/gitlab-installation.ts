export const defaultReviewRouterControlProjectConfigPath =
  ".gitlab/reviewrouter.yml";
export const defaultReviewRouterSetupBranchPrefix = "reviewrouter/setup";
export const defaultReviewRouterSetupFilePath = ".gitlab-ci.yml";
export const defaultGitLabReviewRuntimeImage =
  "ghcr.io/777genius/review-router-gitlab-runtime:v1";

export type GitLabProjectInstallationSettings = {
  readonly projectId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly ciConfigPath: string | null;
  readonly canEditProjectSettings: boolean;
  readonly canCreateMergeRequest: boolean;
};

export type GitLabGroupProject = {
  readonly projectId: string;
  readonly fullName: string;
  readonly name: string;
  readonly defaultBranch: string | null;
  readonly webUrl: string | null;
  readonly archived: boolean;
};

export type GitLabGroupProjectsPage = {
  readonly groupIdOrPath: string;
  readonly page: number;
  readonly perPage: number;
  readonly nextPage: number | null;
  readonly total: number | null;
  readonly totalPages: number | null;
  readonly projects: readonly GitLabGroupProject[];
};

export type GitLabCiLintResult = {
  readonly valid: boolean;
  readonly errors: readonly string[];
};

export type GitLabCiVariableTarget =
  | {
      readonly kind: "group";
      readonly id: string;
    }
  | {
      readonly kind: "project";
      readonly id: string;
    };

export type GitLabCiVariableSpec = {
  readonly target: GitLabCiVariableTarget;
  readonly key: string;
  readonly value: string;
  readonly masked?: boolean | undefined;
  readonly protected?: boolean | undefined;
  readonly raw?: boolean | undefined;
  readonly variableType?: "env_var" | "file" | undefined;
};

export type GitLabSetupMergeRequestFile = {
  readonly path: string;
  readonly content: string;
};

export type GitLabInstallPlan =
  | {
      readonly mode: "ci_config_path";
      readonly reason: "preferred_rollout" | "refresh_reviewrouter_path";
      readonly projectId: string;
      readonly ciConfigPath: string;
      readonly lintContent: string;
      readonly lintRef: string;
      readonly variables: readonly GitLabCiVariableSpec[];
    }
  | {
      readonly mode: "setup_merge_request";
      readonly reason:
        | "project_settings_permission_missing"
        | "existing_ci_config_path_not_owned"
        | "ci_lint_invalid";
      readonly projectId: string;
      readonly targetBranch: string;
      readonly sourceBranch: string;
      readonly title: string;
      readonly description: string;
      readonly files: readonly GitLabSetupMergeRequestFile[];
      readonly variables: readonly GitLabCiVariableSpec[];
      readonly lintErrors: readonly string[];
    }
  | {
      readonly mode: "skipped";
      readonly reason:
        | "project_settings_permission_missing"
        | "setup_merge_request_permission_missing"
        | "ci_lint_invalid";
      readonly projectId: string;
      readonly lintErrors: readonly string[];
    };

export function buildGitLabCiConfigPath(input: {
  readonly controlProjectPath: string;
  readonly configPath?: string | undefined;
  readonly ref?: string | undefined;
}): string {
  const configPath = normalizeRelativePath(
    input.configPath ?? defaultReviewRouterControlProjectConfigPath,
    "gitlab_control_project_config_path_invalid",
  );
  const controlProjectPath = normalizeProjectPath(input.controlProjectPath);
  const ref = input.ref ? normalizeRef(input.ref) : null;
  return `${configPath}@${controlProjectPath}${ref ? `:${ref}` : ""}`;
}

export function renderGitLabReviewRouterSetupInclude(input: {
  readonly controlProjectPath: string;
  readonly configPath?: string | undefined;
  readonly ref?: string | undefined;
}): string {
  const configPath = normalizeRelativePath(
    input.configPath ?? defaultReviewRouterControlProjectConfigPath,
    "gitlab_control_project_config_path_invalid",
  );
  const includeFile = configPath.startsWith("/")
    ? configPath
    : `/${configPath}`;
  const lines = [
    "include:",
    `  - project: ${yamlString(normalizeProjectPath(input.controlProjectPath))}`,
    `    file: ${yamlString(includeFile)}`,
  ];
  if (input.ref) {
    lines.push(`    ref: ${yamlString(normalizeRef(input.ref))}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderGitLabReviewRouterControlCiConfig(
  input: {
    readonly runtimeImage?: string | undefined;
  } = {},
): string {
  const runtimeImage = normalizeSingleLine(
    input.runtimeImage ?? defaultGitLabReviewRuntimeImage,
    "gitlab_runtime_image_invalid",
  );
  return [
    "stages:",
    "  - review",
    "",
    "reviewrouter:review:",
    "  stage: review",
    `  image: ${yamlString(runtimeImage)}`,
    "  timeout: 30m",
    "  rules:",
    "    - if: '$CI_PIPELINE_SOURCE == \"merge_request_event\" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID && $CI_MERGE_REQUEST_IID'",
    "      when: on_success",
    "    - when: never",
    "  variables:",
    '    GIT_DEPTH: "0"',
    '    REVIEWROUTER_SCM_PROVIDER: "gitlab"',
    '    REVIEWROUTER_FINDINGS_ARTIFACT_PATH: "reviewrouter-findings.json"',
    "  id_tokens:",
    "    REVIEWROUTER_ID_TOKEN:",
    "      aud: $REVIEWROUTER_ID_TOKEN_AUDIENCE",
    "  script:",
    "    - reviewrouter-gitlab-review",
    "  artifacts:",
    "    when: always",
    "    paths:",
    "      - reviewrouter-findings.json",
    "    expire_in: 7 days",
    "",
  ].join("\n");
}

export function buildGitLabReviewRouterVariables(input: {
  readonly target: GitLabCiVariableTarget;
  readonly apiBaseUrl: string;
  readonly idTokenAudience: string;
  readonly reviewToken?: string | undefined;
}): readonly GitLabCiVariableSpec[] {
  const variables: GitLabCiVariableSpec[] = [
    {
      target: input.target,
      key: "REVIEWROUTER_API_URL",
      value: normalizeUrl(
        input.apiBaseUrl,
        "gitlab_reviewrouter_api_url_invalid",
      ),
      raw: true,
      variableType: "env_var",
    },
    {
      target: input.target,
      key: "REVIEWROUTER_ID_TOKEN_AUDIENCE",
      value: assertNonEmpty(
        input.idTokenAudience,
        "gitlab_reviewrouter_id_token_audience_invalid",
      ),
      raw: true,
      variableType: "env_var",
    },
  ];
  if (input.reviewToken) {
    variables.push({
      target: input.target,
      key: "REVIEWROUTER_GITLAB_TOKEN",
      value: assertNonEmpty(
        input.reviewToken,
        "gitlab_reviewrouter_review_token_invalid",
      ),
      masked: true,
      protected: false,
      raw: true,
      variableType: "env_var",
    });
  }
  return variables;
}

export function buildGitLabInstallPlan(input: {
  readonly project: GitLabProjectInstallationSettings;
  readonly desiredCiConfigPath: string;
  readonly setupIncludeContent: string;
  readonly sourceBranch: string;
  readonly variables?: readonly GitLabCiVariableSpec[] | undefined;
  readonly lintResult?: GitLabCiLintResult | undefined;
}): GitLabInstallPlan {
  const existingCiConfigPath = normalizeOptionalCiConfigPath(
    input.project.ciConfigPath,
  );
  const variables = input.variables ?? [];

  if (
    existingCiConfigPath &&
    !isReviewRouterManagedCiConfigPath({
      existingCiConfigPath,
      desiredCiConfigPath: input.desiredCiConfigPath,
    })
  ) {
    return setupMergeRequestPlan({
      project: input.project,
      reason: "existing_ci_config_path_not_owned",
      sourceBranch: input.sourceBranch,
      setupIncludeContent: input.setupIncludeContent,
      variables,
      lintErrors: [],
    });
  }

  if (!input.project.canEditProjectSettings) {
    return setupMergeRequestPlan({
      project: input.project,
      reason: "project_settings_permission_missing",
      sourceBranch: input.sourceBranch,
      setupIncludeContent: input.setupIncludeContent,
      variables,
      lintErrors: [],
    });
  }

  if (!input.lintResult?.valid) {
    return setupMergeRequestPlan({
      project: input.project,
      reason: "ci_lint_invalid",
      sourceBranch: input.sourceBranch,
      setupIncludeContent: input.setupIncludeContent,
      variables,
      lintErrors: input.lintResult?.errors ?? [],
    });
  }

  return {
    mode: "ci_config_path",
    reason: existingCiConfigPath
      ? "refresh_reviewrouter_path"
      : "preferred_rollout",
    projectId: input.project.projectId,
    ciConfigPath: input.desiredCiConfigPath,
    lintContent: input.setupIncludeContent,
    lintRef: input.project.defaultBranch,
    variables,
  };
}

export function buildGitLabSetupBranchName(input: {
  readonly projectId: string;
  readonly now: Date;
  readonly prefix?: string | undefined;
}): string {
  const timestamp = input.now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return `${input.prefix ?? defaultReviewRouterSetupBranchPrefix}-${input.projectId}-${timestamp}`;
}

export function isReviewRouterManagedCiConfigPath(input: {
  readonly existingCiConfigPath: string;
  readonly desiredCiConfigPath: string;
}): boolean {
  return (
    input.existingCiConfigPath.trim().toLowerCase() ===
    input.desiredCiConfigPath.trim().toLowerCase()
  );
}

function setupMergeRequestPlan(input: {
  readonly project: GitLabProjectInstallationSettings;
  readonly reason: Extract<
    GitLabInstallPlan,
    { mode: "setup_merge_request" }
  >["reason"];
  readonly sourceBranch: string;
  readonly setupIncludeContent: string;
  readonly variables: readonly GitLabCiVariableSpec[];
  readonly lintErrors: readonly string[];
}): GitLabInstallPlan {
  if (!input.project.canCreateMergeRequest) {
    return {
      mode: "skipped",
      reason:
        input.reason === "ci_lint_invalid"
          ? "ci_lint_invalid"
          : input.reason === "project_settings_permission_missing"
            ? "project_settings_permission_missing"
            : "setup_merge_request_permission_missing",
      projectId: input.project.projectId,
      lintErrors: input.lintErrors,
    };
  }

  return {
    mode: "setup_merge_request",
    reason: input.reason,
    projectId: input.project.projectId,
    targetBranch: input.project.defaultBranch,
    sourceBranch: input.sourceBranch,
    title: "Install ReviewRouter",
    description:
      "Adds the ReviewRouter GitLab CI include. Review posting tokens stay in GitLab CI/CD variables.",
    files: [
      {
        path: defaultReviewRouterSetupFilePath,
        content: input.setupIncludeContent,
      },
    ],
    variables: input.variables,
    lintErrors: input.lintErrors,
  };
}

function normalizeOptionalCiConfigPath(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeRelativePath(value: string, errorCode: string): string {
  const trimmed = assertNonEmpty(value, errorCode).replace(/^\/+/, "");
  if (
    trimmed.includes("\n") ||
    trimmed.includes("\r") ||
    trimmed.includes("..") ||
    trimmed.endsWith("/")
  ) {
    throw new Error(errorCode);
  }
  return trimmed;
}

function normalizeProjectPath(value: string): string {
  const trimmed = assertNonEmpty(value, "gitlab_control_project_path_invalid");
  if (
    trimmed.includes("\n") ||
    trimmed.includes("\r") ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    !trimmed.includes("/")
  ) {
    throw new Error("gitlab_control_project_path_invalid");
  }
  return trimmed;
}

function normalizeRef(value: string): string {
  const trimmed = assertNonEmpty(value, "gitlab_control_project_ref_invalid");
  if (
    trimmed.includes("\n") ||
    trimmed.includes("\r") ||
    trimmed.includes("..")
  ) {
    throw new Error("gitlab_control_project_ref_invalid");
  }
  return trimmed;
}

function normalizeSingleLine(value: string, errorCode: string): string {
  const trimmed = assertNonEmpty(value, errorCode);
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error(errorCode);
  }
  return trimmed;
}

function normalizeUrl(value: string, errorCode: string): string {
  const trimmed = assertNonEmpty(value, errorCode);
  try {
    return new URL(trimmed).toString().replace(/\/+$/, "");
  } catch {
    throw new Error(errorCode);
  }
}

function assertNonEmpty(value: string, errorCode: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(errorCode);
  }
  return trimmed;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
