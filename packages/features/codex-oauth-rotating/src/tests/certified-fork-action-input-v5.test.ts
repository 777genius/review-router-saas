import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readActionInputs,
  runCodexRotatingGitHubAction,
} from "../action/github-action";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    INPUT_MODE: "fork_prompt_only_v2",
    "INPUT_API-URL": "https://api.reviewrouter.site",
    "INPUT_PROVIDER-INSTANCE-ID": "codex-rotating:123456",
    "INPUT_WORKFLOW-SCHEMA-VERSION": "5",
    "INPUT_SOURCE-REPOSITORY": "contributor/repository",
    "INPUT_SOURCE-REPOSITORY-ID": "654321",
    "INPUT_BASE-REPOSITORY": "base/repository",
    "INPUT_BASE-REPOSITORY-ID": "123456",
    "INPUT_PULL-REQUEST-NUMBER": "42",
    "INPUT_REVIEW-HEAD-SHA": "b".repeat(40),
    "INPUT_BASE-SHA": "c".repeat(40),
    "INPUT_TRUST-DOMAIN": "fork",
    ...overrides,
  };
}

function forkEvent(): Record<string, unknown> {
  return {
    number: 42,
    repository: { id: 123456, full_name: "base/repository" },
    pull_request: {
      draft: false,
      head: {
        sha: "b".repeat(40),
        repo: {
          id: 654321,
          full_name: "contributor/repository",
          private: false,
        },
      },
      base: { sha: "c".repeat(40) },
    },
  };
}

describe("certified fork V5 action inputs", () => {
  it("parses the complete immutable fork tuple", () => {
    expect(readActionInputs(env()).forkReviewBinding).toEqual({
      sourceRepository: "contributor/repository",
      sourceRepositoryId: "654321",
      baseRepository: "base/repository",
      baseRepositoryId: "123456",
      pullRequestNumber: 42,
      reviewHeadSha: "b".repeat(40),
      baseSha: "c".repeat(40),
      trustDomain: "fork",
    });
  });

  it.each([
    ["missing source", { "INPUT_SOURCE-REPOSITORY": "" }],
    ["malformed source", { "INPUT_SOURCE-REPOSITORY": "attacker" }],
    ["invalid source id", { "INPUT_SOURCE-REPOSITORY-ID": "0" }],
    ["stale-shaped head", { "INPUT_REVIEW-HEAD-SHA": "not-a-sha" }],
    ["wrong trust domain", { "INPUT_TRUST-DOMAIN": "trusted" }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => readActionInputs(env(overrides))).toThrow();
  });

  it("does not reinterpret the legacy fork action contract as V5", () => {
    const legacy = env({ "INPUT_WORKFLOW-SCHEMA-VERSION": "4" });
    for (const key of Object.keys(legacy)) {
      if (
        key.startsWith("INPUT_SOURCE-") ||
        key.startsWith("INPUT_BASE-") ||
        key === "INPUT_PULL-REQUEST-NUMBER" ||
        key === "INPUT_REVIEW-HEAD-SHA" ||
        key === "INPUT_TRUST-DOMAIN"
      ) {
        delete legacy[key];
      }
    }
    expect(readActionInputs(legacy).forkReviewBinding).toBeUndefined();
  });

  it("validates the event and passes no workspace or auth to an injected executor", async () => {
    const root = await mkdtemp(join(tmpdir(), "rr-fork-v5-input-"));
    const eventPath = join(root, "event.json");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(eventPath, JSON.stringify(forkEvent()));
    const runtimeEnv = env({
      "INPUT_AUTH-JSON": "must-never-be-read",
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "base/repository",
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: root,
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://vstoken.actions.githubusercontent.com/oidc/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
    });
    try {
      const execute = vi.fn(async (input) => {
        expect(input).toEqual({
          apiUrl: "https://api.reviewrouter.site",
          providerInstanceId: "codex-rotating:123456",
          workflowSchemaVersion: 5,
          binding: {
            sourceRepository: "contributor/repository",
            sourceRepositoryId: "654321",
            baseRepository: "base/repository",
            baseRepositoryId: "123456",
            pullRequestNumber: 42,
            reviewHeadSha: "b".repeat(40),
            baseSha: "c".repeat(40),
            trustDomain: "fork",
          },
        });
        expect(runtimeEnv).not.toHaveProperty("INPUT_AUTH-JSON");
        expect(runtimeEnv).not.toHaveProperty("GITHUB_WORKSPACE");
      });
      await expect(
        runCodexRotatingGitHubAction({
          env: runtimeEnv,
          forkPromptOnlyV2Executor: { execute },
        }),
      ).resolves.toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(existsSync(eventPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked, out-of-temp, and nonempty fork material", async () => {
    const root = await mkdtemp(join(tmpdir(), "rr-fork-v5-material-"));
    const runnerTemp = join(root, "runner-temp");
    const workspace = join(root, "workspace");
    await mkdir(runnerTemp);
    await mkdir(workspace);
    const actionRuntime = (eventPath: string, overrides = {}) => ({
      env: env({
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "base/repository",
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://vstoken.actions.githubusercontent.com/oidc/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
        ...overrides,
      }),
      forkPromptOnlyV2Executor: { execute: vi.fn() },
    });
    try {
      const target = join(runnerTemp, "target.json");
      const link = join(runnerTemp, "event-link.json");
      await writeFile(target, JSON.stringify(forkEvent()));
      await symlink(target, link);
      await expect(
        runCodexRotatingGitHubAction(actionRuntime(link)),
      ).rejects.toThrow("certified_fork_event_file_invalid");

      const outside = join(root, "outside.json");
      await writeFile(outside, JSON.stringify(forkEvent()));
      await expect(
        runCodexRotatingGitHubAction(actionRuntime(outside)),
      ).rejects.toThrow("certified_fork_event_path_outside_runner_temp");

      const eventPath = join(runnerTemp, "event.json");
      await writeFile(eventPath, JSON.stringify(forkEvent()));
      await writeFile(join(workspace, "attacker-checkout.txt"), "fork bytes");
      await expect(
        runCodexRotatingGitHubAction(actionRuntime(eventPath)),
      ).rejects.toThrow("certified_fork_workspace_not_empty");
      expect(existsSync(eventPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("securely consumes a workflow_dispatch exact binding event", async () => {
    const root = await mkdtemp(join(tmpdir(), "rr-fork-v5-dispatch-"));
    const eventPath = join(root, "event.json");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(
      eventPath,
      JSON.stringify({
        repository: { id: 123456, full_name: "base/repository" },
        inputs: {
          source_repository: "contributor/repository",
          source_repository_id: "654321",
          pull_request_number: "42",
          review_head_sha: "b".repeat(40),
          base_sha: "c".repeat(40),
        },
      }),
    );
    const execute = vi.fn(async () => undefined);
    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: env({
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "base/repository",
            GITHUB_WORKSPACE: workspace,
            RUNNER_TEMP: root,
            ACTIONS_ID_TOKEN_REQUEST_URL:
              "https://vstoken.actions.githubusercontent.com/oidc/token",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
          }),
          forkPromptOnlyV2Executor: { execute },
        }),
      ).resolves.toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(existsSync(eventPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "source input",
      {
        repository: { id: 123456, full_name: "base/repository" },
        inputs: {
          source_repository: "attacker/repository",
          source_repository_id: "654321",
          pull_request_number: "42",
          review_head_sha: "b".repeat(40),
          base_sha: "c".repeat(40),
        },
      },
    ],
    [
      "trusted base repository id",
      {
        repository: { id: 999999, full_name: "base/repository" },
        inputs: {
          source_repository: "contributor/repository",
          source_repository_id: "654321",
          pull_request_number: "42",
          review_head_sha: "b".repeat(40),
          base_sha: "c".repeat(40),
        },
      },
    ],
  ])("rejects tampered workflow_dispatch %s", async (_name, event) => {
    const root = await mkdtemp(join(tmpdir(), "rr-fork-v5-dispatch-bad-"));
    const eventPath = join(root, "event.json");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(eventPath, JSON.stringify(event));
    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: env({
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "base/repository",
            GITHUB_WORKSPACE: workspace,
            RUNNER_TEMP: root,
          }),
          forkPromptOnlyV2Executor: { execute: vi.fn() },
        }),
      ).rejects.toThrow("fork_review_binding_event_mismatch");
      expect(existsSync(eventPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts workflow_dispatch only when the base repository context is exact", async () => {
    const root = await mkdtemp(join(tmpdir(), "rr-fork-v5-backfill-"));
    const eventPath = join(root, "event.json");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(
      eventPath,
      JSON.stringify({
        repository: { id: 123456, full_name: "base/repository" },
        inputs: {
          source_repository: "contributor/repository",
          source_repository_id: "654321",
          pull_request_number: "42",
          review_head_sha: "b".repeat(40),
          base_sha: "c".repeat(40),
        },
      }),
    );
    const runtimeEnv = env({
      "INPUT_AUTH-JSON": "must-never-be-read",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "base/repository",
      GITHUB_REPOSITORY_ID: "123456",
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: root,
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://vstoken.actions.githubusercontent.com/oidc/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
    });
    try {
      const execute = vi.fn(async (input) => {
        expect(input.binding.sourceRepository).toBe("contributor/repository");
      });
      await expect(
        runCodexRotatingGitHubAction({
          env: runtimeEnv,
          forkPromptOnlyV2Executor: { execute },
        }),
      ).resolves.toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(runtimeEnv).not.toHaveProperty("INPUT_AUTH-JSON");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["another event", { GITHUB_EVENT_NAME: "repository_dispatch" }],
    ["missing base id", { GITHUB_REPOSITORY_ID: "" }],
    ["spoofed base name", { GITHUB_REPOSITORY: "attacker/repository" }],
    ["spoofed base id", { GITHUB_REPOSITORY_ID: "999999" }],
  ])("rejects workflow dispatch with %s", async (_name, overrides) => {
    const root = await mkdtemp(join(tmpdir(), "rr-fork-v5-backfill-reject-"));
    const eventPath = join(root, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        repository: { id: 123456, full_name: "base/repository" },
      }),
    );
    try {
      await expect(
        runCodexRotatingGitHubAction({
          env: env({
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "base/repository",
            GITHUB_REPOSITORY_ID: "123456",
            ...overrides,
          }),
          forkPromptOnlyV2Executor: { execute: vi.fn() },
        }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
