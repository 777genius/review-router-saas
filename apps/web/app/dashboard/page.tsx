import { Badge, Card } from "@reviewrouter/ui";
import { PrismaRepositoryConnectionRepository } from "@reviewrouter/features-repositories";
import { getPrisma } from "../../src/server/prisma";

export const dynamic = "force-dynamic";

type DashboardWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly installations: readonly {
    readonly accountLogin: string;
    readonly status: string;
    readonly repositorySelection: string;
  }[];
};

async function loadDashboardData() {
  const prisma = getPrisma();
  const workspaces = await prisma.workspace.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      installations: {
        orderBy: { updatedAt: "desc" },
        take: 3,
        select: {
          accountLogin: true,
          status: true,
          repositorySelection: true,
        },
      },
    },
  });
  const repositoryStore = new PrismaRepositoryConnectionRepository(prisma);

  return Promise.all(
    workspaces.map(
      async (
        workspace,
      ): Promise<{
        workspace: DashboardWorkspace;
        repositoryCount: number;
        repositories: readonly Awaited<
          ReturnType<typeof repositoryStore.listWorkspaceRepositories>
        >[number][];
      }> => {
        const repositories = await repositoryStore.listWorkspaceRepositories(
          workspace.id,
        );

        return {
          workspace,
          repositoryCount: repositories.length,
          repositories: repositories.slice(0, 8),
        };
      },
    ),
  );
}

export default async function DashboardPage(): Promise<React.ReactElement> {
  const workspaces = await loadDashboardData();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-10">
      <section className="space-y-3">
        <Badge tone="accent">Dashboard</Badge>
        <h1 className="text-4xl font-semibold tracking-tight text-cyan-50 md:text-6xl">
          Connected repositories
        </h1>
        <p className="max-w-3xl text-base leading-7 text-slate-300">
          Repository sync is App-driven. The dashboard reads normalized
          installation and repository metadata, not code, diffs, PR bodies, or
          commit messages.
        </p>
      </section>

      <section className="grid gap-5">
        {workspaces.length === 0 ? (
          <Card className="space-y-3">
            <Badge tone="warning">No workspace yet</Badge>
            <p className="text-sm leading-6 text-slate-300">
              Sign in with GitHub and install the ReviewRouter App to create a
              workspace and start syncing repositories.
            </p>
          </Card>
        ) : (
          workspaces.map(({ workspace, repositoryCount, repositories }) => (
            <Card key={workspace.id} className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-semibold text-cyan-50">
                    {workspace.name}
                  </h2>
                  <p className="text-sm text-slate-400">{workspace.slug}</p>
                </div>
                <Badge tone="success">{repositoryCount} repositories</Badge>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                {workspace.installations.map((installation) => (
                  <div
                    key={`${workspace.id}-${installation.accountLogin}`}
                    className="rounded-xl border border-cyan-200/10 bg-cyan-300/5 p-3"
                  >
                    <p className="text-sm font-semibold text-cyan-50">
                      {installation.accountLogin}
                    </p>
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-400">
                      {installation.status} / {installation.repositorySelection}
                    </p>
                  </div>
                ))}
              </div>

              <div className="overflow-hidden rounded-xl border border-cyan-200/10">
                <table className="w-full text-left text-sm">
                  <thead className="bg-cyan-300/10 text-xs uppercase tracking-[0.16em] text-cyan-100">
                    <tr>
                      <th className="px-4 py-3">Repository</th>
                      <th className="px-4 py-3">Visibility</th>
                      <th className="px-4 py-3">Default branch</th>
                      <th className="px-4 py-3">Setup</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cyan-200/10 text-slate-200">
                    {repositories.map((repository) => (
                      <tr
                        key={repository.id}
                        className={repository.selected ? "" : "opacity-50"}
                      >
                        <td className="px-4 py-3 font-medium">
                          {repository.fullName}
                        </td>
                        <td className="px-4 py-3">{repository.visibility}</td>
                        <td className="px-4 py-3">
                          {repository.defaultBranch}
                        </td>
                        <td className="px-4 py-3">{repository.setupStatus}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))
        )}
      </section>
    </main>
  );
}
