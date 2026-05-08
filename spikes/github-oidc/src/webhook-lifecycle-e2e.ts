import { config as loadDotenv } from "dotenv";
import { createApiApp } from "../../../apps/api/src/app.js";
import {
  PrismaOutboxEventRepository,
  processOutboxBatch,
} from "../../../packages/features/outbox/src/index.ts";
import {
  PrismaRepositoryConnectionRepository,
  type GitHubRepositorySourcePort,
  type GitHubRepositorySnapshot,
} from "../../../packages/features/repositories/src/index.ts";
import { createInstallationSyncRequestedHandler } from "../../../packages/features/repositories/src/infrastructure/outbox/installation-sync-requested-handler.ts";
import { signGitHubWebhookPayload } from "../../../packages/features/github-installations/src/infrastructure/crypto/github-webhook-signature.js";
import { createPrismaClient } from "../../../packages/platform/db/src/index.js";

loadDotenv({ path: ".env.local", override: false });
loadDotenv({ path: ".env", override: false });

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");
}

const webhookSecret = "webhook-lifecycle-e2e-secret";
const installationId = BigInt(900000000001);
const repositoryId = BigInt(9876543210123);
const senderGithubUserId = BigInt(777000001);
const accountLogin = "reviewrouter-lifecycle-e2e";
const renamedAccountLogin = "reviewrouter-lifecycle-e2e-renamed";
const workspaceSlug = "gh-organization-reviewrouter-lifecycle-e2e";
const renamedWorkspaceSlug =
  "gh-organization-reviewrouter-lifecycle-e2e-renamed";
const prisma = createPrismaClient({ databaseUrl });
const syncedAt = new Date("2026-05-03T17:30:00.000Z");
const syncClock = { now: () => syncedAt };

async function main(): Promise<void> {
  await cleanup();
  const app = await createApiApp({
    githubWebhookSecret: webhookSecret,
    prisma,
  });

  try {
    await postWebhook(app, {
      deliveryId: "e2e-installation-created",
      eventName: "installation",
      payload: {
        action: "created",
        installation: {
          id: Number(installationId),
          account: {
            login: accountLogin,
            type: "Organization",
          },
          repository_selection: "selected",
        },
        sender: {
          id: Number(senderGithubUserId),
          login: "reviewrouter-e2e-installer",
        },
      },
    });

    const activeInstallation =
      await prisma.gitHubInstallation.findUniqueOrThrow({
        where: { githubInstallationId: installationId },
        include: { workspace: true },
      });
    assert(activeInstallation.status === "active", "installation is active");
    assert(
      activeInstallation.workspace.slug === workspaceSlug,
      "workspace slug is deterministic",
    );
    const originalWorkspaceId = activeInstallation.workspaceId;
    const ownerMember = await prisma.workspaceMember.findFirst({
      where: {
        workspaceId: activeInstallation.workspaceId,
        user: { githubUserId: senderGithubUserId },
      },
      select: { role: true, githubLogin: true },
    });
    assert(ownerMember?.role === "owner", "webhook sender is workspace owner");
    assert(
      ownerMember.githubLogin === "reviewrouter-e2e-installer",
      "webhook sender login is stored as snapshot",
    );
    await assertOutboxCount(1, "created installation enqueues one sync");

    await postWebhook(app, {
      deliveryId: "e2e-installation-created",
      eventName: "installation",
      payload: {
        action: "created",
        installation: {
          id: Number(installationId),
          account: {
            login: accountLogin,
            type: "Organization",
          },
          repository_selection: "selected",
        },
        sender: {
          id: Number(senderGithubUserId),
          login: "reviewrouter-e2e-installer",
        },
      },
    });
    await assertOutboxCount(1, "duplicate delivery does not duplicate outbox");

    await postWebhook(app, {
      deliveryId: "e2e-installation-renamed",
      eventName: "installation",
      payload: {
        action: "new_permissions_accepted",
        installation: {
          id: Number(installationId),
          account: {
            login: renamedAccountLogin,
            type: "Organization",
          },
          repository_selection: "selected",
        },
        sender: {
          id: Number(senderGithubUserId),
          login: "reviewrouter-e2e-installer",
        },
      },
    });
    const renamedInstallation =
      await prisma.gitHubInstallation.findUniqueOrThrow({
        where: { githubInstallationId: installationId },
        include: { workspace: true },
      });
    assert(
      renamedInstallation.workspaceId === originalWorkspaceId,
      "installation rename preserves workspace id",
    );
    assert(
      renamedInstallation.accountLogin === renamedAccountLogin,
      "installation login snapshot is updated",
    );
    assert(
      renamedInstallation.workspace.slug === workspaceSlug,
      "installation rename does not create a replacement workspace slug",
    );
    await assertOutboxCount(2, "rename/access event enqueues sync");

    await postWebhook(app, {
      deliveryId: "e2e-installation-repositories",
      eventName: "installation_repositories",
      payload: {
        action: "added",
        repository_selection: "selected",
        repositories_added: [{ id: Number(repositoryId), name: "example" }],
        repositories_removed: [],
        installation: {
          id: Number(installationId),
          account: {
            login: renamedAccountLogin,
            type: "Organization",
          },
          repository_selection: "selected",
        },
      },
    });
    await assertOutboxCount(
      3,
      "installation_repositories enqueues another sync",
    );

    const syncResult = await processInstallationSyncOutbox();
    assert(syncResult.claimed === 3, "worker claims all sync events");
    assert(syncResult.processed === 3, "worker processes all sync events");
    const syncedRepository =
      await prisma.repositoryConnection.findUniqueOrThrow({
        where: { githubRepositoryId: repositoryId },
      });
    assert(syncedRepository.selected === true, "repository sync selects repo");
    assert(
      syncedRepository.lastSyncedAt?.toISOString() === syncedAt.toISOString(),
      "repository sync records deterministic sync timestamp",
    );

    await postWebhook(app, {
      deliveryId: "e2e-installation-deleted",
      eventName: "installation",
      payload: {
        action: "deleted",
        installation: {
          id: Number(installationId),
          account: {
            login: renamedAccountLogin,
            type: "Organization",
          },
          repository_selection: "selected",
        },
      },
    });

    const removedInstallation =
      await prisma.gitHubInstallation.findUniqueOrThrow({
        where: { githubInstallationId: installationId },
      });
    const repository = await prisma.repositoryConnection.findUniqueOrThrow({
      where: { githubRepositoryId: repositoryId },
    });
    assert(removedInstallation.status === "removed", "installation is removed");
    assert(
      repository.selected === false,
      "deleted installation unselects repos",
    );
    await assertOutboxCount(3, "deleted installation does not enqueue sync");
    await assertProcessedOutboxCount(3, "sync events stay processed");

    console.info("Webhook lifecycle E2E passed");
  } finally {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  }
}

async function processInstallationSyncOutbox(): Promise<{
  readonly claimed: number;
  readonly processed: number;
}> {
  const outbox = new PrismaOutboxEventRepository(prisma);
  return processOutboxBatch(
    {
      limit: 10,
      handlers: [
        createInstallationSyncRequestedHandler({
          github: new StaticGitHubRepositorySource([
            {
              githubRepositoryId: repositoryId.toString(),
              owner: renamedAccountLogin,
              name: "example",
              fullName: `${renamedAccountLogin}/example`,
              defaultBranch: "main",
              visibility: "private",
              archived: false,
              stargazersCount: 0,
            },
          ]),
          repositories: new PrismaRepositoryConnectionRepository(prisma),
          clock: syncClock,
        }),
      ],
    },
    { outbox, clock: syncClock },
  );
}

async function postWebhook(
  app: Awaited<ReturnType<typeof createApiApp>>,
  input: {
    readonly deliveryId: string;
    readonly eventName: string;
    readonly payload: unknown;
  },
): Promise<void> {
  const payload = JSON.stringify(input.payload);
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/github",
    payload,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": input.deliveryId,
      "x-github-event": input.eventName,
      "x-hub-signature-256": signGitHubWebhookPayload(payload, webhookSecret),
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(
      `Webhook ${input.eventName}/${input.deliveryId} failed: ${response.statusCode} ${response.body}`,
    );
  }
}

async function assertOutboxCount(
  expected: number,
  message: string,
): Promise<void> {
  const count = await prisma.outboxEvent.count({
    where: {
      idempotencyKey: {
        startsWith: `installation:${installationId.toString()}:sync:`,
      },
    },
  });
  assert(count === expected, `${message}; expected ${expected}, got ${count}`);
}

async function assertProcessedOutboxCount(
  expected: number,
  message: string,
): Promise<void> {
  const count = await prisma.outboxEvent.count({
    where: {
      idempotencyKey: {
        startsWith: `installation:${installationId.toString()}:sync:`,
      },
      status: "processed",
    },
  });
  assert(count === expected, `${message}; expected ${expected}, got ${count}`);
}

class StaticGitHubRepositorySource implements GitHubRepositorySourcePort {
  constructor(
    private readonly repositories: readonly GitHubRepositorySnapshot[],
  ) {}

  async listInstallationRepositories(): Promise<
    readonly GitHubRepositorySnapshot[]
  > {
    return this.repositories;
  }
}

async function cleanup(): Promise<void> {
  await prisma.repositoryConnection.deleteMany({
    where: { githubRepositoryId: repositoryId },
  });
  await prisma.outboxEvent.deleteMany({
    where: {
      idempotencyKey: {
        startsWith: `installation:${installationId.toString()}:sync:`,
      },
    },
  });
  await prisma.gitHubWebhookDelivery.deleteMany({
    where: { deliveryId: { startsWith: "e2e-installation-" } },
  });
  await prisma.gitHubInstallation.deleteMany({
    where: { githubInstallationId: installationId },
  });
  await prisma.workspace.deleteMany({ where: { slug: workspaceSlug } });
  await prisma.workspace.deleteMany({
    where: { slug: renamedWorkspaceSlug },
  });
  await prisma.user.deleteMany({
    where: { githubUserId: senderGithubUserId },
  });
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

await main();
