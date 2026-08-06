import { execFile } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { exportJWK, SignJWT } from "jose";
import {
  canonicalJson,
  canonicalReviewOperationalSloProfile,
  canonicalReviewProtocolLimits,
  reviewInvestigationCapabilityV1,
  type ReviewOperationalSloThresholds,
  type ReviewProtocolLimits,
} from "../../../packages/features/review-run-control/src/index.js";
import {
  createPrismaClient,
  type PrismaClient,
} from "../../../packages/platform/db/src/index.js";
import {
  reviewActionV2CanonicalizerDigest,
  reviewActionV2PublishedSchemaDigest,
} from "../../../packages/protocol-review-action-v2/src/index.js";
import { createApiApp } from "../../../apps/api/src/app.js";
import {
  composeReviewActionV2ProductionRoutes,
  reviewActionV2CapabilityActiveKeyIdEnv,
  reviewActionV2CapabilityKeysEnv,
  reviewActionV2ProjectionPolicyVersionEnv,
  reviewActionV2ProviderVoteLanesEnv,
  reviewInvestigationLeaseCapabilityActiveKeyIdEnv,
  reviewInvestigationLeaseCapabilityKeysEnv,
  reviewInvestigationContextCriticEnabledEnv,
  reviewInvestigationCrossRevisionReplayEnabledEnv,
  reviewInvestigationEmergencyDisabledEnv,
  reviewInvestigationMaintenanceEnabledEnv,
  reviewInvestigationPrivateMaterialActiveKeyIdEnv,
  reviewInvestigationPrivateMaterialKeysEnv,
  reviewInvestigationPrivateMaterialTtlEnv,
  reviewInvestigationRecordingEnabledEnv,
  reviewInvestigationRolloutSelectorsEnv,
  reviewInvestigationProductionEffectsEnabledEnv,
  reviewInvestigationShadowEnabledEnv,
  reviewInvestigationVerifiedCleanEnabledEnv,
} from "../../../apps/api/src/review-action-v2-production-composition.js";
import {
  reviewActionV2ContextReplayActiveKeyIdEnv,
  reviewActionV2ContextReplayKeysEnv,
  reviewActionV2ContextSessionSecretEnv,
} from "../../../apps/api/src/review-action-v2-context-attestation-composition.js";
import { reviewActionV2ProjectionPolicyVersion } from "../../../apps/api/src/review-action-v2-projection-policy.js";
import { FakeGitHubTransport } from "../../review-action-v2-production-e2e/support/fake-github.js";
import { assertDisposableDatabaseUrl } from "../../review-action-v2-production-e2e/support/review-action-v2-e2e-harness.js";
import { resetReviewInvestigationProductionE2EDatabase } from "../../review-investigation-production-e2e/support/review-investigation-production-e2e-harness.js";
// @ts-expect-error The shared release parser is intentionally ESM JavaScript.
import { parseContextGatewayReleaseMetadata } from "../../lib/review-action-v2-release-manifests.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const owner = "reviewrouter-paired-e2e";
const repo = "disposable-action-saas-investigation";
const pullRequestNumber = 73;
const githubRepositoryId = "9988776655";
const githubInstallationId = "887766";
const sourceRunId = "770001";
const providerVoteIdentityHash = sha256("paired-action-saas-provider-vote");
const capabilityKeyId = "paired-action-saas-capability-key";
const contextReplayKeyId = "paired-action-saas-context-replay-key";
const investigationLeaseKeyId = "paired-action-saas-investigation-lease-key";
const privateMaterialKeyId = "paired-action-saas-private-material-key";
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

export enum PairedActionScenario {
  Success = "success",
  HighRiskProposal = "high_risk_proposal",
  TamperedSeedManifest = "tampered_seed_manifest",
  StaleRevision = "stale_revision",
  IncompletePathChain = "incomplete_path_chain",
  ReplayPrepared = "replay_prepared",
}

export type PairedProtocolDiagnostic = Readonly<{
  operationId: string;
  protocolErrorCode: string;
  protocolIssues: readonly string[];
  requestId: string;
  statusCode: number;
}>;

export type PairedActionProcessResult = Readonly<{
  ok: boolean;
  scenario: PairedActionScenario;
  releaseManifestHash: string;
  replayPreparationMissing?: boolean;
  preparedObligationCount?: number;
  sourceInvestigationId?: string;
  replayedInvestigationId?: string;
  observation?: Readonly<{
    investigationCertificateId: string;
    investigationCertificateHash: string;
    payloadHash: string;
    qualityFlags: readonly string[];
  }>;
  failure?: Readonly<{
    name: string;
    message: string;
    failureClass: string | null;
    clientFailureCode: string | null;
    protocolErrorCode: string | null;
    issues: readonly string[];
  }>;
}>;

type PairedActionReleaseManifest = Readonly<{
  manifestVersion: 1;
  actionCommitSha: string;
  runtimeCommitSha: string;
  runtimeEntrypointPath: string;
  runtimeEntrypointDigest: string;
  contextGatewayEntrypointPath: string;
  contextGatewayEntrypointDigest: string;
  contextGatewayPolicyVersion: string;
  supportedContextGatewayPolicyVersions: readonly string[];
  reviewInvestigationCapability: string;
  reviewInvestigationCoverageProfileHash: string;
  reviewInvestigationPolicyHash: string;
  schemaDigest: string;
  canonicalizerDigest: string;
}>;

type DisposableRepository = Readonly<{
  parent: string;
  root: string;
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  headTreeSha: string;
  reviewRevisionHash: string;
  fullDiff: string;
}>;

export class PairedActionSaasE2EHarness {
  readonly prisma: PrismaClient;
  readonly diagnostics: PairedProtocolDiagnostic[];
  readonly releaseManifest: PairedActionReleaseManifest;
  readonly releaseManifestCanonicalJson: string;
  readonly releaseManifestHash: string;
  repository: DisposableRepository;
  readonly actionSourceDir: string;
  readonly actionRef: string;
  readonly producerReleaseId: string;
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
  readonly scmRepositoryIdentityId: string;
  private readonly app: Awaited<ReturnType<typeof createApiApp>>;
  private readonly apiUrl: string;
  private readonly oidcPrivateKey: KeyObject;
  private readonly oidcKeyId: string;
  private readonly fakeGitHub: FakeGitHubTransport;
  private readonly originalFetch: typeof globalThis.fetch;
  private readonly temporaryRoot: string;
  private oidcOrdinal = 0;

  private constructor(input: {
    prisma: PrismaClient;
    diagnostics: PairedProtocolDiagnostic[];
    releaseManifest: PairedActionReleaseManifest;
    releaseManifestCanonicalJson: string;
    releaseManifestHash: string;
    repository: DisposableRepository;
    actionSourceDir: string;
    actionRef: string;
    producerReleaseId: string;
    workspaceId: string;
    repositoryConnectionId: string;
    scmRepositoryIdentityId: string;
    app: Awaited<ReturnType<typeof createApiApp>>;
    apiUrl: string;
    oidcPrivateKey: KeyObject;
    oidcKeyId: string;
    fakeGitHub: FakeGitHubTransport;
    originalFetch: typeof globalThis.fetch;
    temporaryRoot: string;
  }) {
    Object.assign(this, input);
    this.prisma = input.prisma;
    this.diagnostics = input.diagnostics;
    this.releaseManifest = input.releaseManifest;
    this.releaseManifestCanonicalJson = input.releaseManifestCanonicalJson;
    this.releaseManifestHash = input.releaseManifestHash;
    this.repository = input.repository;
    this.actionSourceDir = input.actionSourceDir;
    this.actionRef = input.actionRef;
    this.producerReleaseId = input.producerReleaseId;
    this.workspaceId = input.workspaceId;
    this.repositoryConnectionId = input.repositoryConnectionId;
    this.scmRepositoryIdentityId = input.scmRepositoryIdentityId;
    this.app = input.app;
    this.apiUrl = input.apiUrl;
    this.oidcPrivateKey = input.oidcPrivateKey;
    this.oidcKeyId = input.oidcKeyId;
    this.fakeGitHub = input.fakeGitHub;
    this.originalFetch = input.originalFetch;
    this.temporaryRoot = input.temporaryRoot;
  }

  static async create(input: {
    databaseUrl: string;
    actionSourceDir: string;
    actionRef: string;
  }): Promise<PairedActionSaasE2EHarness> {
    assertDisposableDatabaseUrl(input.databaseUrl);
    const sourceActionDir = path.resolve(input.actionSourceDir);
    const actionRef = requireFullCommitSha(input.actionRef);
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "reviewrouter-paired-action-saas-"),
    );
    const actionSourceDir = path.join(temporaryRoot, "action-release");
    await createDetachedActionReleaseCheckout({
      sourceActionDir,
      targetDirectory: actionSourceDir,
      actionRef,
    });
    await assertExactActionReleaseWorktree(actionSourceDir, actionRef);
    const prefix = `paired-e2e-${randomUUID()}`;
    const producerReleaseId = `${prefix}-release`;
    const workspaceId = `${prefix}-workspace`;
    const repositoryConnectionId = `${prefix}-repository`;
    const scmRepositoryIdentityId = `${prefix}-scm`;
    const repository = await createDisposableRepository(temporaryRoot, {
      workspaceId,
      repositoryConnectionId,
      scmRepositoryIdentityId,
    });
    const release = await readActionRelease(actionSourceDir, actionRef);
    const protocolLimitsProfileId = `${prefix}-limits`;
    const operationalSloProfileId = `${prefix}-slo`;
    const appKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const oidcKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const oidcKeyId = `${prefix}-oidc`;
    const oidcJwk = await exportJWK(oidcKeys.publicKey);
    oidcJwk.alg = "RS256";
    oidcJwk.kid = oidcKeyId;
    oidcJwk.use = "sig";
    const fakeGitHub = new FakeGitHubTransport({
      owner,
      repo,
      pullRequestNumber,
      sourceRunId,
      installationId: githubInstallationId,
      appSlug: "reviewrouter-paired-e2e",
      oidcKeyId,
      oidcJwk,
      revision: {
        baseSha: repository.baseSha,
        mergeBaseSha: repository.mergeBaseSha,
        headSha: repository.headSha,
        headTreeSha: repository.headTreeSha,
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeGitHub.fetch;
    const prisma = createPrismaClient({
      databaseUrl: input.databaseUrl,
      poolMax: 12,
    });
    const diagnostics: PairedProtocolDiagnostic[] = [];
    try {
      await seedControlPlane(prisma, {
        prefix,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        producerReleaseId,
        protocolLimitsProfileId,
        operationalSloProfileId,
        release: release.manifest,
      });
      const env = productionEnvironment({
        appPrivateKey: appKeys.privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
        producerReleaseId,
        protocolLimitsProfileId,
        operationalSloProfileId,
        release: release.manifest,
      });
      const runtime = {
        readServerTime: async () => new Date(),
        createRequestId: () => `${prefix}-request-${randomUUID()}`,
        recordProtocolRejection: (diagnostic: PairedProtocolDiagnostic) => {
          diagnostics.push(
            Object.freeze({
              ...diagnostic,
              protocolIssues: Object.freeze([...diagnostic.protocolIssues]),
            }),
          );
        },
      };
      const routes = composeReviewActionV2ProductionRoutes({
        enabled: true,
        env,
        runtime,
        prisma,
      });
      const app = await createApiApp({
        prisma,
        reviewRunControlV2Enabled: true,
        reviewActionV2Env: env,
        reviewRunControlV2Dependencies: routes.runControl,
        reviewExecutionV2Dependencies: routes.execution,
        reviewInvestigationV2Dependencies: routes.investigation,
        reviewContextAttestationV2Dependencies: routes.contextAttestation,
        reviewEvidenceV2Dependencies: routes.evidence,
        reviewSnapshotReadV2Dependencies: routes.snapshot,
        reviewPublicationRequestV2Dependencies: routes.publication,
      });
      const apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
      return new PairedActionSaasE2EHarness({
        prisma,
        diagnostics,
        releaseManifest: release.manifest,
        releaseManifestCanonicalJson: release.canonicalJson,
        releaseManifestHash: release.hash,
        repository,
        actionSourceDir,
        actionRef,
        producerReleaseId,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        app,
        apiUrl,
        oidcPrivateKey: oidcKeys.privateKey,
        oidcKeyId,
        fakeGitHub,
        originalFetch,
        temporaryRoot,
      });
    } catch (error) {
      globalThis.fetch = originalFetch;
      await prisma.$disconnect();
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async run(
    scenario: PairedActionScenario,
  ): Promise<PairedActionProcessResult> {
    const configPath = path.join(
      this.temporaryRoot,
      `action-run-${scenario}-${randomUUID()}.json`,
    );
    const oidcToken = await this.signOidcToken();
    await writeFile(
      configPath,
      JSON.stringify({
        scenario,
        apiUrl: this.apiUrl,
        oidcToken,
        actionSourceDir: this.actionSourceDir,
        actionRef: this.actionRef,
        gatewayBundlePath: path.join(
          this.actionSourceDir,
          this.releaseManifest.contextGatewayEntrypointPath,
        ),
        checkoutRoot: this.repository.root,
        revision: {
          baseSha: this.repository.baseSha,
          mergeBaseSha: this.repository.mergeBaseSha,
          headSha: this.repository.headSha,
          reviewRevisionHash: this.repository.reviewRevisionHash,
        },
        fullDiff: this.repository.fullDiff,
        changedFiles: [
          {
            path: "src/contract.ts",
            previousPath: null,
            status: "modified",
            patch: this.repository.fullDiff,
          },
        ],
        releaseManifest: this.releaseManifest,
        releaseManifestCanonicalJson: this.releaseManifestCanonicalJson,
        releaseManifestHash: this.releaseManifestHash,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      const tsxCli = require.resolve("tsx/cli");
      const runner = path.resolve(
        "scripts/review-investigation-paired-e2e/support/paired-action-runner.ts",
      );
      let execution: Readonly<{
        stdout: string;
        stderr: string;
        failed: boolean;
      }>;
      try {
        const completed = await execFileAsync(
          process.execPath,
          [tsxCli, runner, configPath],
          {
            cwd: path.resolve("."),
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              TMPDIR: process.env.TMPDIR,
              NODE_OPTIONS: process.env.NODE_OPTIONS,
              REVIEW_ROUTER_ACTION_SOURCE_DIR: this.actionSourceDir,
            },
            timeout: 120_000,
            maxBuffer: 16 * 1024 * 1024,
          },
        );
        execution = { ...completed, failed: false };
      } catch (error) {
        if (!isSubprocessFailure(error)) throw error;
        execution = {
          stdout: error.stdout,
          stderr: error.stderr,
          failed: true,
        };
      }
      const marker = "REVIEWROUTER_PAIRED_RESULT:";
      const line = execution.stdout
        .split(/\r?\n/u)
        .reverse()
        .find((candidate: string) => candidate.startsWith(marker));
      if (!line) {
        const rejected = execution.failed
          ? parseTypedActionRejection(
              scenario,
              this.releaseManifestHash,
              execution.stderr,
            )
          : null;
        if (rejected) return rejected;
        throw new Error(
          `paired_action_result_missing:${execution.stderr.slice(0, 400)}`,
        );
      }
      const parsed = parseActionResult(line.slice(marker.length));
      if (execution.failed && parsed.ok) {
        throw new Error("paired_action_success_exit_code_invalid");
      }
      return parsed;
    } finally {
      await rm(configPath, { force: true });
    }
  }

  async advanceReviewRevision(): Promise<DisposableRepository> {
    this.repository = await advanceDisposableRepository(this.repository, {
      workspaceId: this.workspaceId,
      repositoryConnectionId: this.repositoryConnectionId,
      scmRepositoryIdentityId: this.scmRepositoryIdentityId,
    });
    this.fakeGitHub.revision = {
      baseSha: this.repository.baseSha,
      mergeBaseSha: this.repository.mergeBaseSha,
      headSha: this.repository.headSha,
      headTreeSha: this.repository.headTreeSha,
    };
    this.fakeGitHub.sourceRunId = String(
      Number(this.fakeGitHub.sourceRunId) + 1,
    );
    return this.repository;
  }

  async close(): Promise<void> {
    await this.app.close();
    globalThis.fetch = this.originalFetch;
    await this.prisma.$disconnect();
    await rm(this.temporaryRoot, { recursive: true, force: true });
  }

  private async signOidcToken(): Promise<string> {
    this.oidcOrdinal += 1;
    return new SignJWT({
      sub: `repo:${owner}/${repo}:pull_request`,
      repository: `${owner}/${repo}`,
      repository_id: githubRepositoryId,
      repository_owner: owner,
      event_name: "pull_request",
      ref: `refs/pull/${pullRequestNumber}/merge`,
      run_id: this.fakeGitHub.sourceRunId,
      run_attempt: "1",
      workflow_ref: `${owner}/${repo}/.github/workflows/reviewrouter.yml@refs/pull/${pullRequestNumber}/merge`,
      workflow_sha: this.repository.headSha,
      job_workflow_ref: `777genius/review-router/.github/workflows/reviewrouter-execution-reusable.yml@${this.actionRef}`,
      job_workflow_sha: this.actionRef,
      actor: "reviewrouter-paired-e2e",
      jti: `paired-action-saas-${this.oidcOrdinal}-${randomUUID()}`,
    })
      .setProtectedHeader({ alg: "RS256", kid: this.oidcKeyId })
      .setIssuer("https://token.actions.githubusercontent.com")
      .setAudience("reviewrouter-paired-e2e")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(this.oidcPrivateKey);
  }
}

function isSubprocessFailure(
  error: unknown,
): error is Error & { readonly stdout: string; readonly stderr: string } {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return typeof record.stdout === "string" && typeof record.stderr === "string";
}

function parseTypedActionRejection(
  scenario: PairedActionScenario,
  releaseManifestHash: string,
  stderr: string,
): PairedActionProcessResult | null {
  const match =
    /ReviewInvestigationControlPlaneError: (review_action_v2_protocol_error operation=[^\s]+ http_status=\d+ error_code=([a-z_]+) issues=([^\s]+))/u.exec(
      stderr,
    );
  if (!match) return null;
  return Object.freeze({
    ok: false,
    scenario,
    releaseManifestHash,
    failure: Object.freeze({
      name: "ReviewInvestigationControlPlaneError",
      message: match[1]!,
      failureClass: "rejected",
      clientFailureCode: null,
      protocolErrorCode: match[2]!,
      issues: Object.freeze(match[3]!.split(",")),
    }),
  });
}

export async function createDetachedActionReleaseCheckout(input: {
  readonly sourceActionDir: string;
  readonly targetDirectory: string;
  readonly actionRef: string;
}): Promise<void> {
  await execFileAsync("git", [
    "clone",
    "--quiet",
    "--shared",
    "--no-checkout",
    input.sourceActionDir,
    input.targetDirectory,
  ]);
  await execFileAsync(
    "git",
    ["checkout", "--quiet", "--detach", input.actionRef],
    { cwd: input.targetDirectory },
  );
  await symlink(
    path.join(input.sourceActionDir, "node_modules"),
    path.join(input.targetDirectory, "node_modules"),
    "dir",
  );
}

export async function resetPairedActionSaasE2EDatabase(
  databaseUrl: string,
): Promise<void> {
  await resetReviewInvestigationProductionE2EDatabase(databaseUrl);
}

export async function assertExactActionReleaseWorktree(
  actionSourceDir: string,
  actionRef: string,
): Promise<void> {
  const expectedRef = requireFullCommitSha(actionRef);
  const head = await gitText(actionSourceDir, ["rev-parse", "HEAD"]);
  if (head !== expectedRef) {
    throw new Error("paired_action_ref_checkout_mismatch");
  }

  const status = await gitText(
    actionSourceDir,
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--",
      ...actionReleaseRelevantPaths,
    ],
    false,
  );
  if (status) {
    throw new Error("paired_action_release_worktree_dirty");
  }
}

async function readActionRelease(actionSourceDir: string, actionRef: string) {
  const metadataPath = path.join(
    actionSourceDir,
    "dist/context-gateway.release.json",
  );
  const metadata = parseContextGatewayReleaseMetadata(
    await readFile(metadataPath, "utf8"),
  );
  if (
    metadata.metadataVersion !== 2 ||
    metadata.reviewInvestigationCapability !== reviewInvestigationCapabilityV1
  ) {
    throw new Error("paired_action_investigation_release_required");
  }
  const gatewayPath = path.join(
    actionSourceDir,
    metadata.contextGatewayEntrypointPath,
  );
  const runtimeEntrypointPath = "dist/index.js";
  const runtimePath = path.join(actionSourceDir, runtimeEntrypointPath);
  const [gatewayBytes, runtimeBytes] = await Promise.all([
    readFile(gatewayPath),
    readFile(runtimePath),
  ]);
  if (sha256(gatewayBytes) !== metadata.contextGatewayEntrypointDigest) {
    throw new Error("paired_action_gateway_metadata_digest_mismatch");
  }
  const manifest: PairedActionReleaseManifest = Object.freeze({
    manifestVersion: 1,
    actionCommitSha: actionRef,
    runtimeCommitSha: actionRef,
    runtimeEntrypointPath,
    runtimeEntrypointDigest: sha256(runtimeBytes),
    contextGatewayEntrypointPath: metadata.contextGatewayEntrypointPath,
    contextGatewayEntrypointDigest: metadata.contextGatewayEntrypointDigest,
    contextGatewayPolicyVersion: metadata.contextGatewayPolicyVersion,
    supportedContextGatewayPolicyVersions: Object.freeze([
      ...metadata.supportedContextGatewayPolicyVersions,
    ]),
    reviewInvestigationCapability: metadata.reviewInvestigationCapability,
    reviewInvestigationCoverageProfileHash:
      metadata.reviewInvestigationCoverageProfileHash,
    reviewInvestigationPolicyHash: metadata.reviewInvestigationPolicyHash,
    schemaDigest: reviewActionV2PublishedSchemaDigest,
    canonicalizerDigest: reviewActionV2CanonicalizerDigest,
  });
  const serialized = canonicalJson(manifest);
  return Object.freeze({
    manifest,
    canonicalJson: serialized,
    hash: sha256(serialized),
  });
}

async function seedControlPlane(
  prisma: PrismaClient,
  input: Readonly<{
    prefix: string;
    workspaceId: string;
    repositoryConnectionId: string;
    scmRepositoryIdentityId: string;
    producerReleaseId: string;
    protocolLimitsProfileId: string;
    operationalSloProfileId: string;
    release: PairedActionReleaseManifest;
  }>,
): Promise<void> {
  const now = new Date();
  const limits: ReviewProtocolLimits = {
    maxWorkSlots: 8,
    maxAttemptsPerSlot: 4,
    maxObservationBytes: 1_000_000,
    maxObservationFindings: 1_000,
    maxProjectionBytes: 1_000_000,
    maxProjectionFindings: 1_000,
    maxPublicationOperations: 100,
    maxPublicationChunks: 100,
    maxPublicationBodyBytes: 1_000_000,
    maxRequestBatchSize: 100,
    maxLeaseDurationMs: 300_000,
    maxResultReportDurationMs: 600_000,
    maxReconciliationDurationMs: 600_000,
  };
  const slos: ReviewOperationalSloThresholds = {
    integrationEventDeliveryMs: 1_000,
    outboxClaimAgeMs: 1_000,
    missingCompletionProcessMs: 1_000,
    dueCompletionProcessMs: 1_000,
    publicationReconciliationMs: 1_000,
    v1DrainMs: 1_000,
    admissionMs: 1_000,
    pruningBacklogAgeMs: 1_000,
  };
  await prisma.reviewProtocolLimitsV2.create({
    data: {
      protocolLimitsProfileId: input.protocolLimitsProfileId,
      limitsDigest: sha256(canonicalReviewProtocolLimits(limits)),
      ...limits,
      registeredAt: now,
    },
  });
  await prisma.reviewOperationalSloProfileV2.create({
    data: {
      operationalSloProfileId: input.operationalSloProfileId,
      sloDigest: sha256(
        canonicalReviewOperationalSloProfile({
          thresholds: slos,
          ownerRefs: ["paired-action-saas-e2e"],
          runbookRefs: ["paired-action-saas-e2e"],
        }),
      ),
      ...slos,
      ownerRefs: ["paired-action-saas-e2e"],
      runbookRefs: ["paired-action-saas-e2e"],
      registeredAt: now,
    },
  });
  await prisma.producerRelease.create({
    data: {
      producerReleaseId: input.producerReleaseId,
      distributionKind: "public_reusable",
      actionCommitSha: input.release.actionCommitSha,
      runtimeCommitSha: input.release.runtimeCommitSha,
      wrapperEntrypointDigest: null,
      runtimeEntrypointDigest: input.release.runtimeEntrypointDigest,
      contextGatewayPolicyVersion: input.release.contextGatewayPolicyVersion,
      contextGatewayEntrypointDigest:
        input.release.contextGatewayEntrypointDigest,
      schemaDigest: input.release.schemaDigest,
      capabilityProfile: "exact_revision_v2",
      protocolLimitsProfileId: input.protocolLimitsProfileId,
      operationalSloProfileId: input.operationalSloProfileId,
      reviewInvestigationCapability:
        input.release.reviewInvestigationCapability,
      reviewInvestigationCoverageProfileHash:
        input.release.reviewInvestigationCoverageProfileHash,
      reviewInvestigationPolicyHash:
        input.release.reviewInvestigationPolicyHash,
      registeredAt: now,
    },
  });
  const installationId = `${input.prefix}-installation`;
  await prisma.workspace.create({
    data: {
      id: input.workspaceId,
      slug: `${input.prefix}-workspace`,
      name: "Paired Action SaaS E2E",
    },
  });
  await prisma.gitHubInstallation.create({
    data: {
      id: installationId,
      workspaceId: input.workspaceId,
      githubInstallationId: BigInt(githubInstallationId),
      accountLogin: owner,
      accountType: "Organization",
      repositorySelection: "selected",
      status: "active",
    },
  });
  await prisma.scmRepositoryIdentity.create({
    data: {
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      provider: "github",
      normalizedSourceBaseUrl: "https://github.com",
      externalRepositoryId: githubRepositoryId,
      createdAt: now,
    },
  });
  await prisma.repositoryConnection.create({
    data: {
      id: input.repositoryConnectionId,
      workspaceId: input.workspaceId,
      provider: "github",
      sourceBaseUrl: "https://github.com",
      externalRepositoryId: githubRepositoryId,
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      installationId,
      githubRepositoryId: BigInt(githubRepositoryId),
      owner,
      name: repo,
      fullName: `${owner}/${repo}`,
      defaultBranch: "main",
      visibility: "private",
      selected: true,
    },
  });
  await prisma.scmRepositoryIdentity.update({
    where: { scmRepositoryIdentityId: input.scmRepositoryIdentityId },
    data: {
      currentWorkspaceId: input.workspaceId,
      currentRepositoryConnectionId: input.repositoryConnectionId,
      boundAt: now,
    },
  });
  await prisma.reviewMutationAuthority.create({
    data: {
      scmRepositoryIdentityId: input.scmRepositoryIdentityId,
      laneKind: "hosted_reviewrouter_app",
      version: 1,
      epoch: 1n,
      mode: "v2_active",
      managedWorkflowInventoryHash: sha256(`${input.prefix}-inventory`),
      activationSafetyDecisionHash: sha256(`${input.prefix}-activation`),
      initializedAt: now,
      activatedAt: now,
    },
  });
  await prisma.reviewSafetyEmergencyControl.update({
    where: { emergencyControlId: "global-review-v2" },
    data: {
      version: 2,
      stopped: false,
      reason: "paired_e2e_enabled",
      updatedBy: "paired-action-saas-e2e",
      updatedAt: now,
    },
  });
  for (const capability of [
    "run_authorization_v2",
    "evidence_writes_v2",
    "evidence_reuse_v2",
    "prompt_only_reuse",
    "context_gateway_reuse",
    "publication_operations_v2",
    "mutation_epoch_v2",
  ] as const) {
    await prisma.reviewSafetyPolicy.create({
      data: {
        policyId: `${input.prefix}-policy-${capability}`,
        policyScope: "global",
        capability,
        workspaceId: null,
        repositoryConnectionId: null,
        scmRepositoryIdentityId: null,
        version: 1,
        rolloutMode: "enabled",
        updatedBy: "paired-action-saas-e2e",
        updatedAt: now,
      },
    });
  }
}

function productionEnvironment(input: {
  appPrivateKey: string;
  producerReleaseId: string;
  protocolLimitsProfileId: string;
  operationalSloProfileId: string;
  release: PairedActionReleaseManifest;
}): Readonly<Record<string, string>> {
  const signingKeys = JSON.stringify([
    {
      keyId: capabilityKeyId,
      secretBase64: Buffer.from("paired-action-saas-signing-secret-32-bytes!")
        .subarray(0, 32)
        .toString("base64"),
      verifyUntil: null,
    },
  ]);
  return {
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: input.appPrivateKey,
    REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: "reviewrouter-paired-e2e",
    REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID: capabilityKeyId,
    REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON: signingKeys,
    REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON: JSON.stringify([
      {
        producerReleaseId: input.producerReleaseId,
        distributionKind: "public_reusable",
        actionCommitSha: input.release.actionCommitSha,
        runtimeCommitSha: input.release.runtimeCommitSha,
        wrapperEntrypointDigest: null,
        runtimeEntrypointDigest: input.release.runtimeEntrypointDigest,
        contextGatewayPolicyVersion: input.release.contextGatewayPolicyVersion,
        contextGatewayEntrypointDigest:
          input.release.contextGatewayEntrypointDigest,
        schemaDigest: input.release.schemaDigest,
        canonicalizerDigest: input.release.canonicalizerDigest,
        capabilityProfile: "exact_revision_v2",
        protocolLimitsProfileId: input.protocolLimitsProfileId,
        operationalSloProfileId: input.operationalSloProfileId,
        reviewInvestigationCapability:
          input.release.reviewInvestigationCapability,
        reviewInvestigationCoverageProfileHash:
          input.release.reviewInvestigationCoverageProfileHash,
        reviewInvestigationPolicyHash:
          input.release.reviewInvestigationPolicyHash,
      },
    ]),
    [reviewActionV2ProviderVoteLanesEnv]: JSON.stringify([
      { providerKind: "codex", providerVoteIdentityHash },
    ]),
    [reviewActionV2ProjectionPolicyVersionEnv]:
      reviewActionV2ProjectionPolicyVersion,
    [reviewActionV2CapabilityActiveKeyIdEnv]: capabilityKeyId,
    [reviewActionV2CapabilityKeysEnv]: signingKeys,
    [reviewInvestigationLeaseCapabilityActiveKeyIdEnv]: investigationLeaseKeyId,
    [reviewInvestigationLeaseCapabilityKeysEnv]: JSON.stringify([
      {
        keyId: investigationLeaseKeyId,
        secretBase64: Buffer.from("l".repeat(32)).toString("base64"),
        verifyUntil: null,
      },
    ]),
    [reviewActionV2ContextSessionSecretEnv]: Buffer.from(
      "s".repeat(32),
    ).toString("base64"),
    [reviewActionV2ContextReplayActiveKeyIdEnv]: contextReplayKeyId,
    [reviewActionV2ContextReplayKeysEnv]: JSON.stringify([
      {
        keyId: contextReplayKeyId,
        secretBase64: Buffer.from("r".repeat(32)).toString("base64"),
      },
    ]),
    [reviewInvestigationRecordingEnabledEnv]: "1",
    [reviewInvestigationShadowEnabledEnv]: "1",
    [reviewInvestigationContextCriticEnabledEnv]: "1",
    [reviewInvestigationCrossRevisionReplayEnabledEnv]: "1",
    [reviewInvestigationVerifiedCleanEnabledEnv]: "1",
    [reviewInvestigationProductionEffectsEnabledEnv]: "1",
    [reviewInvestigationRolloutSelectorsEnv]: JSON.stringify({
      verified_clean: [
        {
          producerReleaseIds: [input.producerReleaseId],
          providers: ["codex"],
        },
      ],
      cross_revision_replay: [
        {
          producerReleaseIds: [input.producerReleaseId],
          providers: ["codex"],
        },
      ],
      production_effects: [
        {
          producerReleaseIds: [input.producerReleaseId],
          providers: ["codex"],
        },
      ],
    }),
    [reviewInvestigationMaintenanceEnabledEnv]: "1",
    [reviewInvestigationEmergencyDisabledEnv]: "0",
    [reviewInvestigationPrivateMaterialActiveKeyIdEnv]: privateMaterialKeyId,
    [reviewInvestigationPrivateMaterialKeysEnv]: JSON.stringify({
      [privateMaterialKeyId]: Buffer.from("p".repeat(32)).toString("base64url"),
    }),
    [reviewInvestigationPrivateMaterialTtlEnv]: "3600000",
  };
}

async function createDisposableRepository(
  temporaryRoot: string,
  scope: Readonly<{
    workspaceId: string;
    repositoryConnectionId: string;
    scmRepositoryIdentityId: string;
  }>,
): Promise<DisposableRepository> {
  const root = path.join(temporaryRoot, "repository");
  await mkdir(path.join(root, "src"), { recursive: true });
  await git(root, ["init", "-q", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "ReviewRouter Paired E2E"]);
  await git(root, ["config", "user.email", "paired-e2e@example.invalid"]);
  await writeFile(
    path.join(root, "src/contract.ts"),
    "export const sharedValue = 1;\n",
  );
  await writeFile(
    path.join(root, "src/caller-a.ts"),
    'import { sharedValue } from "./contract";\nexport const callerA = sharedValue;\n',
  );
  await writeFile(
    path.join(root, "src/caller-b.ts"),
    'import { sharedValue } from "./contract";\nexport const callerB = sharedValue;\n',
  );
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "test: paired base"]);
  const baseSha = await gitText(root, ["rev-parse", "HEAD"]);
  await writeFile(
    path.join(root, "src/contract.ts"),
    "export const sharedValue = 2;\n",
  );
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "test: paired head"]);
  return disposableRepositoryRevision(temporaryRoot, root, baseSha, scope);
}

async function advanceDisposableRepository(
  repository: DisposableRepository,
  scope: Readonly<{
    workspaceId: string;
    repositoryConnectionId: string;
    scmRepositoryIdentityId: string;
  }>,
): Promise<DisposableRepository> {
  await writeFile(
    path.join(repository.root, "src/independent.ts"),
    "export const independentValue = 1;\n",
  );
  await git(repository.root, ["add", "-A"]);
  await git(repository.root, ["commit", "-qm", "test: paired replay target"]);
  return disposableRepositoryRevision(
    repository.parent,
    repository.root,
    repository.baseSha,
    scope,
  );
}

async function disposableRepositoryRevision(
  parent: string,
  root: string,
  baseSha: string,
  scope: Readonly<{
    workspaceId: string;
    repositoryConnectionId: string;
    scmRepositoryIdentityId: string;
  }>,
): Promise<DisposableRepository> {
  const headSha = await gitText(root, ["rev-parse", "HEAD"]);
  const headTreeSha = await gitText(root, ["rev-parse", "HEAD^{tree}"]);
  const fullDiff = await gitText(
    root,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      baseSha,
      headSha,
      "--",
      "src/contract.ts",
    ],
    false,
  );
  return Object.freeze({
    parent,
    root,
    baseSha,
    mergeBaseSha: baseSha,
    headSha,
    headTreeSha,
    reviewRevisionHash: sha256(
      canonicalJson({
        workspaceId: scope.workspaceId,
        repositoryConnectionId: scope.repositoryConnectionId,
        scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
        pullRequestNumber,
        baseSha,
        mergeBaseSha: baseSha,
        headSha,
      }),
    ),
    fullDiff,
  });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: gitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function gitText(
  cwd: string,
  args: readonly string[],
  normalize = true,
): Promise<string> {
  const value = (
    await execFileAsync("git", args, {
      cwd,
      env: gitEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout.trim();
  return normalize ? value.toLowerCase() : value;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function parseActionResult(value: string): PairedActionProcessResult {
  const parsed = JSON.parse(value) as PairedActionProcessResult;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.ok !== "boolean" ||
    !Object.values(PairedActionScenario).includes(parsed.scenario) ||
    !/^[a-f0-9]{64}$/u.test(parsed.releaseManifestHash)
  ) {
    throw new Error("paired_action_result_invalid");
  }
  return parsed;
}

function requireFullCommitSha(value: string): string {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error("paired_action_ref_must_be_full_commit_sha");
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
