import {
  evaluateRepositoryHealth,
  type RepositoryHealthInput,
  type RepositoryHealthSnapshot,
} from "../../domain/repository-health";
import type { RepositoryHealthRepositoryPort } from "../ports/repository-health-repository-port";
import type { RepositoryWorkflowProbePort } from "../ports/repository-workflow-probe-port";

export const defaultRepositoryHealthWorkflowPath =
  ".github/workflows/reviewrouter.yml";

export async function listWorkspaceRepositoryHealth(
  input: {
    readonly workspaceId: string;
    readonly expectedActionRef: string;
    readonly workflowPath?: string;
    readonly workflowProbeMaxRepositories?: number;
    readonly actionHealthStaleAfterMs?: number;
    readonly checkedAt?: Date;
  },
  dependencies: {
    readonly repositories: RepositoryHealthRepositoryPort;
    readonly workflowProbe?: RepositoryWorkflowProbePort;
  },
): Promise<readonly RepositoryHealthSnapshot[]> {
  const repositories =
    await dependencies.repositories.listWorkspaceHealthInputs(
      input.workspaceId,
    );
  const checkedAt = input.checkedAt ?? new Date();
  const enrichedRepositories = await attachWorkflowChecks(
    repositories.map((repository) => ({
      ...repository,
      expectedActionRef: input.expectedActionRef,
      ...(input.actionHealthStaleAfterMs !== undefined
        ? { actionHealthStaleAfterMs: input.actionHealthStaleAfterMs }
        : {}),
    })),
    {
      workflowPath: input.workflowPath ?? defaultRepositoryHealthWorkflowPath,
      maxRepositories: input.workflowProbeMaxRepositories ?? 20,
      ...(dependencies.workflowProbe
        ? { workflowProbe: dependencies.workflowProbe }
        : {}),
    },
  );

  return enrichedRepositories.map((repository) =>
    evaluateRepositoryHealth(repository, checkedAt),
  );
}

async function attachWorkflowChecks(
  repositories: readonly RepositoryHealthInput[],
  input: {
    readonly workflowPath: string;
    readonly maxRepositories: number;
    readonly workflowProbe?: RepositoryWorkflowProbePort;
  },
): Promise<readonly RepositoryHealthInput[]> {
  if (!input.workflowProbe || input.maxRepositories <= 0) {
    return repositories;
  }

  const workflowProbe = input.workflowProbe;
  let probesStarted = 0;
  return Promise.all(
    repositories.map(async (repository) => {
      if (
        !shouldProbeWorkflow(repository) ||
        probesStarted >= input.maxRepositories
      ) {
        return repository;
      }
      probesStarted += 1;
      return {
        ...repository,
        workflowCheck: await probeWorkflowSafely(workflowProbe, repository, {
          workflowPath: input.workflowPath,
        }),
      };
    }),
  );
}

async function probeWorkflowSafely(
  workflowProbe: RepositoryWorkflowProbePort,
  repository: RepositoryHealthInput & {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly name: string;
    readonly defaultBranch: string;
  },
  input: {
    readonly workflowPath: string;
  },
): Promise<NonNullable<RepositoryHealthInput["workflowCheck"]>> {
  try {
    return await workflowProbe.probeWorkflow({
      githubInstallationId: repository.githubInstallationId,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
      workflowPath: input.workflowPath,
      expectedActionRef: repository.expectedActionRef,
    });
  } catch {
    return {
      status: "unavailable",
      reason: "workflow_probe_failed",
    };
  }
}

function shouldProbeWorkflow(
  repository: RepositoryHealthInput,
): repository is RepositoryHealthInput & {
  readonly githubInstallationId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
} {
  return (
    repository.setupStatus !== "needs_attention" &&
    Boolean(repository.githubInstallationId) &&
    Boolean(repository.owner) &&
    Boolean(repository.name) &&
    Boolean(repository.defaultBranch)
  );
}
