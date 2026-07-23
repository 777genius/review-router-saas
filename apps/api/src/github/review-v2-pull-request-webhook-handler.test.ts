import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryOutboxEventRepository } from "@reviewrouter/features-outbox";
import {
  GitHubReviewRequestIngressCommandKind,
  githubReviewRequestIngressEventType,
} from "@reviewrouter/features-github-installations";
import { ReviewV2GitHubRequestIngressOutbox } from "../review-v2-github-request-ingress-outbox";
import { ReviewV2PullRequestWebhookHandler } from "./review-v2-pull-request-webhook-handler";

describe("ReviewV2PullRequestWebhookHandler", () => {
  it("durably queues and restores the same verified delivery", async () => {
    const { handler, outbox } = fixture();

    await expect(
      handler.handleGitHubPullRequestWebhook(envelope()),
    ).resolves.toMatchObject({
      reviewV2Intent: "queued",
      commandKind: GitHubReviewRequestIngressCommandKind.Request,
    });
    await expect(
      handler.handleGitHubPullRequestWebhook(envelope()),
    ).resolves.toMatchObject({ reviewV2Intent: "restored" });
    expect([...outbox.events.values()]).toHaveLength(1);
    expect([...outbox.events.values()][0]).toMatchObject({
      type: githubReviewRequestIngressEventType,
      payload: {
        expectedBaseSha: "a".repeat(40),
        expectedHeadSha: "b".repeat(40),
      },
    });
  });

  it("preserves distinct deliveries for worker-side current-revision coalescing", async () => {
    const { handler, outbox } = fixture();
    await handler.handleGitHubPullRequestWebhook(envelope("delivery-1"));
    await handler.handleGitHubPullRequestWebhook(envelope("delivery-2"));

    expect([...outbox.events.values()]).toHaveLength(2);
    expect(
      new Set(
        [...outbox.events.values()].map(
          (event) =>
            (event.payload as { deliveryIdentityHash: string })
              .deliveryIdentityHash,
        ),
      ).size,
    ).toBe(2);
  });

  it("queues cancellation for closed and disabled-draft pull requests", async () => {
    const { handler, outbox } = fixture();
    const closed = envelope("delivery-closed");
    closed.payload.action = "closed";
    closed.payload.pull_request.state = "closed";
    const draft = envelope("delivery-draft");
    draft.payload.pull_request.draft = true;

    await expect(
      handler.handleGitHubPullRequestWebhook(closed),
    ).resolves.toMatchObject({
      commandKind: GitHubReviewRequestIngressCommandKind.Cancel,
    });
    await expect(
      handler.handleGitHubPullRequestWebhook(draft),
    ).resolves.toMatchObject({
      commandKind: GitHubReviewRequestIngressCommandKind.Cancel,
    });
    expect(
      [...outbox.events.values()].every(
        (event) =>
          (event.payload as { commandKind: string }).commandKind === "cancel",
      ),
    ).toBe(true);
  });

  it("ignores forks, bots, and non-revision edits before persistence", async () => {
    const { handler, outbox } = fixture();
    const fork = envelope("delivery-fork");
    fork.payload.pull_request.head.repo = { full_name: "outside/fork" };
    const bot = envelope("delivery-bot");
    bot.payload.pull_request.user = { type: "Bot" };
    const edit = envelope("delivery-edit");
    edit.payload.action = "edited";

    await expect(
      handler.handleGitHubPullRequestWebhook(fork),
    ).resolves.toMatchObject({ reason: "trust_domain_unsupported" });
    await expect(
      handler.handleGitHubPullRequestWebhook(bot),
    ).resolves.toMatchObject({ reason: "trust_domain_unsupported" });
    await expect(
      handler.handleGitHubPullRequestWebhook(edit),
    ).resolves.toMatchObject({ reason: "edit_not_revision_changing" });
    expect([...outbox.events.values()]).toHaveLength(0);
  });
});

function fixture() {
  const outbox = new InMemoryOutboxEventRepository();
  const handler = new ReviewV2PullRequestWebhookHandler({
    ingress: new ReviewV2GitHubRequestIngressOutbox(outbox, {
      digestUtf8: async (value) =>
        createHash("sha256").update(value).digest("hex"),
    }),
    clock: { now: () => new Date("2026-07-23T10:00:00.000Z") },
    policy: {
      reviewDrafts: () => false,
    },
  });
  return { handler, outbox };
}

function envelope(deliveryId = "delivery-1") {
  return {
    deliveryId,
    eventName: "pull_request" as const,
    payload: {
      action: "synchronize",
      installation: { id: 123 },
      repository: {
        id: 99,
        name: "agent-teams-ai",
        full_name: "777genius/agent-teams-ai",
      },
      pull_request: {
        number: 42,
        html_url: "https://github.com/777genius/agent-teams-ai/pull/42",
        state: "open",
        merged: false,
        draft: false,
        user: { type: "User" },
        base: {
          ref: "main",
          sha: "a".repeat(40),
          repo: { full_name: "777genius/agent-teams-ai" },
        },
        head: {
          ref: "feature",
          sha: "b".repeat(40),
          repo: { full_name: "777genius/agent-teams-ai" },
        },
      },
    },
  };
}
