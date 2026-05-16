import { describe, expect, it } from "vitest";
import {
  runConflictReviewRuntime,
  type ConflictRuntimeHealthEvent,
  type ConflictRuntimePrStateValidatorPort,
} from "../application/conflict-runtime-runner.js";
import type { ConflictRuntimeFileDiff } from "../domain/conflict-runtime.js";

const runtimeConfig = {
  protocolVersion: 1,
  reviewKind: "conflict-head",
  dispatchId: "cr_123e4567-e89b-12d3-a456-426614174000",
  pullRequestNumber: 7,
  headSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  checkout: {
    mode: "exact_head_sha",
    headSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "b".repeat(40),
    persistCredentials: false,
  },
  diff: {
    mode: "expected_base_to_head",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    maxFiles: 10,
    maxBytes: 20_000,
    maxPatchBytesPerFile: 10_000,
  },
  posting: {
    mode: "proxy",
    sessionEndpoint: "/api/action/v1/conflict-posting/session",
    summaryEndpoint: "/api/action/v1/conflict-posting/summary",
    statusEndpoint: "/api/action/v1/conflict-posting/status",
    allowedOperations: ["summary_comment", "advisory_status"],
    summaryMaxBytes: 60_000,
    statusContext: "ReviewRouter conflict review",
  },
} as const;

describe("conflict runtime runner", () => {
  it("runs conflict review phases in the fail-closed posting order", async () => {
    const calls: string[] = [];
    const providerInputs: Array<{
      readonly providerEnv: Readonly<Record<string, string>>;
      readonly diffManifestHash: string;
    }> = [];
    const postingRequests: Array<{ readonly manifestHash: string }> = [];
    const healthEvents: ConflictRuntimeHealthEvent[] = [];

    const result = await runConflictReviewRuntime(
      {
        runtimeConfig,
        sourceEnv: {
          CODEX_MODEL: "gpt-5.5",
          OPENAI_API_KEY: "sk-provider",
          GITHUB_TOKEN: "ghs_must_not_leak",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc_must_not_leak",
          REVIEW_ROUTER_POSTING_TOKEN: "posting_must_not_leak",
        },
      },
      {
        prStateValidator: {
          async assertCurrentPrState(input) {
            calls.push(`validate:${input.phase}`);
          },
        },
        checkout: {
          async checkoutExactHead(input) {
            calls.push(`checkout:${input.headSha}`);
            expect(input.persistCredentials).toBe(false);
          },
        },
        diffSource: {
          async collectDiff() {
            calls.push("diff");
            return [
              {
                path: "src/review.ts",
                status: "modified",
                patch: "@@ -1 +1 @@\n-safe\n+safer\n",
              },
            ] satisfies ConflictRuntimeFileDiff[];
          },
        },
        providerRunner: {
          async runReview(input) {
            calls.push("provider");
            providerInputs.push({
              providerEnv: input.providerEnv,
              diffManifestHash: input.diffPacket.manifestHash,
            });
            return {
              protocolVersion: 1,
              summaryMarkdown: "Conflict-head review found one issue.",
              findings: [
                {
                  severity: "major",
                  title: "Keep stale-head guard",
                  body: "Posting must stay bound to the expected head SHA.",
                  path: "src/review.ts",
                  startLine: 1,
                },
              ],
            };
          },
        },
        postingClient: {
          async requestPostingSession(input) {
            calls.push(`posting-session:${input.manifestHash}`);
            postingRequests.push(input);
            return { postingSessionToken: "scoped-posting-token" };
          },
          async postSummary(input) {
            calls.push("summary");
            expect(input.postingSessionToken).toBe("scoped-posting-token");
            expect(input.summaryMarkdown).toContain(
              "Conflict-head review found one issue.",
            );
          },
          async postStatus(input) {
            calls.push(`status:${input.state}`);
            expect(input.postingSessionToken).toBe("scoped-posting-token");
          },
        },
        healthReporter: {
          async report(event) {
            healthEvents.push(event);
          },
        },
      },
    );

    expect(result.status).toBe("completed");
    expect(result.posting).toBe("posted");
    expect(postingRequests).toEqual([
      { manifestHash: result.postingManifest.manifestHash },
    ]);
    expect(providerInputs[0]?.providerEnv).toEqual({
      CODEX_MODEL: "gpt-5.5",
      OPENAI_API_KEY: "sk-provider",
    });
    expect(providerInputs[0]?.diffManifestHash).toBe(
      result.diffPacket.manifestHash,
    );
    expect(calls).toEqual([
      "validate:before_checkout",
      `checkout:${"a".repeat(40)}`,
      "diff",
      "provider",
      "validate:before_posting_session",
      `posting-session:${result.postingManifest.manifestHash}`,
      "summary",
      "validate:before_status",
      "status:success",
    ]);
    expect(healthEvents.map((event) => event.phase)).toEqual([
      "started",
      "checkout_completed",
      "diff_completed",
      "provider_completed",
      "summary_posted",
      "status_posted",
      "completed",
    ]);
  });

  it("stops before checkout when pre-checkout PR validation fails", async () => {
    const calls: string[] = [];
    const staleValidator: ConflictRuntimePrStateValidatorPort = {
      async assertCurrentPrState(input) {
        calls.push(`validate:${input.phase}`);
        throw new Error("conflict_runtime_stale_head");
      },
    };

    await expect(
      runConflictReviewRuntime(
        { runtimeConfig, sourceEnv: {} },
        {
          prStateValidator: staleValidator,
          checkout: {
            async checkoutExactHead() {
              calls.push("checkout");
            },
          },
          diffSource: {
            async collectDiff() {
              calls.push("diff");
              return [];
            },
          },
          providerRunner: {
            async runReview() {
              calls.push("provider");
              return {
                protocolVersion: 1,
                summaryMarkdown: "Should not run.",
              };
            },
          },
        },
      ),
    ).rejects.toThrow("conflict_runtime_stale_head");

    expect(calls).toEqual(["validate:before_checkout"]);
  });

  it("redacts secret-like provider failures from health events", async () => {
    const healthEvents: ConflictRuntimeHealthEvent[] = [];

    await expect(
      runConflictReviewRuntime(
        {
          runtimeConfig,
          sourceEnv: {
            CODEX_MODEL: "gpt-5.5",
            OPENAI_API_KEY: "sk-provider",
          },
        },
        {
          prStateValidator: {
            async assertCurrentPrState() {},
          },
          checkout: {
            async checkoutExactHead() {},
          },
          diffSource: {
            async collectDiff() {
              return [
                {
                  path: "src/review.ts",
                  status: "modified",
                  patch: "safe",
                },
              ] satisfies ConflictRuntimeFileDiff[];
            },
          },
          providerRunner: {
            async runReview() {
              throw new Error(
                "provider failed with OPENAI_API_KEY=sk-secret123456789",
              );
            },
          },
          healthReporter: {
            async report(event) {
              healthEvents.push(event);
            },
          },
        },
      ),
    ).rejects.toThrow("provider failed");

    expect(healthEvents.at(-1)).toEqual({
      phase: "failed",
      safeReasonCode: "runtime_error",
    });
    expect(JSON.stringify(healthEvents)).not.toContain("sk-secret");
  });

  it("redacts nonce-like runtime failures from health events", async () => {
    const healthEvents: ConflictRuntimeHealthEvent[] = [];

    await expect(
      runConflictReviewRuntime(
        { runtimeConfig, sourceEnv: {} },
        {
          prStateValidator: {
            async assertCurrentPrState() {
              throw new Error("conflict failed nonce=raw-dispatch-nonce");
            },
          },
          checkout: {
            async checkoutExactHead() {
              throw new Error("checkout_should_not_run");
            },
          },
          diffSource: {
            async collectDiff() {
              return [];
            },
          },
          providerRunner: {
            async runReview() {
              return {
                protocolVersion: 1,
                summaryMarkdown: "Should not run.",
              };
            },
          },
          healthReporter: {
            async report(event) {
              healthEvents.push(event);
            },
          },
        },
      ),
    ).rejects.toThrow("nonce=raw-dispatch-nonce");

    expect(healthEvents.at(-1)).toEqual({
      phase: "failed",
      safeReasonCode: "runtime_error",
    });
    expect(JSON.stringify(healthEvents)).not.toContain("raw-dispatch-nonce");
  });

  it("supports dry-run runtime config without a posting client", async () => {
    const result = await runConflictReviewRuntime(
      {
        runtimeConfig: {
          ...runtimeConfig,
          posting: {
            mode: "disabled",
            reason: "posting_proxy_not_enabled",
          },
        },
        sourceEnv: {},
      },
      {
        prStateValidator: {
          async assertCurrentPrState() {},
        },
        checkout: {
          async checkoutExactHead() {},
        },
        diffSource: {
          async collectDiff() {
            return [
              {
                path: "src/review.ts",
                status: "modified",
                patch: "safe",
              },
            ] satisfies ConflictRuntimeFileDiff[];
          },
        },
        providerRunner: {
          async runReview() {
            return {
              protocolVersion: 1,
              summaryMarkdown: "Dry-run conflict review.",
            };
          },
        },
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      posting: "disabled",
    });
  });
});
