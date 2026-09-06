import { describe, expect, it, vi } from "vitest";
import type {
  WorkflowSetupGatewayInput,
  WorkflowSetupGatewayPort,
} from "@reviewrouter/features-workflow-provisioning";
import {
  AppFirstWorkflowSetupGateway,
  isRecoverableAppSetupWriteFailure,
} from "./workflow-setup-gateway-fallback";

class CapturingGateway implements WorkflowSetupGatewayPort {
  public readonly calls: WorkflowSetupGatewayInput[] = [];

  constructor(private readonly failure: Error | null = null) {}

  async createOrUpdateSetupPullRequest(input: WorkflowSetupGatewayInput) {
    this.calls.push(input);
    if (this.failure) {
      throw this.failure;
    }
    return {
      url: "https://github.com/777genius/example/pull/1",
      number: 1,
      branch: input.setupBranch,
      headSha: "b".repeat(40),
    };
  }
}

const input = {
  owner: "777genius",
  repo: "example",
  baseBranch: "main",
  setupBranch: "reviewrouter/setup",
  workflowFiles: [
    {
      path: ".github/workflows/reviewrouter.yml",
      content: "name: ReviewRouter\n",
    },
  ],
} satisfies WorkflowSetupGatewayInput;

describe("AppFirstWorkflowSetupGateway", () => {
  it("uses the app gateway without creating the user fallback when app writes work", async () => {
    const primary = new CapturingGateway();
    const fallbackFactory = vi.fn(async () => new CapturingGateway());
    const gateway = new AppFirstWorkflowSetupGateway({
      primary,
      fallback: fallbackFactory,
    });

    await expect(
      gateway.createOrUpdateSetupPullRequest(input),
    ).resolves.toEqual({
      url: "https://github.com/777genius/example/pull/1",
      number: 1,
      branch: "reviewrouter/setup",
      headSha: "b".repeat(40),
    });

    expect(primary.calls).toHaveLength(1);
    expect(fallbackFactory).not.toHaveBeenCalled();
  });

  it("falls back to the user gateway when the app cannot write the setup branch", async () => {
    const appError = githubError(403, "Resource not accessible by integration");
    const primary = new CapturingGateway(appError);
    const fallback = new CapturingGateway();
    const onFallback = vi.fn();
    const gateway = new AppFirstWorkflowSetupGateway({
      primary,
      fallback: vi.fn(async () => fallback),
      onFallback,
    });

    await expect(
      gateway.createOrUpdateSetupPullRequest(input),
    ).resolves.toMatchObject({
      branch: "reviewrouter/setup",
    });

    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
    expect(onFallback).toHaveBeenCalledWith({
      reason: "github_app_write_forbidden",
      error: appError,
    });
  });

  it("does not fall back for non-permission GitHub failures", async () => {
    const primary = new CapturingGateway(githubError(500, "Server Error"));
    const fallbackFactory = vi.fn(async () => new CapturingGateway());
    const gateway = new AppFirstWorkflowSetupGateway({
      primary,
      fallback: fallbackFactory,
    });

    await expect(gateway.createOrUpdateSetupPullRequest(input)).rejects.toThrow(
      "Server Error",
    );

    expect(fallbackFactory).not.toHaveBeenCalled();
  });

  it("does not treat rate limits as recoverable app write failures", () => {
    expect(
      isRecoverableAppSetupWriteFailure(
        githubError(403, "API rate limit exceeded"),
      ),
    ).toBe(false);
  });
});

function githubError(
  status: number,
  message: string,
): Error & {
  readonly status: number;
} {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
