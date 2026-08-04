import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

type Scenario =
  | "success"
  | "high_risk_proposal"
  | "tampered_seed_manifest"
  | "stale_revision"
  | "incomplete_path_chain";

type RunnerConfig = Readonly<{
  scenario: Scenario;
  apiUrl: string;
  oidcToken: string;
  actionSourceDir: string;
  actionRef: string;
  gatewayBundlePath: string;
  checkoutRoot: string;
  revision: Readonly<{
    baseSha: string;
    mergeBaseSha: string;
    headSha: string;
    reviewRevisionHash: string;
  }>;
  fullDiff: string;
  changedFiles: readonly Readonly<{
    path: string;
    previousPath: string | null;
    status: "modified";
    patch: string;
  }>[];
  releaseManifest: Readonly<Record<string, unknown>> & {
    runtimeEntrypointPath: string;
    runtimeEntrypointDigest: string;
    contextGatewayEntrypointPath: string;
    contextGatewayEntrypointDigest: string;
    contextGatewayPolicyVersion: string;
    reviewInvestigationCoverageProfileHash: string;
    reviewInvestigationPolicyHash: string;
  };
  releaseManifestCanonicalJson: string;
  releaseManifestHash: string;
}>;

type RecordingInputShape = Readonly<{
  invocation: Readonly<{
    requestedModel: string;
    manifestFacts: Readonly<{
      executionProfile: string;
      providerKind: string;
      toolPolicyHash: string;
    }>;
  }>;
  manifest: Readonly<{
    manifestKey: string;
    providerInvocationKey: string;
  }>;
}>;

const execFileAsync = promisify(execFile);
const resultMarker = "REVIEWROUTER_PAIRED_RESULT:";
const actionReleaseRelevantPaths = Object.freeze([
  ".github/workflows",
  "action-dist",
  "action.yml",
  "dist",
  "package-lock.json",
  "package.json",
  "scripts/generate-context-gateway-release-metadata.mjs",
  "src",
  "tsconfig.json",
]);

void main();

async function main(): Promise<void> {
  const config = await readConfig(process.argv[2]);
  let artifactsRoot: string | null = null;
  try {
    await assertExactActionCheckout(config);
    const modules = await loadActionModules(config.actionSourceDir);
    await assertExactActionReleaseArtifacts(
      config,
      modules.canonical.canonicalJson,
    );
    artifactsRoot = await mkdtemp(
      path.join(tmpdir(), "reviewrouter-paired-codex-"),
    );
    const fakeCodexPath = await buildFakeCodex(
      artifactsRoot,
      config.actionSourceDir,
    );
    const result = await executeScenario(config, modules, fakeCodexPath);
    emitResult(result);
  } catch (error) {
    emitResult(failureResult(config, error));
  } finally {
    if (artifactsRoot) {
      await rm(artifactsRoot, { recursive: true, force: true });
    }
  }
}

async function executeScenario(
  config: RunnerConfig,
  modules: Awaited<ReturnType<typeof loadActionModules>>,
  fakeCodexPath: string,
) {
  const {
    ReviewExecutionProviderKind,
    ReviewInvestigationRecordingMode,
    ReviewInvocationLeaseAcquireOutcomeStatus,
    ReviewTaskKind,
  } = modules.application;
  const { canonicalJson, sha256 } = modules.canonical;
  const client = new modules.client.ReviewActionV2Client({
    apiUrl: config.apiUrl,
    allowInsecureLocalhost: true,
    maxAttempts: 1,
    requestIdFactory: requestIdFactory(),
  });
  const controlPlane =
    new modules.controlPlane.ReviewActionV2ControlPlaneAdapter(client);
  const authorization = await controlPlane.authorize({
    oidcToken: config.oidcToken,
  });
  const investigationControlPlane =
    new modules.investigationControlPlane.ReviewActionV2InvestigationAdapter(
      client,
    );

  if (
    !modules.recording.matchesReviewInvestigationCapability({
      facts: authorization.facts,
      providerKind: ReviewExecutionProviderKind.Codex,
    })
  ) {
    throw new Error("paired_action_investigation_capability_mismatch");
  }

  const compatibilityKey = sha256("paired-action-saas-compatibility-v1");
  const batchId = modules.workPlan.createStableReviewBatchId({
    taskKind: ReviewTaskKind.FindingDiscovery,
    members: [
      {
        filename: "src/contract.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: config.fullDiff,
        language: "typescript",
      },
    ],
  });
  const plan = modules.workPlan.createStableReviewWorkPlan({
    reviewRevisionHash: config.revision.reviewRevisionHash,
    compatibilityKey,
    providers: [
      {
        providerName: "codex",
        providerKind: ReviewExecutionProviderKind.Codex,
        providerVoteIdentityHash:
          authorization.facts.providerVoteLanes[0]!.providerVoteIdentityHash,
        required: true,
        attemptBudget: 2,
        retryPolicyVersion: "paired-e2e-retry.v1",
      },
    ],
    batches: [
      {
        batchId,
        taskKind: ReviewTaskKind.FindingDiscovery,
        required: true,
      },
    ],
    maxWorkSlots: authorization.limits.maxWorkSlots,
    maxAttemptsPerSlot: authorization.limits.maxAttemptsPerSlot,
  });
  const assignment = plan.assignments[0]!;
  const executionId = sha256(
    `paired-execution:${authorization.authorizationId}:${plan.planHash}`,
  );
  const execution = await controlPlane.startExecution({
    authorization,
    idempotencyKey: sha256(`paired-start:${executionId}`),
    executionId,
    reviewRevisionHash: config.revision.reviewRevisionHash,
    compatibilityKey,
    planHash: plan.planHash,
    workSlotsCanonicalJson: plan.workSlotsCanonicalJson,
    workSlots: [assignment.workSlot],
    sourceRunId: authorization.facts.sourceRunId,
    sourceRunAttempt: authorization.facts.sourceRunAttempt,
  });

  const reviewPrompt = [
    "Review the disposable contract change and its repository relationships.",
    `REVIEWROUTER_PAIRED_E2E_SCENARIO:${
      config.scenario === "incomplete_path_chain" ||
      config.scenario === "high_risk_proposal"
        ? config.scenario
        : "success"
    }`,
  ].join("\n");
  const coverageManifest = modules.coverage.createReviewPromptCoverageManifest({
    workSlotId: assignment.workSlot.workSlotId,
    reviewRevisionHash: config.revision.reviewRevisionHash,
    assignedPaths: ["src/contract.ts"],
    pathCoverage: [
      {
        path: "src/contract.ts",
        kind: modules.coverage.ReviewPromptPathCoverageKind.FullPatch,
        contentHash: sha256(config.fullDiff),
      },
    ],
  });
  const probePlan = modules.probes.createReviewInvestigationProbePlan({
    files: config.changedFiles.map((file) => ({
      ...file,
      status: modules.probes.ReviewInvestigationChangedFileStatus.Modified,
    })),
    fullDiff: config.fullDiff,
  });
  const requestedModel = "gpt-paired-e2e";
  const preparedSeed = modules.seed.buildReviewInvestigationSeedEnvelope({
    canonicalInventory: await modules.inventory.buildCanonicalGitInventory({
      root: config.checkoutRoot,
      mergeBaseSha: config.revision.mergeBaseSha,
      headSha: config.revision.headSha,
    }),
    coverageManifest,
    probePlan,
    reviewPrompt,
    requestedModel,
  });
  const invocation = Object.freeze({
    workSlotId: assignment.workSlot.workSlotId,
    attemptOrdinal: 1,
    provider: "codex",
    requestedModel,
    reviewPrompt,
    immutableRequest: Object.freeze({ pairedE2E: true }),
    manifestFacts: Object.freeze({
      taskKindSet: Object.freeze([ReviewTaskKind.FindingDiscovery]),
      providerKind: ReviewExecutionProviderKind.Codex,
      providerCapabilityHash: sha256("paired-codex-capability-v1"),
      providerRequestEnvelopeHash: preparedSeed.hash,
      outputSchemaHash: sha256("paired-investigation-output-schema-v2"),
      filePatchManifestHash: sha256(config.fullDiff),
      contextManifestHash: coverageManifest.coverageHash,
      lifecycleTargetSetHash: null,
      liveLifecycleStateHash: null,
      toolPolicyHash: sha256("paired-context-gateway-tool-policy-v4"),
      executionProfile: "investigation_gateway_v1" as const,
      baseTreeHash: sha256(`base-tree:${config.revision.baseSha}`),
      environmentContractHash: sha256("paired-environment-contract-v1"),
    }),
    coverageManifest,
    investigationProbePlan: probePlan,
    investigationSeedEnvelope: preparedSeed,
  });
  const manifest =
    await new modules.invocationManifest.GeneratedProviderInvocationManifestAssembler(
      authorization,
      {},
      compatibilityKey,
    ).assemble(invocation);
  const ownerIdHash = sha256(`paired-owner:${executionId}`);
  const leaseOutcome = await controlPlane.acquireInvocationLease({
    authorization,
    idempotencyKey: sha256(`paired-lease:${executionId}`),
    execution,
    workSlot: assignment.workSlot,
    manifest,
    acquireRequestId: sha256(`paired-acquire:${executionId}`),
    ownerIdHash,
  });
  if (
    leaseOutcome.status !== ReviewInvocationLeaseAcquireOutcomeStatus.Acquired
  ) {
    throw new Error(`paired_invocation_lease_${leaseOutcome.status}`);
  }
  const lease = leaseOutcome.lease;
  try {
    if (
      config.scenario === "tampered_seed_manifest" ||
      config.scenario === "stale_revision"
    ) {
      const openInput = investigationOpenInput({
        authorization,
        execution,
        assignment,
        invocation,
        manifest,
        modules,
      });
      if (config.scenario === "tampered_seed_manifest") {
        const tampered = JSON.parse(preparedSeed.canonicalJson) as Record<
          string,
          unknown
        >;
        tampered.reviewPromptHash = sha256("tampered-review-prompt");
        const canonical = canonicalJson(tampered);
        await investigationControlPlane.open({
          ...openInput,
          seedEnvelope: { canonicalJson: canonical, hash: sha256(canonical) },
        });
      } else {
        await investigationControlPlane.open({
          ...openInput,
          reviewRevisionHash: sha256("stale-review-revision"),
        });
      }
      throw new Error(`paired_negative_unexpected_success:${config.scenario}`);
    }

    const gatewayFactory =
      new modules.gatewaySession.ContextGatewayInvocationSessionFactory(
        controlPlane,
        {
          checkoutRoot: config.checkoutRoot,
          gatewayBundlePath: config.gatewayBundlePath,
          policyVersion: config.releaseManifest.contextGatewayPolicyVersion,
        },
        new modules.gatewaySession.SubprocessRequiredContextWitnessRunner(),
      );
    const recording = new modules.recording.ReviewInvestigationRecordingAdapter(
      (recordingInput: RecordingInputShape) => {
        const gateway =
          new modules.gateway.ContextGatewayV4InvestigationAdapter(
            gatewayFactory,
            {
              revision: config.revision,
              preparedManifestKey: recordingInput.manifest.manifestKey,
              providerKind:
                recordingInput.invocation.manifestFacts.providerKind,
              requestedModel: recordingInput.invocation.requestedModel,
              executionProfile:
                recordingInput.invocation.manifestFacts.executionProfile,
              providerInvocationKey:
                recordingInput.manifest.providerInvocationKey,
              toolPolicyHash:
                recordingInput.invocation.manifestFacts.toolPolicyHash,
            },
          );
        const codex = new modules.codex.CodexReviewAgentAdapter(
          new modules.processRunner.NodeReviewAgentProcessRunner(),
          {
            binary: fakeCodexPath,
            reasoningEffort: "xhigh",
            executionSessions: gateway,
          },
        );
        const selector = new modules.selector.DeterministicReviewAgentSelector(
          [
            {
              providerKind:
                modules.runtimeProfile.ReviewAgentProviderKind.Codex,
              agent: codex,
              providerCredentialEnvironment: () => ({}),
            },
          ],
          {
            allowedProviderKinds: [
              modules.runtimeProfile.ReviewAgentProviderKind.Codex,
            ],
          },
        );
        return new modules.workSlot.RunInvestigationWorkSlot({
          controlPlane: investigationControlPlane,
          leases: new modules.recording.ManagedOnlyInvestigationLeaseAdapter(),
          turnRunner: new modules.turn.RunInvestigationTurn({
            controlPlane: investigationControlPlane,
            currency: {
              check: async () =>
                modules.investigationPort.ReviewInvestigationCurrency.Current,
            },
            gateway,
            agents: selector,
            now: () => new Date(),
          }),
        });
      },
      {
        workingDirectory: config.checkoutRoot,
        leaseDurationMs: 5 * 60_000,
        providerTimeoutMs: 60_000,
        certificateTtlMs: 60 * 60_000,
        minimumCapacityParkMs: 1_000,
        maxObligationsForTurn: 64,
        maxStateTransitions: 64,
        policy: modules.recording.REVIEW_INVESTIGATION_PRODUCTION_POLICY,
      },
      ReviewInvestigationRecordingMode.Authoritative,
      true,
    );
    if (!recording.supports({ workSlot: assignment.workSlot, invocation })) {
      throw new Error("paired_recording_adapter_rejected_invocation");
    }
    const observation = await recording.execute({
      authorization,
      execution,
      workSlot: assignment.workSlot,
      invocation,
      manifest,
      currentLease: () => lease,
      ownerIdHash,
      sourceReviewRevisionHash: config.revision.reviewRevisionHash,
      signal: new AbortController().signal,
    });
    return Object.freeze({
      ok: true,
      scenario: config.scenario,
      releaseManifestHash: config.releaseManifestHash,
      observation: Object.freeze({
        investigationCertificateId: observation.investigationCertificateId,
        investigationCertificateHash: observation.investigationCertificateHash,
        payloadHash: observation.payloadHash,
        qualityFlags: Object.freeze([...observation.qualityFlags]),
      }),
    });
  } finally {
    await controlPlane.releaseInvocationLease({
      idempotencyKey: sha256(`paired-release:${lease.leaseId}`),
      lease,
      ownerIdHash,
      releaseRequestId: sha256(`paired-release-request:${lease.leaseId}`),
    });
  }
}

function investigationOpenInput(input: {
  authorization: any;
  execution: any;
  assignment: any;
  invocation: any;
  manifest: any;
  modules: Awaited<ReturnType<typeof loadActionModules>>;
}) {
  return Object.freeze({
    authorizationToken: input.authorization.authorizationToken,
    authorizationId: input.authorization.authorizationId,
    executionId: input.execution.executionId,
    workSlotId: input.assignment.workSlot.workSlotId,
    reviewRevisionHash: input.authorization.facts.reviewRevisionHash,
    stableReviewUnitKey: input.assignment.workSlot.shardKey,
    providerVoteLaneId: input.assignment.workSlot.providerVoteIdentityHash,
    providerStrategyId: input.manifest.providerInvocationKey,
    runtimeProfile:
      input.modules.runtimeProfile.ReviewAgentExecutionProfile
        .GatewayAttestedAgentV1,
    coverageContract:
      input.modules.recording.reviewInvestigationCoverageContract(
        input.authorization.facts.producerReleaseId,
      ),
    investigationPolicy:
      input.modules.recording.REVIEW_INVESTIGATION_PRODUCTION_POLICY,
    seedEnvelope: input.invocation.investigationSeedEnvelope,
    initialReceipts: [],
  });
}

async function loadActionModules(actionSourceDir: string) {
  const load = (relativePath: string) =>
    import(pathToFileURL(path.join(actionSourceDir, relativePath)).href);
  const [
    client,
    controlPlane,
    investigationControlPlane,
    recording,
    application,
    workPlan,
    invocationManifest,
    coverage,
    probes,
    seed,
    inventory,
    canonical,
    gatewaySession,
    gateway,
    codex,
    selector,
    processRunner,
    workSlot,
    turn,
    runtimeProfile,
    investigationPort,
  ] = await Promise.all([
    load("src/control-plane/review-action-v2-client.ts"),
    load(
      "src/review-orchestration/infrastructure/review-action-v2-control-plane-adapter.ts",
    ),
    load(
      "src/review-investigation/infrastructure/review-action-v2-investigation-adapter.ts",
    ),
    load(
      "src/review-orchestration/infrastructure/review-investigation-recording-adapter.ts",
    ),
    load("src/review-orchestration/application/index.ts"),
    load("src/review-orchestration/domain/stable-review-work-plan.ts"),
    load(
      "src/review-orchestration/infrastructure/codex-review-invocation-adapter.ts",
    ),
    load("src/review-orchestration/domain/review-prompt-coverage.ts"),
    load("src/review-investigation/domain/deterministic-context-probe-plan.ts"),
    load(
      "src/review-investigation/domain/review-investigation-seed-envelope.ts",
    ),
    load("src/context-gateway/canonical-git-inventory.ts"),
    load("src/review-investigation/domain/canonical-json.ts"),
    load(
      "src/review-orchestration/infrastructure/context-gateway-invocation-session.ts",
    ),
    load(
      "src/review-investigation/infrastructure/context-gateway-v4-investigation-adapter.ts",
    ),
    load(
      "src/review-investigation/infrastructure/codex-review-agent-adapter.ts",
    ),
    load(
      "src/review-investigation/infrastructure/deterministic-review-agent-selector.ts",
    ),
    load(
      "src/review-investigation/infrastructure/review-agent-process-runner.ts",
    ),
    load("src/review-investigation/application/run-investigation-work-slot.ts"),
    load("src/review-investigation/application/run-investigation-turn.ts"),
    load("src/review-investigation/domain/runtime-profile.ts"),
    load(
      "src/review-investigation/application/investigation-control-plane-port.ts",
    ),
  ]);
  return {
    client,
    controlPlane,
    investigationControlPlane,
    recording,
    application,
    workPlan,
    invocationManifest,
    coverage,
    probes,
    seed,
    inventory,
    canonical,
    gatewaySession,
    gateway,
    codex,
    selector,
    processRunner,
    workSlot,
    turn,
    runtimeProfile,
    investigationPort,
  };
}

async function assertExactActionCheckout(config: RunnerConfig): Promise<void> {
  const head = (
    await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: config.actionSourceDir,
    })
  ).stdout.trim();
  if (head !== config.actionRef) {
    throw new Error("paired_action_ref_checkout_mismatch");
  }
  const status = (
    await execFileAsync(
      "git",
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "--",
        ...actionReleaseRelevantPaths,
      ],
      { cwd: config.actionSourceDir },
    )
  ).stdout.trim();
  if (status) {
    throw new Error("paired_action_release_worktree_dirty");
  }
}

async function assertExactActionReleaseArtifacts(
  config: RunnerConfig,
  canonicalJson: (value: unknown) => string,
): Promise<void> {
  const canonical = canonicalJson(config.releaseManifest);
  if (
    canonical !== config.releaseManifestCanonicalJson ||
    sha256(canonical) !== config.releaseManifestHash
  ) {
    throw new Error("paired_action_release_manifest_hash_mismatch");
  }
  const [runtime, gateway] = await Promise.all([
    readFile(
      path.join(
        config.actionSourceDir,
        config.releaseManifest.runtimeEntrypointPath,
      ),
    ),
    readFile(config.gatewayBundlePath),
  ]);
  if (
    sha256(runtime) !== config.releaseManifest.runtimeEntrypointDigest ||
    sha256(gateway) !== config.releaseManifest.contextGatewayEntrypointDigest
  ) {
    throw new Error("paired_action_release_artifact_digest_mismatch");
  }
}

async function buildFakeCodex(
  artifactsRoot: string,
  actionSourceDir: string,
): Promise<string> {
  const output = path.join(artifactsRoot, "paired-fake-codex.cjs");
  await build({
    entryPoints: [
      path.resolve(
        "scripts/review-investigation-paired-e2e/support/fake-codex-investigation-cli.ts",
      ),
    ],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: output,
    logLevel: "silent",
    banner: { js: "#!/usr/bin/env node" },
    nodePaths: [path.join(actionSourceDir, "node_modules")],
  });
  await chmod(output, 0o700);
  return output;
}

async function readConfig(value: string | undefined): Promise<RunnerConfig> {
  if (!value) throw new Error("paired_action_config_path_missing");
  const parsed = JSON.parse(await readFile(value, "utf8")) as RunnerConfig;
  if (
    !parsed ||
    ![
      "success",
      "high_risk_proposal",
      "tampered_seed_manifest",
      "stale_revision",
      "incomplete_path_chain",
    ].includes(parsed.scenario) ||
    !/^[a-f0-9]{40}$/u.test(parsed.actionRef) ||
    !/^[a-f0-9]{64}$/u.test(parsed.releaseManifestHash)
  ) {
    throw new Error("paired_action_config_invalid");
  }
  return parsed;
}

function failureResult(config: RunnerConfig, error: unknown) {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const message = error instanceof Error ? error.message : String(error);
  const protocolMatch = /error_code=([a-z_]+)/u.exec(message);
  const issuesMatch = /issues=([^\s]+)/u.exec(message);
  return Object.freeze({
    ok: false,
    scenario: config.scenario,
    releaseManifestHash: config.releaseManifestHash,
    failure: Object.freeze({
      name: error instanceof Error ? error.name : "UnknownError",
      message,
      failureClass:
        typeof record.failureClass === "string" ? record.failureClass : null,
      clientFailureCode: typeof record.code === "string" ? record.code : null,
      protocolErrorCode:
        typeof record.protocolErrorCode === "string"
          ? record.protocolErrorCode
          : (protocolMatch?.[1] ?? null),
      issues: Array.isArray(record.issues)
        ? record.issues.filter(
            (item): item is string => typeof item === "string",
          )
        : (issuesMatch?.[1]?.split(",") ?? []),
    }),
  });
}

function emitResult(result: unknown): void {
  process.stdout.write(`${resultMarker}${JSON.stringify(result)}\n`);
}

let requestOrdinal = 0;
function requestIdFactory(): () => string {
  return () => `paired-action-request-${++requestOrdinal}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
