import type { ActionConflictReviewRuntimeConfig } from "@reviewrouter/features-action-control-plane";
import {
  buildBoundedConflictDiffPacket,
  buildConflictProviderEnvironment,
  buildConflictRuntimeCheckoutPlan,
  buildConflictRuntimePostingManifest,
  buildConflictRuntimeSummaryMarkdown,
  parseConflictRuntimeConfig,
  parseConflictRuntimeModelOutput,
  type ConflictRuntimeDiffPacket,
  type ConflictRuntimeFileDiff,
  type ConflictRuntimeModelOutput,
  type ConflictRuntimePostingManifest,
} from "../domain/conflict-runtime.js";

export type ConflictRuntimeValidationPhase =
  | "before_checkout"
  | "before_posting_session"
  | "before_status";

export interface ConflictRuntimePrStateValidatorPort {
  assertCurrentPrState(input: {
    readonly phase: ConflictRuntimeValidationPhase;
    readonly config: ActionConflictReviewRuntimeConfig;
    readonly manifestHash?: string | undefined;
  }): Promise<void>;
}

export interface ConflictRuntimeCheckoutPort {
  checkoutExactHead(input: {
    readonly mode: "exact_head_sha";
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly persistCredentials: false;
  }): Promise<void>;
}

export interface ConflictRuntimeDiffSourcePort {
  collectDiff(input: {
    readonly config: ActionConflictReviewRuntimeConfig;
  }): Promise<readonly ConflictRuntimeFileDiff[]>;
}

export interface ConflictRuntimeProviderRunnerPort {
  runReview(input: {
    readonly config: ActionConflictReviewRuntimeConfig;
    readonly diffPacket: ConflictRuntimeDiffPacket;
    readonly providerEnv: Readonly<Record<string, string>>;
  }): Promise<unknown>;
}

export interface ConflictRuntimePostingClientPort {
  requestPostingSession(input: {
    readonly manifestHash: string;
  }): Promise<{ readonly postingSessionToken: string }>;

  postSummary(input: {
    readonly postingSessionToken: string;
    readonly summaryMarkdown: string;
  }): Promise<void>;

  postStatus(input: {
    readonly postingSessionToken: string;
    readonly state: "success" | "failure" | "error";
    readonly description?: string | undefined;
  }): Promise<void>;
}

export interface ConflictRuntimeHealthReporterPort {
  report(input: ConflictRuntimeHealthEvent): Promise<void>;
}

export type ConflictRuntimeHealthEvent = {
  readonly phase:
    | "started"
    | "checkout_completed"
    | "diff_completed"
    | "provider_completed"
    | "posting_skipped"
    | "summary_posted"
    | "status_posted"
    | "completed"
    | "failed";
  readonly safeReasonCode?: string | undefined;
  readonly manifestHash?: string | undefined;
  readonly diffManifestHash?: string | undefined;
  readonly fileCount?: number | undefined;
  readonly summaryBytes?: number | undefined;
};

export type ConflictRuntimeRunResult =
  | {
      readonly status: "completed";
      readonly posting: "posted";
      readonly diffPacket: ConflictRuntimeDiffPacket;
      readonly modelOutput: ConflictRuntimeModelOutput;
      readonly postingManifest: ConflictRuntimePostingManifest;
    }
  | {
      readonly status: "completed";
      readonly posting: "disabled";
      readonly diffPacket: ConflictRuntimeDiffPacket;
      readonly modelOutput: ConflictRuntimeModelOutput;
      readonly postingManifest: ConflictRuntimePostingManifest;
    };

export async function runConflictReviewRuntime(
  input: {
    readonly runtimeConfig: unknown;
    readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  },
  ports: {
    readonly prStateValidator: ConflictRuntimePrStateValidatorPort;
    readonly checkout: ConflictRuntimeCheckoutPort;
    readonly diffSource: ConflictRuntimeDiffSourcePort;
    readonly providerRunner: ConflictRuntimeProviderRunnerPort;
    readonly postingClient?: ConflictRuntimePostingClientPort | undefined;
    readonly healthReporter?: ConflictRuntimeHealthReporterPort | undefined;
  },
): Promise<ConflictRuntimeRunResult> {
  const config = parseConflictRuntimeConfig(input.runtimeConfig);
  await safeReport(ports.healthReporter, { phase: "started" });

  try {
    await ports.prStateValidator.assertCurrentPrState({
      phase: "before_checkout",
      config,
    });
    await ports.checkout.checkoutExactHead(
      buildConflictRuntimeCheckoutPlan(config),
    );
    await safeReport(ports.healthReporter, { phase: "checkout_completed" });

    const diffPacket = buildBoundedConflictDiffPacket({
      config,
      files: await ports.diffSource.collectDiff({ config }),
    });
    await safeReport(ports.healthReporter, {
      phase: "diff_completed",
      diffManifestHash: diffPacket.manifestHash,
      fileCount: diffPacket.files.length,
    });

    const providerEnv = buildConflictProviderEnvironment({
      sourceEnv: input.sourceEnv,
    });
    const modelOutput = parseConflictRuntimeModelOutput(
      await ports.providerRunner.runReview({
        config,
        diffPacket,
        providerEnv,
      }),
    );
    const summaryMarkdown = buildConflictRuntimeSummaryMarkdown(modelOutput);
    await safeReport(ports.healthReporter, {
      phase: "provider_completed",
      summaryBytes: Buffer.byteLength(summaryMarkdown, "utf8"),
    });

    const postingManifest = buildConflictRuntimePostingManifest({
      config,
      diffPacket,
      modelOutput,
      summaryMarkdown,
    });

    if (config.posting.mode === "disabled") {
      await safeReport(ports.healthReporter, {
        phase: "posting_skipped",
        safeReasonCode: config.posting.reason,
        manifestHash: postingManifest.manifestHash,
      });
      await safeReport(ports.healthReporter, {
        phase: "completed",
        manifestHash: postingManifest.manifestHash,
      });
      return {
        status: "completed",
        posting: "disabled",
        diffPacket,
        modelOutput,
        postingManifest,
      };
    }

    if (!ports.postingClient) {
      throw new Error("conflict_runtime_posting_client_unavailable");
    }

    await ports.prStateValidator.assertCurrentPrState({
      phase: "before_posting_session",
      config,
      manifestHash: postingManifest.manifestHash,
    });
    const postingSession = await ports.postingClient.requestPostingSession({
      manifestHash: postingManifest.manifestHash,
    });
    await ports.postingClient.postSummary({
      postingSessionToken: postingSession.postingSessionToken,
      summaryMarkdown,
    });
    await safeReport(ports.healthReporter, {
      phase: "summary_posted",
      manifestHash: postingManifest.manifestHash,
    });

    await ports.prStateValidator.assertCurrentPrState({
      phase: "before_status",
      config,
      manifestHash: postingManifest.manifestHash,
    });
    await ports.postingClient.postStatus({
      postingSessionToken: postingSession.postingSessionToken,
      state: "success",
    });
    await safeReport(ports.healthReporter, {
      phase: "status_posted",
      manifestHash: postingManifest.manifestHash,
    });
    await safeReport(ports.healthReporter, {
      phase: "completed",
      manifestHash: postingManifest.manifestHash,
    });
    return {
      status: "completed",
      posting: "posted",
      diffPacket,
      modelOutput,
      postingManifest,
    };
  } catch (error) {
    await safeReport(ports.healthReporter, {
      phase: "failed",
      safeReasonCode: safeRuntimeErrorCode(error),
    });
    throw error;
  }
}

async function safeReport(
  reporter: ConflictRuntimeHealthReporterPort | undefined,
  event: ConflictRuntimeHealthEvent,
): Promise<void> {
  await reporter?.report(event);
}

function safeRuntimeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (
    /secret|token|nonce|api[_-]?key|authorization|bearer|gh[spou]_|sk-[a-z0-9]/i.test(
      message,
    )
  ) {
    return "runtime_error";
  }
  return message.replaceAll(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 120);
}
