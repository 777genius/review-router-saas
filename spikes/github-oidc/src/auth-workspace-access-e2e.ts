import { linkGitHubIdentity } from "../../../packages/features/auth/src/application/use-cases/link-github-identity.ts";
import { PrismaUserRepository } from "../../../packages/features/auth/src/infrastructure/prisma/prisma-user-repository.ts";
import { PrismaWorkspaceMembershipRepository } from "../../../packages/features/auth/src/infrastructure/prisma/prisma-workspace-membership-repository.ts";
import { PrismaGitHubInstallationRepository } from "../../../packages/features/github-installations/src/infrastructure/prisma/prisma-github-installation-repository.ts";
import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";
import { loadEnvFiles } from "./config.js";

loadEnvFiles();

const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const githubLogin = `rr-auth-e2e-${suffix.slice(-16)}`;
const githubUserId = suffix;
const installationId = `8${suffix}`;
const organizationInstallationId = `9${suffix}`;
const installationWorkspaceSlug = `gh-user-${githubLogin}`;
const organizationWorkspaceSlug = `gh-organization-${githubLogin}`;
const personalWorkspaceSlug = `gh-user-${githubUserId}`;

const prisma = createPrismaClient();

try {
  const installations = new PrismaGitHubInstallationRepository(prisma);
  await installations.upsertInstallation({
    githubInstallationId: installationId,
    accountLogin: githubLogin,
    accountType: "User",
    repositorySelection: "selected",
    status: "active",
  });
  await installations.upsertInstallation({
    githubInstallationId: organizationInstallationId,
    accountLogin: githubLogin,
    accountType: "Organization",
    repositorySelection: "selected",
    status: "active",
  });

  const principal = await linkGitHubIdentity(
    {
      githubUserId,
      githubLogin: githubLogin.toUpperCase(),
      primaryEmail: `${githubLogin}@example.invalid`,
      avatarUrl: null,
    },
    {
      users: new PrismaUserRepository(prisma),
      memberships: new PrismaWorkspaceMembershipRepository(prisma),
    },
  );

  const installationWorkspace = await prisma.workspace.findUnique({
    where: { slug: installationWorkspaceSlug },
    select: {
      id: true,
      members: {
        select: {
          role: true,
          githubLogin: true,
          user: { select: { githubUserId: true } },
        },
      },
    },
  });
  if (!installationWorkspace) {
    throw new Error("installation workspace was not created");
  }

  const installationMember = installationWorkspace.members.find(
    (member) => member.user?.githubUserId?.toString() === githubUserId,
  );
  if (installationMember?.role !== "owner") {
    throw new Error(
      "signed-in user was not granted owner on installation workspace",
    );
  }

  const organizationWorkspace = await prisma.workspace.findUnique({
    where: { slug: organizationWorkspaceSlug },
    select: {
      members: {
        select: { user: { select: { githubUserId: true } } },
      },
    },
  });
  const organizationMember = organizationWorkspace?.members.find(
    (member) => member.user?.githubUserId?.toString() === githubUserId,
  );
  if (organizationMember) {
    throw new Error(
      "signed-in user was granted org workspace access implicitly",
    );
  }

  const personalWorkspace = await prisma.workspace.findUnique({
    where: { slug: personalWorkspaceSlug },
    select: { id: true },
  });
  if (!personalWorkspace) {
    throw new Error("personal workspace was not created");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        principal: {
          userId: principal.userId,
          githubUserId: principal.githubUserId,
          githubLogin: principal.githubLogin,
        },
        workspaces: {
          personal: personalWorkspaceSlug,
          installation: installationWorkspaceSlug,
          organizationNotGranted: organizationWorkspaceSlug,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$transaction([
    prisma.workspace.deleteMany({
      where: {
        slug: {
          in: [
            installationWorkspaceSlug,
            organizationWorkspaceSlug,
            personalWorkspaceSlug,
          ],
        },
      },
    }),
    prisma.user.deleteMany({ where: { githubUserId: BigInt(githubUserId) } }),
  ]);
  await prisma.$disconnect();
}
