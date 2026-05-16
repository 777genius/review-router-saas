import { describe, expect, it } from "vitest";
import {
  normalizeMemoryInteractionEvent,
  parseMemoryInteractionInstructions,
  stripIgnoredMarkdown,
} from "../index";

describe("memory interaction command parser", () => {
  it("parses explicit remember commands into safe candidate instructions", () => {
    expect(
      parseMemoryInteractionInstructions(
        "/rr remember repo Prefer guard clauses in service methods.",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "candidate",
        intent: "explicit_command",
        extractionMethod: "explicit_command",
        requestedScope: "repository",
        candidateBody: "Prefer guard clauses in service methods.",
      }),
    ]);

    expect(
      parseMemoryInteractionInstructions(
        "/rr remember team Database migrations must use Prisma migrate.",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "candidate",
        requestedScope: "workspace",
        candidateBody: "Database migrations must use Prisma migrate.",
      }),
    ]);
  });

  it("parses natural-language remember requests without accepting ambiguity", () => {
    expect(
      parseMemoryInteractionInstructions(
        "Запомни это для проекта: маленькие PR проще ревьюить.",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "candidate",
        intent: "explicit_natural_language",
        extractionMethod: "explicit_natural_language",
        requestedScope: "repository",
        candidateBody: "маленькие PR проще ревьюить.",
      }),
    ]);

    expect(
      parseMemoryInteractionInstructions("Do you remember why this failed?"),
    ).toEqual([{ kind: "ignored", reason: "no_memory_intent" }]);
    expect(
      parseMemoryInteractionInstructions("запомни то что мы выше обсудили"),
    ).toEqual([{ kind: "ignored", reason: "ambiguous_discussion" }]);
  });

  it("ignores commands inside blockquotes, code fences, tables, and html comments", () => {
    const markdown = [
      "> /rr remember repo quoted command must not run",
      "",
      "```",
      "/rr remember repo code block command must not run",
      "```",
      "",
      "| command |",
      "| --- |",
      "| /rr remember repo table command must not run |",
      "",
      "<!-- /rr remember repo hidden command must not run -->",
      "/rr remember repo Real top-level command.",
    ].join("\n");

    expect(stripIgnoredMarkdown(markdown)).toBe(
      "/rr remember repo Real top-level command.",
    );
    expect(parseMemoryInteractionInstructions(markdown)).toEqual([
      expect.objectContaining({
        kind: "candidate",
        requestedScope: "repository",
        candidateBody: "Real top-level command.",
      }),
    ]);
  });

  it("parses management commands as AST without side effects", () => {
    expect(
      parseMemoryInteractionInstructions("/rr remember mem_suggestion_123"),
    ).toEqual([
      {
        kind: "confirm_suggestion",
        suggestionId: "mem_suggestion_123",
        rawCommand: "/rr remember mem_suggestion_123",
      },
    ]);
    expect(
      parseMemoryInteractionInstructions(
        "/rr reject-memory mem_suggestion_123 duplicate",
      ),
    ).toEqual([
      {
        kind: "reject_suggestion",
        suggestionId: "mem_suggestion_123",
        reason: "duplicate",
        rawCommand: "/rr reject-memory mem_suggestion_123 duplicate",
      },
    ]);
    expect(parseMemoryInteractionInstructions("/rr forget mem_123")).toEqual([
      {
        kind: "forget_memory",
        memoryItemId: "mem_123",
        rawCommand: "/rr forget mem_123",
      },
    ]);
    expect(parseMemoryInteractionInstructions("/rr memory pending")).toEqual([
      {
        kind: "list_memory",
        view: "pending",
        rawCommand: "/rr memory pending",
      },
    ]);
  });

  it("rejects unsafe and malformed memory commands deterministically", () => {
    expect(
      parseMemoryInteractionInstructions(
        "/rr remember global Use this everywhere.",
      ),
    ).toEqual([
      {
        kind: "invalid",
        reason: "unsafe_scope_alias",
        rawCommand: "/rr remember global Use this everywhere.",
      },
    ]);
    expect(
      parseMemoryInteractionInstructions("/rr remember workspace"),
    ).toEqual([
      {
        kind: "invalid",
        reason: "empty_memory_body",
        rawCommand: "/rr remember workspace",
      },
    ]);
    expect(
      parseMemoryInteractionInstructions("/rr forget mem_suggestion_123"),
    ).toEqual([
      {
        kind: "invalid",
        reason: "invalid_memory_item_id",
        rawCommand: "/rr forget mem_suggestion_123",
      },
    ]);
  });
});

describe("memory interaction event normalizer", () => {
  it("normalizes pull request issue comments into candidate submission payloads", () => {
    const result = normalizeMemoryInteractionEvent({
      eventName: "issue_comment",
      action: "created",
      repository: {
        githubRepositoryId: "123456",
        sourceVisibility: "private",
      },
      issue: { number: 17, isPullRequest: true },
      comment: {
        id: 98765,
        body: "/rr remember repo Prefer small cohesive pull requests.",
        htmlUrl:
          "https://github.com/777genius/example/pull/17#issuecomment-98765",
        actorLogin: "777genius",
      },
    });

    expect(result).toEqual({
      kind: "processed",
      instructions: [
        expect.objectContaining({
          kind: "candidate",
          candidateBody: "Prefer small cohesive pull requests.",
        }),
      ],
      candidates: [
        expect.objectContaining({
          protocolVersion: 1,
          intent: "explicit_command",
          requestedScope: "repository",
          candidateBody: "Prefer small cohesive pull requests.",
          extractionMethod: "explicit_command",
          extractionVersion: 1,
          source: expect.objectContaining({
            sourceId: "issue_comment:98765",
            githubCommentId: "98765",
            githubPullRequestNumber: 17,
            redactedExcerpt:
              "/rr remember repo Prefer small cohesive pull requests.",
            sourceVisibility: "private",
          }),
        }),
      ],
      commands: [],
    });
    if (result.kind === "processed") {
      expect(result.candidates[0]?.sourceTextHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.candidates[0]?.source.sourceHash).toBe(
        result.candidates[0]?.sourceTextHash,
      );
    }
  });

  it("normalizes management commands into command submission payloads", () => {
    const result = normalizeMemoryInteractionEvent({
      eventName: "pull_request_review_comment",
      action: "created",
      repository: { githubRepositoryId: "123456" },
      pullRequest: { number: 21 },
      comment: {
        id: 55,
        body: [
          "/rr remember mem_suggestion_123",
          "/rr reject-memory mem_suggestion_456 duplicate",
          "/rr disable-memory mem_789",
          "/rr forget mem_987",
        ].join("\n"),
      },
    });

    expect(result).toEqual({
      kind: "processed",
      instructions: [
        expect.objectContaining({ kind: "confirm_suggestion" }),
        expect.objectContaining({ kind: "reject_suggestion" }),
        expect.objectContaining({ kind: "disable_memory" }),
        expect.objectContaining({ kind: "forget_memory" }),
      ],
      candidates: [],
      commands: [
        { kind: "confirm_suggestion", suggestionId: "mem_suggestion_123" },
        {
          kind: "reject_suggestion",
          suggestionId: "mem_suggestion_456",
          reason: "duplicate",
        },
        { kind: "disable_memory", memoryItemId: "mem_789" },
        { kind: "forget_memory", memoryItemId: "mem_987" },
      ],
    });
  });

  it("fails closed for unsupported or unsafe interaction events", () => {
    expect(
      normalizeMemoryInteractionEvent({
        eventName: "issue_comment",
        action: "created",
        repository: { githubRepositoryId: "123456" },
        issue: { number: 9, isPullRequest: false },
        comment: {
          id: "issue-1",
          body: "/rr remember repo Should not persist from issue comments.",
        },
      }),
    ).toEqual({ kind: "ignored", reason: "not_pull_request_comment" });

    expect(
      normalizeMemoryInteractionEvent({
        eventName: "pull_request",
        action: "opened",
        repository: { githubRepositoryId: "123456" },
        comment: { id: "none", body: "/rr remember repo nope" },
      }),
    ).toEqual({ kind: "ignored", reason: "unsupported_event" });

    expect(
      normalizeMemoryInteractionEvent({
        eventName: "pull_request_review_comment",
        action: "deleted",
        repository: { githubRepositoryId: "123456" },
        pullRequest: { number: 17 },
        comment: { id: 12, body: "/rr remember repo deleted command" },
      }),
    ).toEqual({ kind: "ignored", reason: "deleted_comment" });
  });

  it("does not emit action candidate payloads for GitHub user preference commands", () => {
    const result = normalizeMemoryInteractionEvent({
      eventName: "pull_request_review_comment",
      action: "created",
      repository: { githubRepositoryId: "123456" },
      pullRequest: { number: 21 },
      comment: {
        id: 55,
        body: "/rr remember user Answer me in Russian.",
      },
    });

    expect(result).toEqual({
      kind: "processed",
      instructions: [
        expect.objectContaining({
          kind: "candidate",
          requestedScope: "user_prefs",
          candidateBody: "Answer me in Russian.",
        }),
      ],
      candidates: [],
      commands: [],
    });
  });
});
