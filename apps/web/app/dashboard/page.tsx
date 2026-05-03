import { Badge, Card } from "@reviewrouter/ui";
import { PrismaRepositoryConnectionRepository } from "@reviewrouter/features-repositories";
import {
  listWorkspaceRepositoryHealth,
  PrismaRepositoryHealthRepository,
} from "@reviewrouter/features-repo-health";
import {
  freeBetaEntitlement,
  PrismaEntitlementRepository,
} from "@reviewrouter/features-entitlements";
import { buildProviderSecretSetupGuidance } from "@reviewrouter/features-provider-setup";
import { getPrisma } from "../../src/server/prisma";

export const dynamic = "force-dynamic";

type DashboardWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly installations: readonly {
    readonly accountLogin: string;
    readonly accountType: string;
    readonly status: string;
    readonly repositorySelection: string;
  }[];
  readonly auditEvents: readonly {
    readonly action: string;
    readonly actor: string;
    readonly targetType: string;
    readonly createdAt: Date;
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
          accountType: true,
          status: true,
          repositorySelection: true,
        },
      },
      auditEvents: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          action: true,
          actor: true,
          targetType: true,
          createdAt: true,
        },
      },
    },
  });
  const repositoryStore = new PrismaRepositoryConnectionRepository(prisma);
  const healthStore = new PrismaRepositoryHealthRepository(prisma);
  const entitlementStore = new PrismaEntitlementRepository(prisma);

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
        health: readonly Awaited<
          ReturnType<typeof listWorkspaceRepositoryHealth>
        >[number][];
        entitlement: ReturnType<typeof freeBetaEntitlement>;
      }> => {
        const repositories = await repositoryStore.listWorkspaceRepositories(
          workspace.id,
        );
        const entitlement =
          (await entitlementStore.findWorkspaceEntitlement(workspace.id)) ??
          freeBetaEntitlement(workspace.id);
        const health = await listWorkspaceRepositoryHealth(
          {
            workspaceId: workspace.id,
            expectedActionRef:
              process.env.REVIEW_ROUTER_ACTION_REF ??
              "777genius/review-router@v1",
          },
          { repositories: healthStore },
        );

        return {
          workspace,
          repositoryCount: repositories.length,
          repositories: repositories.slice(0, 8),
          entitlement,
          health,
        };
      },
    ),
  );
}

type DashboardWorkspaceData = Awaited<
  ReturnType<typeof loadDashboardData>
>[number];

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
          workspaces.map((workspace) => (
            <WorkspaceCard key={workspace.workspace.id} data={workspace} />
          ))
        )}
      </section>
    </main>
  );
}

function WorkspaceCard({
  data,
}: {
  readonly data: DashboardWorkspaceData;
}): React.ReactElement {
  const { workspace, repositoryCount, repositories, entitlement, health } =
    data;
  const primaryRepository =
    repositories.find((repository) => repository.selected) ?? repositories[0];
  const primaryInstallation = workspace.installations[0];
  const providerGuidance = primaryRepository
    ? buildProviderSecretSetupGuidance({
        provider: "codex_oauth",
        repoFullName: primaryRepository.fullName,
        organizationLogin:
          primaryInstallation?.accountType === "Organization"
            ? primaryInstallation.accountLogin
            : null,
      })
    : null;

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-cyan-50">
            {workspace.name}
          </h2>
          <p className="text-sm text-slate-400">{workspace.slug}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone="success">{repositoryCount} repositories</Badge>
          <Badge tone="accent">
            {entitlement.plan.replace("_", " ")} / {entitlement.status}
          </Badge>
        </div>
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
              {installation.accountType} / {installation.status} /{" "}
              {installation.repositorySelection}
            </p>
          </div>
        ))}
      </div>

      {providerGuidance ? (
        <div className="rounded-xl border border-emerald-300/20 bg-emerald-300/10 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone="success">Codex OAuth setup</Badge>
            <span className="text-xs uppercase tracking-[0.16em] text-emerald-100">
              {providerGuidance.recommendedScope.replaceAll("_", " ")}
            </span>
          </div>
          <p className="mb-4 text-sm leading-6 text-emerald-50">
            Run this on a trusted machine where Codex CLI is already logged in.
            The command writes directly to GitHub Actions secrets through{" "}
            <code>gh</code>; ReviewRouter SaaS never receives{" "}
            <code>CODEX_AUTH_JSON</code>.
          </p>
          <div className="grid gap-3">
            {providerGuidance.commands.map((command) => (
              <div
                key={command.title}
                className="rounded-lg border border-emerald-200/10 bg-slate-950/80 p-3"
              >
                <p className="text-sm font-semibold text-emerald-50">
                  {command.title}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  {command.description}
                </p>
                <pre className="mt-3 overflow-x-auto rounded-md bg-black/40 p-3 text-xs text-cyan-100">
                  <code>{command.command}</code>
                </pre>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {repositories.some((repository) => repository.visibility === "public") ? (
        <div className="rounded-xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
          Public repository warning: fork pull requests are skipped by default
          for secret-backed providers. Maintainers can add a trusted rerun flow
          later, but v1 keeps provider secrets out of untrusted fork code paths.
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-cyan-200/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-cyan-300/10 text-xs uppercase tracking-[0.16em] text-cyan-100">
            <tr>
              <th className="px-4 py-3">Repository</th>
              <th className="px-4 py-3">Visibility</th>
              <th className="px-4 py-3">Default branch</th>
              <th className="px-4 py-3">Setup</th>
              <th className="px-4 py-3">Health</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cyan-200/10 text-slate-200">
            {repositories.map((repository) => {
              const repositoryHealth = health.find(
                (item) => item.repositoryId === repository.id,
              );
              return (
                <tr
                  key={repository.id}
                  className={repository.selected ? "" : "opacity-50"}
                >
                  <td className="px-4 py-3 font-medium">
                    {repository.fullName}
                  </td>
                  <td className="px-4 py-3">{repository.visibility}</td>
                  <td className="px-4 py-3">{repository.defaultBranch}</td>
                  <td className="px-4 py-3">{repository.setupStatus}</td>
                  <td className="px-4 py-3">
                    <span className="block text-cyan-100">
                      {repositoryHealth?.status ?? "unknown"}
                    </span>
                    <span className="text-xs text-slate-400">
                      {repositoryHealth?.summary ?? "No health data"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-cyan-200/10 bg-slate-950/60 p-4">
        <p className="mb-3 text-xs uppercase tracking-[0.16em] text-cyan-100">
          Recent audit
        </p>
        {workspace.auditEvents.length === 0 ? (
          <p className="text-sm text-slate-400">No audit events yet.</p>
        ) : (
          <ul className="space-y-2 text-sm text-slate-300">
            {workspace.auditEvents.map((event) => (
              <li
                key={`${event.action}-${event.targetType}-${event.createdAt.toISOString()}`}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span>
                  {event.action} by {event.actor}
                </span>
                <span className="text-xs text-slate-500">
                  {event.createdAt.toISOString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
