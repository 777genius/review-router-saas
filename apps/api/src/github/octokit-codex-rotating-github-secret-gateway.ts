import { App } from "@octokit/app";
import { request as githubRequest } from "@octokit/request";
import { createHash } from "node:crypto";
import {
  areWorkflowDocumentsSemanticallyEqual,
  readCanonicalCodexRotatingT0WorkflowSourceMetadata,
  readCodexRotatingWorkflowSourceMetadata,
  scanCodexRotatingAdvisoryWorkflow,
} from "@reviewrouter/features-codex-oauth-rotating";
import {
  renderCanonicalCodexRotatingInteractionWorkflowV1,
  renderCanonicalCodexRotatingInteractionWorkflowV2,
} from "@reviewrouter/features-workflow-provisioning";
import { REVIEW_ROUTER_ACTION_REPOSITORY } from "@reviewrouter/platform-config";
import {
  managedCodexWorkflowPath,
  managedInteractionWorkflowPath,
  type ActionRepositoryContext,
  type CodexRotatingGitHubSecretTokenIssuerPort,
  type CodexRotatingGitHubSecretWriterPort,
  type CodexRotatingGitHubCheckoutTokenIssuerPort,
  type CodexRotatingWorkflowSourceVerifierPort,
  type CodexRotatingSecretWriteTarget,
} from "@reviewrouter/features-action-control-plane";
import type { HostedReviewPullRequestFactsPort } from "../hosted-review-prelease-gate.js";
type InstallationTokenResponse = {
  readonly type?: unknown;
  readonly tokenType?: unknown;
  readonly token?: unknown;
  readonly expiresAt?: unknown;
  readonly permissions?: {
    readonly actions?: unknown;
    readonly contents?: unknown;
    readonly pull_requests?: unknown;
    readonly secrets?: unknown;
  };
};

type SecretPutResponse = {
  readonly status: number;
};

type SecretPermission = "read" | "write";
type InstallationPermission = {
  readonly actions?: "read";
  readonly secrets?: SecretPermission;
  readonly contents?: "read";
  readonly pull_requests?: "read";
};

type ContentsResponse = {
  readonly data?: unknown;
};

type WorkflowRunResponse = {
  readonly data?: unknown;
};

type RepositoryResponse = {
  readonly data?: unknown;
};

type PullRequestListResponse = {
  readonly data?: unknown;
};

type PullRequestResponse = {
  readonly data?: unknown;
};

type BranchResponse = {
  readonly data?: unknown;
};

enum ReviewInventoryReferenceKind {
  DefaultBranch = "default_branch",
  ActiveBaseBranch = "active_base_branch",
  PullRequestMerge = "pull_request_merge",
}

enum ReviewInventoryPullRequestMergeState {
  Ready = "ready",
  Conflicted = "conflicted",
  StaleBase = "stale_base",
}

type ReviewInventoryPullRequestSnapshot = {
  readonly number: number;
  readonly draft: boolean;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeState: ReviewInventoryPullRequestMergeState;
  readonly mergeCommitSha: string | null;
};

type ReviewInventoryReferenceSnapshot = {
  readonly ref: string;
  readonly headSha: string;
  readonly isDefault: boolean;
  readonly kind: ReviewInventoryReferenceKind;
  readonly pullRequestNumber: number | null;
};

type ReviewInventoryCoverageSnapshot = {
  readonly defaultBranch: string;
  readonly pullRequests: readonly ReviewInventoryPullRequestSnapshot[];
  readonly references: readonly ReviewInventoryReferenceSnapshot[];
};

const REVIEW_INVENTORY_PULLS_PER_PAGE = 100;
const REVIEW_INVENTORY_MAX_PULL_PAGES = 10;
const REVIEW_INVENTORY_MAX_BRANCHES = 64;
const REVIEW_INVENTORY_MAX_REFERENCES = 128;
const REVIEW_INVENTORY_MAX_CONCURRENCY = 4;
const REVIEW_INVENTORY_COVERAGE_POLICY_VERSION = 3;

export class OctokitCodexRotatingGitHubSecretGateway
  implements
    CodexRotatingGitHubSecretTokenIssuerPort,
    CodexRotatingGitHubSecretWriterPort,
    CodexRotatingGitHubCheckoutTokenIssuerPort,
    CodexRotatingWorkflowSourceVerifierPort,
    HostedReviewPullRequestFactsPort
{
  private readonly app: App;
  private readonly expectedApiUrl: string;
  private readonly trustedActionRefs: ReadonlySet<string>;

  constructor(options: {
    readonly appId: string;
    readonly privateKey: string;
    readonly expectedApiUrl?: string;
    readonly trustedActionRefs?: readonly string[];
  }) {
    this.app = new App({
      appId: options.appId,
      privateKey: options.privateKey,
    });
    this.expectedApiUrl = normalizeWorkflowApiUrl(
      options.expectedApiUrl ?? "https://api.reviewrouter.site",
    );
    this.trustedActionRefs = new Set(
      (options.trustedActionRefs ?? []).map((ref) => ref.toLowerCase()),
    );
  }

  async issueSecretsReadToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
    readonly permissions: { readonly secrets: "read" };
  }> {
    const token = await this.mintRepositorySecretsToken({
      githubInstallationId: input.githubInstallationId,
      githubRepositoryId: input.githubRepositoryId,
      permission: "read",
    });
    return {
      token: token.token,
      expiresAt: token.expiresAt,
      permissions: { secrets: "read" },
    };
  }

  async assertCanWriteRepositorySecret(
    input: CodexRotatingSecretWriteTarget,
  ): Promise<{ readonly status: "ready" }> {
    await this.mintRepositorySecretsToken({
      githubInstallationId: input.githubInstallationId,
      githubRepositoryId: input.githubRepositoryId,
      permission: "write",
    });
    return { status: "ready" };
  }

  async issueContentsReadToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
    readonly permissions: {
      readonly contents: "read";
      readonly pullRequests: "read";
    };
  }> {
    const token = await this.mintRepositoryToken({
      githubInstallationId: input.githubInstallationId,
      githubRepositoryId: input.githubRepositoryId,
      permissions: { contents: "read", pull_requests: "read" },
    });
    return {
      token: token.token,
      expiresAt: token.expiresAt,
      permissions: { contents: "read", pullRequests: "read" },
    };
  }

  async putEncryptedRepositorySecret(
    input: CodexRotatingSecretWriteTarget & {
      readonly encryptedValue: string;
      readonly keyId: string;
    },
  ): Promise<{
    readonly status: "accepted";
    readonly statusCode: 201 | 204;
  }> {
    const token = await this.mintRepositorySecretsToken({
      githubInstallationId: input.githubInstallationId,
      githubRepositoryId: input.githubRepositoryId,
      permission: "write",
    });
    const response = (await githubRequest(
      "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}",
      {
        owner: input.owner,
        repo: input.repo,
        secret_name: input.secretName,
        encrypted_value: input.encryptedValue,
        key_id: input.keyId,
        headers: {
          authorization: `Bearer ${token.token}`,
        },
      },
    )) as SecretPutResponse;

    if (response.status !== 201 && response.status !== 204) {
      throw new Error("codex_rotating_secret_put_unexpected_status");
    }
    return { status: "accepted", statusCode: response.status };
  }

  async verifyWorkflowSource(input: {
    readonly repository: {
      readonly githubInstallationId: string;
      readonly githubRepositoryId: string;
      readonly fullName: string;
      readonly owner: string;
    };
    readonly workflowSha: string;
    readonly workflowPath: string;
    readonly expectedActionOwnerRepo: string;
    readonly expectedProviderInstanceId: string;
    readonly expectedWorkflowSchemaVersion: number;
  }) {
    const token = await this.mintRepositoryToken({
      githubInstallationId: input.repository.githubInstallationId,
      githubRepositoryId: input.repository.githubRepositoryId,
      permissions: { contents: "read" },
    });
    const response = (await githubRequest(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: input.repository.owner,
        repo: repoNameFromFullName(input.repository.fullName),
        path: input.workflowPath,
        ref: input.workflowSha,
        headers: {
          authorization: `Bearer ${token.token}`,
        },
      },
    )) as ContentsResponse;
    const workflow = decodeWorkflowContent(response.data);
    const metadata = readCodexRotatingWorkflowSourceMetadata(workflow);
    if (
      metadata.actionRef.split("@")[0]!.toLowerCase() !==
      input.expectedActionOwnerRepo.toLowerCase()
    ) {
      throw new Error("codex_rotating_workflow_action_ref_not_allowed");
    }
    if (metadata.providerInstanceId !== input.expectedProviderInstanceId) {
      throw new Error("codex_rotating_workflow_provider_instance_mismatch");
    }
    if (normalizeWorkflowApiUrl(metadata.apiUrl) !== this.expectedApiUrl) {
      throw new Error("codex_rotating_workflow_api_url_mismatch");
    }
    if (
      metadata.workflowSchemaVersion !== input.expectedWorkflowSchemaVersion
    ) {
      throw new Error("codex_rotating_workflow_schema_mismatch");
    }

    return {
      binding: {
        providerInstanceId: metadata.providerInstanceId,
        repositoryFullName: input.repository.fullName,
        githubRepositoryId: input.repository.githubRepositoryId,
        actionRef: metadata.actionRef,
        workflowPath: input.workflowPath,
        workflowSchemaVersion: metadata.workflowSchemaVersion,
      },
      workflowSourceSha256: createHash("sha256")
        .update(workflow, "utf8")
        .digest("hex"),
    };
  }

  async verifyManagedV2SessionBootstrapSource(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly owner: string;
    readonly workflowPath: string;
    readonly workflowSha: string;
  }): Promise<{ readonly compatible: boolean }> {
    if (
      input.workflowPath !== managedCodexWorkflowPath &&
      input.workflowPath !== managedInteractionWorkflowPath
    ) {
      return { compatible: false };
    }
    let codexWorkflow: string | null;
    let claimedWorkflow: string | null;
    try {
      const token = await this.mintRepositoryToken({
        githubInstallationId: input.githubInstallationId,
        githubRepositoryId: input.githubRepositoryId,
        permissions: { contents: "read" },
      });
      const repo = repoNameFromFullName(input.repositoryFullName);
      [codexWorkflow, claimedWorkflow] = await Promise.all([
        this.readWorkflowAtRef({
          token: token.token,
          owner: input.owner,
          repo,
          path: managedCodexWorkflowPath,
          ref: input.workflowSha,
          missingAllowed: true,
        }),
        input.workflowPath === managedCodexWorkflowPath
          ? Promise.resolve(null)
          : this.readWorkflowAtRef({
              token: token.token,
              owner: input.owner,
              repo,
              path: input.workflowPath,
              ref: input.workflowSha,
              missingAllowed: true,
            }),
      ]);
    } catch {
      throw new Error("managed_workflow_source_temporarily_unavailable");
    }
    if (!codexWorkflow) {
      return { compatible: false };
    }

    let metadata;
    try {
      metadata =
        readCanonicalCodexRotatingT0WorkflowSourceMetadata(codexWorkflow);
    } catch {
      return { compatible: false };
    }
    if (
      normalizeWorkflowApiUrl(metadata.apiUrl) !== this.expectedApiUrl ||
      metadata.providerInstanceId !==
        `codex-rotating:${input.githubRepositoryId}` ||
      !this.trustedActionRefs.has(metadata.actionRef.toLowerCase())
    ) {
      return { compatible: false };
    }
    if (input.workflowPath === managedCodexWorkflowPath) {
      return { compatible: true };
    }
    const expectedInteractionWorkflows = [
      renderCanonicalCodexRotatingInteractionWorkflowV2({
        actionRef: metadata.actionRef,
        apiUrl: this.expectedApiUrl,
        runtimeConfigMode: "oidc",
      }),
      renderCanonicalCodexRotatingInteractionWorkflowV1({
        actionRef: metadata.actionRef,
        apiUrl: this.expectedApiUrl,
        runtimeConfigMode: "oidc",
      }),
    ];
    return {
      compatible:
        claimedWorkflow !== null &&
        expectedInteractionWorkflows.some((expectedInteractionWorkflow) =>
          areWorkflowDocumentsSemanticallyEqual(
            claimedWorkflow,
            expectedInteractionWorkflow,
          ),
        ),
    };
  }

  async inspectReviewV2ManagedWorkflowInventory(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly owner: string;
  }): Promise<{
    readonly compatible: boolean;
    readonly inventoryHash: string;
    readonly actionCommitSha: string | null;
    readonly workflowSchemaVersion: number | null;
    readonly defaultBranchHeadSha: string;
  }> {
    const token = await this.mintRepositoryToken({
      githubInstallationId: input.githubInstallationId,
      githubRepositoryId: input.githubRepositoryId,
      permissions: { contents: "read", pull_requests: "read" },
    });
    const repo = repoNameFromFullName(input.repositoryFullName);
    const reviewPath = managedCodexWorkflowPath;
    const legacyPaths = [".github/workflows/reviewrouter.yml"];
    const coverage = await this.resolveReviewInventoryCoverage({
      token: token.token,
      owner: input.owner,
      repo,
      githubRepositoryId: input.githubRepositoryId,
    });
    const referenceInventories = await mapWithConcurrency(
      coverage.references,
      REVIEW_INVENTORY_MAX_CONCURRENCY,
      async (reference) => {
        const [reviewWorkflow, legacyPresence] = await Promise.all([
          this.readWorkflowAtRef({
            token: token.token,
            owner: input.owner,
            repo,
            path: reviewPath,
            ref: reference.headSha,
            missingAllowed: !reference.isDefault,
          }),
          Promise.all(
            legacyPaths.map(async (path) => ({
              path,
              present:
                (await this.readWorkflowAtRef({
                  token: token.token,
                  owner: input.owner,
                  repo,
                  path,
                  ref: reference.headSha,
                  missingAllowed: true,
                })) !== null,
            })),
          ),
        ]);
        const scan = reviewWorkflow
          ? scanCodexRotatingAdvisoryWorkflow(reviewWorkflow)
          : {
              valid: !reference.isDefault,
              errors: reference.isDefault ? ["review_workflow_missing"] : [],
            };
        let metadata = null;
        if (scan.valid && reviewWorkflow) {
          try {
            metadata =
              readCanonicalCodexRotatingT0WorkflowSourceMetadata(
                reviewWorkflow,
              );
          } catch {
            // Managed T0 inventory only trusts the exact generator output.
          }
        }
        const scanErrors =
          reviewWorkflow && !metadata
            ? [...scan.errors, "t0_workflow_source_not_canonical"]
            : [...scan.errors];
        const immutableT0 =
          reviewWorkflow === null
            ? !reference.isDefault
            : Boolean(
                metadata &&
                /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(
                  metadata.actionRef,
                ) &&
                reviewWorkflow.includes(
                  "/.github/workflows/reviewrouter-t0-reusable.yml@",
                ),
              );
        return {
          ref: reference.ref,
          headSha: reference.headSha,
          isDefault: reference.isDefault,
          kind: reference.kind,
          pullRequestNumber: reference.pullRequestNumber,
          reviewWorkflowPresent: reviewWorkflow !== null,
          reviewWorkflowSha256: reviewWorkflow
            ? createHash("sha256").update(reviewWorkflow, "utf8").digest("hex")
            : null,
          actionRef: metadata?.actionRef ?? null,
          apiUrl: metadata?.apiUrl ?? null,
          actionCommitSha:
            metadata?.actionRef.match(/@([a-f0-9]{40})$/)?.[1] ?? null,
          providerInstanceId: metadata?.providerInstanceId ?? null,
          workflowSchemaVersion: metadata?.workflowSchemaVersion ?? null,
          scanErrors: [...new Set(scanErrors)].sort(),
          immutableT0,
          legacyPresence,
        };
      },
    );
    const defaultInventory = referenceInventories.find(
      (reference) => reference.isDefault,
    );
    if (!defaultInventory) {
      throw new Error("codex_rotating_default_branch_inventory_missing");
    }
    const reviewActionCommitSha = defaultInventory.actionCommitSha;
    const defaultBindingCompatible = Boolean(
      defaultInventory.actionRef?.startsWith(
        `${REVIEW_ROUTER_ACTION_REPOSITORY}@`,
      ) &&
      defaultInventory.apiUrl === this.expectedApiUrl &&
      defaultInventory.providerInstanceId ===
        `codex-rotating:${input.githubRepositoryId}` &&
      defaultInventory.workflowSchemaVersion !== null,
    );
    const interactionPath = managedInteractionWorkflowPath;
    const interactionWorkflow = await this.readWorkflowAtRef({
      token: token.token,
      owner: input.owner,
      repo,
      path: interactionPath,
      ref: defaultInventory.headSha,
      missingAllowed: true,
    });
    const interaction = inspectReviewV2InteractionWorkflow(
      interactionWorkflow,
      defaultInventory.actionRef,
      this.expectedApiUrl,
    );
    const revalidatedCoverage = await this.resolveReviewInventoryCoverage({
      token: token.token,
      owner: input.owner,
      repo,
      githubRepositoryId: input.githubRepositoryId,
    });
    if (!sameReviewInventoryCoverage(coverage, revalidatedCoverage)) {
      throw new Error("codex_rotating_workflow_inventory_coverage_moved");
    }
    const referencesWithCompatibility = referenceInventories.map(
      (reference) => ({
        ...reference,
        compatible:
          reference.scanErrors.length === 0 &&
          reference.immutableT0 &&
          reference.legacyPresence.every((entry) => !entry.present) &&
          (!reference.reviewWorkflowPresent ||
            (defaultBindingCompatible &&
              reference.actionRef === defaultInventory.actionRef &&
              reference.apiUrl === defaultInventory.apiUrl &&
              reference.providerInstanceId ===
                defaultInventory.providerInstanceId &&
              reference.workflowSchemaVersion ===
                defaultInventory.workflowSchemaVersion)),
      }),
    );
    const inventory = {
      coveragePolicyVersion: REVIEW_INVENTORY_COVERAGE_POLICY_VERSION,
      defaultBranch: {
        ref: defaultInventory.ref,
        headSha: defaultInventory.headSha,
      },
      pullRequests: coverage.pullRequests,
      reviewPath,
      references: referencesWithCompatibility,
      interaction,
    };
    return {
      compatible:
        referencesWithCompatibility.every(
          (reference) => reference.compatible,
        ) && interaction.compatible,
      inventoryHash: createHash("sha256")
        .update(JSON.stringify(inventory), "utf8")
        .digest("hex"),
      actionCommitSha: reviewActionCommitSha,
      workflowSchemaVersion: defaultInventory.workflowSchemaVersion,
      defaultBranchHeadSha: defaultInventory.headSha,
    };
  }

  async resolveWorkflowRunPullRequest(input: {
    readonly repository: {
      readonly githubInstallationId: string;
      readonly githubRepositoryId: string;
      readonly fullName: string;
      readonly owner: string;
    };
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly eventName: "pull_request_target";
  }): Promise<number> {
    const token = await this.mintRepositoryToken({
      githubInstallationId: input.repository.githubInstallationId,
      githubRepositoryId: input.repository.githubRepositoryId,
      permissions: { actions: "read" },
    });
    const response = (await githubRequest(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      {
        owner: input.repository.owner,
        repo: repoNameFromFullName(input.repository.fullName),
        run_id: parsePositiveSafeInteger(
          input.githubRunId,
          "codex_rotating_workflow_run_id_invalid",
        ),
        headers: { authorization: `Bearer ${token.token}` },
      },
    )) as WorkflowRunResponse;
    return decodeWorkflowRunPullRequest(response.data, {
      eventName: input.eventName,
      githubRepositoryId: input.repository.githubRepositoryId,
      githubRunAttempt: input.githubRunAttempt,
    });
  }

  async resolve(input: {
    readonly repository: ActionRepositoryContext;
    readonly pullRequestNumber: number;
  }) {
    const token = await this.mintRepositoryToken({
      githubInstallationId: input.repository.githubInstallationId,
      githubRepositoryId: input.repository.githubRepositoryId,
      permissions: { pull_requests: "read" },
    });
    const response = (await githubRequest(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: input.repository.owner,
        repo: repoNameFromFullName(input.repository.fullName),
        pull_number: input.pullRequestNumber,
        headers: { authorization: `Bearer ${token.token}` },
      },
    )) as PullRequestResponse;
    return decodePullRequestReviewFacts(response.data, {
      githubRepositoryId: input.repository.githubRepositoryId,
      pullRequestNumber: input.pullRequestNumber,
    });
  }

  private async mintRepositorySecretsToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly permission: SecretPermission;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
  }> {
    const data = (await this.app.octokit.auth({
      type: "installation",
      installationId: parsePositiveSafeInteger(
        input.githubInstallationId,
        "codex_rotating_secret_installation_id_invalid",
      ),
      repositoryIds: [
        parsePositiveSafeInteger(
          input.githubRepositoryId,
          "codex_rotating_secret_repository_id_invalid",
        ),
      ],
      permissions: {
        secrets: input.permission,
      },
    })) as InstallationTokenResponse;
    if (typeof data.token !== "string" || data.token.length === 0) {
      throw new Error("codex_rotating_secret_token_invalid_response");
    }
    if (typeof data.expiresAt !== "string") {
      throw new Error("codex_rotating_secret_token_invalid_response");
    }
    const expiresAt = new Date(data.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new Error("codex_rotating_secret_token_invalid_response");
    }
    if (data.permissions?.secrets !== input.permission) {
      throw new Error("codex_rotating_secret_token_permissions_mismatch");
    }

    return { token: data.token, expiresAt };
  }

  private async mintRepositoryToken(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly permissions: InstallationPermission;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: Date;
  }> {
    const data = (await this.app.octokit.auth({
      type: "installation",
      installationId: parsePositiveSafeInteger(
        input.githubInstallationId,
        "codex_rotating_installation_id_invalid",
      ),
      repositoryIds: [
        parsePositiveSafeInteger(
          input.githubRepositoryId,
          "codex_rotating_repository_id_invalid",
        ),
      ],
      permissions: input.permissions,
    })) as InstallationTokenResponse;
    if (typeof data.token !== "string" || data.token.length === 0) {
      throw new Error("codex_rotating_installation_token_invalid_response");
    }
    if (typeof data.expiresAt !== "string") {
      throw new Error("codex_rotating_installation_token_invalid_response");
    }
    const expiresAt = new Date(data.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new Error("codex_rotating_installation_token_invalid_response");
    }
    if (
      input.permissions.actions &&
      data.permissions?.actions !== input.permissions.actions
    ) {
      throw new Error("codex_rotating_installation_token_permissions_mismatch");
    }
    if (
      input.permissions.contents &&
      data.permissions?.contents !== input.permissions.contents
    ) {
      throw new Error("codex_rotating_installation_token_permissions_mismatch");
    }
    if (
      input.permissions.pull_requests &&
      data.permissions?.pull_requests !== input.permissions.pull_requests
    ) {
      throw new Error("codex_rotating_installation_token_permissions_mismatch");
    }
    return { token: data.token, expiresAt };
  }

  private async resolveReviewInventoryCoverage(input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly githubRepositoryId: string;
  }): Promise<ReviewInventoryCoverageSnapshot> {
    const repositoryResponse = (await githubRequest(
      "GET /repos/{owner}/{repo}",
      {
        owner: input.owner,
        repo: input.repo,
        headers: { authorization: `Bearer ${input.token}` },
      },
    )) as RepositoryResponse;
    const defaultBranch = decodeRepositoryDefaultBranch(
      repositoryResponse.data,
      input.githubRepositoryId,
    );
    const pullRequests: ReviewInventoryPullRequestSnapshot[] = [];
    let paginationComplete = false;
    for (let page = 1; page <= REVIEW_INVENTORY_MAX_PULL_PAGES + 1; page += 1) {
      const response = (await githubRequest("GET /repos/{owner}/{repo}/pulls", {
        owner: input.owner,
        repo: input.repo,
        state: "open",
        per_page: REVIEW_INVENTORY_PULLS_PER_PAGE,
        page,
        headers: { authorization: `Bearer ${input.token}` },
      })) as PullRequestListResponse;
      const pagePullRequests = decodeOpenPullRequests(
        response.data,
        input.githubRepositoryId,
      );
      if (
        page > REVIEW_INVENTORY_MAX_PULL_PAGES &&
        pagePullRequests.length > 0
      ) {
        throw new Error("codex_rotating_workflow_inventory_pull_cap_exceeded");
      }
      pullRequests.push(
        ...(await mapWithConcurrency(
          pagePullRequests,
          REVIEW_INVENTORY_MAX_CONCURRENCY,
          (pullRequest) =>
            pullRequest.mergeCommitSha === null
              ? this.resolvePullRequestMergeability({
                  token: input.token,
                  owner: input.owner,
                  repo: input.repo,
                  githubRepositoryId: input.githubRepositoryId,
                  pullRequest,
                })
              : Promise.resolve(pullRequest),
        )),
      );
      if (pagePullRequests.length < REVIEW_INVENTORY_PULLS_PER_PAGE) {
        paginationComplete = true;
        break;
      }
    }
    if (!paginationComplete) {
      throw new Error("codex_rotating_workflow_inventory_pull_cap_exceeded");
    }
    assertUniquePullRequestNumbers(pullRequests);
    pullRequests.sort((left, right) => left.number - right.number);
    const branchRefs = new Set<string>([
      defaultBranch,
      ...pullRequests.map((pullRequest) => pullRequest.baseRef),
    ]);
    if (branchRefs.size > REVIEW_INVENTORY_MAX_BRANCHES) {
      throw new Error("codex_rotating_workflow_inventory_branch_cap_exceeded");
    }
    const references = await mapWithConcurrency(
      [...branchRefs].sort(),
      REVIEW_INVENTORY_MAX_CONCURRENCY,
      async (ref): Promise<ReviewInventoryReferenceSnapshot> => ({
        ref,
        headSha: await this.readBranchHead({
          token: input.token,
          owner: input.owner,
          repo: input.repo,
          branch: ref,
        }),
        isDefault: ref === defaultBranch,
        kind:
          ref === defaultBranch
            ? ReviewInventoryReferenceKind.DefaultBranch
            : ReviewInventoryReferenceKind.ActiveBaseBranch,
        pullRequestNumber: null,
      }),
    );
    for (let index = 0; index < pullRequests.length; index += 1) {
      const pullRequest = pullRequests[index]!;
      const baseReference = references.find(
        (reference) => reference.ref === pullRequest.baseRef,
      );
      if (!baseReference) {
        throw new Error(
          "codex_rotating_workflow_inventory_base_reference_missing",
        );
      }
      if (baseReference.headSha !== pullRequest.baseSha) {
        pullRequests[index] = {
          ...pullRequest,
          mergeState: ReviewInventoryPullRequestMergeState.StaleBase,
        };
      }
    }
    for (const pullRequest of pullRequests) {
      if (
        pullRequest.mergeState !== ReviewInventoryPullRequestMergeState.Ready
      ) {
        continue;
      }
      if (pullRequest.mergeCommitSha === null) {
        throw new Error(
          "codex_rotating_workflow_inventory_mergeability_invalid",
        );
      }
      references.push({
        ref: `refs/pull/${pullRequest.number}/merge`,
        headSha: pullRequest.mergeCommitSha,
        isDefault: false,
        kind: ReviewInventoryReferenceKind.PullRequestMerge,
        pullRequestNumber: pullRequest.number,
      });
    }
    if (references.length > REVIEW_INVENTORY_MAX_REFERENCES) {
      throw new Error(
        "codex_rotating_workflow_inventory_reference_cap_exceeded",
      );
    }
    references.sort((left, right) => left.ref.localeCompare(right.ref));
    return { defaultBranch, pullRequests, references };
  }

  private async resolvePullRequestMergeability(input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly githubRepositoryId: string;
    readonly pullRequest: ReviewInventoryPullRequestSnapshot;
  }): Promise<ReviewInventoryPullRequestSnapshot> {
    const response = (await githubRequest(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullRequest.number,
        headers: { authorization: `Bearer ${input.token}` },
      },
    )) as PullRequestResponse;
    return decodePullRequestMergeability(
      response.data,
      input.githubRepositoryId,
      input.pullRequest,
    );
  }

  private async readBranchHead(input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly branch: string;
  }): Promise<string> {
    const response = (await githubRequest(
      "GET /repos/{owner}/{repo}/branches/{branch}",
      {
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
        headers: { authorization: `Bearer ${input.token}` },
      },
    )) as BranchResponse;
    return decodeBranchHead(response.data, input.branch);
  }

  private async readWorkflowAtRef(input: {
    readonly token: string;
    readonly owner: string;
    readonly repo: string;
    readonly path: string;
    readonly ref: string;
    readonly missingAllowed?: boolean;
  }): Promise<string | null> {
    try {
      const response = (await githubRequest(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: input.owner,
          repo: input.repo,
          path: input.path,
          ref: input.ref,
          headers: { authorization: `Bearer ${input.token}` },
        },
      )) as ContentsResponse;
      return decodeWorkflowContent(response.data);
    } catch (error) {
      if (
        input.missingAllowed === true &&
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      ) {
        return null;
      }
      throw error;
    }
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function decodeRepositoryDefaultBranch(
  data: unknown,
  expectedRepositoryId: string,
): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("codex_rotating_repository_invalid_response");
  }
  const repository = data as {
    readonly id?: unknown;
    readonly default_branch?: unknown;
  };
  if (
    String(repository.id ?? "") !== expectedRepositoryId ||
    typeof repository.default_branch !== "string" ||
    repository.default_branch.length === 0 ||
    repository.default_branch.trim() !== repository.default_branch
  ) {
    throw new Error("codex_rotating_repository_identity_mismatch");
  }
  return repository.default_branch;
}

function normalizeWorkflowApiUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("codex_rotating_workflow_api_url_invalid");
  }
  return url.toString().replace(/\/$/, "");
}

function decodeOpenPullRequests(
  data: unknown,
  expectedRepositoryId: string,
): ReviewInventoryPullRequestSnapshot[] {
  if (!Array.isArray(data)) {
    throw new Error("codex_rotating_pull_request_inventory_invalid_response");
  }
  const pullRequests: ReviewInventoryPullRequestSnapshot[] = [];
  for (const value of data) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("codex_rotating_pull_request_inventory_invalid_response");
    }
    const pullRequest = value as {
      readonly number?: unknown;
      readonly draft?: unknown;
      readonly merge_commit_sha?: unknown;
      readonly base?: {
        readonly ref?: unknown;
        readonly sha?: unknown;
        readonly repo?: { readonly id?: unknown } | null;
      };
      readonly head?: { readonly sha?: unknown };
    };
    const number = pullRequest.number;
    const draft = pullRequest.draft;
    const ref = pullRequest.base?.ref;
    const baseSha = pullRequest.base?.sha;
    const headSha = pullRequest.head?.sha;
    const mergeCommitSha = pullRequest.merge_commit_sha;
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      typeof draft !== "boolean" ||
      String(pullRequest.base?.repo?.id ?? "") !== expectedRepositoryId ||
      typeof ref !== "string" ||
      ref.length === 0 ||
      ref.trim() !== ref ||
      typeof baseSha !== "string" ||
      !isCommitSha(baseSha) ||
      typeof headSha !== "string" ||
      !isCommitSha(headSha) ||
      (mergeCommitSha !== null &&
        (typeof mergeCommitSha !== "string" || !isCommitSha(mergeCommitSha)))
    ) {
      throw new Error("codex_rotating_pull_request_base_identity_mismatch");
    }
    pullRequests.push({
      number,
      draft,
      baseRef: ref,
      baseSha: baseSha.toLowerCase(),
      headSha: headSha.toLowerCase(),
      mergeState:
        mergeCommitSha === null
          ? ReviewInventoryPullRequestMergeState.Conflicted
          : ReviewInventoryPullRequestMergeState.Ready,
      mergeCommitSha:
        typeof mergeCommitSha === "string"
          ? mergeCommitSha.toLowerCase()
          : null,
    });
  }
  return pullRequests;
}

function decodePullRequestMergeability(
  data: unknown,
  expectedRepositoryId: string,
  expected: ReviewInventoryPullRequestSnapshot,
): ReviewInventoryPullRequestSnapshot {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("codex_rotating_pull_request_inventory_invalid_response");
  }
  const pullRequest = data as {
    readonly number?: unknown;
    readonly draft?: unknown;
    readonly mergeable?: unknown;
    readonly merge_commit_sha?: unknown;
    readonly base?: {
      readonly ref?: unknown;
      readonly sha?: unknown;
      readonly repo?: { readonly id?: unknown } | null;
    };
    readonly head?: { readonly sha?: unknown };
  };
  if (
    pullRequest.number !== expected.number ||
    pullRequest.draft !== expected.draft ||
    String(pullRequest.base?.repo?.id ?? "") !== expectedRepositoryId ||
    pullRequest.base?.ref !== expected.baseRef ||
    normalizeCommitSha(pullRequest.base?.sha) !== expected.baseSha ||
    normalizeCommitSha(pullRequest.head?.sha) !== expected.headSha
  ) {
    throw new Error("codex_rotating_workflow_inventory_coverage_moved");
  }
  if (pullRequest.mergeable === null) {
    throw new Error(
      "codex_rotating_workflow_inventory_mergeability_unavailable",
    );
  }
  if (pullRequest.mergeable === false) {
    if (pullRequest.merge_commit_sha !== null) {
      throw new Error("codex_rotating_workflow_inventory_mergeability_invalid");
    }
    return {
      ...expected,
      mergeState: ReviewInventoryPullRequestMergeState.Conflicted,
      mergeCommitSha: null,
    };
  }
  const mergeCommitSha = normalizeCommitSha(pullRequest.merge_commit_sha);
  if (pullRequest.mergeable !== true || mergeCommitSha === null) {
    throw new Error("codex_rotating_workflow_inventory_mergeability_invalid");
  }
  return {
    ...expected,
    mergeState: ReviewInventoryPullRequestMergeState.Ready,
    mergeCommitSha,
  };
}

function assertUniquePullRequestNumbers(
  pullRequests: readonly ReviewInventoryPullRequestSnapshot[],
): void {
  if (
    new Set(pullRequests.map((pullRequest) => pullRequest.number)).size !==
    pullRequests.length
  ) {
    throw new Error("codex_rotating_pull_request_inventory_duplicate_response");
  }
}

function sameReviewInventoryCoverage(
  left: ReviewInventoryCoverageSnapshot,
  right: ReviewInventoryCoverageSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeCommitSha(value: unknown): string | null {
  return typeof value === "string" && isCommitSha(value)
    ? value.toLowerCase()
    : null;
}

function isCommitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}

function decodeBranchHead(data: unknown, expectedBranch: string): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("codex_rotating_branch_invalid_response");
  }
  const branch = data as {
    readonly name?: unknown;
    readonly commit?: { readonly sha?: unknown };
  };
  const sha = branch.commit?.sha;
  if (
    branch.name !== expectedBranch ||
    typeof sha !== "string" ||
    !isCommitSha(sha)
  ) {
    throw new Error("codex_rotating_branch_identity_mismatch");
  }
  return sha.toLowerCase();
}

function inspectReviewV2InteractionWorkflow(
  workflow: string | null,
  expectedActionRef: string | null,
  expectedApiUrl: string,
) {
  const expectedActionCommitSha =
    expectedActionRef?.match(/@([a-f0-9]{40})$/i)?.[1]?.toLowerCase() ?? null;
  if (workflow === null) {
    return {
      path: managedInteractionWorkflowPath,
      present: false,
      compatible: true,
      actionCommitSha: null,
      errors: [] as string[],
    };
  }

  const expectedWorkflow =
    expectedActionRef && expectedActionCommitSha
      ? renderCanonicalCodexRotatingInteractionWorkflowV2({
          actionRef: expectedActionRef,
          apiUrl: expectedApiUrl,
          runtimeConfigMode: "oidc",
        })
      : null;
  const errors =
    expectedWorkflow &&
    areWorkflowDocumentsSemanticallyEqual(workflow, expectedWorkflow)
      ? []
      : ["interaction_workflow_source_mismatch"];
  return {
    path: managedInteractionWorkflowPath,
    present: true,
    compatible: errors.length === 0,
    actionCommitSha: expectedActionCommitSha,
    errors: errors.sort(),
  };
}

function decodeWorkflowRunPullRequest(
  data: unknown,
  expected: {
    readonly eventName: "pull_request_target";
    readonly githubRepositoryId: string;
    readonly githubRunAttempt: string;
  },
): number {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("codex_rotating_workflow_run_invalid_response");
  }
  const run = data as {
    readonly event?: unknown;
    readonly run_attempt?: unknown;
    readonly repository?: { readonly id?: unknown };
    readonly pull_requests?: readonly { readonly number?: unknown }[];
  };
  const expectedAttempt = parsePositiveSafeInteger(
    expected.githubRunAttempt,
    "codex_rotating_workflow_run_attempt_invalid",
  );
  if (
    run.event !== expected.eventName ||
    run.run_attempt !== expectedAttempt ||
    String(run.repository?.id ?? "") !== expected.githubRepositoryId ||
    !Array.isArray(run.pull_requests) ||
    run.pull_requests.length !== 1
  ) {
    throw new Error("codex_rotating_workflow_run_identity_mismatch");
  }
  const pullRequestNumber = run.pull_requests[0]?.number;
  if (
    !Number.isSafeInteger(pullRequestNumber) ||
    (pullRequestNumber as number) <= 0
  ) {
    throw new Error("codex_rotating_workflow_run_pull_request_invalid");
  }
  return pullRequestNumber as number;
}

function decodePullRequestReviewFacts(
  data: unknown,
  expected: {
    readonly githubRepositoryId: string;
    readonly pullRequestNumber: number;
  },
) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("codex_rotating_pull_request_facts_invalid_response");
  }
  const pullRequest = data as {
    readonly number?: unknown;
    readonly additions?: unknown;
    readonly deletions?: unknown;
    readonly base?: { readonly repo?: { readonly id?: unknown } | null };
    readonly head?: { readonly sha?: unknown };
  };
  const headSha = normalizeCommitSha(pullRequest.head?.sha);
  if (
    pullRequest.number !== expected.pullRequestNumber ||
    String(pullRequest.base?.repo?.id ?? "") !== expected.githubRepositoryId ||
    headSha === null ||
    !Number.isSafeInteger(pullRequest.additions) ||
    (pullRequest.additions as number) < 0 ||
    !Number.isSafeInteger(pullRequest.deletions) ||
    (pullRequest.deletions as number) < 0
  ) {
    throw new Error("codex_rotating_pull_request_facts_identity_mismatch");
  }
  return {
    pullRequestNumber: expected.pullRequestNumber,
    headSha,
    additions: pullRequest.additions as number,
    deletions: pullRequest.deletions as number,
  };
}

function parsePositiveSafeInteger(value: string, errorCode: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(errorCode);
  }
  return parsed;
}

function repoNameFromFullName(fullName: string): string {
  const [, repo] = fullName.split("/");
  if (!repo) {
    throw new Error("codex_rotating_invalid_repository_full_name");
  }
  return repo;
}

function decodeWorkflowContent(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("codex_rotating_workflow_content_invalid_response");
  }
  const record = data as {
    readonly type?: unknown;
    readonly encoding?: unknown;
    readonly content?: unknown;
  };
  if (record.type !== "file" || record.encoding !== "base64") {
    throw new Error("codex_rotating_workflow_content_invalid_response");
  }
  if (typeof record.content !== "string") {
    throw new Error("codex_rotating_workflow_content_invalid_response");
  }
  const compacted = record.content.replace(/\s+/g, "");
  if (compacted.length === 0 || compacted.length > 128 * 1024) {
    throw new Error("codex_rotating_workflow_content_too_large");
  }
  return Buffer.from(compacted, "base64").toString("utf8");
}
