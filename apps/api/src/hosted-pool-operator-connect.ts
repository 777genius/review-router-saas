import {
  classifyHostedPoolSetupSource,
  decodeHostedPoolWorkflowFile,
} from "./hosted-pool-operator-setup-source.js";
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  hostedBindingId,
  repositoryId,
  workspaceId,
  operatorConnectRepository,
  PrismaHostedPoolRepository,
  PrismaHostedPoolBindingRepository,
  type HostedPoolRepositoryBinding,
} from "@reviewrouter/features-hosted-account-pool";
import {
  canonicalHostedPoolProviderInstanceId,
  provisionHostedPoolRepositoryWorkflow,
  PrismaWorkflowProvisioningTarget,
  PrismaWorkflowProvisioningRepository,
  OctokitWorkflowSetupGateway,
  type WorkflowProvisioningRepositoryPort,
} from "@reviewrouter/features-workflow-provisioning";
import type { HostedPoolOperatorConnect } from "./hosted-pool-operator-composition.js";

type Requester = ConstructorParameters<typeof OctokitWorkflowSetupGateway>[0];
export type HostedPoolOperatorConnectComposition = {
  readonly prisma: PrismaClient;
  readonly actionRef: string;
  readonly trustedPriorActionRefs?: readonly string[];
  readonly apiUrl: string;
  /** Supply the existing PostgresLeaseLock; no network-spanning database transaction. */
  readonly lock: {
    withLock<T>(key: string, ttlMs: number, work: () => Promise<T>): Promise<T>;
  };
  authorize(workspaceId: string): Promise<void>;
  installationOctokit(githubInstallationId: string): Promise<Requester>;
  /** Bind the existing activateConfirmedHostedPoolBindingAfterWorkflowMerge here. */
  activateExact(input: {
    readonly repository: {
      id: string;
      workspaceId: string;
      installationId: string;
      githubRepositoryId: string;
      owner: string;
      name: string;
      fullName: string;
      defaultBranch: string;
    };
    readonly octokit: Requester;
    readonly binding: HostedPoolRepositoryBinding;
  }): Promise<"active" | "pending">;
};

export function createHostedPoolOperatorConnect(
  input: HostedPoolOperatorConnectComposition,
): HostedPoolOperatorConnect {
  return async (command) => {
    const prisma = input.prisma;
    await input.authorize(command.workspaceId);
    const repository = await prisma.repositoryConnection.findFirst({
      where: {
        workspaceId: command.workspaceId,
        fullName: command.repository,
        provider: "github",
        selected: true,
        archived: false,
        visibility: { in: ["public", "private", "internal"] },
        installation: { workspaceId: command.workspaceId, status: "active" },
      },
      include: { installation: true },
    });
    if (!repository?.installation || !repository.githubRepositoryId)
      throw new Error("hosted_pool_repository_unavailable");
    const octokit = await input.installationOctokit(
      repository.installation.githubInstallationId.toString(),
    );
    const authority = async () => {
      await input.authorize(command.workspaceId);
      const current = await prisma.repositoryConnection.findFirst({
        where: {
          id: repository.id,
          workspaceId: command.workspaceId,
          installationId: repository.installation!.id,
          githubRepositoryId: repository.githubRepositoryId,
          fullName: command.repository,
          defaultBranch: repository.defaultBranch,
          selected: true,
          archived: false,
          visibility: { in: ["public", "private", "internal"] },
          installation: { workspaceId: command.workspaceId, status: "active" },
        },
        select: { id: true },
      });
      if (!current) throw new Error("hosted_pool_repository_unavailable");
      const response = await octokit.request("GET /repos/{owner}/{repo}", {
        owner: repository.owner,
        repo: repository.name,
      });
      const remote = response.data as {
        id?: number;
        full_name?: string;
        archived?: boolean;
        default_branch?: string;
      };
      if (
        String(remote.id) !== String(repository.githubRepositoryId) ||
        remote.full_name?.toLowerCase() !== repository.fullName.toLowerCase() ||
        remote.archived !== false ||
        remote.default_branch !== repository.defaultBranch
      )
        throw new Error("hosted_pool_repository_unavailable");
    };
    const bindings = new PrismaHostedPoolBindingRepository(prisma);
    const classify = (data: unknown, binding: HostedPoolRepositoryBinding) =>
      classifyHostedPoolSetupSource(decodeHostedPoolWorkflowFile(data), {
        actionRef: input.actionRef,
        apiUrl: input.apiUrl,
        bindingId: binding.bindingId,
        bindingRevision: binding.revision,
        providerInstanceId: canonicalHostedPoolProviderInstanceId(
          repository.githubRepositoryId!.toString(),
        ),
        ...(input.trustedPriorActionRefs
          ? { trustedPriorActionRefs: input.trustedPriorActionRefs }
          : {}),
      });
    return operatorConnectRepository(
      {
        bindingId: hostedBindingId(randomUUID()),
        repositoryId: repositoryId(repository.id),
        workspaceId: workspaceId(command.workspaceId),
        expectedRevision: command.expectedRevision,
        now: new Date(),
      },
      {
        pools: new PrismaHostedPoolRepository(prisma),
        bindings,
        assertRepositoryAuthority: authority,
        withRepositoryLock: (work) =>
          input.lock.withLock(
            `repo:${repository.id}:workflow-provision`,
            5 * 60_000,
            work,
          ),
        activateExact: async (binding) => {
          // A verified repository-owned caller needs a setup PR before Hosted activation.
          try {
            const source = await octokit.request(
              "GET /repos/{owner}/{repo}/contents/{path}",
              {
                owner: repository.owner,
                repo: repository.name,
                path: ".github/workflows/reviewrouter-codex.yml",
                ref: repository.defaultBranch,
              },
            );
            if (classify(source.data, binding) === "repository_owned")
              return "pending";
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "status" in error &&
              error.status === 404
            )
              return "pending";
            throw error;
          }
          return input.activateExact({
            binding,
            octokit,
            repository: {
              id: repository.id,
              workspaceId: repository.workspaceId,
              installationId: repository.installation!.id,
              githubRepositoryId: repository.githubRepositoryId!.toString(),
              owner: repository.owner,
              name: repository.name,
              fullName: repository.fullName,
              defaultBranch: repository.defaultBranch,
            },
          });
        },
        provisionOrResume: async (binding) => {
          const provisioning = new PrismaWorkflowProvisioningRepository(prisma);
          let current = await prisma.workflowProvisioning.findUnique({
            where: { repositoryId: repository.id },
          });
          const attemptMarker = `-pool-${createHash("sha256").update(`${binding.bindingId}:${binding.revision}`).digest("hex")}-`;
          let migrateRepositoryOwned = false;
          if (current) {
            if (
              current.workspaceId !== command.workspaceId ||
              current.installationId !== repository.installation!.id ||
              current.workflowStyle !== "reusable" ||
              current.workflowPath !==
                ".github/workflows/reviewrouter-codex.yml"
            ) {
              throw new Error("hosted_pool_setup_conflict");
            }
            // Prove that a saved attempt belongs to this exact binding before reusing it.
            try {
              const read = (ref: string) =>
                octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
                  owner: repository.owner,
                  repo: repository.name,
                  path: current!.workflowPath,
                  ref,
                });
              let response;
              try {
                response = await read(current.branch);
              } catch (error) {
                if (
                  !(
                    typeof error === "object" &&
                    error !== null &&
                    "status" in error &&
                    error.status === 404 &&
                    /^[a-f0-9]{40}$/u.test(current.pullRequestHeadSha ?? "")
                  )
                )
                  throw error;
                response = await read(current.pullRequestHeadSha!);
              }
              migrateRepositoryOwned =
                classify(response.data, binding) === "repository_owned";
              if (
                !migrateRepositoryOwned &&
                current.actionVersion !== input.actionRef
              )
                throw new Error("hosted_pool_setup_conflict");
            } catch (error) {
              // Only an unfinished attempt can legitimately have no branch/file yet.
              if (
                !(
                  typeof error === "object" &&
                  error !== null &&
                  "status" in error &&
                  error.status === 404 &&
                  ["not_started", "failed"].includes(current.status) &&
                  current.branch.includes(attemptMarker)
                )
              )
                throw new Error("hosted_pool_setup_conflict", { cause: error });
            }
            if (current.status === "configured") {
              if (!migrateRepositoryOwned) return { pullRequestUrl: null };
              // A merged repository-owned setup is terminal. Start one new Hosted attempt.
              current = null;
            } else {
              if (
                !migrateRepositoryOwned &&
                current.status === "setup_pr_open" &&
                current.pullRequestUrl
              ) {
                // A saved open status can outlive an unmerged PR closure.
                // Recheck the exact PR before returning a read-only no-op.
                const match = /\/pull\/([1-9]\d*)$/u.exec(
                  current.pullRequestUrl,
                );
                const pullNumber = Number(match?.[1]);
                if (!Number.isSafeInteger(pullNumber) || pullNumber < 1)
                  throw new Error("hosted_pool_setup_conflict");
                const response = await octokit.request(
                  "GET /repos/{owner}/{repo}/pulls/{pull_number}",
                  {
                    owner: repository.owner,
                    repo: repository.name,
                    pull_number: pullNumber,
                  },
                );
                const pull = (response.data ?? {}) as {
                  head?: { ref?: string; repo?: { id?: number } | null };
                  base?: { ref?: string; repo?: { id?: number } | null };
                  merged_at?: string | null;
                  state?: string;
                  html_url?: string;
                };
                if (
                  pull.head?.ref !== current.branch ||
                  pull.base?.ref !== repository.defaultBranch ||
                  String(pull.head?.repo?.id) !==
                    repository.githubRepositoryId!.toString() ||
                  String(pull.base?.repo?.id) !==
                    repository.githubRepositoryId!.toString() ||
                  pull.merged_at !== null ||
                  typeof pull.html_url !== "string"
                )
                  throw new Error("hosted_pool_setup_conflict");
                if (pull.state === "open")
                  return { pullRequestUrl: pull.html_url };
                if (pull.state !== "closed")
                  throw new Error("hosted_pool_setup_conflict");
                // The existing setup gateway reopens this branch's closed PR.
              }
              if (
                !["failed", "not_started", "setup_pr_open"].includes(
                  current.status,
                )
              )
                throw new Error("hosted_pool_setup_conflict");
            }
          }
          const resume: WorkflowProvisioningRepositoryPort = {
            // The existing gateway reconciles this exact branch/PR after response loss.
            beginAttempt: async (record) => {
              if (!current)
                return provisioning.beginAttempt({
                  ...record,
                  branch: `${record.branch}${attemptMarker.slice(0, -1)}`,
                });
              const resumed = await prisma.workflowProvisioning.updateMany({
                where: {
                  repositoryId: repository.id,
                  workspaceId: command.workspaceId,
                  installationId: repository.installation!.id,
                  attemptId: current.attemptId,
                  revision: current.revision,
                  status: current.status,
                  branch: current.branch,
                },
                data: {
                  status: "not_started",
                  errorMessage: null,
                  actionVersion: input.actionRef,
                },
              });
              if (resumed.count !== 1)
                throw new Error("hosted_pool_setup_conflict");
              return {
                workspaceId: current.workspaceId,
                repositoryId: current.repositoryId,
                installationId: repository.installation!.id,
                attemptId: current.attemptId,
                branch: current.branch,
                revision: current.revision,
              };
            },
            markSetupPullRequestOpen: (record) =>
              provisioning.markSetupPullRequestOpen(record),
            markFailed: (record) => provisioning.markFailed(record),
          };
          const result = await provisionHostedPoolRepositoryWorkflow(
            {
              workspaceId: command.workspaceId,
              repositoryId: repository.id,
              installationId: repository.installation!.id,
              actionRef: input.actionRef,
              apiUrl: input.apiUrl,
              providerInstanceId: canonicalHostedPoolProviderInstanceId(
                repository.githubRepositoryId!.toString(),
              ),
              bindingId: binding.bindingId,
              bindingRevision: binding.revision,
              actor: command.operatorId,
            },
            {
              targets: new PrismaWorkflowProvisioningTarget(prisma),
              provisioning: resume,
              setupGateway: new OctokitWorkflowSetupGateway(octokit),
            },
          );
          return { pullRequestUrl: result.url };
        },
      },
    );
  };
}
