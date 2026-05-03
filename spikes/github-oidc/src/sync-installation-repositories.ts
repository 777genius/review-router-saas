import { createPrismaClient } from "../../../packages/platform/db/src/index.ts";
import { SystemClock } from "../../../packages/shared/src/index.ts";
import {
  OctokitGitHubRepositorySource,
  PrismaRepositoryConnectionRepository,
  syncInstallationRepositories,
} from "../../../packages/features/repositories/src/index.ts";
import { createGitHubApp } from "./github-app.js";
import { loadAppProfile, loadEnvFiles } from "./config.js";

loadEnvFiles();

const profile = loadAppProfile();
const app = createGitHubApp(profile);
const installationId =
  process.env.REVIEW_ROUTER_INSTALLATION_ID ??
  String(
    (await app.octokit.request("GET /app/installations")).data[0]?.id ?? "",
  );

if (!installationId) {
  throw new Error("No GitHub App installation found for repository sync spike");
}

const prisma = createPrismaClient();
try {
  const result = await syncInstallationRepositories(installationId, {
    github: new OctokitGitHubRepositorySource({
      appId: profile.APP_ID,
      privateKey: profile.privateKey,
    }),
    repositories: new PrismaRepositoryConnectionRepository(prisma),
    clock: new SystemClock(),
  });

  const repositories = await prisma.repositoryConnection.findMany({
    where: {
      installation: { githubInstallationId: BigInt(installationId) },
      selected: true,
    },
    select: {
      fullName: true,
      visibility: true,
      defaultBranch: true,
      setupStatus: true,
    },
    orderBy: { fullName: "asc" },
    take: 10,
  });

  console.log(JSON.stringify({ result, sample: repositories }, null, 2));
} finally {
  await prisma.$disconnect();
}
