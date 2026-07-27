import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import http from "node:http";
import {
  createSubscriptionRuntime,
  DefaultRedactor,
  DeterministicIdGenerator,
  NullObservability,
  SystemClock,
  type AgentDriver,
  type IdGeneratorPort,
  type LeaseStorePort,
  type ProviderSessionDriver,
  type RuntimePolicy,
  type SessionArtifact,
  type SessionEnvelope,
  type SessionStoreCapabilities,
  type SessionStorePort,
  type SessionWriteResult,
  type WorkspaceHandle,
  type WorkspacePort,
} from "@777genius/subscription-runtime/core";
import {
  CodexJsonAgentDriver,
  CodexCliSessionDriver,
  sessionArtifactFromCodexAuthJson,
} from "@777genius/subscription-runtime/provider-codex";
import { GitHubActionRunner } from "@777genius/subscription-runtime/runner-github-action";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  chmod,
  mkdir,
  access,
  lstat,
  realpath,
  stat,
  statfs,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  codexRotatingRefreshRuntimeMode,
  codexRotatingRuntimeAuthMode,
  compactCodexAuthJson,
  computeCodexAuthGenerationHash,
  encryptCodexRotatingAuthForGitHubSecret,
  classifyCodexRuntimeFailure,
  pruneCodexRotatingChildEnv,
  validateCodexAuthJsonBytes,
} from "../domain/codex-oauth-rotating";
import { decidePullRequestReviewAdmission } from "../domain/pull-request-review-admission";
import {
  createReviewExecutionBudget,
  createReviewExecutionDeadlineEpochMs,
  defaultReviewJobTimeoutMinutes,
  remainingReviewExecutionBudgetMs,
} from "../domain/review-execution-budget";
import {
  isStalePullRequestHeadError,
  stalePullRequestHeadErrorCode,
  startPullRequestHeadSupervisor,
  type PullRequestHeadSupervisor,
} from "./pull-request-head-supervisor";

declare const __dirname: string | undefined;

const defaultOidcAudience = "reviewrouter";
const forkAgenticSandboxActionMode = "fork-agentic-sandbox";
const defaultChatGptCodexResponsesUrl =
  "https://chatgpt.com/backend-api/codex/responses";
const bundledCodexPlatform = "linux-x64";
const bundledCodexVersion = "0.135.0";
const bundledCodexPackageName = ["@openai", "codex"].join("/");
const bundledCodexArchiveName = "codex-linux-x64.tgz";
const bundledCodexBinaryPathInArchive =
  "package/vendor/x86_64-unknown-linux-musl/bin/codex";
const maxCommentBytes = 60_000;
const maxCapturedProcessOutputBytes = 256_000;
const maxProxyRequestBodyBytes = 2_000_000;
const maxProxyRequestsPerReview = 16;
const codexProxyForwardHeaderNames = new Set([
  "chatgpt-account-id",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "originator",
  "session-id",
  "thread-id",
  "user-agent",
  "x-client-request-id",
  "x-oai-attestation",
  "x-openai-internal-codex-responses-lite",
  "x-responsesapi-include-timing-metrics",
]);
const minimumRunnerFreeDiskBytes = 4 * 1024 * 1024 * 1024;
const supportedRunnerOs = "Linux";
const supportedRunnerArch = "X64";
const supportedRunnerImageOs = "ubuntu24";
const minimumNodeMajor = 20;
const controlPlaneRequestTimeoutMs = 30_000;
const oidcRequestTimeoutMs = 20_000;
const githubRequestTimeoutMs = 30_000;
const networkRetryMaxAttempts = 3;
const networkRetryBaseDelayMs = 750;
const fullRuntimeProgressCommentMarker =
  "<!-- review-router-progress-tracker -->";
const providerNeutralReviewFindingsArtifactFileName =
  "reviewrouter-findings.json";
const reviewThreadLifecycleResolveTokenEnvKey =
  "REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN";
const reviewSnapshotInputFileName = "incremental-snapshot-input.json";
const reviewSnapshotOutputFileName = "incremental-snapshot-output.json";
const reviewCheckpointFinalizationFileName =
  "review-checkpoint-finalization.json";
const maxReviewSnapshotCandidateBytes = 512 * 1024 + 16 * 1024;
const processTerminationGracePeriodMs = 5_000;

type FetchLike = typeof fetch;

type ActionIO = {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
};

type ActionRuntime = {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly fetchImpl: FetchLike;
  readonly io: ActionIO;
  readonly localProviderProxyFactory: LocalProviderProxyFactory;
  readonly fullReviewRuntimeRunner: FullReviewRuntimeRunner;
  readonly now: () => number;
};

type ActionInputs = {
  readonly mode: string;
  readonly apiUrl: string;
  readonly providerInstanceId: string;
  readonly workflowSchemaVersion: number;
  readonly reviewDrafts: boolean;
  readonly maxChangedLines: number;
  readonly reviewTimeoutMinutes: number;
  readonly providerSecrets: ProviderSecretInputs;
};

type ProviderSecretInputs = {
  readonly claudeCodeOAuthToken?: string;
  readonly openRouterApiKey?: string;
};

type PullRequestEvent = {
  readonly number: number;
  readonly repositoryId?: string | undefined;
  readonly repository: string;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly changedLines?: number | undefined;
};

type PreleaseResponse = {
  readonly leaseId: string;
  readonly generationHashSalt: string;
};

type FinalizeResponse =
  | {
      readonly status: "finalized";
      readonly nextGeneration: number;
      readonly repositoryOwner: string;
      readonly repositoryName: string;
      readonly publicKeyReadToken: string;
      readonly runtimeConfigVersion: number;
      readonly runtimeEnv: Record<string, string>;
    }
  | {
      readonly status: "stale_queued_secret";
      readonly nextGeneration: number;
    };

type GitHubPublicKeyResponse = {
  readonly key: string;
  readonly key_id: string;
};

type CheckoutTokenResponse = {
  readonly token: string;
  readonly repository: string;
};

type WritebackResponse = {
  readonly protocolVersion: 1;
  readonly status:
    | "accepted"
    | "idempotent_replay"
    | "github_put_failed"
    | "writeback_idempotency_conflict";
};

type CommentTokenResponse = {
  readonly token: string;
  readonly repository: string;
  readonly expiresAt?: string | undefined;
};

const reviewSnapshotRestoreResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    status: z.enum(["found", "missing", "expired", "base_changed"]),
    expectedVersion: z.number().int().nonnegative(),
    snapshot: z
      .object({
        version: z.number().int().positive(),
        schemaVersion: z.literal(1),
        reviewedHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
        baseSha: z.string().regex(/^[a-f0-9]{40}$/i),
        compatibilityKey: z.string().regex(/^[a-f0-9]{64}$/i),
        payload: z.unknown(),
        reviewedAt: z.string().datetime(),
        expiresAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "found") {
      if (!value.snapshot) {
        context.addIssue({
          code: "custom",
          message: "snapshot is required when status is found",
          path: ["snapshot"],
        });
      } else if (value.expectedVersion !== value.snapshot.version) {
        context.addIssue({
          code: "custom",
          message: "snapshot version must match expected version",
          path: ["expectedVersion"],
        });
      }
    } else if (value.snapshot) {
      context.addIssue({
        code: "custom",
        message: "snapshot is not allowed when status is not found",
        path: ["snapshot"],
      });
    }
  });

const reviewSnapshotFindingCandidateSchema = z
  .object({
    file: z.string().min(1).max(4_096),
    startLine: z.number().int().positive().optional(),
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    severity: z.enum(["critical", "major", "minor"]),
    title: z.string().min(1).max(1_000),
    message: z.string().min(1).max(20_000),
    provider: z.string().min(1).max(500).optional(),
    providers: z.array(z.string().min(1).max(500)).max(50).optional(),
    actualModel: z.string().min(1).max(500).optional(),
    providerVoteKeys: z.array(z.string().min(1).max(500)).max(50).optional(),
    providerPoolSize: z.number().int().positive().optional(),
    confidence: z.number().min(0).max(1).optional(),
    category: z.string().min(1).max(500).optional(),
    hasConsensus: z.boolean().optional(),
  })
  .strict();

const reviewSnapshotCandidateSchema = z
  .object({
    protocolVersion: z.literal(1),
    expectedVersion: z.number().int().nonnegative(),
    pullRequestNumber: z.number().int().positive(),
    schemaVersion: z.literal(1),
    reviewedHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/i),
    compatibilityKey: z.string().regex(/^[a-f0-9]{64}$/i),
    payload: z
      .object({
        reviewSummary: z.string().min(1).max(100_000),
        findings: z.array(reviewSnapshotFindingCandidateSchema).max(500),
      })
      .strict(),
  })
  .strict();

const reviewSnapshotCommitResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.enum(["committed", "idempotent"]),
      version: z.number().int().positive(),
      reviewedHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("conflict"),
      currentVersion: z.number().int().nonnegative(),
      currentHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
    })
    .strict(),
]);

const reviewCheckpointFinalizationMarkerSchema = z
  .object({
    protocolVersion: z.literal(1),
    pullRequestNumber: z.number().int().positive(),
    headSha: z.string().regex(/^[a-f0-9]{40}$/i),
    planHash: z.string().regex(/^[a-f0-9]{64}$/i),
    expectedVersion: z.number().int().positive(),
    snapshotAdvancementRequired: z.boolean().optional(),
  })
  .strict();

export enum FinalizedReviewCheckpointMarkerReadStatus {
  Missing = "missing",
  Valid = "valid",
  Invalid = "invalid",
}

type FinalizedReviewCheckpointMarkerReadResult =
  | {
      readonly status: FinalizedReviewCheckpointMarkerReadStatus.Missing;
    }
  | {
      readonly status: FinalizedReviewCheckpointMarkerReadStatus.Invalid;
    }
  | {
      readonly status: FinalizedReviewCheckpointMarkerReadStatus.Valid;
      readonly marker: z.infer<typeof reviewCheckpointFinalizationMarkerSchema>;
    };

const reviewCheckpointClearResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.enum(["cleared", "missing"]),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("conflict"),
      currentVersion: z.number().int().nonnegative(),
    })
    .strict(),
]);

type ReviewSnapshotRestoreResponse = z.infer<
  typeof reviewSnapshotRestoreResponseSchema
>;

type GitHubIssueCommentResponse = {
  readonly id: number;
  readonly body?: string | null;
};

type LocalProviderProxy = {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
};

type LocalProviderProxyFactory = (input: {
  readonly fetchImpl: FetchLike;
  readonly accessToken: string;
  readonly upstreamResponsesUrl: string;
}) => Promise<LocalProviderProxy>;

type FullReviewRuntimeRunner = (input: {
  readonly inputs: ActionInputs;
  readonly leaseId: string;
  readonly codexBinaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly io: ActionIO;
  readonly fetchImpl: FetchLike;
  readonly workspace: string;
  readonly tempHome: string;
  readonly tempCodexHome: string;
  readonly event: PullRequestEvent;
  readonly commentToken: string;
  readonly commentTokenExpiresAt?: string | undefined;
  readonly runtimeConfigVersion: number;
  readonly runtimeEnv: Record<string, string>;
  readonly reviewSnapshotInputPath?: string | undefined;
  readonly reviewSnapshotOutputPath?: string | undefined;
  readonly reviewCheckpointFinalizationPath?: string | undefined;
  readonly executionDeadlineEpochMs: number;
  readonly onCommentTokenUpdated?: ((token: string) => void) | undefined;
}) => Promise<void>;

type CodexBinaryManifest = {
  readonly protocolVersion: 1;
  readonly packageName: string;
  readonly version: string;
  readonly platform: string;
  readonly archive: string;
  readonly archiveSize: number;
  readonly archiveSha256: string;
  readonly binaryPathInArchive: string;
  readonly binary: string;
  readonly size: number;
  readonly sha256: string;
};

type RunnerEnvironmentCheckOptions = {
  readonly minimumFreeDiskBytes?: number;
  readonly nodeVersion?: string;
};

export async function runCodexRotatingGitHubAction(
  runtime: Partial<ActionRuntime> = {},
): Promise<void> {
  const now = runtime.now ?? Date.now;
  const executionStartedAtEpochMs = now();
  const env = runtime.env ?? process.env;
  const io = runtime.io ?? { stdout: process.stdout, stderr: process.stderr };
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const fullReviewRuntimeRunner =
    runtime.fullReviewRuntimeRunner ?? runFullReviewRouterRuntime;
  const inputs = readActionInputs(env);
  maskProviderSecretInputs(io, inputs.providerSecrets);
  clearActionProviderSecretEnv(env);

  if (inputs.mode === forkAgenticSandboxActionMode) {
    const executionDeadlineEpochMs = createReviewExecutionDeadlineEpochMs({
      jobTimeoutMinutes: inputs.reviewTimeoutMinutes,
      executionStartedAtEpochMs,
    });
    await runForkAgenticSandboxGitHubAction({
      inputs,
      env,
      io,
      fetchImpl,
      fullReviewRuntimeRunner,
      executionDeadlineEpochMs,
      now,
    });
    return;
  }

  if (inputs.mode === codexRotatingRefreshRuntimeMode) {
    await runCodexRefreshOnlyGitHubAction({
      inputs,
      env,
      io,
      fetchImpl,
    });
    return;
  }

  if (inputs.mode !== codexRotatingRuntimeAuthMode) {
    throw new Error(`unsupported_reviewrouter_action_mode:${inputs.mode}`);
  }
  const executionDeadlineEpochMs = createReviewExecutionDeadlineEpochMs({
    jobTimeoutMinutes: inputs.reviewTimeoutMinutes,
    executionStartedAtEpochMs,
  });

  const event = await readPullRequestEvent(env, inputs.reviewDrafts);
  assertSameRepositoryPullRequest(event, env);
  const admission = decidePullRequestReviewAdmission({
    changedLines: event.changedLines ?? null,
    maxChangedLines: inputs.maxChangedLines,
  });
  if (admission.status === "skipped") {
    clearActionAuthEnv(env);
    clearOidcRequestEnv(env);
    notice(io, formatReviewAdmissionSkipNotice(event.number, admission));
    return;
  }
  const prelease = await requestCodexRotatingPreleaseWithFreshOidc({
    env,
    io,
    fetchImpl,
    apiUrl: inputs.apiUrl,
    providerInstanceId: inputs.providerInstanceId,
    workflowSchemaVersion: inputs.workflowSchemaVersion,
  });

  await assertSupportedRunnerEnvironment(env);
  const codexBinaryPath = await resolveCodexBinary(env);
  const authJson = readActionAuthJson(env);
  mask(io, authJson);
  clearActionAuthEnv(env);
  validateCodexAuthJsonBytes({ authJsonBytes: authJson });
  const restoredGenerationHash = computeCodexAuthGenerationHash({
    authJsonBytes: authJson,
    generationHashSalt: prelease.generationHashSalt,
  });

  const finalize = await postJson<FinalizeResponse>({
    fetchImpl,
    label: "api_finalize",
    url: `${inputs.apiUrl}/api/action/v1/codex-oauth/finalize`,
    body: {
      leaseId: prelease.leaseId,
      providerInstanceId: inputs.providerInstanceId,
      restoredGenerationHash,
    },
  });

  if (finalize.status === "stale_queued_secret") {
    clearActionAuthEnv(env);
    notice(io, "ReviewRouter skipped a stale queued Codex OAuth secret.");
    return;
  }

  mask(io, finalize.publicKeyReadToken);
  const publicKey = await fetchGitHubRepositoryPublicKey({
    fetchImpl,
    owner: finalize.repositoryOwner,
    repo: finalize.repositoryName,
    token: finalize.publicKeyReadToken,
  });

  await postJson({
    fetchImpl,
    label: "api_writeback_preflight",
    url: `${inputs.apiUrl}/api/action/v1/codex-oauth/writeback-preflight`,
    body: {
      leaseId: prelease.leaseId,
      providerInstanceId: inputs.providerInstanceId,
      githubKeyId: publicKey.key_id,
    },
  });

  try {
    const workspace = await makeTempDirectory("reviewrouter-workspace-");
    try {
      const tempHome = await makeTempDirectory("reviewrouter-home-");
      const tempCodexHome = await makeGitHubWorkspaceCodexHomeDirectory(env);
      try {
        await refreshAndWritebackCodexAuthJson({
          authJson,
          inputs,
          fetchImpl,
          prelease,
          finalize,
          publicKey,
          codexBinaryPath,
          env,
          tempHome,
          tempCodexHome,
        });

        const checkout = await postJson<CheckoutTokenResponse>({
          fetchImpl,
          label: "api_checkout_token",
          url: `${inputs.apiUrl}/api/action/v1/codex-oauth/checkout-token`,
          body: {
            leaseId: prelease.leaseId,
            providerInstanceId: inputs.providerInstanceId,
          },
        });
        mask(io, checkout.token);

        const restoredReviewSnapshot = await tryRestoreReviewSnapshot({
          fetchImpl,
          inputs,
          leaseId: prelease.leaseId,
          event,
          io,
        });

        const previousHeadFetched = await safeCheckoutPullRequest({
          env,
          workspace,
          event,
          checkoutToken: checkout.token,
          previousReviewedHeadSha:
            restoredReviewSnapshot?.status === "found"
              ? restoredReviewSnapshot.snapshot?.reviewedHeadSha
              : undefined,
        });
        if (!previousHeadFetched) {
          notice(
            io,
            "ReviewRouter could not fetch the previous reviewed commit; the runtime will safely review the full PR diff.",
          );
        }
        const reviewSnapshotForRuntime =
          !previousHeadFetched && restoredReviewSnapshot?.status === "found"
            ? {
                protocolVersion: 1 as const,
                status: "missing" as const,
                expectedVersion: restoredReviewSnapshot.expectedVersion,
              }
            : (restoredReviewSnapshot ?? {
                protocolVersion: 1 as const,
                status: "missing" as const,
                expectedVersion: 0,
              });

        const commentToken = await postJson<CommentTokenResponse>({
          fetchImpl,
          label: "api_comment_token",
          url: `${inputs.apiUrl}/api/action/v1/codex-oauth/comment-token`,
          body: {
            leaseId: prelease.leaseId,
            providerInstanceId: inputs.providerInstanceId,
            authCleared: true,
          },
        });
        mask(io, commentToken.token);
        let cleanupCommentToken = commentToken.token;
        await deleteStaleCodexRotatingSummaryComments({
          fetchImpl,
          token: commentToken.token,
          owner: event.owner,
          repo: event.repo,
          issueNumber: event.number,
        });

        const reviewHome = await makeTempDirectory("reviewrouter-review-home-");
        try {
          const reviewSnapshotInputPath = join(
            reviewHome,
            reviewSnapshotInputFileName,
          );
          const reviewSnapshotOutputPath = join(
            reviewHome,
            reviewSnapshotOutputFileName,
          );
          const reviewCheckpointFinalizationPath = join(
            reviewHome,
            reviewCheckpointFinalizationFileName,
          );
          await writeFile(
            reviewSnapshotInputPath,
            JSON.stringify(reviewSnapshotForRuntime),
            { encoding: "utf8", mode: 0o600 },
          );
          let reviewRuntimeFailure: unknown;
          try {
            await runReviewRuntimeWithinExecutionBudget({
              executionDeadlineEpochMs,
              now,
              run: () =>
                fullReviewRuntimeRunner({
                  inputs,
                  leaseId: prelease.leaseId,
                  codexBinaryPath,
                  env,
                  io,
                  fetchImpl,
                  workspace,
                  tempHome: reviewHome,
                  tempCodexHome,
                  event,
                  commentToken: commentToken.token,
                  commentTokenExpiresAt: commentToken.expiresAt,
                  runtimeConfigVersion: finalize.runtimeConfigVersion,
                  runtimeEnv: finalize.runtimeEnv,
                  reviewSnapshotInputPath,
                  reviewSnapshotOutputPath,
                  reviewCheckpointFinalizationPath,
                  executionDeadlineEpochMs,
                  onCommentTokenUpdated: (token) => {
                    cleanupCommentToken = token;
                  },
                }),
            });
          } catch (error) {
            reviewRuntimeFailure = error;
          }
          const finalizedCheckpointMarkerRead =
            await tryReadFinalizedReviewCheckpointMarker({
              markerPath: reviewCheckpointFinalizationPath,
              event,
              io,
            });
          await settleFinalizedReviewCheckpoint({
            markerRead: finalizedCheckpointMarkerRead,
            runtimeCompleted: didReviewRuntimeComplete(reviewRuntimeFailure),
            commitSnapshot: () =>
              tryCommitReviewSnapshot({
                fetchImpl,
                inputs,
                leaseId: prelease.leaseId,
                event,
                candidatePath: reviewSnapshotOutputPath,
                io,
              }),
            clearCheckpoint: (marker) =>
              tryClearFinalizedReviewCheckpoint({
                fetchImpl,
                inputs,
                leaseId: prelease.leaseId,
                marker,
                io,
              }),
          });
          try {
            await deleteFullRuntimeProgressCommentsWithTokenRefresh({
              fetchImpl,
              token: cleanupCommentToken,
              owner: event.owner,
              repo: event.repo,
              issueNumber: event.number,
              refreshToken: () =>
                refreshCleanupCommentToken({
                  fetchImpl,
                  inputs,
                  leaseId: prelease.leaseId,
                  event,
                  io,
                }),
            });
          } catch {
            notice(io, "ReviewRouter could not clean up progress comments.");
          }
          if (isStalePullRequestHeadError(reviewRuntimeFailure)) {
            notice(
              io,
              "ReviewRouter stopped a stale review because the PR head changed; the newer run will review the current head.",
            );
            return;
          }
          if (reviewRuntimeFailure) {
            throw reviewRuntimeFailure;
          }
        } finally {
          await removeTree(reviewHome);
        }
      } finally {
        clearActionAuthEnv(env);
        await removeTree(tempCodexHome);
        await removeTree(tempHome);
      }
      notice(io, "ReviewRouter Codex OAuth review completed.");
    } finally {
      await removeTree(workspace);
    }
  } finally {
    clearActionAuthEnv(env);
    clearOidcRequestEnv(env);
  }
}

async function runCodexRefreshOnlyGitHubAction(input: {
  readonly inputs: ActionInputs;
  readonly env: NodeJS.ProcessEnv;
  readonly io: ActionIO;
  readonly fetchImpl: FetchLike;
}): Promise<void> {
  try {
    const prelease = await requestCodexRotatingPreleaseWithFreshOidc({
      env: input.env,
      io: input.io,
      fetchImpl: input.fetchImpl,
      apiUrl: input.inputs.apiUrl,
      providerInstanceId: input.inputs.providerInstanceId,
      workflowSchemaVersion: input.inputs.workflowSchemaVersion,
    });

    await assertSupportedRunnerEnvironment(input.env);
    const codexBinaryPath = await resolveCodexBinary(input.env);
    const authJson = readActionAuthJson(input.env);
    mask(input.io, authJson);
    clearActionAuthEnv(input.env);
    validateCodexAuthJsonBytes({ authJsonBytes: authJson });
    const restoredGenerationHash = computeCodexAuthGenerationHash({
      authJsonBytes: authJson,
      generationHashSalt: prelease.generationHashSalt,
    });

    const finalize = await postJson<FinalizeResponse>({
      fetchImpl: input.fetchImpl,
      label: "api_finalize",
      url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/finalize`,
      body: {
        leaseId: prelease.leaseId,
        providerInstanceId: input.inputs.providerInstanceId,
        restoredGenerationHash,
      },
    });

    if (finalize.status === "stale_queued_secret") {
      notice(
        input.io,
        "ReviewRouter skipped a stale queued Codex OAuth secret.",
      );
      return;
    }

    mask(input.io, finalize.publicKeyReadToken);
    const publicKey = await fetchGitHubRepositoryPublicKey({
      fetchImpl: input.fetchImpl,
      owner: finalize.repositoryOwner,
      repo: finalize.repositoryName,
      token: finalize.publicKeyReadToken,
    });

    await postJson({
      fetchImpl: input.fetchImpl,
      label: "api_writeback_preflight",
      url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/writeback-preflight`,
      body: {
        leaseId: prelease.leaseId,
        providerInstanceId: input.inputs.providerInstanceId,
        githubKeyId: publicKey.key_id,
      },
    });

    const tempHome = await makeTempDirectory("reviewrouter-refresh-home-");
    const tempCodexHome = await makeGitHubWorkspaceCodexHomeDirectory(
      input.env,
    );
    try {
      await refreshAndWritebackCodexAuthJson({
        authJson,
        inputs: input.inputs,
        fetchImpl: input.fetchImpl,
        prelease,
        finalize,
        publicKey,
        codexBinaryPath,
        env: input.env,
        tempHome,
        tempCodexHome,
      });
    } finally {
      await removeTree(tempCodexHome);
      await removeTree(tempHome);
    }

    notice(input.io, "ReviewRouter Codex OAuth refresh completed.");
  } finally {
    clearActionAuthEnv(input.env);
    clearOidcRequestEnv(input.env);
  }
}

async function runForkAgenticSandboxGitHubAction(input: {
  readonly inputs: ActionInputs;
  readonly env: NodeJS.ProcessEnv;
  readonly io: ActionIO;
  readonly fetchImpl: FetchLike;
  readonly fullReviewRuntimeRunner: FullReviewRuntimeRunner;
  readonly executionDeadlineEpochMs: number;
  readonly now: () => number;
}): Promise<void> {
  const event = await readForkPullRequestTargetEvent(input.env);
  assertSameRepositoryPullRequest(event, input.env);
  const workspace = await resolveForkSandboxWorkspace(input.env);
  await assertForkSandboxWorkspace(workspace);

  const prelease = await requestCodexRotatingPreleaseWithFreshOidc({
    env: input.env,
    io: input.io,
    fetchImpl: input.fetchImpl,
    apiUrl: input.inputs.apiUrl,
    providerInstanceId: input.inputs.providerInstanceId,
    workflowSchemaVersion: input.inputs.workflowSchemaVersion,
  });

  await assertSupportedRunnerEnvironment(input.env);
  const codexBinaryPath = await resolveCodexBinary(input.env);
  const authJson = readActionAuthJson(input.env);
  mask(input.io, authJson);
  clearActionAuthEnv(input.env);
  validateCodexAuthJsonBytes({ authJsonBytes: authJson });
  const restoredGenerationHash = computeCodexAuthGenerationHash({
    authJsonBytes: authJson,
    generationHashSalt: prelease.generationHashSalt,
  });

  const finalize = await postJson<FinalizeResponse>({
    fetchImpl: input.fetchImpl,
    label: "api_finalize",
    url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/finalize`,
    body: {
      leaseId: prelease.leaseId,
      providerInstanceId: input.inputs.providerInstanceId,
      restoredGenerationHash,
    },
  });

  if (finalize.status === "stale_queued_secret") {
    clearActionAuthEnv(input.env);
    notice(input.io, "ReviewRouter skipped a stale queued Codex OAuth secret.");
    return;
  }

  const runtimeEnv = forkAgenticSandboxRuntimeEnv(finalize.runtimeEnv);
  mask(input.io, finalize.publicKeyReadToken);
  const publicKey = await fetchGitHubRepositoryPublicKey({
    fetchImpl: input.fetchImpl,
    owner: finalize.repositoryOwner,
    repo: finalize.repositoryName,
    token: finalize.publicKeyReadToken,
  });

  await postJson({
    fetchImpl: input.fetchImpl,
    label: "api_writeback_preflight",
    url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/writeback-preflight`,
    body: {
      leaseId: prelease.leaseId,
      providerInstanceId: input.inputs.providerInstanceId,
      githubKeyId: publicKey.key_id,
    },
  });

  const tempHome = await makeTempDirectory("reviewrouter-home-");
  const tempCodexHome = await makeGitHubWorkspaceCodexHomeDirectory(input.env);
  try {
    const refreshed = await refreshAndWritebackCodexAuthJson({
      authJson,
      inputs: input.inputs,
      fetchImpl: input.fetchImpl,
      prelease,
      finalize,
      publicKey,
      codexBinaryPath,
      env: input.env,
      tempHome,
      tempCodexHome,
    });

    const commentToken = await postJson<CommentTokenResponse>({
      fetchImpl: input.fetchImpl,
      label: "api_comment_token",
      url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/comment-token`,
      body: {
        leaseId: prelease.leaseId,
        providerInstanceId: input.inputs.providerInstanceId,
        authCleared: true,
      },
    });
    mask(input.io, commentToken.token);
    let cleanupCommentToken = commentToken.token;
    await deleteStaleCodexRotatingSummaryComments({
      fetchImpl: input.fetchImpl,
      token: commentToken.token,
      owner: event.owner,
      repo: event.repo,
      issueNumber: event.number,
    });

    const accessToken = extractCodexAccessToken(refreshed.authJson);
    const proxy = await startCodexLocalProviderProxy({
      fetchImpl: input.fetchImpl,
      accessToken,
      upstreamResponsesUrl: resolveCodexProxyUpstreamResponsesUrl(input.env),
    });
    try {
      await writeCodexProxySnapshot({
        codexHome: tempCodexHome,
        baseUrl: proxy.baseUrl,
        model: codexModelForForkRuntime(runtimeEnv),
      });

      const reviewHome = await makeTempDirectory("reviewrouter-review-home-");
      try {
        let reviewRuntimeFailure: unknown;
        try {
          await runReviewRuntimeWithinExecutionBudget({
            executionDeadlineEpochMs: input.executionDeadlineEpochMs,
            now: input.now,
            run: () =>
              input.fullReviewRuntimeRunner({
                inputs: input.inputs,
                leaseId: prelease.leaseId,
                codexBinaryPath,
                env: input.env,
                io: input.io,
                fetchImpl: input.fetchImpl,
                workspace,
                tempHome: reviewHome,
                tempCodexHome,
                event,
                commentToken: commentToken.token,
                commentTokenExpiresAt: commentToken.expiresAt,
                runtimeConfigVersion: finalize.runtimeConfigVersion,
                runtimeEnv,
                executionDeadlineEpochMs: input.executionDeadlineEpochMs,
                onCommentTokenUpdated: (token) => {
                  cleanupCommentToken = token;
                },
              }),
          });
        } catch (error) {
          reviewRuntimeFailure = error;
        }
        try {
          await deleteFullRuntimeProgressCommentsWithTokenRefresh({
            fetchImpl: input.fetchImpl,
            token: cleanupCommentToken,
            owner: event.owner,
            repo: event.repo,
            issueNumber: event.number,
            refreshToken: () =>
              refreshCleanupCommentToken({
                fetchImpl: input.fetchImpl,
                inputs: input.inputs,
                leaseId: prelease.leaseId,
                event,
                io: input.io,
              }),
          });
        } catch {
          notice(
            input.io,
            "ReviewRouter could not clean up progress comments.",
          );
        }
        if (isStalePullRequestHeadError(reviewRuntimeFailure)) {
          notice(
            input.io,
            "ReviewRouter stopped a stale review because the PR head changed; the newer run will review the current head.",
          );
          return;
        }
        if (reviewRuntimeFailure) {
          throw reviewRuntimeFailure;
        }
      } finally {
        await removeTree(reviewHome);
      }
    } finally {
      await proxy.close();
    }
  } finally {
    clearActionAuthEnv(input.env);
    clearOidcRequestEnv(input.env);
    await removeTree(tempCodexHome);
    await removeTree(tempHome);
  }
  notice(input.io, "ReviewRouter fork sandbox review completed.");
}

export function readActionInputs(env: NodeJS.ProcessEnv): ActionInputs {
  const mode = readInput(env, "mode") || codexRotatingRuntimeAuthMode;
  const claudeCodeOAuthToken = optionalSecretInput(
    env,
    "claude-code-oauth-token",
  );
  const openRouterApiKey = optionalSecretInput(env, "openrouter-api-key");
  const workflowSchemaVersion = Number(
    readInput(env, "workflow-schema-version") || "1",
  );
  if (!Number.isInteger(workflowSchemaVersion) || workflowSchemaVersion <= 0) {
    throw new Error("invalid_workflow_schema_version");
  }
  const apiUrl = (
    readInput(env, "control-plane-url") || requireInput(env, "api-url")
  ).replace(/\/+$/, "");

  return {
    mode,
    apiUrl,
    providerInstanceId: requireInput(env, "provider-instance-id"),
    workflowSchemaVersion,
    reviewDrafts: readBooleanInput(env, "review-drafts"),
    maxChangedLines: readNonNegativeIntegerInput(env, "max-changed-lines"),
    reviewTimeoutMinutes: readReviewTimeoutMinutesInput(env),
    providerSecrets: {
      ...(claudeCodeOAuthToken ? { claudeCodeOAuthToken } : {}),
      ...(openRouterApiKey ? { openRouterApiKey } : {}),
    },
  };
}

export function readActionAuthJson(env: NodeJS.ProcessEnv): string {
  const value = readRawInput(env, "auth-json");
  if (value === undefined || value.length === 0) {
    throw new Error("needs_reconnect");
  }
  clearActionAuthEnv(env);
  return value;
}

export async function assertSupportedRunnerEnvironment(
  env: NodeJS.ProcessEnv,
  options: RunnerEnvironmentCheckOptions = {},
): Promise<void> {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < minimumNodeMajor) {
    throw new Error("unsupported_node_runtime");
  }
  if (env.RUNNER_OS !== supportedRunnerOs) {
    throw new Error("unsupported_runner_os");
  }
  if (env.RUNNER_ARCH !== supportedRunnerArch) {
    throw new Error("unsupported_runner_arch");
  }
  if ((env.ImageOS ?? env.IMAGE_OS) !== supportedRunnerImageOs) {
    throw new Error("unsupported_runner_image_os");
  }
  const imageVersion = env.ImageVersion ?? env.IMAGE_VERSION;
  if (!imageVersion || !/^[A-Za-z0-9._-]{1,80}$/.test(imageVersion)) {
    throw new Error("unsupported_runner_image_version");
  }

  const actionPath = resolveGitHubActionPath(env);
  const freeDiskBytes = await getAvailableDiskBytes(actionPath);
  if (
    freeDiskBytes < (options.minimumFreeDiskBytes ?? minimumRunnerFreeDiskBytes)
  ) {
    throw new Error("runner_disk_budget_too_low");
  }
}

export function sanitizeReviewComment(
  body: string,
  options: { readonly marker?: string } = {},
): string {
  const sanitized =
    body
      .replace(
        /<!--\s*reviewrouter:codex-oauth-rotating(?:\s+head=[a-f0-9]{40})?\s*-->\s*/gi,
        "",
      )
      .replace(
        /refresh_token["'\s:=]+[A-Za-z0-9._~+/=-]+/gi,
        "refresh_token: [redacted]",
      )
      .replace(
        /access_token["'\s:=]+[A-Za-z0-9._~+/=-]+/gi,
        "access_token: [redacted]",
      )
      .replace(/id_token["'\s:=]+[A-Za-z0-9._~+/=-]+/gi, "id_token: [redacted]")
      .trim() ||
    "ReviewRouter completed the Codex review without a response body.";
  const header = `${options.marker ?? "<!-- reviewrouter:codex-oauth-rotating -->"}\n`;
  return limitUtf8(`${header}${sanitized}`, maxCommentBytes);
}

export function buildCodexCommand(input: {
  readonly codexBinaryPath: string;
  readonly mode: "bootstrap" | "review";
  readonly cwd: string;
  readonly outputFile?: string;
}): { readonly command: string; readonly args: readonly string[] } {
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--ignore-rules",
    "--ephemeral",
    "-C",
    input.cwd,
  ];
  if (input.mode === "bootstrap") {
    args.push("--skip-git-repo-check");
  }
  if (input.outputFile) {
    args.push("--output-last-message", input.outputFile);
  }
  args.push("-");
  return { command: input.codexBinaryPath, args };
}

function readInput(env: NodeJS.ProcessEnv, name: string): string {
  return (readRawInput(env, name) ?? "").trim();
}

function readRawInput(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const canonical = `INPUT_${name.toUpperCase()}`;
  const underscore = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
  return env[canonical] ?? env[underscore];
}

function requireInput(env: NodeJS.ProcessEnv, name: string): string {
  const value = readInput(env, name);
  if (!value) {
    throw new Error(`missing_action_input:${name}`);
  }
  return value;
}

function readBooleanInput(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = readInput(env, name);
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`invalid_boolean_action_input:${name}`);
}

function readNonNegativeIntegerInput(
  env: NodeJS.ProcessEnv,
  name: string,
): number {
  const value = readInput(env, name);
  if (!value) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`invalid_non_negative_integer_action_input:${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid_non_negative_integer_action_input:${name}`);
  }
  return parsed;
}

function readReviewTimeoutMinutesInput(env: NodeJS.ProcessEnv): number {
  const value =
    readInput(env, "review-timeout-minutes") ||
    String(defaultReviewJobTimeoutMinutes);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(
      "invalid_positive_integer_action_input:review-timeout-minutes",
    );
  }
  const parsed = Number(value);
  try {
    return createReviewExecutionBudget(parsed).jobTimeoutMinutes;
  } catch {
    throw new Error(
      "invalid_review_timeout_action_input:review-timeout-minutes",
    );
  }
}

function optionalSecretInput(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = readRawInput(env, name);
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function readPullRequestEvent(
  env: NodeJS.ProcessEnv,
  reviewDrafts: boolean,
): Promise<PullRequestEvent> {
  const eventName = env.GITHUB_EVENT_NAME;
  if (eventName !== "pull_request" && eventName !== "pull_request_target") {
    throw new Error("unsupported_event");
  }
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("missing_github_event_path");
  }
  const event = JSON.parse(await readFile(eventPath, "utf8")) as {
    readonly number?: unknown;
    readonly repository?: {
      readonly id?: unknown;
      readonly full_name?: unknown;
    };
    readonly pull_request?: {
      readonly draft?: unknown;
      readonly head?: {
        readonly sha?: unknown;
        readonly repo?: { readonly full_name?: unknown };
      };
      readonly base?: { readonly sha?: unknown };
      readonly additions?: unknown;
      readonly deletions?: unknown;
    };
  };
  const repository = requireString(event.repository?.full_name, "event_repo");
  const headRepo = requireString(
    event.pull_request?.head?.repo?.full_name,
    "head_repo",
  );
  const draft = event.pull_request?.draft === true;
  if (draft && !reviewDrafts) {
    throw new Error("draft_pull_request_unsupported");
  }
  if (draft && eventName !== "pull_request_target") {
    throw new Error("draft_pull_request_target_required");
  }
  if (!draft && eventName !== "pull_request") {
    throw new Error("ready_pull_request_event_required");
  }
  if (repository !== headRepo) {
    throw new Error("fork_pull_request_unsupported");
  }
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error("invalid_github_repository");
  }
  const changedLines = readPullRequestChangedLines({
    additions: event.pull_request?.additions,
    deletions: event.pull_request?.deletions,
  });
  return {
    number: requireNumber(event.number, "pr_number"),
    ...(isSafeGitHubNumericId(event.repository?.id)
      ? { repositoryId: String(event.repository.id) }
      : {}),
    repository,
    owner,
    repo,
    headSha: requireSha(event.pull_request?.head?.sha, "head_sha"),
    baseSha: requireSha(event.pull_request?.base?.sha, "base_sha"),
    ...(changedLines === undefined ? {} : { changedLines }),
  };
}

function readPullRequestChangedLines(input: {
  readonly additions: unknown;
  readonly deletions: unknown;
}): number | undefined {
  if (input.additions === undefined && input.deletions === undefined) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(input.additions) ||
    (input.additions as number) < 0 ||
    !Number.isSafeInteger(input.deletions) ||
    (input.deletions as number) < 0
  ) {
    throw new Error("invalid_event_field:changed_lines");
  }
  const changedLines =
    (input.additions as number) + (input.deletions as number);
  if (!Number.isSafeInteger(changedLines)) {
    throw new Error("invalid_event_field:changed_lines");
  }
  return changedLines;
}

function formatReviewAdmissionSkipNotice(
  pullRequestNumber: number,
  decision: Exclude<
    ReturnType<typeof decidePullRequestReviewAdmission>,
    { readonly status: "admitted" }
  >,
): string {
  if (decision.reason === "max_changed_lines_exceeded") {
    return `ReviewRouter skipped PR #${pullRequestNumber}: ${decision.changedLines} changed lines exceed the configured maximum of ${decision.maxChangedLines}.`;
  }
  return `ReviewRouter skipped PR #${pullRequestNumber}: GitHub did not provide a changed-line count while the configured maximum is ${decision.maxChangedLines}.`;
}

async function readForkPullRequestTargetEvent(
  env: NodeJS.ProcessEnv,
): Promise<PullRequestEvent> {
  if (env.GITHUB_EVENT_NAME !== "pull_request_target") {
    throw new Error("unsupported_event");
  }
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("missing_github_event_path");
  }
  const event = JSON.parse(await readFile(eventPath, "utf8")) as {
    readonly number?: unknown;
    readonly repository?: {
      readonly id?: unknown;
      readonly full_name?: unknown;
    };
    readonly pull_request?: {
      readonly draft?: unknown;
      readonly head?: {
        readonly sha?: unknown;
        readonly repo?: { readonly full_name?: unknown };
      };
      readonly base?: { readonly sha?: unknown };
    };
  };
  const repository = requireString(event.repository?.full_name, "event_repo");
  const headRepo = requireString(
    event.pull_request?.head?.repo?.full_name,
    "head_repo",
  );
  if (event.pull_request?.draft === true) {
    throw new Error("draft_pull_request_unsupported");
  }
  if (repository === headRepo) {
    throw new Error("fork_pull_request_required");
  }
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error("invalid_github_repository");
  }
  return {
    number: requireNumber(event.number, "pr_number"),
    ...(isSafeGitHubNumericId(event.repository?.id)
      ? { repositoryId: String(event.repository.id) }
      : {}),
    repository,
    owner,
    repo,
    headSha: requireSha(event.pull_request?.head?.sha, "head_sha"),
    baseSha: requireSha(event.pull_request?.base?.sha, "base_sha"),
  };
}

function assertSameRepositoryPullRequest(
  event: PullRequestEvent,
  env: NodeJS.ProcessEnv,
): void {
  if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== event.repository) {
    throw new Error("github_repository_mismatch");
  }
}

async function requestGitHubActionsOidcToken(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: FetchLike;
  readonly audience: string;
}): Promise<string> {
  const requestUrl = input.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = input.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error("github_oidc_unavailable");
  }
  const separator = requestUrl.includes("?") ? "&" : "?";
  const { response, body } = await fetchWithRetry({
    fetchImpl: input.fetchImpl,
    label: "github_oidc",
    timeoutMs: oidcRequestTimeoutMs,
    url: `${requestUrl}${separator}audience=${encodeURIComponent(input.audience)}`,
    init: { headers: { authorization: `bearer ${requestToken}` } },
    consume: async (response) => ({
      response,
      body: (await response.json()) as { readonly value?: unknown },
    }),
  });
  if (
    !response.ok ||
    typeof body.value !== "string" ||
    body.value.length === 0
  ) {
    throw new Error("github_oidc_request_failed");
  }
  return body.value;
}

async function requestCodexRotatingPreleaseWithFreshOidc(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly io: ActionIO;
  readonly fetchImpl: FetchLike;
  readonly apiUrl: string;
  readonly providerInstanceId: string;
  readonly workflowSchemaVersion: number;
}): Promise<PreleaseResponse> {
  let lastError: unknown;
  try {
    for (let attempt = 1; attempt <= networkRetryMaxAttempts; attempt += 1) {
      const oidcToken = await requestGitHubActionsOidcToken({
        env: input.env,
        fetchImpl: input.fetchImpl,
        audience: defaultOidcAudience,
      });
      mask(input.io, oidcToken);
      try {
        return await postJson<PreleaseResponse>({
          fetchImpl: input.fetchImpl,
          label: "api_prelease",
          url: `${input.apiUrl}/api/action/v1/codex-oauth/prelease`,
          body: {
            oidcToken,
            audience: defaultOidcAudience,
            providerInstanceId: input.providerInstanceId,
            workflowSchemaVersion: input.workflowSchemaVersion,
          },
          maxAttempts: 1,
        });
      } catch (error) {
        lastError = error;
        if (
          attempt >= networkRetryMaxAttempts ||
          !isRetryableFreshOidcExchangeError(error)
        ) {
          throw error;
        }
        await sleep(networkRetryDelayMs(attempt));
      }
    }
  } finally {
    clearOidcRequestEnv(input.env);
  }
  throw lastError;
}

function isRetryableFreshOidcExchangeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.startsWith("network_request_timeout:api_prelease") ||
    message.startsWith("network_request_failed:api_prelease") ||
    message === "workflow_source_temporarily_unavailable" ||
    message === "rate_limited" ||
    message === "action_control_plane_disabled" ||
    message === "codex_rotating_oauth_unavailable" ||
    /^reviewrouter_api_error:(?:408|429|5\d\d)$/.test(message)
  );
}

async function postJson<T = unknown>(input: {
  readonly fetchImpl: FetchLike;
  readonly label: string;
  readonly url: string;
  readonly body: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly maxAttempts?: number;
}): Promise<T> {
  const { response, text } = await fetchWithRetry({
    fetchImpl: input.fetchImpl,
    label: input.label,
    timeoutMs: controlPlaneRequestTimeoutMs,
    url: input.url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.body),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    ...(input.maxAttempts === undefined
      ? {}
      : { maxAttempts: input.maxAttempts }),
    consume: async (response) => ({ response, text: await response.text() }),
  });
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      if (!response.ok) {
        throw new Error(`reviewrouter_api_error:${response.status}`, {
          cause: error,
        });
      }
      throw new Error("reviewrouter_api_response_invalid", { cause: error });
    }
  }
  if (!response.ok) {
    throw new Error(safeRemoteError(parsed, response.status));
  }
  return parsed as T;
}

async function refreshCleanupCommentToken(input: {
  readonly fetchImpl: FetchLike;
  readonly inputs: ActionInputs;
  readonly leaseId: string;
  readonly event: PullRequestEvent;
  readonly io: ActionIO;
}): Promise<string> {
  const refreshedToken = await postJson<CommentTokenResponse>({
    fetchImpl: input.fetchImpl,
    label: "api_comment_token_cleanup_refresh",
    url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/comment-token`,
    body: {
      leaseId: input.leaseId,
      providerInstanceId: input.inputs.providerInstanceId,
      authCleared: true,
    },
  });
  if (refreshedToken.repository !== input.event.repository) {
    throw new Error("comment_token_repository_mismatch");
  }
  mask(input.io, refreshedToken.token);
  return refreshedToken.token;
}

async function tryRestoreReviewSnapshot(input: {
  readonly fetchImpl: FetchLike;
  readonly inputs: ActionInputs;
  readonly leaseId: string;
  readonly event: PullRequestEvent;
  readonly io: ActionIO;
}): Promise<ReviewSnapshotRestoreResponse | null> {
  try {
    const response = await postJson<unknown>({
      fetchImpl: input.fetchImpl,
      label: "api_review_snapshot_restore",
      url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/review-snapshot/restore`,
      body: {
        protocolVersion: 1,
        leaseId: input.leaseId,
        providerInstanceId: input.inputs.providerInstanceId,
        pullRequestNumber: input.event.number,
        baseSha: input.event.baseSha,
      },
    });
    const parsed = reviewSnapshotRestoreResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new Error("review_snapshot_restore_response_invalid");
    }
    if (
      parsed.data.status === "found" &&
      parsed.data.snapshot?.baseSha !== input.event.baseSha
    ) {
      throw new Error("review_snapshot_restore_base_mismatch");
    }
    return parsed.data;
  } catch {
    notice(
      input.io,
      "ReviewRouter incremental snapshot restore is unavailable; running a full review.",
    );
    return null;
  }
}

export async function settleFinalizedReviewCheckpoint(input: {
  readonly markerRead: FinalizedReviewCheckpointMarkerReadResult;
  readonly runtimeCompleted: boolean;
  readonly commitSnapshot: () => Promise<boolean>;
  readonly clearCheckpoint: (
    marker: z.infer<typeof reviewCheckpointFinalizationMarkerSchema>,
  ) => Promise<void>;
}): Promise<void> {
  if (!input.runtimeCompleted) return;
  if (
    input.markerRead.status ===
    FinalizedReviewCheckpointMarkerReadStatus.Invalid
  ) {
    return;
  }
  if (
    input.markerRead.status ===
    FinalizedReviewCheckpointMarkerReadStatus.Missing
  ) {
    await input.commitSnapshot();
    return;
  }
  const marker = input.markerRead.marker;
  if (marker.snapshotAdvancementRequired === false) {
    await input.clearCheckpoint(marker);
    return;
  }
  if (await input.commitSnapshot()) {
    await input.clearCheckpoint(marker);
  }
}

export function didReviewRuntimeComplete(error: unknown): boolean {
  return error === undefined || shouldSuppressTopLevelActionError(error);
}

async function tryCommitReviewSnapshot(input: {
  readonly fetchImpl: FetchLike;
  readonly inputs: ActionInputs;
  readonly leaseId: string;
  readonly event: PullRequestEvent;
  readonly candidatePath: string;
  readonly io: ActionIO;
}): Promise<boolean> {
  let candidateStats;
  try {
    candidateStats = await stat(input.candidatePath);
  } catch {
    return false;
  }
  try {
    if (
      !candidateStats.isFile() ||
      candidateStats.size > maxReviewSnapshotCandidateBytes
    ) {
      throw new Error("review_snapshot_candidate_size_invalid");
    }
    const rawCandidate = await readFile(input.candidatePath, "utf8");
    const parsedCandidate = reviewSnapshotCandidateSchema.safeParse(
      JSON.parse(rawCandidate),
    );
    if (!parsedCandidate.success) {
      throw new Error("review_snapshot_candidate_invalid");
    }
    const candidate = parsedCandidate.data;
    if (
      candidate.pullRequestNumber !== input.event.number ||
      candidate.reviewedHeadSha !== input.event.headSha ||
      candidate.baseSha !== input.event.baseSha
    ) {
      throw new Error("review_snapshot_candidate_context_mismatch");
    }

    const headToken = await postJson<CheckoutTokenResponse>({
      fetchImpl: input.fetchImpl,
      label: "api_review_snapshot_head_token",
      url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/review-snapshot/head-token`,
      body: {
        leaseId: input.leaseId,
        providerInstanceId: input.inputs.providerInstanceId,
      },
    });
    if (headToken.repository !== input.event.repository) {
      throw new Error("review_snapshot_head_token_repository_mismatch");
    }
    mask(input.io, headToken.token);
    const currentHeadSha = await fetchCurrentPullRequestHeadSha({
      fetchImpl: input.fetchImpl,
      token: headToken.token,
      event: input.event,
    });
    if (currentHeadSha !== input.event.headSha) {
      notice(
        input.io,
        "ReviewRouter skipped a stale incremental snapshot because the PR head changed.",
      );
      return false;
    }

    const commitSnapshot = async (expectedVersion: number) => {
      const response = await postJson<unknown>({
        fetchImpl: input.fetchImpl,
        label: "api_review_snapshot_commit",
        url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/review-snapshot/commit`,
        body: {
          ...candidate,
          expectedVersion,
          leaseId: input.leaseId,
          providerInstanceId: input.inputs.providerInstanceId,
        },
      });
      const parsedResponse =
        reviewSnapshotCommitResponseSchema.safeParse(response);
      if (!parsedResponse.success) {
        throw new Error("review_snapshot_commit_response_invalid");
      }
      return parsedResponse.data;
    };
    let commitResult = await commitSnapshot(candidate.expectedVersion);
    if (
      commitResult.status === "conflict" &&
      commitResult.currentHeadSha !== candidate.reviewedHeadSha
    ) {
      const recheckedHeadSha = await fetchCurrentPullRequestHeadSha({
        fetchImpl: input.fetchImpl,
        token: headToken.token,
        event: input.event,
      });
      if (recheckedHeadSha !== candidate.reviewedHeadSha) {
        notice(
          input.io,
          "ReviewRouter skipped a stale incremental snapshot because the PR head changed.",
        );
        return false;
      }
      commitResult = await commitSnapshot(commitResult.currentVersion);
    }
    if (commitResult.status === "conflict") {
      notice(
        input.io,
        "ReviewRouter kept a newer incremental snapshot from another run.",
      );
      return false;
    }
    return true;
  } catch {
    notice(
      input.io,
      "ReviewRouter completed the review but could not persist its incremental snapshot.",
    );
    return false;
  }
}

async function tryClearFinalizedReviewCheckpoint(input: {
  readonly fetchImpl: FetchLike;
  readonly inputs: ActionInputs;
  readonly leaseId: string;
  readonly marker: z.infer<typeof reviewCheckpointFinalizationMarkerSchema>;
  readonly io: ActionIO;
}): Promise<void> {
  try {
    const response = await postJson<unknown>({
      fetchImpl: input.fetchImpl,
      label: "api_review_checkpoint_clear",
      url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/review-execution-checkpoint/clear`,
      body: {
        protocolVersion: 1,
        leaseId: input.leaseId,
        providerInstanceId: input.inputs.providerInstanceId,
        pullRequestNumber: input.marker.pullRequestNumber,
        expectedVersion: input.marker.expectedVersion,
        headSha: input.marker.headSha,
        planHash: input.marker.planHash,
      },
    });
    const parsedResponse =
      reviewCheckpointClearResponseSchema.safeParse(response);
    if (!parsedResponse.success) {
      throw new Error("review_checkpoint_clear_response_invalid");
    }
    if (parsedResponse.data.status === "conflict") {
      notice(
        input.io,
        "ReviewRouter kept a newer review checkpoint from another run.",
      );
    }
  } catch {
    notice(
      input.io,
      "ReviewRouter kept the finalized batch checkpoint for a safe retry.",
    );
  }
}

async function tryReadFinalizedReviewCheckpointMarker(input: {
  readonly markerPath: string;
  readonly event: PullRequestEvent;
  readonly io: ActionIO;
}): Promise<FinalizedReviewCheckpointMarkerReadResult> {
  try {
    const markerStats = await stat(input.markerPath);
    if (!markerStats.isFile() || markerStats.size > 8_192) {
      throw new Error("review_checkpoint_marker_size_invalid");
    }
    const parsedMarker = reviewCheckpointFinalizationMarkerSchema.safeParse(
      JSON.parse(await readFile(input.markerPath, "utf8")),
    );
    if (!parsedMarker.success) {
      throw new Error("review_checkpoint_marker_invalid");
    }
    if (
      parsedMarker.data.pullRequestNumber !== input.event.number ||
      parsedMarker.data.headSha !== input.event.headSha
    ) {
      throw new Error("review_checkpoint_marker_context_mismatch");
    }
    return {
      status: FinalizedReviewCheckpointMarkerReadStatus.Valid,
      marker: parsedMarker.data,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: FinalizedReviewCheckpointMarkerReadStatus.Missing };
    }
    notice(
      input.io,
      "ReviewRouter ignored an invalid batch finalization marker and will only settle a validated snapshot candidate.",
    );
    return { status: FinalizedReviewCheckpointMarkerReadStatus.Invalid };
  }
}

async function fetchCurrentPullRequestHeadSha(input: {
  readonly fetchImpl: FetchLike;
  readonly token: string;
  readonly event: PullRequestEvent;
  readonly signal?: AbortSignal | undefined;
}): Promise<string> {
  const { response, body } = await fetchWithRetry({
    fetchImpl: input.fetchImpl,
    label: "github_pull_request_head",
    timeoutMs: githubRequestTimeoutMs,
    url: `https://api.github.com/repos/${encodeURIComponent(input.event.owner)}/${encodeURIComponent(input.event.repo)}/pulls/${input.event.number}`,
    init: {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
      ...(input.signal ? { signal: input.signal } : {}),
    },
    consume: async (response) => {
      if (response.status === 401) {
        await discardResponseBody(response);
        return { response, body: undefined };
      }
      return {
        response,
        body: (await response.json()) as {
          readonly head?: { readonly sha?: unknown };
        },
      };
    },
  });
  if (response.status === 401) {
    throw new Error("github_pull_request_head_auth_expired");
  }
  if (
    body === undefined ||
    !response.ok ||
    typeof body.head?.sha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(body.head.sha)
  ) {
    throw new Error("github_pull_request_head_fetch_failed");
  }
  return body.head.sha;
}

async function fetchGitHubRepositoryPublicKey(input: {
  readonly fetchImpl: FetchLike;
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
}): Promise<GitHubPublicKeyResponse> {
  const { response, body } = await fetchWithRetry({
    fetchImpl: input.fetchImpl,
    label: "github_public_key",
    timeoutMs: githubRequestTimeoutMs,
    url: `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/secrets/public-key`,
    init: {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
    consume: async (response) => ({
      response,
      body: (await response.json()) as Partial<GitHubPublicKeyResponse>,
    }),
  });
  if (
    !response.ok ||
    typeof body.key !== "string" ||
    typeof body.key_id !== "string"
  ) {
    throw new Error("github_public_key_fetch_failed");
  }
  return { key: body.key, key_id: body.key_id };
}

async function fetchWithRetry<T = Response>(input: {
  readonly fetchImpl: FetchLike;
  readonly label: string;
  readonly url: string;
  readonly init?: RequestInit;
  readonly timeoutMs: number;
  readonly maxAttempts?: number;
  readonly consume?: ((response: Response) => Promise<T>) | undefined;
}): Promise<T> {
  const maxAttempts = input.maxAttempts ?? networkRetryMaxAttempts;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const externalSignal = input.init?.signal;
    if (externalSignal?.aborted) {
      throw new Error(
        `network_request_aborted:${safeNetworkLabel(input.label)}`,
      );
    }
    const abortFromExternalSignal = (): void => controller.abort();
    externalSignal?.addEventListener("abort", abortFromExternalSignal, {
      once: true,
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, input.timeoutMs);
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    };

    try {
      const response = await input.fetchImpl(input.url, {
        ...input.init,
        signal: controller.signal,
      });
      if (shouldRetryHttpStatus(response.status) && attempt < maxAttempts) {
        await discardResponseBody(response);
        cleanup();
        await sleep(networkRetryDelayMs(attempt));
        continue;
      }
      const result = input.consume
        ? await input.consume(response)
        : (response as T);
      cleanup();
      return result;
    } catch (error) {
      cleanup();
      lastError = error;
      if (externalSignal?.aborted) {
        throw new Error(
          `network_request_aborted:${safeNetworkLabel(input.label)}`,
          { cause: error },
        );
      }
      if (attempt < maxAttempts) {
        await sleep(networkRetryDelayMs(attempt));
        continue;
      }
      const code = timedOut
        ? "network_request_timeout"
        : "network_request_failed";
      throw new Error(`${code}:${safeNetworkLabel(input.label)}`, {
        cause: error,
      });
    }
  }

  throw new Error(`network_request_failed:${safeNetworkLabel(input.label)}`, {
    cause: lastError,
  });
}

function shouldRetryHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function networkRetryDelayMs(attempt: number): number {
  return networkRetryBaseDelayMs * 2 ** Math.max(0, attempt - 1);
}

function safeNetworkLabel(label: string): string {
  return /^[a-z0-9_:-]{1,80}$/i.test(label) ? label : "unknown";
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Best effort only. The retry path should not fail because body cleanup did.
  }
}

async function consumeResponseBody(response: Response): Promise<Response> {
  await discardResponseBody(response);
  return response;
}

async function consumeJsonResponse(response: Response): Promise<{
  readonly response: Response;
  readonly body: unknown;
}> {
  if (!response.ok) {
    await discardResponseBody(response);
    return { response, body: undefined };
  }
  return { response, body: await response.json() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertWritebackAccepted(response: WritebackResponse): void {
  if (!response || response.protocolVersion !== 1) {
    throw new Error("unknown_auth_state");
  }
  if (
    response.status === "accepted" ||
    response.status === "idempotent_replay"
  ) {
    return;
  }
  if (response.status === "writeback_idempotency_conflict") {
    throw new Error("security_invariant_failed");
  }
  throw new Error("unknown_auth_state");
}

export function routeCodexLocalProviderRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly nonce: string;
  readonly bodyBytes: number;
}): "responses" | "deny" {
  if (input.method !== "POST") return "deny";
  if (input.bodyBytes > maxProxyRequestBodyBytes) return "deny";
  if (input.path !== `/${input.nonce}/v1/responses`) return "deny";
  return "responses";
}

export async function startCodexLocalProviderProxy(input: {
  readonly fetchImpl: FetchLike;
  readonly accessToken: string;
  readonly upstreamResponsesUrl: string;
}): Promise<LocalProviderProxy> {
  const nonce = randomBytes(24).toString("base64url");
  let requestCount = 0;
  let closing = false;
  const activeUpstreamRequests = new Set<AbortController>();
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const body = await readProxyRequestBody(req);
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        const route = routeCodexLocalProviderRequest({
          method: req.method ?? "GET",
          path,
          nonce,
          bodyBytes: body.byteLength,
        });
        if (route !== "responses") {
          writeProxyDeny(res);
          return;
        }
        requestCount += 1;
        if (requestCount > maxProxyRequestsPerReview) {
          writeProxyError(res, 429, "proxy_request_budget_exceeded");
          return;
        }
        if (closing) {
          writeProxyError(res, 503, "proxy_closing");
          return;
        }
        const upstreamController = new AbortController();
        activeUpstreamRequests.add(upstreamController);
        try {
          const upstream = await input.fetchImpl(input.upstreamResponsesUrl, {
            method: "POST",
            headers: buildCodexProxyUpstreamHeaders({
              requestHeaders: req.headers,
              fallbackAccessToken: input.accessToken,
            }),
            body: new Uint8Array(body),
            signal: upstreamController.signal,
          });
          await writeProxyUpstreamResponse(res, upstream);
        } finally {
          activeUpstreamRequests.delete(upstreamController);
        }
      } catch {
        writeProxyError(res, 502, "proxy_upstream_failed");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(server);
    throw new Error("proxy_listener_invalid_address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/${nonce}/v1`,
    close: async () => {
      closing = true;
      for (const controller of activeUpstreamRequests) {
        controller.abort(new Error("proxy_closing"));
      }
      const closePromise = closeHttpServer(server);
      server.closeAllConnections();
      await closePromise;
    },
  };
}

export function resolveCodexProxyUpstreamResponsesUrl(
  env: NodeJS.ProcessEnv,
): string {
  return (
    env.REVIEWROUTER_CODEX_RESPONSES_URL ??
    env.REVIEWROUTER_OPENAI_RESPONSES_URL ??
    defaultChatGptCodexResponsesUrl
  );
}

function buildCodexProxyUpstreamHeaders(input: {
  readonly requestHeaders: http.IncomingHttpHeaders;
  readonly fallbackAccessToken: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    accept:
      getJoinedRequestHeader(input.requestHeaders, "accept") ??
      "text/event-stream",
    "content-type":
      getJoinedRequestHeader(input.requestHeaders, "content-type") ??
      "application/json",
  };
  const authorization = getJoinedRequestHeader(
    input.requestHeaders,
    "authorization",
  );
  headers.authorization =
    authorization && /^Bearer\s+\S+/i.test(authorization)
      ? authorization
      : `Bearer ${input.fallbackAccessToken}`;

  for (const name of Object.keys(input.requestHeaders)) {
    if (!shouldForwardCodexProxyHeader(name)) continue;
    const value = getJoinedRequestHeader(input.requestHeaders, name);
    if (value) {
      headers[name] = value;
    }
  }
  return headers;
}

function shouldForwardCodexProxyHeader(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    codexProxyForwardHeaderNames.has(lowerName) ||
    lowerName.startsWith("x-codex-")
  );
}

function getJoinedRequestHeader(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

function readProxyRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxProxyRequestBodyBytes) {
        req.destroy(new Error("proxy_request_body_too_large"));
        return;
      }
      chunks.push(buffer);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function writeProxyUpstreamResponse(
  res: http.ServerResponse,
  upstream: Response,
): Promise<void> {
  const headers: Record<string, string> = {};
  const contentType = upstream.headers.get("content-type");
  if (contentType) {
    headers["content-type"] = contentType;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}

function writeProxyDeny(res: http.ServerResponse): void {
  writeProxyError(res, 404, "proxy_route_denied");
}

function writeProxyError(
  res: http.ServerResponse,
  status: number,
  code: string,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: code }));
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function resolveCodexBinary(
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const actionPath = resolveGitHubActionPath(env);

  const bundleRoot = join(
    actionPath,
    "action-dist",
    "codex",
    bundledCodexPlatform,
  );
  const archivePath = join(bundleRoot, bundledCodexArchiveName);
  const manifestPath = join(bundleRoot, "manifest.json");

  let resolvedBundleRoot: string;
  let resolvedArchivePath: string;
  let resolvedManifestPath: string;
  try {
    [resolvedBundleRoot, resolvedArchivePath, resolvedManifestPath] =
      await Promise.all([
        realpath(bundleRoot),
        realpath(archivePath),
        realpath(manifestPath),
      ]);
  } catch (error) {
    throw new Error("codex_bundled_binary_missing", { cause: error });
  }

  if (
    !resolvedArchivePath.startsWith(`${resolvedBundleRoot}/`) ||
    !resolvedManifestPath.startsWith(`${resolvedBundleRoot}/`)
  ) {
    throw new Error("codex_bundled_binary_escape");
  }

  const [archiveLinkStats, manifestLinkStats, archiveStats, manifest] =
    await Promise.all([
      lstat(archivePath),
      lstat(manifestPath),
      stat(resolvedArchivePath),
      readCodexBinaryManifest(resolvedManifestPath),
    ]);
  if (archiveLinkStats.isSymbolicLink() || manifestLinkStats.isSymbolicLink()) {
    throw new Error("codex_bundled_binary_symlink");
  }
  if (!archiveStats.isFile()) {
    throw new Error("codex_bundled_binary_not_file");
  }
  validateCodexBinaryManifest(manifest, archiveStats.size);
  const archiveSha256 = await sha256File(resolvedArchivePath);
  if (archiveSha256 !== manifest.archiveSha256) {
    throw new Error("codex_bundled_archive_hash_mismatch");
  }

  const extractionRoot = await mkdtemp(
    join(env.RUNNER_TEMP ?? tmpdir(), "reviewrouter-codex-bundle-"),
  );
  await runProcess({
    command: "tar",
    args: ["-xzf", resolvedArchivePath, "-C", extractionRoot],
    cwd: extractionRoot,
    env: {
      PATH: env.PATH ?? process.env.PATH ?? "",
    },
    timeoutMs: 60_000,
  });
  const extractedBinaryPath = join(
    extractionRoot,
    manifest.binaryPathInArchive,
  );
  const resolvedExtractionRoot = await realpath(extractionRoot);
  const resolvedBinaryPath = await realpath(extractedBinaryPath);
  if (!resolvedBinaryPath.startsWith(`${resolvedExtractionRoot}/`)) {
    throw new Error("codex_bundled_binary_escape");
  }
  const binaryStats = await stat(resolvedBinaryPath);
  if (!binaryStats.isFile() || binaryStats.size !== manifest.size) {
    throw new Error("codex_bundled_binary_manifest_mismatch");
  }
  const binarySha256 = await sha256File(resolvedBinaryPath);
  if (binarySha256 !== manifest.sha256) {
    throw new Error("codex_bundled_binary_hash_mismatch");
  }
  await chmod(resolvedBinaryPath, 0o755);
  await access(resolvedBinaryPath, fsConstants.X_OK);
  return resolvedBinaryPath;
}

function resolveGitHubActionPath(env: NodeJS.ProcessEnv): string {
  const explicitActionPath = env.GITHUB_ACTION_PATH;
  if (explicitActionPath) {
    return explicitActionPath;
  }

  if (typeof __dirname === "string" && __dirname.endsWith("action-dist")) {
    return join(__dirname, "..");
  }

  throw new Error("missing_github_action_path");
}

async function readCodexBinaryManifest(
  manifestPath: string,
): Promise<CodexBinaryManifest> {
  try {
    return JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as CodexBinaryManifest;
  } catch (error) {
    throw new Error("codex_bundled_binary_manifest_invalid", { cause: error });
  }
}

function validateCodexBinaryManifest(
  manifest: unknown,
  archiveSize: number,
): void {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("codex_bundled_binary_manifest_mismatch");
  }
  const candidate = manifest as Partial<CodexBinaryManifest>;
  if (
    candidate.protocolVersion !== 1 ||
    candidate.packageName !== bundledCodexPackageName ||
    candidate.version !== bundledCodexVersion ||
    candidate.platform !== bundledCodexPlatform ||
    candidate.archive !== bundledCodexArchiveName ||
    candidate.archiveSize !== archiveSize ||
    typeof candidate.archiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(candidate.archiveSha256) ||
    candidate.binaryPathInArchive !== bundledCodexBinaryPathInArchive ||
    candidate.binary !== "codex" ||
    typeof candidate.size !== "number" ||
    candidate.size <= 0 ||
    typeof candidate.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(candidate.sha256)
  ) {
    throw new Error("codex_bundled_binary_manifest_mismatch");
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function getAvailableDiskBytes(path: string): Promise<number> {
  try {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  } catch (error) {
    throw new Error("runner_disk_budget_unavailable", { cause: error });
  }
}

async function writeCodexAuthSnapshot(
  codexHome: string,
  authJson: string,
): Promise<void> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const config = [
    'cli_auth_credentials_store = "file"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    "disable_response_storage = true",
    'model_verbosity = "low"',
    "",
    "[features]",
    "apps = false",
    "hooks = false",
    "memories = false",
    "multi_agent = false",
    "shell_snapshot = false",
    "skill_mcp_dependency_install = false",
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[otel]",
    'exporter = "none"',
    'metrics_exporter = "none"',
    'trace_exporter = "none"',
    "log_user_prompt = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
    "",
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), config, {
    mode: 0o600,
  });
  await writeFile(join(codexHome, "auth.json"), authJson, { mode: 0o600 });
}

async function writeCodexProxySnapshot(input: {
  readonly codexHome: string;
  readonly baseUrl: string;
  readonly model: string;
}): Promise<void> {
  await mkdir(input.codexHome, { recursive: true, mode: 0o700 });
  await rm(join(input.codexHome, "auth.json"), { force: true });
  const config = [
    `model = ${JSON.stringify(input.model)}`,
    'model_provider = "reviewrouter_proxy"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    "disable_response_storage = true",
    'model_verbosity = "low"',
    "",
    "[model_providers.reviewrouter_proxy]",
    'name = "ReviewRouter local Responses proxy"',
    `base_url = ${JSON.stringify(input.baseUrl)}`,
    'wire_api = "responses"',
    "",
    "[features]",
    "apps = false",
    "hooks = false",
    "memories = false",
    "multi_agent = false",
    "shell_snapshot = false",
    "skill_mcp_dependency_install = false",
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[otel]",
    'exporter = "none"',
    'metrics_exporter = "none"',
    'trace_exporter = "none"',
    "log_user_prompt = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
    "",
  ].join("\n");
  await writeFile(join(input.codexHome, "config.toml"), config, {
    mode: 0o600,
  });
}

async function runCodexBootstrap(input: {
  readonly inputs: ActionInputs;
  readonly codexBinaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tempHome: string;
  readonly tempCodexHome: string;
}): Promise<void> {
  const emptyCwd = await makeTempDirectory("reviewrouter-empty-");
  try {
    const command = buildCodexCommand({
      codexBinaryPath: input.codexBinaryPath,
      mode: "bootstrap",
      cwd: emptyCwd,
    });
    try {
      await runProcess({
        ...command,
        stdin: "Respond with OK only.",
        env: buildCodexChildEnv(input.env, input.tempHome, input.tempCodexHome),
        timeoutMs: 5 * 60 * 1000,
      });
    } catch (error) {
      throw classifyCodexBootstrapFailure(error);
    }
  } finally {
    await removeTree(emptyCwd);
  }
}

async function refreshCodexAuthJson(input: {
  readonly authJson: string;
  readonly inputs: ActionInputs;
  readonly fetchImpl: FetchLike;
  readonly prelease: PreleaseResponse;
  readonly finalize: Extract<
    FinalizeResponse,
    { readonly status: "finalized" }
  >;
  readonly publicKey: GitHubPublicKeyResponse;
  readonly codexBinaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tempHome: string;
  readonly tempCodexHome: string;
}): Promise<{
  readonly authJson: string;
  readonly writebackCommittedByRuntime: boolean;
}> {
  if (!shouldUseSubscriptionRuntimeCodex(input.env)) {
    await writeCodexAuthSnapshot(input.tempCodexHome, input.authJson);
    await runCodexBootstrap(input);
    return {
      authJson: await readFile(join(input.tempCodexHome, "auth.json"), "utf8"),
      writebackCommittedByRuntime: false,
    };
  }

  const subscriptionRuntimeSourceEnv = {
    ...input.env,
    SUBSCRIPTION_RUNTIME_TMPDIR: input.tempCodexHome,
  };
  const sessionDriver = new CodexCliSessionDriver({
    codexBinaryPath: input.codexBinaryPath,
    sourceEnv: subscriptionRuntimeSourceEnv,
  });
  const agentDriver = new CodexJsonAgentDriver({
    codexBinaryPath: input.codexBinaryPath,
    sourceEnv: subscriptionRuntimeSourceEnv,
  });
  const redactor = new DefaultRedactor();
  const sessionStore = new ReviewRouterCodexActionSessionStore({
    authJson: input.authJson,
    inputs: input.inputs,
    fetchImpl: input.fetchImpl,
    prelease: input.prelease,
    finalize: input.finalize,
    publicKey: input.publicKey,
    env: input.env,
  });
  const runtime = createSubscriptionRuntime({
    policy: buildCodexActionRuntimePolicy({
      sessionDriver,
      agentDriver,
      sessionStore,
    }),
    sessionDriver,
    agentDriver,
    sessionStore,
    leaseStore: new ReviewRouterCodexActionLeaseStore(input.prelease),
    runner: new GitHubActionRunner({ redactor }),
    workspace: new ExistingPathWorkspace(input.tempHome),
    redactor,
    observability: new NullObservability(),
    clock: new SystemClock(),
    idGenerator: new ReviewRouterCodexActionIdGenerator({
      env: input.env,
      leaseId: input.prelease.leaseId,
    }),
  });

  const refresh = await runtime.refreshSession({
    providerInstanceId: input.inputs.providerInstanceId,
    runContext: {
      runId: input.env.GITHUB_RUN_ID || input.prelease.leaseId,
      attempt: Number(input.env.GITHUB_RUN_ATTEMPT || "1"),
      abortSignal: new AbortController().signal,
    },
  });

  if (refresh.status === "blocked") {
    throw new Error(mapRefreshBlockedReasonToActionError(refresh.reason));
  }
  if (refresh.status === "skipped" && refresh.reason === "stale_generation") {
    throw new Error("stale_generation");
  }

  const artifact =
    refresh.status === "ready"
      ? refresh.session.artifact
      : refresh.session?.artifact;
  if (!artifact) {
    throw new Error("needs_reconnect");
  }

  const refreshedAuthJson = Buffer.from(artifact.bytes).toString("utf8");
  await writeCodexAuthSnapshot(input.tempCodexHome, refreshedAuthJson);
  return {
    authJson: refreshedAuthJson,
    writebackCommittedByRuntime: refresh.status === "ready",
  };
}

type RefreshCodexAuthJsonInput = Parameters<typeof refreshCodexAuthJson>[0];
type RefreshCodexAuthJsonResult = Awaited<
  ReturnType<typeof refreshCodexAuthJson>
>;

async function refreshAndWritebackCodexAuthJson(
  input: RefreshCodexAuthJsonInput,
): Promise<RefreshCodexAuthJsonResult> {
  try {
    const refreshed = await refreshCodexAuthJson(input);
    if (!refreshed.writebackCommittedByRuntime) {
      await writeRefreshedCodexAuthJson({
        authJson: refreshed.authJson,
        inputs: input.inputs,
        fetchImpl: input.fetchImpl,
        prelease: input.prelease,
        finalize: input.finalize,
        publicKey: input.publicKey,
        env: input.env,
      });
    }
    return refreshed;
  } catch (error) {
    await abandonCodexRotatingLeaseOnReconnect({
      error,
      inputs: input.inputs,
      fetchImpl: input.fetchImpl,
      prelease: input.prelease,
    });
    throw error;
  }
}

async function abandonCodexRotatingLeaseOnReconnect(input: {
  readonly error: unknown;
  readonly inputs: ActionInputs;
  readonly fetchImpl: FetchLike;
  readonly prelease: PreleaseResponse;
}): Promise<void> {
  if (!isNeedsReconnectError(input.error)) {
    return;
  }
  try {
    await postJson({
      fetchImpl: input.fetchImpl,
      label: "api_abandon",
      url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/abandon`,
      body: {
        leaseId: input.prelease.leaseId,
        providerInstanceId: input.inputs.providerInstanceId,
        reason: "needs_reconnect",
      },
    });
  } catch {
    // Keep the original reconnect error visible to the workflow.
  }
}

function isNeedsReconnectError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes(
    "needs_reconnect",
  );
}

async function writeRefreshedCodexAuthJson(input: {
  readonly authJson: string;
  readonly inputs: ActionInputs;
  readonly fetchImpl: FetchLike;
  readonly prelease: PreleaseResponse;
  readonly finalize: Extract<
    FinalizeResponse,
    { readonly status: "finalized" }
  >;
  readonly publicKey: GitHubPublicKeyResponse;
  readonly env: NodeJS.ProcessEnv;
}): Promise<SessionWriteResult> {
  const compact = compactCodexAuthJson({
    authJsonBytes: input.authJson,
  });
  const encrypted = await encryptCodexRotatingAuthForGitHubSecret({
    authJsonBytes: compact.compactAuthJsonBytes,
    githubPublicKeyBase64: input.publicKey.key,
    githubKeyId: input.publicKey.key_id,
    generationHashSalt: input.prelease.generationHashSalt,
  });

  const writeback = await postJson<WritebackResponse>({
    fetchImpl: input.fetchImpl,
    label: "api_writeback",
    url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/writeback`,
    body: {
      protocolVersion: 1,
      leaseId: input.prelease.leaseId,
      providerInstanceId: input.inputs.providerInstanceId,
      generation: input.finalize.nextGeneration,
      latestGenerationHash: encrypted.latestGenerationHash,
      encryptedValue: encrypted.encryptedValue,
      keyId: encrypted.keyId,
      idempotencyKey: buildWritebackIdempotencyKey(
        input.env,
        input.prelease.leaseId,
      ),
    },
  });
  assertWritebackAccepted(writeback);

  return {
    status:
      writeback.status === "idempotent_replay"
        ? "idempotent_replay"
        : "accepted",
    generation: input.finalize.nextGeneration,
    generationHash: encrypted.latestGenerationHash,
  };
}

const reviewRouterCodexActionStoreCapabilities: SessionStoreCapabilities = {
  storeId: "reviewrouter-codex-action-secret-writeback",
  custody: "no-plaintext-backend",
  supportsRead: true,
  supportsWriteback: true,
  supportsCompareAndSwap: true,
  supportsIdempotency: true,
  supportsDelete: false,
  supportsAuditLog: false,
  supportsMetadataOnlyHealthCheck: true,
  plaintextAvailableToBackend: false,
  maxArtifactBytes: 256_000,
};

class ReviewRouterCodexActionSessionStore implements SessionStorePort {
  readonly storeId = reviewRouterCodexActionStoreCapabilities.storeId;
  readonly custody = reviewRouterCodexActionStoreCapabilities.custody;
  readonly capabilities = reviewRouterCodexActionStoreCapabilities;
  private readonly artifact: SessionArtifact;
  private readonly generation: number;

  constructor(
    private readonly options: {
      readonly authJson: string;
      readonly inputs: ActionInputs;
      readonly fetchImpl: FetchLike;
      readonly prelease: PreleaseResponse;
      readonly finalize: Extract<
        FinalizeResponse,
        { readonly status: "finalized" }
      >;
      readonly publicKey: GitHubPublicKeyResponse;
      readonly env: NodeJS.ProcessEnv;
    },
  ) {
    this.artifact = sessionArtifactFromCodexAuthJson(options.authJson);
    this.generation = Math.max(1, options.finalize.nextGeneration - 1);
  }

  async read(input: {
    readonly providerInstanceId: string;
    readonly expectedProviderId?: string;
  }): Promise<SessionEnvelope | null> {
    if (input.providerInstanceId !== this.options.inputs.providerInstanceId) {
      return null;
    }
    if (
      input.expectedProviderId &&
      input.expectedProviderId !== this.artifact.providerId
    ) {
      return null;
    }
    return {
      providerInstanceId: this.options.inputs.providerInstanceId,
      providerId: this.artifact.providerId,
      artifact: this.artifact,
      generation: this.generation,
      generationHash: computeRestoredCodexGenerationHash(this.options),
      storageVersion: "reviewrouter-codex-action-secret-v1",
      custody: this.custody,
      metadata: {
        leaseId: this.options.prelease.leaseId,
      },
    };
  }

  async write(input: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
  }): Promise<SessionWriteResult> {
    if (input.providerInstanceId !== this.options.inputs.providerInstanceId) {
      throw new Error("provider_instance_mismatch");
    }
    if (input.expectedGeneration !== this.generation) {
      return {
        status: "stale_generation",
        currentGeneration: this.generation,
        currentGenerationHash: computeRestoredCodexGenerationHash(this.options),
      };
    }
    const authJson = Buffer.from(input.nextArtifact.bytes).toString("utf8");
    return writeRefreshedCodexAuthJson({
      authJson,
      inputs: this.options.inputs,
      fetchImpl: this.options.fetchImpl,
      prelease: this.options.prelease,
      finalize: this.options.finalize,
      publicKey: this.options.publicKey,
      env: this.options.env,
    });
  }
}

class ReviewRouterCodexActionLeaseStore implements LeaseStorePort {
  readonly leaseStoreId = "reviewrouter-codex-action-lease";
  readonly capabilities = {
    leaseStoreId: this.leaseStoreId,
    supportsTtl: true,
    supportsFinalize: true,
    supportsWritebackCommit: true,
  } as const;

  constructor(private readonly prelease: PreleaseResponse) {}

  async acquire() {
    return {
      status: "granted" as const,
      leaseId: this.prelease.leaseId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };
  }

  async finalize(input: {
    readonly leaseId: string;
    readonly restoredGenerationHash: string;
  }) {
    return input;
  }

  async markWritebackStarted(): Promise<void> {}

  async markWritebackCommitted(): Promise<{ readonly status: "committed" }> {
    return { status: "committed" };
  }
}

class ExistingPathWorkspace implements WorkspacePort {
  readonly workspaceId = "reviewrouter-existing-action-workspace";
  readonly capabilities = {
    workspaceId: this.workspaceId,
    supportsTempDir: true,
    supportsExistingCheckout: true,
    supportsContainer: false,
  } as const;

  constructor(private readonly path: string) {}

  async create(): Promise<WorkspaceHandle> {
    return { path: this.path };
  }
}

class ReviewRouterCodexActionIdGenerator
  extends DeterministicIdGenerator
  implements IdGeneratorPort
{
  constructor(
    private readonly options: {
      readonly env: NodeJS.ProcessEnv;
      readonly leaseId: string;
    },
  ) {
    super();
  }

  override idempotencyKey(input: {
    readonly providerInstanceId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly purpose: "refresh" | "writeback" | "run-task";
  }): string {
    if (input.purpose === "writeback") {
      return buildWritebackIdempotencyKey(
        this.options.env,
        this.options.leaseId,
      );
    }
    return super.idempotencyKey(input);
  }
}

function buildCodexActionRuntimePolicy(input: {
  readonly sessionDriver: ProviderSessionDriver;
  readonly agentDriver: AgentDriver;
  readonly sessionStore: SessionStorePort;
}): RuntimePolicy {
  return {
    custodyMode: "no-plaintext-backend",
    requireNoBackendPlaintext: true,
    requireWritebackBeforeTask: true,
    requireCompareAndSwap: true,
    allowInteractiveSetupInRuntime: false,
    allowedProviderIds: [input.sessionDriver.providerId],
    allowedAgentIds: [input.agentDriver.agentId],
    allowedStoreIds: [input.sessionStore.storeId],
    allowedRunnerIds: ["github-action"],
  };
}

function computeRestoredCodexGenerationHash(input: {
  readonly authJson: string;
  readonly prelease: PreleaseResponse;
}): string {
  return computeCodexAuthGenerationHash({
    authJsonBytes: input.authJson,
    generationHashSalt: input.prelease.generationHashSalt,
  });
}

function mapRefreshBlockedReasonToActionError(
  reason:
    | "provider_reconnect_required"
    | "permission_required"
    | "quota_limited",
): string {
  return reason === "provider_reconnect_required" ? "needs_reconnect" : reason;
}

export function shouldUseSubscriptionRuntimeCodex(
  env: NodeJS.ProcessEnv,
): boolean {
  const value = env.REVIEW_ROUTER_USE_SUBSCRIPTION_RUNTIME_CODEX;
  return value !== "0" && value !== "false";
}

async function safeCheckoutPullRequest(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly workspace: string;
  readonly event: PullRequestEvent;
  readonly checkoutToken: string;
  readonly previousReviewedHeadSha?: string | undefined;
}): Promise<boolean> {
  const askPass = join(input.workspace, ".reviewrouter-askpass.sh");
  await writeFile(
    askPass,
    [
      "#!/usr/bin/env bash",
      'case "$1" in',
      '*Username*) printf "%s\\n" "x-access-token" ;;',
      '*Password*) printf "%s\\n" "$REVIEWROUTER_CHECKOUT_TOKEN" ;;',
      '*) printf "\\n" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(askPass, 0o700);
  const gitEnv = buildSafeCheckoutGitEnv({
    sourceEnv: input.env,
    workspace: input.workspace,
    askPass,
    checkoutToken: input.checkoutToken,
  });
  await runGit(["init", "."], input.workspace, gitEnv);
  await runGit(["config", "--local", "gc.auto", "0"], input.workspace, gitEnv);
  await runGit(
    ["config", "--local", "core.hooksPath", "/dev/null"],
    input.workspace,
    gitEnv,
  );
  await runGit(
    [
      "remote",
      "add",
      "origin",
      `https://github.com/${input.event.repository}.git`,
    ],
    input.workspace,
    gitEnv,
  );
  let previousHeadFetched = true;
  if (
    input.previousReviewedHeadSha &&
    input.previousReviewedHeadSha !== input.event.headSha &&
    input.previousReviewedHeadSha !== input.event.baseSha
  ) {
    try {
      await runGit(
        [
          "-c",
          "protocol.file.allow=never",
          "-c",
          "protocol.ext.allow=never",
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--depth=1",
          "origin",
          input.previousReviewedHeadSha,
        ],
        input.workspace,
        gitEnv,
      );
    } catch {
      previousHeadFetched = false;
    }
  }
  await runGit(
    [
      "-c",
      "protocol.file.allow=never",
      "-c",
      "protocol.ext.allow=never",
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--depth=1",
      "origin",
      input.event.baseSha,
      input.event.headSha,
    ],
    input.workspace,
    gitEnv,
  );
  await runGit(
    [
      "-c",
      "protocol.file.allow=never",
      "-c",
      "protocol.ext.allow=never",
      "checkout",
      "--detach",
      input.event.headSha,
    ],
    input.workspace,
    gitEnv,
  );
  await assertCheckoutConfigDoesNotPersistCredentials({
    workspace: input.workspace,
    checkoutToken: input.checkoutToken,
  });
  return previousHeadFetched;
}

function buildSafeCheckoutGitEnv(input: {
  readonly sourceEnv: NodeJS.ProcessEnv;
  readonly workspace: string;
  readonly askPass: string;
  readonly checkoutToken: string;
}): Record<string, string> {
  return {
    ...pruneCodexRotatingChildEnv(input.sourceEnv),
    HOME: input.workspace,
    XDG_CONFIG_HOME: join(input.workspace, ".config"),
    GIT_ASKPASS: input.askPass,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GCM_INTERACTIVE: "Never",
    GIT_CONFIG_COUNT: "7",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "never",
    GIT_CONFIG_KEY_1: "protocol.ext.allow",
    GIT_CONFIG_VALUE_1: "never",
    GIT_CONFIG_KEY_2: "protocol.ssh.allow",
    GIT_CONFIG_VALUE_2: "never",
    GIT_CONFIG_KEY_3: "protocol.git.allow",
    GIT_CONFIG_VALUE_3: "never",
    GIT_CONFIG_KEY_4: "credential.helper",
    GIT_CONFIG_VALUE_4: "",
    GIT_CONFIG_KEY_5: "core.hooksPath",
    GIT_CONFIG_VALUE_5: "/dev/null",
    GIT_CONFIG_KEY_6: "advice.detachedHead",
    GIT_CONFIG_VALUE_6: "false",
    REVIEWROUTER_CHECKOUT_TOKEN: input.checkoutToken,
  };
}

async function assertCheckoutConfigDoesNotPersistCredentials(input: {
  readonly workspace: string;
  readonly checkoutToken: string;
}): Promise<void> {
  await assertGitConfigDoesNotPersistCredentials(input);
}

async function assertGitConfigDoesNotPersistCredentials(input: {
  readonly workspace: string;
  readonly checkoutToken?: string;
}): Promise<void> {
  let gitConfig: string;
  try {
    gitConfig = await readFile(join(input.workspace, ".git", "config"), "utf8");
  } catch (error) {
    throw new Error("checkout_config_missing", { cause: error });
  }
  const normalized = gitConfig.toLowerCase();
  if (
    (input.checkoutToken ? gitConfig.includes(input.checkoutToken) : false) ||
    normalized.includes("extraheader") ||
    normalized.includes("credential.helper") ||
    normalized.includes("insteadof") ||
    normalized.includes("reviewrouter_checkout_token") ||
    normalized.includes("x-access-token")
  ) {
    throw new Error("checkout_persisted_credentials_detected");
  }
}

async function resolveForkSandboxWorkspace(
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const workspace = env.REVIEW_ROUTER_PR_WORKSPACE;
  if (!workspace) {
    throw new Error("missing_fork_sandbox_workspace");
  }
  const githubWorkspace = env.GITHUB_WORKSPACE;
  if (!githubWorkspace) {
    throw new Error("missing_github_workspace");
  }
  const resolvedWorkspace = await realpath(workspace);
  const resolvedRoot = await realpath(githubWorkspace);
  if (
    resolvedWorkspace !== resolvedRoot &&
    !resolvedWorkspace.startsWith(`${resolvedRoot}/`)
  ) {
    throw new Error("fork_sandbox_workspace_outside_github_workspace");
  }
  if (resolvedWorkspace === "/" || resolvedWorkspace === resolvedRoot) {
    throw new Error("fork_sandbox_workspace_invalid");
  }
  return resolvedWorkspace;
}

async function assertForkSandboxWorkspace(workspace: string): Promise<void> {
  const stats = await lstat(workspace);
  if (!stats.isDirectory()) {
    throw new Error("fork_sandbox_workspace_not_directory");
  }
  await assertGitConfigDoesNotPersistCredentials({ workspace });
}

async function makeGitHubWorkspaceCodexHomeDirectory(
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const githubWorkspace = env.GITHUB_WORKSPACE;
  if (!githubWorkspace) {
    throw new Error("missing_github_workspace");
  }

  const resolvedWorkspaceRoot = await realpath(githubWorkspace);
  const codexHomeRoot = join(resolvedWorkspaceRoot, ".reviewrouter-codex-home");
  await mkdir(codexHomeRoot, { recursive: true, mode: 0o700 });
  const codexHomeRootStats = await lstat(codexHomeRoot);
  if (
    !codexHomeRootStats.isDirectory() ||
    codexHomeRootStats.isSymbolicLink()
  ) {
    throw new Error("github_workspace_codex_home_root_invalid");
  }

  const resolvedCodexHomeRoot = await realpath(codexHomeRoot);
  if (
    resolvedCodexHomeRoot !== codexHomeRoot &&
    !resolvedCodexHomeRoot.startsWith(`${resolvedWorkspaceRoot}/`)
  ) {
    throw new Error("github_workspace_codex_home_root_escape");
  }

  const codexHome = await mkdtemp(join(resolvedCodexHomeRoot, "run-"));
  await chmod(codexHome, 0o700);
  const resolvedCodexHome = await realpath(codexHome);
  if (!resolvedCodexHome.startsWith(`${resolvedCodexHomeRoot}/`)) {
    throw new Error("github_workspace_codex_home_escape");
  }
  return resolvedCodexHome;
}

export function requireRemainingReviewExecutionBudgetMs(input: {
  readonly executionDeadlineEpochMs: number;
  readonly nowEpochMs: number;
}): number {
  const remainingMs = remainingReviewExecutionBudgetMs(input);
  if (remainingMs === 0) {
    throw new Error("review_runtime_budget_exhausted_before_launch");
  }
  return remainingMs;
}

export async function runReviewRuntimeWithinExecutionBudget(input: {
  readonly executionDeadlineEpochMs: number;
  readonly now: () => number;
  readonly run: () => Promise<void>;
}): Promise<void> {
  requireRemainingReviewExecutionBudgetMs({
    executionDeadlineEpochMs: input.executionDeadlineEpochMs,
    nowEpochMs: input.now(),
  });
  await input.run();
}

async function runFullReviewRouterRuntime(input: {
  readonly inputs: ActionInputs;
  readonly leaseId: string;
  readonly codexBinaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly io: ActionIO;
  readonly fetchImpl: FetchLike;
  readonly workspace: string;
  readonly tempHome: string;
  readonly tempCodexHome: string;
  readonly event: PullRequestEvent;
  readonly commentToken: string;
  readonly commentTokenExpiresAt?: string | undefined;
  readonly runtimeConfigVersion: number;
  readonly runtimeEnv: Record<string, string>;
  readonly reviewSnapshotInputPath?: string | undefined;
  readonly reviewSnapshotOutputPath?: string | undefined;
  readonly reviewCheckpointFinalizationPath?: string | undefined;
  readonly executionDeadlineEpochMs: number;
  readonly onCommentTokenUpdated?: ((token: string) => void) | undefined;
}): Promise<void> {
  const actionPath = resolveGitHubActionPath(input.env);
  const runtimePath = join(actionPath, "dist", "index.js");
  await access(runtimePath, fsConstants.R_OK);
  const reviewThreadLifecycleResolveToken =
    input.env[reviewThreadLifecycleResolveTokenEnvKey]?.trim() || undefined;
  if (reviewThreadLifecycleResolveToken) {
    mask(input.io, reviewThreadLifecycleResolveToken);
  }

  const codexBinDir = await makeTempDirectory("reviewrouter-codex-bin-");
  let headSupervisor: PullRequestHeadSupervisor | undefined;
  try {
    let headCheckToken = input.commentToken;
    let headCheckFailureReported = false;
    headSupervisor = await startPullRequestHeadSupervisor({
      expectedHeadSha: input.event.headSha,
      readCurrentHeadSha: async (signal) => {
        try {
          return await fetchCurrentPullRequestHeadSha({
            fetchImpl: input.fetchImpl,
            token: headCheckToken,
            event: input.event,
            signal,
          });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "github_pull_request_head_auth_expired"
          ) {
            throw error;
          }
          const refreshedToken = await postJson<CommentTokenResponse>({
            fetchImpl: input.fetchImpl,
            label: "api_comment_token_refresh",
            url: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/comment-token`,
            body: {
              leaseId: input.leaseId,
              providerInstanceId: input.inputs.providerInstanceId,
              authCleared: true,
            },
            signal,
          });
          if (refreshedToken.repository !== input.event.repository) {
            throw new Error("comment_token_repository_mismatch", {
              cause: error,
            });
          }
          mask(input.io, refreshedToken.token);
          headCheckToken = refreshedToken.token;
          input.onCommentTokenUpdated?.(refreshedToken.token);
          return fetchCurrentPullRequestHeadSha({
            fetchImpl: input.fetchImpl,
            token: headCheckToken,
            event: input.event,
            signal,
          });
        }
      },
      shouldFailOpen: (error) => !isPermanentPullRequestHeadPollFailure(error),
      onPollFailure: () => {
        if (headCheckFailureReported) return;
        headCheckFailureReported = true;
        notice(
          input.io,
          "ReviewRouter could not verify the live PR head; the current review continues and will be rechecked.",
        );
      },
    });

    await symlink(input.codexBinaryPath, join(codexBinDir, "codex"));
    const childEnv = buildFullReviewRuntimeEnv({
      sourceEnv: input.env,
      inputs: input.inputs,
      leaseId: input.leaseId,
      event: input.event,
      workspace: input.workspace,
      tempHome: input.tempHome,
      tempCodexHome: input.tempCodexHome,
      codexBinDir,
      commentToken: input.commentToken,
      commentTokenExpiresAt: input.commentTokenExpiresAt,
      runtimeConfigVersion: input.runtimeConfigVersion,
      runtimeEnv: input.runtimeEnv,
      reviewThreadLifecycleResolveToken,
      reviewSnapshotInputPath: input.reviewSnapshotInputPath,
      reviewSnapshotOutputPath: input.reviewSnapshotOutputPath,
      reviewCheckpointFinalizationPath: input.reviewCheckpointFinalizationPath,
      executionDeadlineEpochMs: input.executionDeadlineEpochMs,
    });
    const toolInstallTimeoutMs = Math.min(
      2 * 60 * 1000,
      requireRemainingReviewExecutionBudgetMs({
        executionDeadlineEpochMs: input.executionDeadlineEpochMs,
        nowEpochMs: Date.now(),
      }),
    );
    await ensureFullReviewRuntimeTools({
      env: childEnv,
      io: input.io,
      workspace: input.workspace,
      runtimeEnv: input.runtimeEnv,
      timeoutMs: toolInstallTimeoutMs,
      abortSignal: headSupervisor.signal,
    });
    const runtimeTimeoutMs = requireRemainingReviewExecutionBudgetMs({
      executionDeadlineEpochMs: input.executionDeadlineEpochMs,
      nowEpochMs: Date.now(),
    });
    await runProcess({
      command: process.execPath,
      args: [runtimePath],
      cwd: input.workspace,
      env: childEnv,
      streamOutput: input.io,
      timeoutMs: runtimeTimeoutMs,
      abortSignal: headSupervisor.signal,
    });
  } catch (error) {
    throw classifyPostWritebackCodexFailure(error);
  } finally {
    headSupervisor?.stop();
    await removeTree(codexBinDir);
  }
}

function isPermanentPullRequestHeadPollFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "comment_token_repository_mismatch" ||
      error.message === "github_pull_request_head_auth_expired")
  );
}

export function buildFullReviewRuntimeEnv(input: {
  readonly sourceEnv: NodeJS.ProcessEnv;
  readonly inputs: ActionInputs;
  readonly leaseId: string;
  readonly event: PullRequestEvent;
  readonly workspace: string;
  readonly tempHome: string;
  readonly tempCodexHome: string;
  readonly codexBinDir: string;
  readonly commentToken: string;
  readonly commentTokenExpiresAt?: string | undefined;
  readonly runtimeConfigVersion: number;
  readonly runtimeEnv: Record<string, string>;
  readonly reviewThreadLifecycleResolveToken?: string | undefined;
  readonly reviewSnapshotInputPath?: string | undefined;
  readonly reviewSnapshotOutputPath?: string | undefined;
  readonly reviewCheckpointFinalizationPath?: string | undefined;
  readonly executionDeadlineEpochMs?: number | undefined;
}): Record<string, string> {
  const inherited = pruneCodexRotatingChildEnv(input.sourceEnv);
  const runtimeEnv = normalizeFullReviewRuntimeEnv(input.runtimeEnv);
  const reviewAuthMode =
    runtimeEnv.REVIEW_AUTH_MODE === codexRotatingRuntimeAuthMode
      ? "codex-oauth"
      : (runtimeEnv.REVIEW_AUTH_MODE ?? "codex-oauth");
  const providerSecretEnv = buildProviderSecretEnvForRuntime({
    runtimeEnv,
    providerSecrets: input.inputs.providerSecrets,
  });
  const reviewThreadLifecycleResolveEnv =
    input.reviewThreadLifecycleResolveToken
      ? {
          [reviewThreadLifecycleResolveTokenEnvKey]:
            input.reviewThreadLifecycleResolveToken,
        }
      : {};
  const executionDeadlineEpochMs =
    input.executionDeadlineEpochMs ??
    createReviewExecutionDeadlineEpochMs({
      jobTimeoutMinutes: input.inputs.reviewTimeoutMinutes,
      executionStartedAtEpochMs: Date.now(),
    });
  return {
    ...inherited,
    ...runtimeEnv,
    ...providerSecretEnv,
    ...reviewThreadLifecycleResolveEnv,
    HOME: input.tempHome,
    CODEX_HOME: input.tempCodexHome,
    GITHUB_WORKSPACE: input.workspace,
    CI: "true",
    PATH: `${input.codexBinDir}:${join(input.tempHome, ".local", "bin")}:${input.sourceEnv.PATH ?? process.env.PATH ?? ""}`,
    GITHUB_OUTPUT: join(input.tempHome, "github-output"),
    GITHUB_TOKEN: input.commentToken,
    PR_NUMBER: String(input.event.number),
    REVIEW_AUTH_MODE: reviewAuthMode,
    CODEX_AGENTIC_AUDIT: runtimeEnv.CODEX_AGENTIC_AUDIT ?? "rerun",
    FAIL_ON_NO_HEALTHY_PROVIDERS:
      runtimeEnv.FAIL_ON_NO_HEALTHY_PROVIDERS ?? "true",
    REVIEWROUTER_RUNTIME_CONFIG_MODE: "static",
    REVIEWROUTER_STATIC_CONFIG_FALLBACK: "false",
    REVIEWROUTER_COMMENT_TOKEN_MODE: "codex-oauth-rotating",
    REVIEWROUTER_COMMENT_TOKEN_REFRESH_URL: `${input.inputs.apiUrl}/api/action/v1/codex-oauth/comment-token`,
    REVIEWROUTER_COMMENT_TOKEN_LEASE_ID: input.leaseId,
    REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID:
      input.inputs.providerInstanceId,
    ...(input.commentTokenExpiresAt
      ? {
          REVIEWROUTER_COMMENT_TOKEN_EXPIRES_AT: input.commentTokenExpiresAt,
        }
      : {}),
    REVIEWROUTER_SCM_PROVIDER: "github",
    REVIEWROUTER_FINDINGS_ARTIFACT_PATH:
      providerNeutralReviewFindingsArtifactFileName,
    REVIEWROUTER_REPOSITORY_EXTERNAL_ID:
      input.event.repositoryId ?? input.event.repository,
    REVIEWROUTER_REPOSITORY_FULL_NAME: input.event.repository,
    REVIEWROUTER_CHANGE_REQUEST_EXTERNAL_ID: String(input.event.number),
    REVIEWROUTER_HEAD_SHA: input.event.headSha,
    REVIEWROUTER_BASE_SHA: input.event.baseSha,
    REVIEWROUTER_REVIEW_MARKER: `reviewrouter:codex-oauth-rotating head=${input.event.headSha}`,
    REVIEWROUTER_API_URL: input.inputs.apiUrl,
    REVIEWROUTER_CONTROL_PLANE_URL: input.inputs.apiUrl,
    REVIEWROUTER_CONFIG_VERSION: String(input.runtimeConfigVersion),
    REVIEWROUTER_EXECUTION_DEADLINE_EPOCH_MS: String(executionDeadlineEpochMs),
    REVIEWROUTER_REVIEW_CHECKPOINT_FINALIZATION_PATH:
      input.reviewCheckpointFinalizationPath ?? "",
    REVIEWROUTER_INCREMENTAL_SNAPSHOT_REQUIRED: "true",
    ...(input.reviewSnapshotInputPath
      ? {
          REVIEWROUTER_INCREMENTAL_SNAPSHOT_INPUT_PATH:
            input.reviewSnapshotInputPath,
        }
      : {}),
    ...(input.reviewSnapshotOutputPath
      ? {
          REVIEWROUTER_INCREMENTAL_SNAPSHOT_OUTPUT_PATH:
            input.reviewSnapshotOutputPath,
        }
      : {}),
  };
}

function buildProviderSecretEnvForRuntime(input: {
  readonly runtimeEnv: Readonly<Record<string, string>>;
  readonly providerSecrets: ProviderSecretInputs;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (
    runtimeProvidersInclude(input.runtimeEnv, "claude/") &&
    input.providerSecrets.claudeCodeOAuthToken
  ) {
    env.CLAUDE_CODE_OAUTH_TOKEN = input.providerSecrets.claudeCodeOAuthToken;
  }
  if (
    runtimeProvidersInclude(input.runtimeEnv, "openrouter/") &&
    input.providerSecrets.openRouterApiKey
  ) {
    env.OPENROUTER_API_KEY = input.providerSecrets.openRouterApiKey;
  }
  return env;
}

async function ensureFullReviewRuntimeTools(input: {
  readonly env: Record<string, string>;
  readonly io: ActionIO;
  readonly workspace: string;
  readonly runtimeEnv: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal | undefined;
}): Promise<void> {
  if (!runtimeProvidersInclude(input.runtimeEnv, "claude/")) {
    return;
  }

  await runProcess({
    command: "bash",
    args: [
      "-lc",
      [
        "set -euo pipefail",
        "if command -v claude >/dev/null 2>&1; then",
        "  claude --version",
        "else",
        "  curl -fsSL https://claude.ai/install.sh | bash -s stable",
        '  "$HOME/.local/bin/claude" --version',
        "fi",
      ].join("\n"),
    ],
    cwd: input.workspace,
    env: buildToolInstallEnv(input.env),
    streamOutput: input.io,
    timeoutMs: input.timeoutMs,
    abortSignal: input.abortSignal,
  });
}

function buildToolInstallEnv(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    HOME: env.HOME ?? "",
    PATH: env.PATH ?? "",
    CI: "true",
  };
}

function runtimeProvidersInclude(
  runtimeEnv: Readonly<Record<string, string>>,
  providerPrefix: string,
): boolean {
  return (runtimeEnv.REVIEW_PROVIDERS ?? "")
    .split(",")
    .some((provider) => provider.trim().startsWith(providerPrefix));
}

const forkRuntimeEnvAllowedKeys = new Set([
  "REVIEWROUTER_CONFIG_SCHEMA_VERSION",
  "REVIEW_AUTH_MODE",
  "INLINE_MAX_COMMENTS",
  "TARGET_TOKENS_PER_BATCH",
  "FAIL_ON_SEVERITY",
  "REVIEW_OUTPUT_LANGUAGE",
  "CODEX_MODEL",
  "CODEX_REASONING_EFFORT",
  "CODEX_AGENTIC_CONTEXT",
  "CODEX_FAST_MODE",
  "CODEX_AGENTIC_AUDIT",
  "CODEX_EVENT_AUDIT",
  "CLAUDE_MODEL",
  "CLAUDE_AGENTIC_CONTEXT",
  "FAIL_ON_NO_HEALTHY_PROVIDERS",
]);

const certifiedForkAgenticProviderPrefixes = [
  "codex/",
  "claude/",
  "openrouter/",
  "codex-openrouter/",
] as const;

function forkAgenticSandboxRuntimeEnv(
  runtimeEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const normalized = normalizeFullReviewRuntimeEnv(runtimeEnv);
  const forkProviders = parseRuntimeProviders(
    normalized.REVIEW_PROVIDERS,
  ).filter(isCertifiedForkAgenticProvider);
  if (forkProviders.length === 0) {
    throw new Error("fork_agentic_sandbox_requires_certified_provider");
  }
  const primaryProvider = forkProviders[0]!;
  const allowedRuntimeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (forkRuntimeEnvAllowedKeys.has(key)) {
      allowedRuntimeEnv[key] = value;
    }
  }
  const providerLimit = Math.min(
    forkRuntimePositiveInteger(normalized.PROVIDER_LIMIT, forkProviders.length),
    forkProviders.length,
  );
  const providerMaxParallel = Math.min(
    forkRuntimePositiveInteger(normalized.PROVIDER_MAX_PARALLEL, providerLimit),
    providerLimit,
  );
  const requiredHealthyProviders = parseRuntimeProviders(
    normalized.REQUIRED_HEALTHY_PROVIDERS,
  ).filter((provider) => forkProviders.includes(provider));
  const synthesisModel = forkProviders.includes(
    normalized.SYNTHESIS_MODEL ?? "",
  )
    ? normalized.SYNTHESIS_MODEL!
    : primaryProvider;
  const inlineMinAgreement = Math.min(
    forkRuntimePositiveInteger(normalized.INLINE_MIN_AGREEMENT, 1),
    providerLimit,
  );
  const forkEnv: Record<string, string> = {
    ...allowedRuntimeEnv,
    REVIEW_PROVIDERS: forkProviders.join(","),
    REQUIRED_HEALTHY_PROVIDERS:
      requiredHealthyProviders.length > 0
        ? requiredHealthyProviders.join(",")
        : primaryProvider,
    SYNTHESIS_MODEL: synthesisModel,
    PROVIDER_LIMIT: String(providerLimit),
    PROVIDER_MAX_PARALLEL: String(providerMaxParallel),
    INLINE_MIN_AGREEMENT: String(inlineMinAgreement),
    REVIEWROUTER_FORK_AGENTIC_SANDBOX: "true",
  };
  if (forkProviders.some((provider) => provider.startsWith("claude/"))) {
    forkEnv.CLAUDE_AGENTIC_CONTEXT = "true";
  }
  return forkEnv;
}

function parseRuntimeProviders(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
}

function isCertifiedForkAgenticProvider(provider: string): boolean {
  return certifiedForkAgenticProviderPrefixes.some((prefix) =>
    provider.startsWith(prefix),
  );
}

function forkRuntimePositiveInteger(
  value: string | undefined,
  defaultValue: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

function codexModelForForkRuntime(
  runtimeEnv: Readonly<Record<string, string>>,
): string {
  const provider = (runtimeEnv.REVIEW_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("codex/"));
  const modelFromProvider = provider?.slice("codex/".length);
  return modelFromProvider || runtimeEnv.CODEX_MODEL || "gpt-5.5";
}

function extractCodexAccessToken(authJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    throw new Error("codex_auth_json_invalid_json");
  }
  const accessToken =
    typeof parsed === "object" &&
    parsed !== null &&
    "tokens" in parsed &&
    typeof parsed.tokens === "object" &&
    parsed.tokens !== null &&
    "access_token" in parsed.tokens &&
    typeof parsed.tokens.access_token === "string"
      ? parsed.tokens.access_token
      : "";
  if (!accessToken) {
    throw new Error("codex_access_token_missing");
  }
  return accessToken;
}

function normalizeFullReviewRuntimeEnv(
  runtimeEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (!isSafeFullReviewRuntimeEnvKey(key)) {
      throw new Error(`unsafe_runtime_env_key:${safeEnvKeyLabel(key)}`);
    }
    if (typeof value !== "string") {
      throw new Error(`unsafe_runtime_env_value:${safeEnvKeyLabel(key)}`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function isSafeFullReviewRuntimeEnvKey(key: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    return false;
  }
  if (key === "TARGET_TOKENS_PER_BATCH") {
    return true;
  }
  return !/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|AUTH_JSON)/.test(key);
}

function safeEnvKeyLabel(key: string): string {
  return /^[A-Z_][A-Z0-9_]{0,80}$/.test(key) ? key : "<invalid-env-key>";
}

export async function postPullRequestComment(input: {
  readonly fetchImpl: FetchLike;
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly marker: string;
  readonly body: string;
}): Promise<void> {
  const commentsUrl = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments`;
  const { response: commentsResponse, body: comments } = await fetchWithRetry({
    fetchImpl: input.fetchImpl,
    label: "github_comment_lookup",
    timeoutMs: githubRequestTimeoutMs,
    url: `${commentsUrl}?per_page=100`,
    init: {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
    consume: consumeJsonResponse,
  });
  if (!commentsResponse.ok) {
    throw new Error("github_comment_lookup_failed");
  }
  if (!Array.isArray(comments)) {
    throw new Error("github_comment_lookup_invalid");
  }
  const existing = comments.find(
    (comment): comment is GitHubIssueCommentResponse =>
      typeof comment === "object" &&
      comment !== null &&
      typeof (comment as GitHubIssueCommentResponse).id === "number" &&
      typeof (comment as GitHubIssueCommentResponse).body === "string" &&
      (comment as GitHubIssueCommentResponse).body!.startsWith(input.marker),
  );
  if (existing) {
    const updateResponse = await fetchWithRetry({
      fetchImpl: input.fetchImpl,
      label: "github_comment_update",
      timeoutMs: githubRequestTimeoutMs,
      url: `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/comments/${existing.id}`,
      init: {
        method: "PATCH",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ body: input.body }),
      },
      consume: consumeResponseBody,
    });
    if (!updateResponse.ok) {
      throw new Error("github_comment_update_failed");
    }
    return;
  }

  const createResponse = await fetchWithRetry({
    fetchImpl: input.fetchImpl,
    label: "github_comment_create",
    timeoutMs: githubRequestTimeoutMs,
    url: commentsUrl,
    init: {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ body: input.body }),
    },
    consume: consumeResponseBody,
  });
  if (!createResponse.ok) {
    throw new Error("github_comment_post_failed");
  }
}

export async function deleteStaleCodexRotatingSummaryComments(input: {
  readonly fetchImpl: FetchLike;
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}): Promise<void> {
  const commentsUrl = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments`;
  const { response: commentsResponse, body: comments } = await fetchWithRetry({
    fetchImpl: input.fetchImpl,
    label: "github_stale_comment_lookup",
    timeoutMs: githubRequestTimeoutMs,
    url: `${commentsUrl}?per_page=100`,
    init: {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
    consume: consumeJsonResponse,
  });
  if (!commentsResponse.ok) {
    throw new Error("github_stale_comment_lookup_failed");
  }
  if (!Array.isArray(comments)) {
    throw new Error("github_stale_comment_lookup_invalid");
  }
  const staleComments = comments.filter(
    (comment): comment is GitHubIssueCommentResponse =>
      typeof comment === "object" &&
      comment !== null &&
      typeof (comment as GitHubIssueCommentResponse).id === "number" &&
      typeof (comment as GitHubIssueCommentResponse).body === "string" &&
      (comment as GitHubIssueCommentResponse).body!.startsWith(
        "<!-- reviewrouter:codex-oauth-rotating",
      ),
  );
  for (const comment of staleComments) {
    const deleteResponse = await fetchWithRetry({
      fetchImpl: input.fetchImpl,
      label: "github_stale_comment_delete",
      timeoutMs: githubRequestTimeoutMs,
      url: `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/comments/${comment.id}`,
      init: {
        method: "DELETE",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "x-github-api-version": "2022-11-28",
        },
      },
      consume: consumeResponseBody,
    });
    if (!deleteResponse.ok) {
      throw new Error("github_stale_comment_delete_failed");
    }
  }
}

class GitHubProgressCommentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function deleteFullRuntimeProgressCommentsWithTokenRefresh(input: {
  readonly fetchImpl: FetchLike;
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly refreshToken: () => Promise<string>;
}): Promise<string> {
  try {
    await deleteFullRuntimeProgressComments(input);
    return input.token;
  } catch (error) {
    if (
      !(error instanceof GitHubProgressCommentRequestError) ||
      error.status !== 401
    ) {
      throw error;
    }
    const refreshedToken = await input.refreshToken();
    await deleteFullRuntimeProgressComments({
      ...input,
      token: refreshedToken,
    });
    return refreshedToken;
  }
}

export async function deleteFullRuntimeProgressComments(input: {
  readonly fetchImpl: FetchLike;
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}): Promise<void> {
  const commentsUrl = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments`;
  const { response: commentsResponse, body: comments } = await fetchWithRetry({
    fetchImpl: input.fetchImpl,
    label: "github_progress_comment_lookup",
    timeoutMs: githubRequestTimeoutMs,
    url: `${commentsUrl}?per_page=100`,
    init: {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
    consume: consumeJsonResponse,
  });
  if (!commentsResponse.ok) {
    throw new GitHubProgressCommentRequestError(
      "github_progress_comment_lookup_failed",
      commentsResponse.status,
    );
  }
  if (!Array.isArray(comments)) {
    throw new Error("github_progress_comment_lookup_invalid");
  }
  const progressComments = comments.filter(
    (comment): comment is GitHubIssueCommentResponse =>
      typeof comment === "object" &&
      comment !== null &&
      typeof (comment as GitHubIssueCommentResponse).id === "number" &&
      typeof (comment as GitHubIssueCommentResponse).body === "string" &&
      (comment as GitHubIssueCommentResponse).body!.includes(
        fullRuntimeProgressCommentMarker,
      ),
  );
  for (const comment of progressComments) {
    const deleteResponse = await fetchWithRetry({
      fetchImpl: input.fetchImpl,
      label: "github_progress_comment_delete",
      timeoutMs: githubRequestTimeoutMs,
      url: `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/comments/${comment.id}`,
      init: {
        method: "DELETE",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "x-github-api-version": "2022-11-28",
        },
      },
      consume: consumeResponseBody,
    });
    if (!deleteResponse.ok) {
      throw new GitHubProgressCommentRequestError(
        "github_progress_comment_delete_failed",
        deleteResponse.status,
      );
    }
  }
}

function buildCodexChildEnv(
  sourceEnv: NodeJS.ProcessEnv,
  home: string,
  codexHome: string,
): Record<string, string> {
  return {
    ...pruneCodexRotatingChildEnv(sourceEnv),
    HOME: home,
    CODEX_HOME: codexHome,
    CI: "true",
  };
}

function runGit(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  return runProcess({
    command: "git",
    args,
    cwd,
    env,
    timeoutMs: 5 * 60 * 1000,
  });
}

class ProcessExecutionError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
  }
}

class AlreadyReportedRuntimeFailure extends Error {
  readonly alreadyReportedToGitHub = true;
}

type KillableChildProcess = Pick<ReturnType<typeof spawn>, "pid" | "kill">;

type UnixProcessEntry = {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
};

type CapturedUnixProcessTree = {
  readonly rootPid: number;
  readonly processGroupIds: readonly number[];
};

function captureUnixProcessTree(
  rootPid: number,
): CapturedUnixProcessTree | null {
  if (process.platform === "win32") return null;
  try {
    const output = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const entries = output
      .split("\n")
      .map((line): UnixProcessEntry | null => {
        const [pid, parentPid, processGroupId] = line
          .trim()
          .split(/\s+/)
          .map(Number);
        if (
          !Number.isSafeInteger(pid) ||
          !Number.isSafeInteger(parentPid) ||
          !Number.isSafeInteger(processGroupId)
        ) {
          return null;
        }
        return {
          pid: pid!,
          parentPid: parentPid!,
          processGroupId: processGroupId!,
        };
      })
      .filter((entry): entry is UnixProcessEntry => entry !== null);
    const descendants = new Set<number>([rootPid]);
    let foundNewDescendant = true;
    while (foundNewDescendant) {
      foundNewDescendant = false;
      for (const entry of entries) {
        if (descendants.has(entry.parentPid) && !descendants.has(entry.pid)) {
          descendants.add(entry.pid);
          foundNewDescendant = true;
        }
      }
    }
    const ownProcessGroupId = entries.find(
      (entry) => entry.pid === process.pid,
    )?.processGroupId;
    const processGroupIds = new Set<number>();
    for (const entry of entries) {
      if (
        descendants.has(entry.pid) &&
        entry.processGroupId > 0 &&
        entry.processGroupId !== ownProcessGroupId
      ) {
        processGroupIds.add(entry.processGroupId);
      }
    }
    if (processGroupIds.size === 0 && rootPid > 0) {
      processGroupIds.add(rootPid);
    }
    return {
      rootPid,
      processGroupIds: [...processGroupIds].sort((left, right) => {
        if (left === rootPid) return 1;
        if (right === rootPid) return -1;
        return left - right;
      }),
    };
  } catch {
    return null;
  }
}

function signalCapturedUnixProcessTree(
  tree: CapturedUnixProcessTree,
  signal: NodeJS.Signals,
): boolean {
  let signaled = false;
  for (const processGroupId of tree.processGroupIds) {
    try {
      process.kill(-processGroupId, signal);
      signaled = true;
    } catch {
      // Continue signaling the remaining captured groups; termination is best effort.
    }
  }
  return signaled;
}

export function signalProcessTree(
  child: KillableChildProcess,
  signal: NodeJS.Signals,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly killProcessGroup?: typeof process.kill;
  } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && child.pid !== undefined) {
    try {
      (options.killProcessGroup ?? process.kill)(-child.pid, signal);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return false;
      }
    }
  }
  return child.kill(signal);
}

export function runProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Record<string, string>;
  readonly stdin?: string;
  readonly streamOutput?: ActionIO;
  readonly timeoutMs: number;
  readonly terminationGracePeriodMs?: number;
  readonly abortSignal?: AbortSignal | undefined;
}): Promise<void> {
  if (input.abortSignal?.aborted) {
    return Promise.reject(processAbortError(input.abortSignal));
  }
  return new Promise((resolve, reject) => {
    const outputChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminationError: unknown;
    let terminationProcessTree: CapturedUnixProcessTree | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const settle = (result: { readonly error?: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.abortSignal?.removeEventListener("abort", onAbort);
      if (result.error !== undefined) {
        reject(result.error);
      } else {
        resolve();
      }
    };
    const requestTermination = (error: unknown): void => {
      if (settled || terminationError !== undefined) return;
      terminationError = error;
      terminationProcessTree =
        child.pid === undefined ? null : captureUnixProcessTree(child.pid);
      if (terminationProcessTree) {
        signalCapturedUnixProcessTree(terminationProcessTree, "SIGTERM");
      } else {
        signalProcessTree(child, "SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        if (terminationProcessTree) {
          signalCapturedUnixProcessTree(terminationProcessTree, "SIGKILL");
        } else {
          signalProcessTree(child, "SIGKILL");
        }
        settle({ error: terminationError });
      }, input.terminationGracePeriodMs ?? processTerminationGracePeriodMs);
    };
    const onAbort = (): void => {
      requestTermination(processAbortError(input.abortSignal!));
    };
    const timer = setTimeout(
      () => requestTermination(new Error("process_timeout")),
      input.timeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      writeProcessLogChunk(input.streamOutput?.stdout, chunk);
      outputBytes = appendCapturedChunk(
        outputChunks,
        outputBytes,
        Buffer.from(chunk),
      );
    });
    child.stderr.on("data", (chunk) => {
      writeProcessLogChunk(input.streamOutput?.stderr, chunk);
      outputBytes = appendCapturedChunk(
        outputChunks,
        outputBytes,
        Buffer.from(chunk),
      );
    });
    child.on("error", (error) => {
      if (terminationError !== undefined && process.platform !== "win32") {
        return;
      }
      settle({ error: terminationError ?? error });
    });
    child.on("close", (code) => {
      if (terminationError !== undefined) {
        if (process.platform === "win32") {
          settle({ error: terminationError });
        }
        return;
      }
      if (code === 0) {
        settle({});
      } else {
        settle({
          error: new ProcessExecutionError(
            `process_failed:${input.command}:${code ?? "signal"}`,
            Buffer.concat(outputChunks).toString("utf8"),
          ),
        });
      }
    });
    input.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (input.abortSignal?.aborted) {
      onAbort();
    }
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.stdin ?? "");
  });
}

function processAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("process_aborted");
}

function writeProcessLogChunk(
  stream: Pick<NodeJS.WriteStream, "write"> | undefined,
  chunk: unknown,
): void {
  if (!stream) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  stream.write(sanitizeProcessLogChunk(text));
}

function appendCapturedChunk(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
): number {
  const remaining = maxCapturedProcessOutputBytes - currentBytes;
  if (remaining <= 0) {
    return currentBytes;
  }
  const nextChunk =
    chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(nextChunk);
  return currentBytes + nextChunk.byteLength;
}

function classifyCodexBootstrapFailure(error: unknown): Error {
  const output = getProcessFailureOutput(error);
  const state = classifyCodexRuntimeFailure(output);
  if (
    state === "needs_reconnect" ||
    state === "quota_limited" ||
    state === "permission_required"
  ) {
    return new Error(state);
  }
  return new Error(
    `unknown_auth_state:${sanitizeProcessFailureOutput(output)}`,
  );
}

function classifyPostWritebackCodexFailure(error: unknown): Error {
  if (isStalePullRequestHeadError(error)) {
    return error;
  }
  if (
    error instanceof Error &&
    error.message === "review_runtime_budget_exhausted_before_launch"
  ) {
    return error;
  }
  if (error instanceof Error && error.message === "process_timeout") {
    return new Error("review_runtime_timeout");
  }
  const output = getProcessFailureOutput(error);
  if (isReviewRouterTargetRevisionMismatchFailure(output)) {
    return new Error(stalePullRequestHeadErrorCode);
  }
  const reviewFailure = extractReviewRouterRuntimeFailure(output);
  if (reviewFailure) {
    return new AlreadyReportedRuntimeFailure(reviewFailure);
  }
  const state = classifyCodexRuntimeFailure(output);
  if (state === "quota_limited") {
    return new Error("quota_limited");
  }
  return new Error(
    `unknown_auth_state:${sanitizeProcessFailureOutput(output)}`,
  );
}

export function extractReviewRouterRuntimeFailure(
  output: string,
): string | undefined {
  const match = output.match(
    /(?:ReviewRouter found [^\r\n]+|Review failed \[[^\r\n]+)(?:\r?\n|$)/,
  );
  return match?.[0]?.trim();
}

export function isReviewRouterTargetRevisionMismatchFailure(
  output: string,
): boolean {
  return (
    output.includes("review_action_v2_protocol_error") &&
    output.includes("operation=review_execution_supersede") &&
    output.includes("issues=target_revision_mismatch")
  );
}

export function shouldSuppressTopLevelActionError(error: unknown): boolean {
  return (
    error instanceof AlreadyReportedRuntimeFailure ||
    (typeof error === "object" &&
      error !== null &&
      (error as { readonly alreadyReportedToGitHub?: unknown })
        .alreadyReportedToGitHub === true)
  );
}

export function formatTopLevelActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  switch (message) {
    case "needs_reconnect":
      return "needs_reconnect: Codex OAuth session is expired or revoked. Reconnect the Codex provider in ReviewRouter.";
    case "quota_limited":
      return "quota_limited: Codex usage, rate, or billing limit was reached. Add credits, wait for reset, or change account entitlement.";
    case "permission_required":
      return "permission_required: Codex permission is required.";
    case "review_runtime_budget_exhausted_before_launch":
      return "review_runtime_budget_exhausted_before_launch: ReviewRouter prework consumed the runtime budget; the review was not launched so cleanup can finish safely.";
    case "review_runtime_timeout":
      return "review_runtime_timeout: ReviewRouter stopped the review at its cleanup deadline; resumable progress remains available for the next run.";
    default:
      return message;
  }
}

function getProcessFailureOutput(error: unknown): string {
  if (error instanceof ProcessExecutionError) {
    return error.output;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { readonly output?: unknown }).output === "string"
  ) {
    return (error as { readonly output: string }).output;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sanitizeProcessFailureOutput(output: string): string {
  const sanitized = output
    .replace(/auth\.json["'\s:=]+[^\s"'`]+/gi, "auth.json: [redacted]")
    .replace(
      /\b(refresh_token|access_token|id_token)\b["'\s:=]+[A-Za-z0-9._~+/=-]+/gi,
      "$1: [redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9._~+/=-]{80,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? limitUtf8Tail(sanitized, 1_000) : "empty_process_output";
}

function sanitizeProcessLogChunk(output: string): string {
  return output
    .replace(/auth\.json["'\s:=]+[^\s"'`]+/gi, "auth.json: [redacted]")
    .replace(
      /\b(refresh_token|access_token|id_token)\b["'\s:=]+[A-Za-z0-9._~+/=-]+/gi,
      "$1: [redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9._~+/=-]{120,}/g, "[redacted]");
}

async function removeTree(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  });
}

async function makeTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function buildWritebackIdempotencyKey(
  env: NodeJS.ProcessEnv,
  leaseId: string,
): string {
  const runId = env.GITHUB_RUN_ID || "local";
  const runAttempt = env.GITHUB_RUN_ATTEMPT || "1";
  const digest = createHash("sha256")
    .update(`${leaseId}:${runId}:${runAttempt}`)
    .digest("hex")
    .slice(0, 24);
  return `idem:${runId}:${runAttempt}:${digest}`;
}

function clearActionAuthEnv(env: NodeJS.ProcessEnv): void {
  delete env["INPUT_AUTH-JSON"];
  delete env.INPUT_AUTH_JSON;
  delete env.CODEX_AUTH_JSON;
  delete env.REVIEWROUTER_CODEX_AUTH_JSON;
  clearActionProviderSecretEnv(env);
}

function clearActionProviderSecretEnv(env: NodeJS.ProcessEnv): void {
  delete env["INPUT_CLAUDE-CODE-OAUTH-TOKEN"];
  delete env.INPUT_CLAUDE_CODE_OAUTH_TOKEN;
  delete env["INPUT_OPENROUTER-API-KEY"];
  delete env.INPUT_OPENROUTER_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.OPENROUTER_API_KEY;
}

function maskProviderSecretInputs(
  io: ActionIO,
  providerSecrets: ProviderSecretInputs,
): void {
  if (providerSecrets.claudeCodeOAuthToken) {
    mask(io, providerSecrets.claudeCodeOAuthToken);
  }
  if (providerSecrets.openRouterApiKey) {
    mask(io, providerSecrets.openRouterApiKey);
  }
}

function clearOidcRequestEnv(env: NodeJS.ProcessEnv): void {
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
}

function notice(io: ActionIO, message: string): void {
  io.stdout.write(`::notice::${escapeCommandValue(message)}\n`);
}

function mask(io: ActionIO, value: string): void {
  if (value.length > 0) {
    io.stdout.write(`::add-mask::${escapeCommandValue(value)}\n`);
  }
}

function escapeCommandValue(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function limitUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return Buffer.from(value, "utf8")
    .subarray(0, maxBytes - 80)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "")
    .concat("\n\n[ReviewRouter truncated this comment for GitHub limits.]");
}

function limitUtf8Tail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return Buffer.from(value, "utf8")
    .subarray(-maxBytes)
    .toString("utf8")
    .replace(/^\uFFFD+/u, "")
    .replace(/^[^\s]+/, "[truncated]");
}

function safeRemoteError(payload: unknown, status: number): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof (payload as { readonly error?: unknown }).error === "object"
  ) {
    const error = (payload as { readonly error: { readonly code?: unknown } })
      .error;
    if (typeof error.code === "string") return error.code;
  }
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof (payload as { readonly error?: unknown }).error === "string"
  ) {
    return (payload as { readonly error: string }).error;
  }
  return `reviewrouter_api_error:${status}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid_event_field:${field}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid_event_field:${field}`);
  }
  return value;
}

function isSafeGitHubNumericId(value: unknown): value is number | string {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0;
  }
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function requireSha(value: unknown, field: string): string {
  const sha = requireString(value, field);
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error(`invalid_event_field:${field}`);
  }
  return sha;
}

export function shouldAutoRunCodexRotatingAction(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
}): boolean {
  if (input.env.REVIEW_ROUTER_RUN_CODEX_ROTATING_ACTION === "1") {
    return true;
  }
  if (input.env.GITHUB_ACTIONS !== "true") {
    return false;
  }

  const entrypoint = input.argv[1] ?? "";
  return /(?:^|[\\/])action-dist[\\/]index\.cjs$/.test(entrypoint);
}

if (
  shouldAutoRunCodexRotatingAction({ env: process.env, argv: process.argv })
) {
  runCodexRotatingGitHubAction().catch((error: unknown) => {
    if (!shouldSuppressTopLevelActionError(error)) {
      process.stderr.write(
        `::error::${escapeCommandValue(formatTopLevelActionErrorMessage(error))}\n`,
      );
    }
    process.exitCode = 1;
  });
}
