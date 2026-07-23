import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { InMemoryOutboxEventRepository } from "@reviewrouter/features-outbox";
import { ReviewRequestedTriggerKind } from "@reviewrouter/features-review-executions";
import { ReviewV2RequestIngressOutbox } from "./review-v2-request-ingress-outbox";
import {
  registerReviewV2RequestCommandRoutes,
  reviewV2ManualRequestPath,
} from "./review-v2-request-command-routes";

describe("review v2 manual request routes", () => {
  it("queues a distinct same-head manual trigger and restores its retry", async () => {
    const { app, outbox } = await fixture();
    const request = {
      method: "POST" as const,
      url: reviewV2ManualRequestPath,
      headers: { authorization: "Bearer session" },
      payload: {
        protocolVersion: 1,
        pullRequestNumber: 252,
        expectedHeadSha: "a".repeat(40),
        sourceId: "review-comment:123",
        commandKind: "skip",
      },
    };

    await expect(app.inject(request)).resolves.toMatchObject({
      statusCode: 200,
    });
    const retry = await app.inject(request);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: "restored" });
    expect([...outbox.events.values()]).toHaveLength(1);
    expect([...outbox.events.values()][0]?.payload).toMatchObject({
      triggerKind: ReviewRequestedTriggerKind.ManualCommand,
      expectedHeadSha: "a".repeat(40),
      quietPeriodMs: 0,
    });
    await app.close();
  });

  it("rejects sessions not issued to an interaction event", async () => {
    const { app } = await fixture("pull_request");
    const response = await app.inject({
      method: "POST",
      url: reviewV2ManualRequestPath,
      headers: { authorization: "Bearer session" },
      payload: {
        protocolVersion: 1,
        pullRequestNumber: 252,
        expectedHeadSha: "a".repeat(40),
        sourceId: "review-comment:123",
        commandKind: "skip",
      },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("does not report a dead-lettered request as restored", async () => {
    const { app, outbox } = await fixture();
    const request = {
      method: "POST" as const,
      url: reviewV2ManualRequestPath,
      headers: { authorization: "Bearer session" },
      payload: {
        protocolVersion: 1,
        pullRequestNumber: 252,
        expectedHeadSha: "a".repeat(40),
        sourceId: "review-comment:dead-letter",
        commandKind: "review",
      },
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    const [key, event] = [...outbox.events.entries()][0]!;
    outbox.events.set(key, {
      ...event,
      status: "dead_letter",
      deadLetteredAt: new Date("2026-07-23T10:01:00.000Z"),
    });

    expect((await app.inject(request)).statusCode).toBe(500);
    await app.close();
  });
});

async function fixture(eventName = "pull_request_review_comment") {
  const app = Fastify();
  const outbox = new InMemoryOutboxEventRepository();
  await registerReviewV2RequestCommandRoutes(app, {
    repositories: {
      findSelectedRepositoryByGithubId: async () => ({
        workspaceId: "workspace-1",
        repositoryId: "connection-1",
        githubRepositoryId: "99",
        githubInstallationId: "123",
        fullName: "777genius/agent-teams-ai",
        owner: "777genius",
        selected: true,
        installationStatus: "active",
      }),
    } as never,
    repositoryIdentities: {
      findScmRepositoryIdentityById: async () => null,
      findScmRepositoryIdentityByExternalIdentity: async () =>
        ({
          scmRepositoryIdentityId: "repository-1",
          provider: "github",
          normalizedSourceBaseUrl: "https://github.com",
          externalRepositoryId: "99",
          currentWorkspaceId: "workspace-1",
          currentRepositoryConnectionId: "connection-1",
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }) as never,
    },
    sessions: {
      sign: async () => {
        throw new Error("unused");
      },
      verify: async () => ({
        workspaceId: "workspace-1",
        repositoryId: "connection-1",
        githubRepositoryId: "99",
        repository: "777genius/agent-teams-ai",
        githubActorLogin: "maintainer",
        githubRunId: "100",
        githubRunAttempt: "1",
        eventName: eventName as never,
        protocolVersion: 1,
      }),
    },
    ingress: new ReviewV2RequestIngressOutbox(outbox, {
      digestUtf8: async (value) =>
        createHash("sha256").update(value).digest("hex"),
    }),
    clock: { now: () => new Date("2026-07-23T10:00:00.000Z") },
    retentionMs: 86_400_000,
  });
  return { app, outbox };
}
