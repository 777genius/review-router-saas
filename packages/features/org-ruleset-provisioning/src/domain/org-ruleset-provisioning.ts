import { z } from "zod";

export const defaultOrgRulesetName = "ReviewRouter required workflow";
export const defaultOrgRulesetSourceBranch = "main";
export const defaultOrgRulesetSourceRepositoryName = "reviewrouter-workflows";

export const orgRulesetScopeSchema = z.enum([
  "selected_repositories",
  "all_repositories",
]);
export type OrgRulesetScope = z.infer<typeof orgRulesetScopeSchema>;

export const orgRulesetEnforcementSchema = z.enum(["evaluate", "active"]);
export type OrgRulesetEnforcement = z.infer<typeof orgRulesetEnforcementSchema>;

export const orgRulesetProvisioningStatusSchema = z.enum([
  "requested",
  "processing",
  "configured",
  "failed",
]);
export type OrgRulesetProvisioningStatus = z.infer<
  typeof orgRulesetProvisioningStatusSchema
>;

export type OrgRulesetSourceWorkflow = {
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly path: string;
  readonly ref: string;
  readonly sha?: string | null;
};

export type OrgRulesetTargetSelection =
  | {
      readonly scope: "selected_repositories";
      readonly repositoryIds: readonly string[];
    }
  | {
      readonly scope: "all_repositories";
      readonly excludeRepositoryNames: readonly string[];
    };

export type OrgRulesetProvisioningRequest = {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly githubInstallationId: string;
  readonly organizationLogin: string;
  readonly sourceRepositoryId?: string;
  readonly sourceGithubRepositoryId?: string;
  readonly sourceRepositoryFullName?: string;
  readonly sourceWorkflowPath: string;
  readonly sourceWorkflowRef: string;
  readonly scope: OrgRulesetScope;
  readonly enforcement: OrgRulesetEnforcement;
  readonly targetRepositoryIds: readonly string[];
  readonly requestedBy: string;
  readonly requestedAt: Date;
};

export type OrgRulesetRepositoryTarget = {
  readonly id: string;
  readonly githubRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly visibility: "public" | "private" | "internal" | string;
};

export type OrgRulesetProvisioningTarget = {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly githubInstallationId: string;
  readonly organizationLogin: string;
  readonly accountType: string;
  readonly installationStatus: string;
  readonly repositorySelection: string;
  readonly repositories: readonly OrgRulesetRepositoryTarget[];
};

export type GitHubRulesetWorkflowRulePayload = {
  readonly type: "workflows";
  readonly parameters: {
    readonly do_not_enforce_on_create: boolean;
    readonly workflows: readonly [
      {
        readonly repository_id: number;
        readonly path: string;
        readonly ref: string;
        readonly sha?: string;
      },
    ];
  };
};

export type GitHubOrgRulesetPayload = {
  readonly name: string;
  readonly target: "branch";
  readonly enforcement: OrgRulesetEnforcement;
  readonly bypass_actors: readonly [];
  readonly conditions:
    | {
        readonly ref_name: {
          readonly include: readonly ["~DEFAULT_BRANCH"];
          readonly exclude: readonly [];
        };
        readonly repository_id: {
          readonly repository_ids: readonly number[];
        };
      }
    | {
        readonly ref_name: {
          readonly include: readonly ["~DEFAULT_BRANCH"];
          readonly exclude: readonly [];
        };
        readonly repository_name: {
          readonly include: readonly ["~ALL"];
          readonly exclude: readonly string[];
          readonly protected: false;
        };
      };
  readonly rules: readonly [GitHubRulesetWorkflowRulePayload];
};

export function createOrgRulesetProvisioningRequest(input: {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly githubInstallationId: string;
  readonly organizationLogin: string;
  readonly sourceRepositoryId?: string;
  readonly sourceGithubRepositoryId?: string;
  readonly sourceRepositoryFullName?: string;
  readonly sourceWorkflowPath: string;
  readonly sourceWorkflowRef: string;
  readonly scope: OrgRulesetScope;
  readonly enforcement: OrgRulesetEnforcement;
  readonly targetRepositoryIds: readonly string[];
  readonly requestedBy: string;
  readonly requestedAt: Date;
}): OrgRulesetProvisioningRequest {
  const workspaceId = requiredString(
    input.workspaceId,
    "workspace_id_required",
  );
  const installationId = requiredString(
    input.installationId,
    "installation_id_required",
  );
  const githubInstallationId = requiredString(
    input.githubInstallationId,
    "github_installation_id_required",
  );
  const organizationLogin = requiredString(
    input.organizationLogin,
    "organization_login_required",
  );
  const sourceWorkflowPath = normalizeWorkflowPath(input.sourceWorkflowPath);
  const sourceWorkflowRef = normalizeGitRef(input.sourceWorkflowRef);
  const scope = orgRulesetScopeSchema.parse(input.scope);
  const enforcement = orgRulesetEnforcementSchema.parse(input.enforcement);
  const targetRepositoryIds = normalizeRepositoryIds(input.targetRepositoryIds);
  if (scope === "selected_repositories" && targetRepositoryIds.length === 0) {
    throw new Error("org_ruleset_selected_repositories_required");
  }
  if (!Number.isFinite(input.requestedAt.getTime())) {
    throw new Error("org_ruleset_requested_at_invalid");
  }

  return {
    workspaceId,
    installationId,
    githubInstallationId,
    organizationLogin,
    ...(input.sourceRepositoryId
      ? { sourceRepositoryId: requiredString(input.sourceRepositoryId) }
      : {}),
    ...(input.sourceGithubRepositoryId
      ? {
          sourceGithubRepositoryId: requiredString(
            input.sourceGithubRepositoryId,
          ),
        }
      : {}),
    ...(input.sourceRepositoryFullName
      ? {
          sourceRepositoryFullName: requiredString(
            input.sourceRepositoryFullName,
          ),
        }
      : {}),
    sourceWorkflowPath,
    sourceWorkflowRef,
    scope,
    enforcement,
    targetRepositoryIds,
    requestedBy: requiredString(input.requestedBy, "requested_by_required"),
    requestedAt: input.requestedAt,
  };
}

export function assertOrganizationRulesetTarget(
  target: OrgRulesetProvisioningTarget,
): void {
  if (target.accountType !== "Organization") {
    throw new Error("org_ruleset_requires_organization_installation");
  }
  if (target.installationStatus !== "active") {
    throw new Error("installation_not_active");
  }
  if (
    target.repositories.filter(
      (repository) => repository.selected && !repository.archived,
    ).length === 0
  ) {
    throw new Error("org_ruleset_no_selected_repositories");
  }
}

export function resolveOrgRulesetSourceRepository(input: {
  readonly target: OrgRulesetProvisioningTarget;
  readonly sourceRepositoryFullName?: string;
}): OrgRulesetRepositoryTarget {
  const sourceFullName = normalizeSourceRepositoryFullName({
    organizationLogin: input.target.organizationLogin,
    ...(input.sourceRepositoryFullName
      ? { sourceRepositoryFullName: input.sourceRepositoryFullName }
      : {}),
  });
  const sourceOwner = sourceFullName.split("/")[0]!;
  if (
    sourceOwner.toLowerCase() !== input.target.organizationLogin.toLowerCase()
  ) {
    throw new Error("org_ruleset_source_repository_wrong_owner");
  }

  const repository = input.target.repositories.find(
    (item) =>
      item.fullName.toLowerCase() === sourceFullName.toLowerCase(),
  );
  if (!repository || !repository.selected) {
    throw new Error("org_ruleset_source_repository_not_installed");
  }
  if (repository.archived) {
    throw new Error("org_ruleset_source_repository_archived");
  }
  return repository;
}

export function normalizeSourceRepositoryFullName(input: {
  readonly organizationLogin: string;
  readonly sourceRepositoryFullName?: string;
}): string {
  const fullName =
    input.sourceRepositoryFullName?.trim() ||
    `${input.organizationLogin}/${defaultOrgRulesetSourceRepositoryName}`;
  const [owner, name, extra] = fullName.split("/");
  if (!owner || !name || extra) {
    throw new Error("org_ruleset_source_repository_invalid");
  }
  return `${requiredString(owner)}/${requiredString(name)}`;
}

export function chooseDefaultSourceRepository(
  target: OrgRulesetProvisioningTarget,
): OrgRulesetRepositoryTarget {
  return resolveOrgRulesetSourceRepository({ target });
}

export function resolveOrgRulesetTargetSelection(input: {
  readonly scope: OrgRulesetScope;
  readonly repositories: readonly OrgRulesetRepositoryTarget[];
  readonly selectedRepositoryIds?: readonly string[];
  readonly excludedRepositoryIds?: readonly string[];
  readonly excludedRepositoryNames?: readonly string[];
}): OrgRulesetTargetSelection {
  const excludedRepositoryIds = new Set(input.excludedRepositoryIds ?? []);
  if (input.scope === "all_repositories") {
    return {
      scope: "all_repositories",
      excludeRepositoryNames: normalizeRepositoryNames(
        input.excludedRepositoryNames ?? [],
      ),
    };
  }

  const allowed = new Set(
    input.repositories
      .filter((repository) => repository.selected && !repository.archived)
      .filter(
        (repository) => !excludedRepositoryIds.has(repository.githubRepositoryId),
      )
      .map((repository) => repository.githubRepositoryId),
  );
  const requested = normalizeRepositoryIds(
    input.selectedRepositoryIds?.length
      ? input.selectedRepositoryIds
      : [...allowed.values()],
  );
  const repositoryIds = requested.filter((repositoryId) =>
    allowed.has(repositoryId),
  );

  if (repositoryIds.length === 0) {
    throw new Error("org_ruleset_selected_repositories_required");
  }

  return { scope: "selected_repositories", repositoryIds };
}

export function buildGitHubOrgRulesetPayload(input: {
  readonly name?: string;
  readonly enforcement: OrgRulesetEnforcement;
  readonly sourceWorkflow: OrgRulesetSourceWorkflow;
  readonly targetSelection: OrgRulesetTargetSelection;
}): GitHubOrgRulesetPayload {
  const sourceRepositoryId = toGitHubIdNumber(
    input.sourceWorkflow.repositoryId,
    "source_repository_id_invalid",
  );
  const workflow: GitHubRulesetWorkflowRulePayload["parameters"]["workflows"][number] =
    {
      repository_id: sourceRepositoryId,
      path: normalizeWorkflowPath(input.sourceWorkflow.path),
      ref: normalizeGitRef(input.sourceWorkflow.ref),
      ...(input.sourceWorkflow.sha
        ? { sha: requiredString(input.sourceWorkflow.sha) }
        : {}),
    };

  return {
    name: input.name ?? defaultOrgRulesetName,
    target: "branch",
    enforcement: orgRulesetEnforcementSchema.parse(input.enforcement),
    bypass_actors: [],
    conditions: buildRulesetConditions(input.targetSelection),
    rules: [
      {
        type: "workflows",
        parameters: {
          do_not_enforce_on_create: true,
          workflows: [workflow],
        },
      },
    ],
  };
}

export function buildSourceWorkflowRef(input: {
  readonly repositoryFullName: string;
  readonly path: string;
  readonly ref: string;
}): string {
  return `${requiredString(input.repositoryFullName)}/${normalizeWorkflowPath(
    input.path,
  )}@${normalizeGitRef(input.ref)}`;
}

export function normalizeWorkflowPath(path: string): string {
  const normalized = requiredString(path, "workflow_path_required");
  if (
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(normalized) ||
    normalized.includes("..")
  ) {
    throw new Error("workflow_path_invalid");
  }
  return normalized;
}

export function normalizeGitRef(ref: string): string {
  const normalized = requiredString(ref, "workflow_ref_required");
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9_./-]+$/.test(normalized)) {
    throw new Error("workflow_ref_invalid");
  }
  return normalized;
}

export function normalizeRepositoryIds(
  repositoryIds: readonly string[],
): readonly string[] {
  return [...new Set(repositoryIds.map((id) => requiredString(id)))].sort(
    compareGitHubIdStrings,
  );
}

export function normalizeRepositoryNames(
  repositoryNames: readonly string[],
): readonly string[] {
  return [...new Set(repositoryNames.map((name) => requiredString(name)))].sort(
    (left, right) => left.localeCompare(right),
  );
}

export function safeOrgRulesetErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (
    message.startsWith("org_ruleset_") ||
    message.startsWith("workflow_") ||
    [
      "installation_not_active",
      "source_repository_id_invalid",
      "target_repository_id_invalid",
      "org_ruleset_all_repositories_requires_all_access",
      "github_ruleset_response_invalid",
      "github_workflow_write_response_invalid",
    ].includes(message)
  ) {
    return message;
  }
  const status = getHttpStatus(error);
  if (status === 403) {
    if (isGitHubRulesetsPlanUpgradeError(error)) {
      return "org_rulesets_not_supported";
    }
    return "org_admin_permission_required";
  }
  if (status === 401) {
    return "github_org_ruleset_permission_denied";
  }
  if (status === 404) {
    return "org_rulesets_not_supported";
  }
  if (status === 422) {
    if (isSourceWorkflowAccessError(error)) {
      return "org_ruleset_source_repository_actions_access_required";
    }
    return "github_org_ruleset_validation_failed";
  }
  if (status >= 400 && status <= 599) {
    return `github_api_error:${status}`;
  }
  return "org_ruleset_provisioning_failed";
}

export function safeOrgRulesetErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message.startsWith("org_ruleset_") || message.startsWith("workflow_")) {
    return message.slice(0, 500);
  }
  return safeOrgRulesetErrorCode(error).slice(0, 500);
}

function buildRulesetConditions(
  targetSelection: OrgRulesetTargetSelection,
): GitHubOrgRulesetPayload["conditions"] {
  const ref_name = {
    include: ["~DEFAULT_BRANCH"] as const,
    exclude: [] as const,
  };
  if (targetSelection.scope === "all_repositories") {
    return {
      ref_name,
      repository_name: {
        include: ["~ALL"],
        exclude: targetSelection.excludeRepositoryNames,
        protected: false,
      },
    };
  }

  return {
    ref_name,
    repository_id: {
      repository_ids: targetSelection.repositoryIds.map((repositoryId) =>
        toGitHubIdNumber(repositoryId, "target_repository_id_invalid"),
      ),
    },
  };
}

function toGitHubIdNumber(value: string, errorCode: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(errorCode);
  }
  return number;
}

function compareGitHubIdStrings(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}

function requiredString(value: string, errorCode = "value_required"): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\n") || normalized.includes("\r")) {
    throw new Error(errorCode);
  }
  return normalized;
}

function getHttpStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : 0;
}

function isGitHubRulesetsPlanUpgradeError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : "";
  return /upgrade to github team|upgrade.*enterprise|rulesets.*unavailable/i.test(
    message,
  );
}

function isSourceWorkflowAccessError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : "";
  return /workflow.*(access|accessible)|source.*workflow|actions.*access|repository.*access/i.test(
    message,
  );
}
