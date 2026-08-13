import { describe, expect, it, vi } from "vitest";
import {
  assertMonotonic,
  assertRerunAttempt,
  createInstallationGitHub,
  parseProgressComment,
  parseSourceIdentity,
  readCanaryConfig,
  triggerHostedProgressCanary,
  verifyHostedProgressCanary,
} from "./run-hosted-live-progress-canary.mjs";

const repo = "777genius/review-router-saas-e2e";
const repoId = 1228051727;
const head = "a".repeat(40);
const producer = "b".repeat(40);
const workflowBlob = "c".repeat(40);

describe("hosted live-progress canary", () => {
  it("pins immutable repository, PR 37, 108 files, branch and fixture profile", async () => {
    const github = fakeGitHub();
    const config = configFixture();
    await triggerHostedProgressCanary(
      { ...config, pullRequest: 627 },
      github,
      () => "2026-08-13T10:00:00Z",
    ).catch((error) =>
      expect(error.message).toBe("hosted_progress_canary_target_not_pinned"),
    );
    expect(github.rerunWorkflow).not.toHaveBeenCalled();
  });

  it("refuses to run without explicit confirmation", () => {
    expect(() =>
      readCanaryConfig(env({ REVIEW_ROUTER_RUN_HOSTED_PROGRESS_CANARY: "0" })),
    ).toThrow("hosted_progress_canary_confirmation_required");
  });

  it("reruns only an exact v2 producer source and emits a bound receipt", async () => {
    const github = fakeGitHub();
    const receipt = await triggerHostedProgressCanary(
      configFixture(),
      github,
      () => "2026-08-13T10:00:00Z",
    );
    expect(github.rerunWorkflow).toHaveBeenCalledWith(repo, 123);
    expect(receipt).toMatchObject({
      headSha: head,
      sourceRunAttempt: 1,
      producerSha: producer,
      sourceWorkflowBlobSha: workflowBlob,
      baselineCommentId: null,
      baselineCommentUpdatedAt: null,
    });
  });

  it("rejects an old source run not referencing the pinned producer", async () => {
    const github = fakeGitHub();
    github.getWorkflowRun.mockResolvedValueOnce({
      ...sourceRun(),
      referenced_workflows: [referencedProducer("d".repeat(40))],
    });
    await expect(
      triggerHostedProgressCanary(
        configFixture(),
        github,
        () => "2026-08-13T10:00:00Z",
      ),
    ).rejects.toThrow("hosted_progress_canary_source_run_contract_mismatch");
    expect(github.rerunWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a failed source run and a run detached from the current PR head", async () => {
    const failed = fakeGitHub();
    failed.getWorkflowRun.mockResolvedValue({
      ...sourceRun(),
      conclusion: "failure",
    });
    await expect(
      triggerHostedProgressCanary(
        configFixture(),
        failed,
        () => "2026-08-13T10:00:00Z",
      ),
    ).rejects.toThrow("hosted_progress_canary_source_run_contract_mismatch");
    const detached = fakeGitHub();
    detached.getWorkflowRun.mockResolvedValue({
      ...sourceRun(),
      head_sha: "d".repeat(40),
    });
    await expect(
      triggerHostedProgressCanary(
        configFixture(),
        detached,
        () => "2026-08-13T10:00:00Z",
      ),
    ).rejects.toThrow("hosted_progress_canary_source_run_contract_mismatch");
  });

  it("rejects a source workflow response without immutable blob bytes", async () => {
    const github = fakeGitHub();
    github.getFile.mockResolvedValue({ sha: "d".repeat(40) });
    await expect(
      triggerHostedProgressCanary(
        configFixture(),
        github,
        () => "2026-08-13T10:00:00Z",
      ),
    ).rejects.toThrow("hosted_progress_canary_source_workflow_invalid");
    expect(github.rerunWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a workflow without exactly one immutable canonical producer pin", async () => {
    const github = fakeGitHub();
    github.getFile.mockResolvedValue(workflowFile("uses: attacker/repo@main"));
    await expect(
      triggerHostedProgressCanary(
        configFixture(),
        github,
        () => "2026-08-13T10:00:00Z",
      ),
    ).rejects.toThrow("hosted_progress_canary_producer_pin_invalid");
  });

  it("fails closed until the exact v1.0.108 release is immutable", async () => {
    const github = fakeGitHub();
    github.getReleaseByTag.mockResolvedValue({
      id: 108,
      tag_name: "v1.0.108",
      draft: false,
      prerelease: false,
      immutable: false,
      published_at: "2026-08-13T10:00:00Z",
    });
    await expect(
      triggerHostedProgressCanary(
        configFixture(),
        github,
        () => "2026-08-13T10:00:00Z",
      ),
    ).rejects.toThrow("hosted_progress_canary_release_not_immutable");
    expect(github.rerunWorkflow).not.toHaveBeenCalled();
  });

  it("peels an annotated release tag to the exact producer commit", async () => {
    const github = fakeGitHub();
    github.getGitRef.mockResolvedValue({
      object: { type: "tag", sha: "d".repeat(40) },
    });
    github.getGitTag.mockResolvedValue({
      object: { type: "commit", sha: producer },
    });
    await expect(
      triggerHostedProgressCanary(
        configFixture(),
        github,
        () => "2026-08-13T10:00:00Z",
      ),
    ).resolves.toMatchObject({ release: releaseAuthority() });
  });

  it("rejects fixture paths that no longer match the pinned large profile", async () => {
    const github = fakeGitHub();
    github.getPullFiles.mockResolvedValue(
      Array.from({ length: 108 }, (_, index) => ({
        filename: `docs/file-${index}.md`,
      })),
    );
    await expect(
      triggerHostedProgressCanary(
        configFixture(),
        github,
        () => "2026-08-13T10:00:00Z",
      ),
    ).rejects.toThrow("hosted_progress_canary_fixture_profile_mismatch");
  });

  it("binds the exact next attempt to source run, head, workflow and producer", () => {
    expect(() =>
      assertRerunAttempt(rerunAttempt(), receipt(), effectiveConfig()),
    ).not.toThrow();
    expect(() =>
      assertRerunAttempt(
        {
          ...rerunAttempt(),
          referenced_workflows: [
            { ...referencedProducer(), ref: "refs/tags/moving-label" },
          ],
        },
        receipt(),
        effectiveConfig(),
      ),
    ).not.toThrow();
    expect(() =>
      assertRerunAttempt(
        { ...rerunAttempt(), head_sha: "d".repeat(40) },
        receipt(),
        effectiveConfig(),
      ),
    ).toThrow("hosted_progress_canary_rerun_attempt_contract_mismatch");
    expect(() =>
      assertRerunAttempt(
        { ...rerunAttempt(), run_attempt: 3 },
        receipt(),
        configFixture(),
      ),
    ).toThrow("hosted_progress_canary_rerun_attempt_contract_mismatch");
  });

  it("requires every observed update to carry the exact rerun source", () => {
    const config = configFixture();
    const exact = progress("Reviewing", 1, 72, 1, 108, 1);
    expect(
      parseProgressComment(comment(41, exact), config, {
        sourceRunId: "123",
        sourceRunAttempt: "2",
      }).sourceIdentity,
    ).toEqual({ sourceRunId: "123", sourceRunAttempt: "2" });
    expect(() =>
      parseProgressComment(
        comment(41, exact.replace("run-attempt=2", "run-attempt=3")),
        config,
        { sourceRunId: "123", sourceRunAttempt: "2" },
      ),
    ).toThrow("hosted_progress_canary_comment_source_mismatch");
    expect(() =>
      parseProgressComment(
        comment(
          41,
          exact.replace(
            /<!-- review-router-live-progress-source[^\n]+-->\n/u,
            "",
          ),
        ),
        config,
        { sourceRunId: "123", sourceRunAttempt: "2" },
      ),
    ).toThrow("hosted_progress_canary_comment_source_mismatch");
    expect(() =>
      parseSourceIdentity(
        exact.replace("run-id=123", "run-id=123 --><script>"),
      ),
    ).toThrow("hosted_progress_canary_comment_source_invalid");
  });

  it("proves one bot/app comment ID, dynamic updates and exact terminal coverage", async () => {
    const github = fakeGitHub();
    const comments = [
      [comment(41, progress("Reviewing", 12, 72, 18, 108, 1))],
      [comment(41, progress("Reviewing", 42, 72, 63, 108, 2))],
      [comment(41, progress("Complete", 72, 72, 108, 108, 3))],
    ];
    let index = 0;
    github.getWorkflowRunAttempt.mockImplementation(async () => ({
      ...rerunAttempt(),
      status: index >= 2 ? "completed" : "in_progress",
      conclusion: index >= 2 ? "success" : null,
    }));
    github.listComments.mockImplementation(
      async () => comments[Math.min(index++, 2)],
    );
    const result = await verifyHostedProgressCanary(
      configFixture(),
      receipt(),
      { github, now: tickingClock(), sleep: async () => undefined },
    );
    expect(result).toMatchObject({
      commentId: 41,
      progressUpdates: 3,
      terminal: "Complete",
    });
  });

  it("rejects foreign bot or App identity", async () => {
    const github = readyVerifierGitHub();
    const foreign = comment(41, progress("Reviewing", 1, 2, 54, 108, 1));
    foreign.performed_via_github_app.slug = "foreign-app";
    github.listComments.mockResolvedValue([foreign]);
    await expect(
      verifyHostedProgressCanary(configFixture(), receipt(), {
        github,
        now: tickingClock(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("hosted_progress_canary_comment_identity_invalid");
  });

  it("rejects a replacement progress comment ID", async () => {
    const github = readyVerifierGitHub();
    github.listComments
      .mockResolvedValueOnce([
        comment(41, progress("Reviewing", 1, 2, 54, 108, 1)),
      ])
      .mockResolvedValue([
        comment(42, progress("Complete", 2, 2, 108, 108, 2)),
      ]);
    await expect(
      verifyHostedProgressCanary(configFixture(), receipt(), {
        github,
        now: tickingClock(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("hosted_progress_canary_comment_id_changed");
  });

  it("ignores caller attempts to override the immutable unit profile", () => {
    const config = readCanaryConfig(
      env({
        REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_REVIEW_UNITS: "2",
        REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_REVIEWED_FILES: "1",
      }),
    );
    expect(config).toMatchObject({
      expectedReviewUnits: 72,
      expectedReviewedFiles: 108,
      expectedExcludedFiles: 0,
    });
  });

  it("refreshes a repository-scoped installation token before expiry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(tokenResponse("token-1")))
      .mockResolvedValueOnce(jsonResponse({ id: repoId }))
      .mockResolvedValueOnce(jsonResponse(tokenResponse("token-2", 120)))
      .mockResolvedValueOnce(jsonResponse({ id: repoId }))
      .mockResolvedValueOnce(jsonResponse({ app_slug: "review-router" }));
    const github = createInstallationGitHub({
      appId: "1",
      privateKey: "unused-by-test-jwt",
      installationId: 10,
      fetchImpl,
      createJwt: () => "signed-test-jwt",
    });
    await github.authenticate();
    await github.getRepository(repo);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 51 * 60 * 1000);
    await github.getRepository(repo);
    await github.getInstallation(10);
    clock.mockRestore();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls[2]?.[1]?.body).toContain(
      `"repository_ids":[${repoId}]`,
    );
    expect(fetchImpl.mock.calls[4]?.[1]?.headers.Authorization).toBe(
      "Bearer signed-test-jwt",
    );
  });

  it("rejects monotonicity and incomplete final coverage false passes", () => {
    expect(() =>
      assertMonotonic(observation(42, 63, 2), observation(41, 62, 3)),
    ).toThrow("hosted_progress_canary_progress_not_monotonic");
  });
});

function env(overrides: Record<string, string> = {}) {
  return {
    REVIEW_ROUTER_RUN_HOSTED_PROGRESS_CANARY: "1",
    REVIEW_ROUTER_HOSTED_CANARY_INSTALLATION_ID: "10",
    REVIEW_ROUTER_HOSTED_CANARY_SOURCE_RUN_ID: "123",
    REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_BOT_LOGIN: "review-router[bot]",
    REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_APP_SLUG: "review-router",
    REVIEW_ROUTER_HOSTED_CANARY_POLL_INTERVAL_MS: "1",
    REVIEW_ROUTER_HOSTED_CANARY_TIMEOUT_MS: "1000",
    ...overrides,
  };
}
function configFixture() {
  return readCanaryConfig(env());
}
function effectiveConfig() {
  return {
    ...configFixture(),
    producerSha: producer,
    producerWorkflowPath: `777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@${producer}`,
    sourceWorkflowBlobSha: workflowBlob,
    release: releaseAuthority(),
  };
}
function receipt() {
  return {
    schemaVersion: 1,
    repositoryId: repoId,
    repositoryNodeId: "R_kgDOSTKVDw",
    pullRequest: 37,
    headSha: head,
    sourceRunId: 123,
    sourceRunAttempt: 1,
    producerSha: producer,
    sourceWorkflowBlobSha: workflowBlob,
    release: releaseAuthority(),
    baselineCommentId: null,
    baselineCommentUpdatedAt: null,
    triggeredAt: "2026-08-13T10:00:00Z",
  };
}
function fakeGitHub() {
  return {
    getRepository: vi.fn(async () => ({
      id: repoId,
      node_id: "R_kgDOSTKVDw",
      full_name: repo,
    })),
    getInstallation: vi.fn(async () => ({ app_slug: "review-router" })),
    getPullRequest: vi.fn(async () => ({
      number: 37,
      state: "open",
      changed_files: 108,
      head: {
        sha: head,
        ref: "test/context-gateway-v103-batches-20260811",
        repo: { id: repoId },
      },
    })),
    getPullFiles: vi.fn(async () => fixtureFiles()),
    getWorkflowRun: vi.fn(async () => sourceRun()),
    getWorkflowRunAttempt: vi.fn(async () => null),
    getFile: vi.fn(async () => workflowFile()),
    getReleaseByTag: vi.fn(async () => ({
      id: 108,
      tag_name: "v1.0.108",
      draft: false,
      prerelease: false,
      immutable: true,
      published_at: "2026-08-13T10:00:00Z",
    })),
    getGitRef: vi.fn(async () => ({
      object: { type: "commit", sha: producer },
    })),
    getGitTag: vi.fn(async () => {
      throw new Error("unexpected annotated tag peel");
    }),
    rerunWorkflow: vi.fn(async () => undefined),
    listComments: vi.fn(async () => []),
  };
}
function readyVerifierGitHub() {
  const github = fakeGitHub();
  github.getWorkflowRunAttempt.mockResolvedValue({
    ...rerunAttempt(),
    status: "in_progress",
  });
  return github;
}
function sourceRun() {
  return {
    id: 123,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: head,
    path: ".github/workflows/reviewrouter-codex.yml",
    pull_requests: [{ number: 37 }],
    referenced_workflows: [referencedProducer()],
    run_attempt: 1,
  };
}
function rerunAttempt() {
  return {
    id: 123,
    run_attempt: 2,
    event: "pull_request",
    head_sha: head,
    path: ".github/workflows/reviewrouter-codex.yml",
    referenced_workflows: [referencedProducer()],
    status: "queued",
    conclusion: null,
  };
}
function comment(id: number, body: string) {
  const second = body.match(/Last update: .*:0(\d) UTC/u)?.[1] ?? "0";
  return {
    id,
    body,
    updated_at: `2026-08-13T10:00:0${second}Z`,
    user: { login: "review-router[bot]" },
    performed_via_github_app: { slug: "review-router" },
  };
}
function progress(
  phase: string,
  completed: number,
  total: number,
  covered: number,
  files: number,
  second: number,
) {
  return `<!-- review-router-live-progress -->\n<!-- review-router-live-progress-source run-id=123 run-attempt=2 -->\n**Phase:** ${phase}\nReview units: ${completed} of ${total} complete (50%)\nFiles in completed units: ${covered} of ${files}\nFiles not assigned: 0\nFiles unavailable or excluded: 0\nUnits not completed after retries: 0\nLast update: 2026-08-13 10:00:0${second} UTC`;
}
function observation(
  completedUnits: number,
  coveredFiles: number,
  second: number,
) {
  return {
    commentId: 41,
    updatedAt: `2026-08-13T10:00:0${second}Z`,
    phase: "Reviewing",
    completedUnits,
    totalUnits: 72,
    coveredFiles,
    totalFiles: 108,
    sourceIdentity: { sourceRunId: "123", sourceRunAttempt: "2" },
  };
}
function tickingClock() {
  let tick = 0;
  return () => 1000 + tick++ * 10;
}

function referencedProducer(sha = producer) {
  return {
    path: `777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@${producer}`,
    sha,
    ref: "refs/heads/main",
  };
}

function workflowFile(
  source = `jobs:\n  review:\n    uses: 777genius/review-router/.github/workflows/reviewrouter-t0-reusable.yml@${producer}\n`,
) {
  return {
    sha: workflowBlob,
    type: "file",
    encoding: "base64",
    content: Buffer.from(source).toString("base64"),
  };
}
function releaseAuthority() {
  return {
    tag: "v1.0.108",
    releaseId: 108,
    publishedAt: "2026-08-13T10:00:00.000Z",
    immutable: true,
    commit: producer,
  };
}

function fixtureFiles() {
  return [
    ".github/workflows/reviewrouter-codex.yml",
    ".github/workflows/reviewrouter-interaction.yml",
    ...Array.from({ length: 106 }, (_, index) => {
      const number = index + 1;
      const batch = Math.ceil(number / 22);
      return `src/batch-${String(batch).padStart(2, "0")}/review-entity-${String(number).padStart(3, "0")}.ts`;
    }),
  ].map((filename) => ({ filename }));
}

function tokenResponse(token: string, minutes = 60) {
  return {
    token,
    expires_at: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
    repositories: [{ id: repoId }],
    permissions: {
      actions: "write",
      contents: "read",
      issues: "read",
      pull_requests: "read",
    },
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
