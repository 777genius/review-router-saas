import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Badge } from "@reviewrouter/ui";
import {
  getDashboardMutationStatus,
  getDashboardWorkspaceScope,
} from "../../../src/server/dashboard-mutations";
import { getPrisma } from "../../../src/server/prisma";
import { LogoMark } from "../../logo-mark";
import { createNoIndexPageMetadata } from "../../seo";
import { GitLabConnectWizard } from "./gitlab-connect-wizard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = createNoIndexPageMetadata({
  title: "Connect GitLab",
  description:
    "Connect GitLab repositories to ReviewRouter without storing GitLab access tokens.",
});

type GitLabSetupPageProps = {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
};

export default async function GitLabSetupPage({
  searchParams,
}: GitLabSetupPageProps): Promise<React.ReactElement> {
  const params = searchParams ? await searchParams : {};
  const requestedWorkspaceId = readParam(params.workspaceId);
  const requestedInstallationId = readParam(params.installationId);
  const callbackUrl = gitLabSetupCallbackUrl({
    workspaceId: requestedWorkspaceId,
    installationId: requestedInstallationId,
  });
  const [mutationStatus, workspaceScope] = await Promise.all([
    getDashboardMutationStatus(),
    getDashboardWorkspaceScope(),
  ]);

  if (!mutationStatus.signedIn) {
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  const workspaceId = await resolveWorkspaceId({
    requestedWorkspaceId,
    workspaceScope,
  });
  if (!workspaceId) {
    redirect("/dashboard");
  }
  const initialSourceUrl = requestedInstallationId
    ? await resolveInitialGitLabSourceUrl({
        workspaceId,
        installationId: requestedInstallationId,
      })
    : "";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 md:py-12">
      <section className="rounded-[2rem] border border-cyan-300/[0.12] bg-[var(--rr-surface-card-strong)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.42),0_0_90px_-54px_rgba(0,240,255,0.9)] backdrop-blur-2xl sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <LogoMark size="sm" />
          <Badge tone="accent">GitLab source</Badge>
        </div>
        <div className="mt-6 max-w-3xl space-y-3">
          <h1 className="text-3xl font-extrabold leading-tight text-cyan-50 sm:text-5xl">
            Connect GitLab repositories
          </h1>
          <p className="text-sm leading-6 text-slate-300 sm:text-base">
            Paste your GitLab group or project URL, select repositories, and
            ReviewRouter will install CI wiring without storing your GitLab
            access token.
          </p>
        </div>
      </section>

      <GitLabConnectWizard
        workspaceId={workspaceId}
        initialSourceUrl={initialSourceUrl}
      />
    </main>
  );
}

async function resolveInitialGitLabSourceUrl(input: {
  readonly workspaceId: string;
  readonly installationId: string;
}): Promise<string> {
  const prisma = getPrisma();
  const installation = await prisma.gitLabInstallation.findFirst({
    where: {
      id: input.installationId,
      workspaceId: input.workspaceId,
    },
    select: {
      namespacePath: true,
      sourceBaseUrl: true,
    },
  });
  if (!installation) return "";
  return `${installation.sourceBaseUrl}/${installation.namespacePath}`;
}

async function resolveWorkspaceId(input: {
  readonly requestedWorkspaceId: string;
  readonly workspaceScope: Awaited<
    ReturnType<typeof getDashboardWorkspaceScope>
  >;
}): Promise<string | null> {
  const prisma = getPrisma();
  if (input.requestedWorkspaceId) {
    const allowed =
      input.workspaceScope.kind === "all" ||
      (input.workspaceScope.kind === "workspace_ids" &&
        input.workspaceScope.workspaceIds.includes(input.requestedWorkspaceId));
    if (!allowed) return null;
    const workspace = await prisma.workspace.findUnique({
      where: { id: input.requestedWorkspaceId },
      select: { id: true },
    });
    return workspace?.id ?? null;
  }

  if (
    input.workspaceScope.kind === "workspace_ids" &&
    input.workspaceScope.workspaceIds.length > 0
  ) {
    return input.workspaceScope.workspaceIds[0] ?? null;
  }

  if (input.workspaceScope.kind === "all") {
    const workspace = await prisma.workspace.findFirst({
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return workspace?.id ?? null;
  }

  return null;
}

function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function gitLabSetupCallbackUrl(input: {
  readonly workspaceId: string;
  readonly installationId: string;
}): string {
  const query = new URLSearchParams();
  if (input.workspaceId) query.set("workspaceId", input.workspaceId);
  if (input.installationId) query.set("installationId", input.installationId);
  const suffix = query.toString();
  return suffix ? `/setup/gitlab?${suffix}` : "/setup/gitlab";
}
