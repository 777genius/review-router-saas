import { config as loadDotenv } from "dotenv";
import { createApiApp } from "../../../apps/api/src/app.js";
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
const workspaceSlug = "gh-organization-reviewrouter-lifecycle-e2e";
const prisma = createPrismaClient({ databaseUrl });

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
            login: "reviewrouter-lifecycle-e2e",
            type: "Organization",
          },
          repository_selection: "selected",
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
    await assertOutboxCount(1, "created installation enqueues one sync");

    await postWebhook(app, {
      deliveryId: "e2e-installation-created",
      eventName: "installation",
      payload: {
        action: "created",
        installation: {
          id: Number(installationId),
          account: {
            login: "reviewrouter-lifecycle-e2e",
            type: "Organization",
          },
          repository_selection: "selected",
        },
      },
    });
    await assertOutboxCount(1, "duplicate delivery does not duplicate outbox");

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
            login: "reviewrouter-lifecycle-e2e",
            type: "Organization",
          },
          repository_selection: "selected",
        },
      },
    });
    await assertOutboxCount(
      2,
      "installation_repositories enqueues a second sync",
    );

    await prisma.repositoryConnection.create({
      data: {
        workspaceId: activeInstallation.workspaceId,
        installationId: activeInstallation.id,
        githubRepositoryId: repositoryId,
        owner: "reviewrouter-lifecycle-e2e",
        name: "example",
        fullName: "reviewrouter-lifecycle-e2e/example",
        defaultBranch: "main",
        visibility: "private",
        selected: true,
      },
    });

    await postWebhook(app, {
      deliveryId: "e2e-installation-deleted",
      eventName: "installation",
      payload: {
        action: "deleted",
        installation: {
          id: Number(installationId),
          account: {
            login: "reviewrouter-lifecycle-e2e",
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
    await assertOutboxCount(2, "deleted installation does not enqueue sync");

    console.info("Webhook lifecycle E2E passed");
  } finally {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  }
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
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

await main();
