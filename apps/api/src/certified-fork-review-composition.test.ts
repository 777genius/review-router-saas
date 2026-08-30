import { describe, expect, it } from "vitest";
import {
  HmacCertifiedForkReviewTickets,
  StrictCertifiedForkReviewOutput,
} from "./certified-fork-review-composition.js";
const binding = {
  sourceRepository: "contributor/example",
  sourceRepositoryId: "101",
  baseRepository: "owner/example",
  baseRepositoryId: "99",
  pullRequestNumber: 42,
  reviewHeadSha: "b".repeat(40),
  baseSha: "a".repeat(40),
  trustDomain: "fork" as const,
};
const promptPacket = {
  protocolVersion: 1 as const,
  contextHash: "c".repeat(64),
  repository: {
    base: binding.baseRepository,
    source: binding.sourceRepository,
  },
  pullRequestNumber: 42,
  baseSha: binding.baseSha,
  headSha: binding.reviewHeadSha,
  files: [
    {
      path: "src/a.ts",
      status: "modified" as const,
      additions: 1,
      deletions: 1,
      patch: "@@",
    },
  ],
};
describe("certified fork composition", () => {
  it("signs opaque execution tickets and rejects tampering", async () => {
    const tickets = new HmacCertifiedForkReviewTickets("s".repeat(32));
    const issued = await tickets.issue({
      contextHash: promptPacket.contextHash,
      leaseId: "lease-123",
      providerInstanceId: "provider-123",
      githubInstallationId: "7",
      githubRunId: "8",
      githubRunAttempt: "1",
      workflowRef:
        "owner/example/.github/workflows/reviewrouter-codex.yml@refs/heads/main",
      workflowSha: "a".repeat(40),
      binding,
    });
    await expect(tickets.verify(issued.executionId)).resolves.toMatchObject({
      contextHash: promptPacket.contextHash,
      binding,
    });
    await expect(tickets.verify(`${issued.executionId}x`)).rejects.toThrow(
      "certified_fork_context_mismatch",
    );
  });
  it("strictly parses output, strips model markers, and rejects non-diff paths", () => {
    const output = new StrictCertifiedForkReviewOutput();
    const rendered = output.render({
      generatedAt: new Date("2026-08-30T10:00:00.000Z"),
      marker: "<!-- owned -->",
      binding,
      promptPacket,
      modelOutput: {
        protocolVersion: 1,
        summaryMarkdown: "<!-- attacker -->ok",
        findings: [
          {
            severity: "major",
            title: "bug",
            body: "body",
            path: "src/a.ts",
            startLine: 1,
          },
        ],
      },
    });
    expect(rendered.body).toContain("<!-- owned -->");
    expect(rendered.body).not.toContain("attacker");
    expect(() =>
      output.render({
        generatedAt: new Date(),
        marker: "<!-- owned -->",
        binding,
        promptPacket,
        modelOutput: {
          protocolVersion: 1,
          summaryMarkdown: "ok",
          findings: [
            {
              severity: "major",
              title: "bug",
              body: "body",
              path: "../secret",
              startLine: 1,
            },
          ],
        },
      }),
    ).toThrow(/review_model_output|certified_fork_model_output/);
  });
});
