import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  allocateVersionedProviderSecretNamespace,
  renderCanonicalCodexRotatingT0WorkflowV4,
} from "../packages/features/codex-oauth-rotating/src/index.js";
import {
  assertHostedMutationAuthority,
  campaignDryRun,
  collectGitHubScheduleEvidence,
  collectRenderReleaseEvidence,
  formatPrepareResult,
  formatStatusResult,
  publishConfirmedCandidate,
  safeOperatorError,
} from "./codex-zero-login-rollover-operator.js";

const oldActionSha = "a".repeat(40);
const releaseSha = "b".repeat(40);
const targetActionSha = "c".repeat(40);
const runHeadSha = "d".repeat(40);
const defaultHeadSha = "e".repeat(40);
const providerInstanceId = "codex-rotating:123456";
const namespace = allocateVersionedProviderSecretNamespace({
  scope: { repositoryId: "123456", providerInstanceId },
  epoch: 4,
  randomBytes: () => new Uint8Array(16).fill(7),
});
const workflow = renderCanonicalCodexRotatingT0WorkflowV4({
  actionRef: `777genius/review-router@${oldActionSha}`,
  apiUrl: "https://api.reviewrouter.site",
  providerInstanceId,
  refreshScheduleCron: "17 3 * * 1",
  activeSecretNamespace: namespace,
});
const provider = {
  repositoryId: "123456",
  providerInstanceId,
  activeNamespaceId: namespace.namespaceId,
  activeNamespaceEpoch: namespace.epoch,
  activeNamespaceName: namespace.name,
};

describe("zero-login rollover operator", () => {
  it("emits the explicit eleven-repository campaign in strict sequence", () => {
    const plan = campaignDryRun();
    expect(plan.mode).toBe("dry_run");
    expect(plan.concurrency).toBe(1);
    expect(plan.repositories).toHaveLength(11);
    expect(plan.repositories.map((item) => item.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(plan.repositories.at(-1)?.repository).toBe(
      "777genius/agent-teams-ai",
    );
  });

  it("double-binds the latest successful scheduled run to current workflow and active namespace", async () => {
    const encoded = Buffer.from(workflow).toString("base64");
    const gh = vi.fn(async (args: readonly string[]) => {
      const endpoint = args[1]!;
      if (endpoint === "repos/owner/repo")
        return JSON.stringify({ id: 123456, default_branch: "main" });
      if (endpoint.includes("/actions/workflows/"))
        return JSON.stringify({
          workflow_runs: [
            {
              id: 99,
              run_attempt: 3,
              event: "schedule",
              status: "completed",
              conclusion: "success",
              path: ".github/workflows/reviewrouter-codex.yml",
              head_branch: "main",
              head_sha: runHeadSha,
              updated_at: "2026-08-30T12:00:00Z",
            },
          ],
        });
      if (endpoint.includes("/git/ref/heads/main"))
        return JSON.stringify({ object: { sha: defaultHeadSha } });
      if (endpoint.includes("/contents/"))
        return JSON.stringify({ encoding: "base64", content: encoded });
      throw new Error(`unexpected:${endpoint}`);
    });
    await expect(
      collectGitHubScheduleEvidence({
        repository: "owner/repo",
        provider,
        expectedRunId: "99",
        expectedRunAttempt: "3",
        gh,
      }),
    ).resolves.toEqual({
      runId: "99",
      runAttempt: "3",
      eventName: "schedule",
      conclusion: "success",
      workflowActionCommitSha: oldActionSha,
      workflowSourceCommitSha: runHeadSha,
      sourceDefaultHeadSha: defaultHeadSha,
      completedAt: "2026-08-30T12:00:00.000Z",
    });
    expect(
      gh.mock.calls.filter(
        ([args]) => args[1]?.includes("/contents/") === true,
      ),
    ).toHaveLength(2);
  });

  it("rejects a schedule when current workflow no longer binds the active namespace", async () => {
    const bad = workflow.replace(
      namespace.namespaceId,
      "sns_11111111111111111111111111111111",
    );
    let contentCall = 0;
    const gh = vi.fn(async (args: readonly string[]) => {
      const endpoint = args[1]!;
      if (endpoint === "repos/owner/repo")
        return JSON.stringify({ id: 123456, default_branch: "main" });
      if (endpoint.includes("/actions/workflows/"))
        return JSON.stringify({
          workflow_runs: [
            {
              id: 99,
              run_attempt: 3,
              event: "schedule",
              status: "completed",
              conclusion: "success",
              path: ".github/workflows/reviewrouter-codex.yml",
              head_branch: "main",
              head_sha: runHeadSha,
              updated_at: "2026-08-30T12:00:00Z",
            },
          ],
        });
      if (endpoint.includes("/git/ref/heads/main"))
        return JSON.stringify({ object: { sha: defaultHeadSha } });
      if (endpoint.includes("/contents/"))
        return JSON.stringify({
          encoding: "base64",
          content: Buffer.from(contentCall++ === 0 ? workflow : bad).toString(
            "base64",
          ),
        });
      throw new Error("unexpected");
    });
    await expect(
      collectGitHubScheduleEvidence({
        repository: "owner/repo",
        provider,
        expectedRunId: "99",
        expectedRunAttempt: "3",
        gh,
      }),
    ).rejects.toThrow("zero_login_rollover_workflow_namespace_mismatch");
  });

  it("requires exact live release and staged B on every Render service", async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("/deploys?"))
        return response([
          {
            deploy: {
              id: `dep-${value.split("/services/")[1]!.split("/")[0]}`,
              status: "live",
              commit: { id: releaseSha },
              updatedAt: "2026-08-30T13:00:00Z",
            },
          },
        ]);
      if (value.endsWith("ACTION_REF"))
        return response({ value: `777genius/review-router@${oldActionSha}` });
      if (value.endsWith("ALLOWED_ACTION_REFS"))
        return response({
          value: `777genius/review-router@${oldActionSha},777genius/review-router@${targetActionSha}`,
        });
      if (value.endsWith("ENABLE_CODEX_FORK_REVIEW_V5"))
        return response({ value: "1" });
      if (value.endsWith("CODEX_FORK_REVIEW_V5_REPOSITORIES"))
        return response({ value: "owner/repo" });
      if (value.endsWith("RUNTIME_ROLLOUT_ID"))
        return response({ value: "rollout-1" });
      if (value.endsWith("RUNTIME_DEPLOYMENT_PROVENANCE"))
        return response({ value: releaseSha });
      if (value.endsWith("/internal/release-canary")) {
        const body = JSON.parse(String(init?.body));
        return response({
          ...body,
          commitSha: releaseSha,
          databaseSystemIdentifier: "987654",
          recoveryWitnessSha256: "f".repeat(64),
          writeReadRoundTrip: true,
          runtimeWitnessProofs: body.serviceFacts.map((fact: any) => ({
            ...fact,
            releaseCommitSha: releaseSha,
          })),
        });
      }
      throw new Error("unexpected render call");
    }) as never;
    const evidence = await collectRenderReleaseEvidence({
      repositoryFullName: "owner/repo",
      sourceActionCommitSha: oldActionSha,
      actionCommitSha: targetActionSha,
      releaseCommitSha: releaseSha,
      apiKey: "not-logged-token",
      services: (["web", "api", "worker"] as const).map((service) => ({
        service,
        serviceId: `srv-${service}`,
      })),
      runtime: runtimeAttestation(),
      fetch,
    });
    expect(evidence.services).toHaveLength(3);
    expect(
      evidence.services.every((item) =>
        item.observedAllowedActionRefs.includes(
          `777genius/review-router@${targetActionSha}`,
        ),
      ),
    ).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("not-logged-token");
  });

  it("rejects a pending deploy race after the runtime attestation", async () => {
    let deployRead = 0;
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.includes("/deploys?")) {
        deployRead += 1;
        const roleRead = Math.ceil(deployRead / 3);
        return response([
          {
            deploy: {
              id: roleRead === 1 ? "dep-live" : "dep-pending",
              status: roleRead === 1 ? "live" : "build_in_progress",
              commit: { id: releaseSha },
              updatedAt: "2026-08-30T13:00:00Z",
            },
          },
        ]);
      }
      if (value.endsWith("ACTION_REF"))
        return response({ value: `777genius/review-router@${oldActionSha}` });
      if (value.endsWith("ALLOWED_ACTION_REFS"))
        return response({
          value: `777genius/review-router@${oldActionSha},777genius/review-router@${targetActionSha}`,
        });
      if (value.endsWith("ENABLE_CODEX_FORK_REVIEW_V5"))
        return response({ value: "1" });
      if (value.endsWith("CODEX_FORK_REVIEW_V5_REPOSITORIES"))
        return response({ value: "owner/repo" });
      if (value.endsWith("RUNTIME_ROLLOUT_ID"))
        return response({ value: "rollout-1" });
      if (value.endsWith("RUNTIME_DEPLOYMENT_PROVENANCE"))
        return response({ value: releaseSha });
      if (value.endsWith("/internal/release-canary")) {
        const body = JSON.parse(String(init?.body));
        return response({
          ...body,
          commitSha: releaseSha,
          databaseSystemIdentifier: "987654",
          recoveryWitnessSha256: "f".repeat(64),
          writeReadRoundTrip: true,
          runtimeWitnessProofs: body.serviceFacts,
        });
      }
      throw new Error("unexpected");
    }) as never;
    await expect(
      collectRenderReleaseEvidence({
        repositoryFullName: "owner/repo",
        sourceActionCommitSha: oldActionSha,
        actionCommitSha: targetActionSha,
        releaseCommitSha: releaseSha,
        apiKey: "token",
        services: (["web", "api", "worker"] as const).map((service) => ({
          service,
          serviceId: `srv-${service}`,
        })),
        runtime: runtimeAttestation(),
        fetch,
      }),
    ).rejects.toThrow("changed_during_attestation");
  });

  it("keeps mutations behind kill switch, protected main, exact SHA, and confirmation", () => {
    const env = {
      REVIEW_ROUTER_ENABLE_CODEX_ZERO_LOGIN_ROLLOVER: "1",
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: releaseSha,
      REVIEW_ROUTER_ZERO_LOGIN_PROTECTED_MAIN_VERIFIED: "1",
    };
    expect(() =>
      assertHostedMutationAuthority({
        releaseCommitSha: releaseSha,
        confirmation: "PREPARE ZERO LOGIN ROLLOVER op-1",
        expectedConfirmation: "PREPARE ZERO LOGIN ROLLOVER op-1",
        env,
      }),
    ).not.toThrow();
    expect(() =>
      assertHostedMutationAuthority({
        releaseCommitSha: releaseSha,
        confirmation: "wrong",
        expectedConfirmation: "PREPARE ZERO LOGIN ROLLOVER op-1",
        env,
      }),
    ).toThrow("zero_login_rollover_confirmation_required");
  });

  it("keeps deterministic recovery available after the prepare kill switch is closed", () => {
    const env = {
      REVIEW_ROUTER_ENABLE_CODEX_ZERO_LOGIN_ROLLOVER: "0",
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: releaseSha,
      REVIEW_ROUTER_ZERO_LOGIN_PROTECTED_MAIN_VERIFIED: "1",
    };
    expect(() =>
      assertHostedMutationAuthority({
        releaseCommitSha: releaseSha,
        confirmation: "ABORT ZERO LOGIN ROLLOVER op-1",
        expectedConfirmation: "ABORT ZERO LOGIN ROLLOVER op-1",
        env,
        requirePrepareEnabled: false,
      }),
    ).not.toThrow();
  });

  it("never emits provider, GitHub, or database error details", () => {
    expect(
      safeOperatorError(
        new Error(
          "connection postgresql://user:secret@db.internal failed token=ghp_secret",
        ),
      ),
    ).toBe("zero_login_rollover_operator_failed");
    expect(
      safeOperatorError(
        new Error("zero_login_rollover_render_read_failed:401 bearer-secret"),
      ),
    ).toBe("zero_login_rollover_render_read_failed");
  });

  it("fails closed for reuse candidate until core publishes the exact setup PR", () => {
    expect(
      formatPrepareResult({
        operationId: "op-1",
        repositoryFullName: "owner/repo",
        state: "provider_confirmed",
        candidateNamespaceEpoch: 5n,
      } as never),
    ).toMatchObject({
      disposition: "reuse_candidate",
      next: "requires_hosted_publication",
      terminal: false,
      state: "provider_confirmed",
    });
  });

  it("renders durable status with exact source, candidate, and nullable PR identity", () => {
    expect(
      formatStatusResult({
        operationId: "op-1",
        repositoryFullName: "owner/repo",
        providerInstanceId,
        state: "prepared",
        candidateNamespaceId: namespace.namespaceId,
        candidateNamespaceEpoch: 5n,
        sourceRunId: "99",
        sourceRunAttempt: "3",
        expectedRerunAttempt: "4",
        sourceWorkflowCommitSha: runHeadSha,
        sourceDefaultHeadSha: defaultHeadSha,
        sourceActionRef: `777genius/review-router@${oldActionSha}`,
        targetActionRef: `777genius/review-router@${targetActionSha}`,
        targetWorkflowSchemaVersion: 5,
      } as never),
    ).toMatchObject({
      operationId: "op-1",
      candidateNamespaceEpoch: "5",
      source: { defaultHeadSha, workflowCommitSha: runHeadSha },
      setupPullRequest: {
        url: null,
        number: null,
        headSha: null,
        baseBranch: null,
      },
    });
  });

  it("recovers a confirmed candidate through the core publisher and confirms setup_pr_open", async () => {
    const confirmed = { operationId: "op-1", state: "provider_confirmed" };
    const opened = { ...confirmed, state: "setup_pr_open" };
    const status = vi
      .fn()
      .mockResolvedValueOnce(confirmed)
      .mockResolvedValueOnce(opened);
    const loadSetupPullRequestPlan = vi.fn(async () => ({
      intentId: "intent-1",
    }));
    const markSetupPullRequest = vi.fn(async () => ({ generation: 1 }));
    const createOrUpdateExactSetupPullRequest = vi.fn(async () => ({
      url: "https://github.com/owner/repo/pull/7",
      number: 7,
      headSha: targetActionSha,
      baseBranch: "main",
    }));
    await expect(
      publishConfirmedCandidate({
        operationId: "op-1",
        ledger: {
          status,
          loadSetupPullRequestPlan,
          markSetupPullRequest,
        } as never,
        setupPullRequests: { createOrUpdateExactSetupPullRequest },
      }),
    ).resolves.toEqual(opened);
    expect(createOrUpdateExactSetupPullRequest).toHaveBeenCalledOnce();
    expect(markSetupPullRequest).toHaveBeenCalledWith({
      intentId: "intent-1",
      url: "https://github.com/owner/repo/pull/7",
      number: 7,
      headSha: targetActionSha,
      baseBranch: "main",
    });
  });
});

describe("zero-login hosted workflow contract", () => {
  const source = readFileSync(
    new URL(
      "../.github/workflows/codex-zero-login-rollover.yml",
      import.meta.url,
    ),
    "utf8",
  );

  it("runs only from protected exact main and never uploads evidence or passes secrets as argv", () => {
    expect(source).toContain('test "${GITHUB_REF}" = "refs/heads/main"');
    expect(source).toContain('/branches/main" --jq .protected');
    expect(source).toContain(
      'test "${{ inputs.release_commit_sha }}" = "${GITHUB_SHA}"',
    );
    expect(source).not.toContain("upload-artifact");
    expect(source).not.toMatch(
      /--(?:token|database-url|api-key|recovery-witness)/u,
    );
    expect(source).toContain(
      "GITHUB_APP_PRIVATE_KEY: ${{ secrets.GITHUB_APP_PRIVATE_KEY }}",
    );
    expect(source).toContain("publish) args+=(--operation-id");
    expect(source).toContain("cancel-in-progress: false");
  });
});

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function runtimeAttestation() {
  return {
    origin: "https://api.reviewrouter.site",
    token: "canary-token-not-logged",
    systemIdentifier: "987654",
    recoveryWitnessSha256: "f".repeat(64),
  };
}
