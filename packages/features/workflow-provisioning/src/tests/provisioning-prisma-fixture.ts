import { Prisma } from "@prisma/client";
import { vi } from "vitest";

export const scope = {
  workspaceId: "workspace_1",
  repositoryId: "repository_1",
  installationId: "installation_1",
};
export const record = {
  ...scope,
  status: "not_started" as const,
  branch: "reviewrouter/setup",
  workflowPath: ".github/workflows/reviewrouter-codex.yml",
  workflowStyle: "reusable" as const,
  actionVersion: "a".repeat(40),
};
export const identity = {
  ...scope,
  setupBranch: record.branch,
  pullRequestNumber: 7,
  baseBranch: "main",
};
export const initialCandidate = {
  ...record,
  id: "provisioning_1",
  attemptId: "attempt_1",
  revision: 1,
  status: "setup_pr_open" as
    | "not_started"
    | "setup_pr_open"
    | "failed"
    | "configured",
  pullRequestUrl: "https://github.com/acme/widget/pull/7" as string | null,
  errorMessage: null as string | null,
};
export type Candidate = typeof initialCandidate;
export function conflict() {
  return new Prisma.PrismaClientKnownRequestError("serialization failure", {
    code: "P2034",
    clientVersion: "7.8.0",
  });
}

export function createProvisioningPrisma(
  initial: Candidate | null = initialCandidate,
) {
  let current = initial ? { ...initial } : null;
  let repository = { id: scope.repositoryId, ...scope, defaultBranch: "main" };
  const workflowProvisioning = {
    findFirst: vi.fn(async () => (current ? { ...current } : null)),
    findUnique: vi.fn(async () => (current ? { ...current } : null)),
    create: vi.fn(async ({ data }: { data: Partial<Candidate> }) => {
      current = {
        ...initialCandidate,
        ...data,
        pullRequestUrl: data.pullRequestUrl ?? null,
        errorMessage: data.errorMessage ?? null,
      };
      return current;
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (
          !current ||
          Object.entries(where).some(
            ([key, value]) =>
              key !== "repository" &&
              current![key as keyof Candidate] !== value,
          )
        )
          return { count: 0 };
        current = {
          ...current,
          ...data,
          revision:
            typeof data.revision === "object"
              ? current.revision + 1
              : ((data.revision as number | undefined) ?? current.revision),
        } as Candidate;
        return { count: 1 };
      },
    ),
  };
  const repositoryConnection = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      where.id === repository.id &&
      where.workspaceId === repository.workspaceId &&
      where.installationId === repository.installationId
        ? repository
        : null,
    ),
  };
  const tx = { workflowProvisioning, repositoryConnection };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  return {
    prisma,
    workflowProvisioning,
    repositoryConnection,
    current: () => current,
    replace: (value: Candidate | null) => {
      current = value;
    },
    transfer: () => {
      repository = {
        ...repository,
        workspaceId: "workspace_2",
        installationId: "installation_2",
      };
    },
  };
}
