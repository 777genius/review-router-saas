import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RolloutPhase,
  RolloutStep,
  sha256Canonical,
  type ReleaseImageIdentity,
  type StepObservation,
  type VerifiedReleaseImageProvenance,
} from "../packages/features/release-rollout/src/index";
import { privatePg17ReleaseImagePolicy } from "./lib/private-pg17-release-image-policy";

const boundaries = vi.hoisted(() => ({
  cleanupWitness: vi.fn(),
  resume: vi.fn(),
  canary: vi.fn(),
  trustedEvidence: vi.fn(),
  compareAndSet: vi.fn(),
  verifyFinalAuthority: vi.fn(),
}));

vi.mock(
  "../packages/features/release-rollout/src/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../packages/features/release-rollout/src/index")
      >();

    class TestRunnerLedger {
      async observe(jobId: string, canary: string) {
        boundaries.cleanupWitness(jobId, canary);
        return {
          providerStatus: "succeeded" as const,
          listenerStopped: true as const,
          workspaceRemoved: true as const,
          credentialProcessGone: true as const,
          canary,
          observedAt: "2026-08-14T00:00:15.000Z",
        };
      }

      async compareAndSet(input: unknown) {
        boundaries.compareAndSet(input);
        return true;
      }

      async verifyFinalAuthority(input: unknown) {
        boundaries.verifyFinalAuthority(input);
        return true;
      }
    }

    class TestProviderAuthority {
      async decide(input: Record<string, unknown>) {
        return {
          ...input,
          decision: "allow",
          decisionId: "decision-finalize-test",
          decidedAt: "2026-08-14T00:00:16.000Z",
        };
      }
    }

    class TestRenderTargetServices {
      async resumeDeployAndObserve(input: {
        stagedServices: Array<{
          serviceId: string;
          deployId: string;
          servicePostcondition: Record<string, unknown>;
        }>;
      }): Promise<StepObservation> {
        boundaries.resume(input);
        const facts = input.stagedServices.map((service) => ({
          serviceId: service.serviceId,
          deployId: service.deployId,
          resumed: true as const,
          authorityDecisionId: "decision-finalize-test",
          servicePostcondition: {
            ...service.servicePostcondition,
            suspended: false,
          },
        }));
        return {
          step: actual.RolloutStep.ResumeTargetServices,
          observedAt: "2026-08-14T00:00:17.000Z",
          facts,
          provider: {
            renderServiceIds: facts.map((service) => service.serviceId),
            renderDeployIds: facts.map((service) => service.deployId),
          },
        };
      }

      async verifyLiveCanary(input: {
        expectedCommitSha: string;
        expectedSystemIdentifier: string;
        expectedRecoveryWitnessSha256: string;
        rolloutId: string;
        expectedServices: Array<{
          runtimeRole: "api" | "web" | "worker";
          serviceId: string;
          deployId: string;
          provenance: { kind: "image"; imageSha: string };
          servicePostcondition: Record<string, unknown>;
        }>;
      }): Promise<StepObservation> {
        boundaries.canary(input);
        const nonce = "f".repeat(48);
        const requestedAt = "2026-08-14T00:00:18.000Z";
        const serviceFacts = input.expectedServices.map((service) => ({
          runtimeRole: service.runtimeRole,
          serviceId: service.serviceId,
          deployId: service.deployId,
          deploymentProvenance: service.provenance.imageSha.replace(
            /^sha256:/u,
            "",
          ),
          servicePostconditionSha256: `sha256:${actual.sha256Canonical(
            service.servicePostcondition,
          )}`,
        }));
        return {
          step: actual.RolloutStep.VerifyLiveCanary,
          observedAt: "2026-08-14T00:00:19.000Z",
          facts: {
            rolloutId: input.rolloutId,
            nonce,
            requestedAt,
            observedAt: "2026-08-14T00:00:19.000Z",
            commitSha: input.expectedCommitSha,
            databaseSystemIdentifier: input.expectedSystemIdentifier,
            recoveryWitnessSha256: input.expectedRecoveryWitnessSha256,
            expectedGeneration: {
              systemIdentifier: input.expectedSystemIdentifier,
              recoveryWitnessSha256: input.expectedRecoveryWitnessSha256,
            },
            serviceFacts,
            runtimeWitnessProofs: serviceFacts.map((service) => ({
              ...service,
              databaseRole: `reviewrouter_${service.runtimeRole}`,
              nonce,
              requestedAt,
              provedAt: "2026-08-14T00:00:19.000Z",
              systemIdentifier: input.expectedSystemIdentifier,
              releaseCommitSha: input.expectedCommitSha,
              recoveryWitnessSha256: input.expectedRecoveryWitnessSha256,
            })),
            writeReadRoundTrip: true,
          },
        };
      }
    }

    return {
      ...actual,
      AuthenticatedRunnerLedgerAdapter: TestRunnerLedger,
      HttpProviderAuthorityDecisionAdapter: TestProviderAuthority,
      HttpProviderMutationAuthorityAdapter: class {},
      RenderTargetServicesAdapter: TestRenderTargetServices,
      assembleTrustedRolloutEvidence: (input: unknown) => {
        boundaries.trustedEvidence(input);
        return { evidenceSha256: `sha256:${"e".repeat(64)}` };
      },
    };
  },
);

const repository = "777genius/review-router-saas";
const commit = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const imageRepository = "ghcr.io/777genius/review-router-saas-runtime";
const digest = `sha256:${"c".repeat(64)}`;
const rolloutId = "private-pg17-finalizer-test";
const sourceSystemIdentifier = "100";
const targetSystemIdentifier = "200";

const servicePostcondition = (serviceId: string) => ({
  serviceId,
  ownerId: "tea-reviewrouter",
  serviceType: "web_service",
  suspended: true,
  region: "oregon",
  plan: "standard",
  runtime: "image" as const,
  image: `${imageRepository}@${imageDigest}`,
  repository: null,
  branch: null,
  rootDirectory: null,
  buildCommand: null,
  startCommand: null,
  preDeployCommand: "",
  healthPath: "/health",
  automaticDeployments: false as const,
  automaticDeployTrigger: "off" as const,
  shutdownDelaySeconds: 60,
  instanceCount: 1,
  environmentSha256: digest,
});

const stagedFacts = ["api", "web", "worker"].map((runtimeRole, index) => {
  const serviceId = `srv-${runtimeRole}`;
  return {
    serviceId,
    deployId: `dep-${index + 1}`,
    provenance: { kind: "image" as const, imageSha: imageDigest },
    envSha256: digest,
    previousEnvSha256: `sha256:${"d".repeat(64)}`,
    databaseHostname: "target.internal",
    databaseName: "reviewrouter",
    databaseRole: `reviewrouter_${runtimeRole}`,
    databaseSystemIdentifier: targetSystemIdentifier,
    recoveryWitnessSha256: "c".repeat(64),
    suspended: true as const,
    targetSwitchFenceNonce: "1".repeat(32),
    targetSwitchFenceVersion: 1,
    servicePostcondition: servicePostcondition(serviceId),
  };
});

const runner = (lifecycle: "role" | "cutover") => ({
  organization: "777genius",
  repository,
  workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
  workflowRef: "refs/heads/main",
  event: "workflow_dispatch" as const,
  actor: "release-operator",
  runId: "123",
  runAttempt: 1,
  workflowJobId: lifecycle === "role" ? "1001" : "1002",
  workflowJobName: `${lifecycle}-job`,
  commitSha: commit,
  runnerName: `rr-${lifecycle}`,
  cleanupCanary: `rr-cleanup:${rolloutId}:rr-${lifecycle}`,
  renderJobId: `job-${lifecycle}`,
  baseServiceId: "srv-runner",
  runnerGroupId: 17,
  runnerGroupName: "private-pg17",
  uniqueRunnerLabel: `rr-${lifecycle}`,
  workFolder: `_work/rr-${lifecycle}`,
  provenance: {
    kind: "git" as const,
    deployId: "dep-runner",
    commitSha: commit,
  },
});

const provenance = (): VerifiedReleaseImageProvenance => {
  const identity: ReleaseImageIdentity = {
    schemaVersion: "reviewrouter.hosted-runtime-image.v1",
    repository,
    commit,
    imageUrl: `${imageRepository}@${imageDigest}`,
    imageDigest,
  };
  return {
    schemaVersion: "reviewrouter.release-image-provenance.v2",
    identity,
    claim: {
      identitySha256: `sha256:${sha256Canonical(identity)}`,
      sourceRepository: repository,
      sourceRevision: commit,
      imageRepository,
      buildRunId: "123",
      artifactId: "456",
      artifactName: "runtime-image-v1",
    },
    verification: {
      policySha256: privatePg17ReleaseImagePolicy({
        sourceRepository: repository,
        sourceRevision: commit,
      }).verificationPolicySha256,
      verifiedAt: "2026-08-14T00:00:00.000Z",
    },
  };
};

const baseReceipt = (
  step: string,
  index: number,
  observationSha256 = digest,
) => ({
  step,
  receiptId: `${rolloutId}:${step}:${index}`,
  observedAt: `2026-08-14T00:00:${String(index).padStart(2, "0")}.000Z`,
  rolloutId,
  expectedCommitSha: commit,
  runId: "123",
  runAttempt: 1,
  sourceSystemIdentifier,
  targetSystemIdentifier,
  observationSha256,
  previousReceiptSha256: digest,
  receiptSha256: `sha256:${String(index).padStart(64, "0")}`,
});

const actualRunOutput = () => {
  const preflight = {
    organization: "777genius",
    repository,
    protected: true,
  };
  const staged: StepObservation<typeof stagedFacts> = {
    step: RolloutStep.StageTargetServices,
    observedAt: "2026-08-14T00:00:12.000Z",
    facts: stagedFacts,
    provider: {
      renderServiceIds: stagedFacts.map((service) => service.serviceId),
      renderDeployIds: stagedFacts.map((service) => service.deployId),
      targetSwitchFenceNonce: "1".repeat(32),
      targetSwitchFenceVersion: 1,
      serviceRecoveryManifestSha256: digest,
      targetServiceContractSha256: digest,
    },
  };
  const preflightReceipt = baseReceipt(
    RolloutStep.VerifyProtectedEnvironment,
    2,
    `sha256:${sha256Canonical(preflight)}`,
  );
  const stageReceipt = {
    ...baseReceipt(
      RolloutStep.StageTargetServices,
      13,
      `sha256:${sha256Canonical(staged.facts)}`,
    ),
    provider: staged.provider,
  };
  const activationReceipt = {
    ...baseReceipt(RolloutStep.ActivateTargetGeneration, 14),
    canonicalPrivilegesSha256: digest,
    catalogFactsSha256: digest,
    preactivationCatalogPolicySha256: digest,
    activatedCatalogPolicySha256: digest,
    transactionId: "42",
    firstWriteReceiptSha256: digest,
    firstWriteBoundary: true,
    postgresMajor: 17,
    migrationChecksum: digest,
    permitEpoch: 1,
    permitNonce: "2".repeat(32),
    targetDeployIds: stagedFacts.map((service) => service.deployId),
    beforePrincipalInventorySha256: digest,
    beforePrincipalPolicySha256: digest,
    activatedPrincipalInventorySha256: digest,
    activatedPrincipalPolicySha256: digest,
  };
  return {
    preflight,
    body: {
      rollout: {
        schemaVersion: 2,
        rolloutId,
        expectedCommitSha: commit,
        execution: {
          organization: "777genius",
          controlRepository: repository,
          workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
          workflowRef: "refs/heads/main",
          event: "workflow_dispatch",
          actor: "release-operator",
          runId: "123",
          runAttempt: 1,
          roleJobName: "role-job",
          cutoverJobName: "cutover-job",
        },
        source: {
          renderResourceId: "dpg-source",
          internalHostname: "source.internal",
          databaseName: "reviewrouter",
          systemIdentifier: sourceSystemIdentifier,
          majorVersion: 16,
          recoveryWitnessSha256: "b".repeat(64),
        },
        target: {
          renderResourceId: "dpg-target",
          internalHostname: "target.internal",
          databaseName: "reviewrouter",
          systemIdentifier: targetSystemIdentifier,
          majorVersion: 17,
          recoveryWitnessSha256: "c".repeat(64),
        },
        phase: RolloutPhase.TargetActivated,
        receipts: [preflightReceipt, stageReceipt, activationReceipt],
        activationReceipt,
        activated: true,
        activationUncertain: false,
        sourcePermanentlyIneligible: true,
      },
      releaseImageProvenance: provenance(),
      runners: [runner("role"), runner("cutover")],
      backup: { backupId: "backup-1" },
      quiescence: { fenceSha256: digest },
      equivalence: { equivalenceSha256: digest },
      migration: { legacyReconciliation: { reconciled: true } },
      staged,
      activation: { step: RolloutStep.ActivateTargetGeneration },
    },
  };
};

describe("private PG17 rollout finalizer serialization", () => {
  let directory: string;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    directory = mkdtempSync(join(tmpdir(), "rr-finalizer-"));
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ releaseWitness: "bound" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  afterEach(() => {
    stdout.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  const writeFixture = (
    mutate?: (value: ReturnType<typeof actualRunOutput>["body"]) => void,
  ) => {
    const value = actualRunOutput();
    mutate?.(value.body);
    const bodyFile = join(directory, "run-private-pg17-rollout.json");
    const preflightFile = join(
      directory,
      "protected-environment-preflight.json",
    );
    const provenanceFile = join(directory, "release-image-provenance.json");
    writeFileSync(bodyFile, JSON.stringify(value.body));
    writeFileSync(preflightFile, JSON.stringify(value.preflight));
    writeFileSync(
      provenanceFile,
      JSON.stringify(value.body.releaseImageProvenance),
    );
    const expectations = stagedFacts.map((service) => ({
      serviceId: service.serviceId,
      databaseRole: service.databaseRole,
      provenance: service.provenance,
    }));
    const env = {
      REVIEW_ROUTER_PRIVATE_ROLLOUT_BODY_FILE: bodyFile,
      REVIEW_ROUTER_RELEASE_IMAGE_PROVENANCE_FILE: provenanceFile,
      REVIEW_ROUTER_PROTECTED_ENVIRONMENT_PREFLIGHT_FILE: preflightFile,
      REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY: repository,
      REVIEW_ROUTER_EXPECTED_SHA: commit,
      REVIEW_ROUTER_RELEASE_WITNESS_SIGNING_KEY_ID: "test-key",
      REVIEW_ROUTER_RELEASE_WITNESS_SIGNING_PUBLIC_KEY_PEM: "test-public-key",
      REVIEW_ROUTER_TARGET_SERVICE_EXPECTATIONS_JSON:
        JSON.stringify(expectations),
      REVIEW_ROUTER_PROVIDER_AUTHORITY_URL: "https://authority.example.test",
      REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN: "authority-token",
      REVIEW_ROUTER_RUNNER_LEDGER_URL: "https://ledger.example.test",
      REVIEW_ROUTER_RUNNER_LEDGER_TOKEN: "ledger-token",
      RENDER_SERVICE_SUSPENSION_API_KEY: "render-token",
      REVIEW_ROUTER_LIVE_CANARY_URL: "https://api.example.test/release-canary",
      REVIEW_ROUTER_LIVE_CANARY_TOKEN: "canary-token",
      REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256: "c".repeat(64),
      REVIEW_ROUTER_RELEASE_WITNESS_URL: "https://witness.example.test",
      REVIEW_ROUTER_RELEASE_WITNESS_TOKEN: "witness-token",
    };
    for (const [name, content] of Object.entries(env))
      vi.stubEnv(name, content);
  };

  it("accepts the serialized cutover stage facts and reaches every post-activation boundary", async () => {
    writeFixture();

    await import("./finalize-private-pg17-rollout");

    expect(boundaries.cleanupWitness).toHaveBeenCalledTimes(2);
    expect(boundaries.resume).toHaveBeenCalledOnce();
    expect(boundaries.canary).toHaveBeenCalledOnce();
    expect(boundaries.verifyFinalAuthority).toHaveBeenCalledOnce();
    expect(boundaries.trustedEvidence).toHaveBeenCalledOnce();
    expect(boundaries.compareAndSet).toHaveBeenCalledTimes(4);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining(`"phase":"${RolloutPhase.RolloutVerified}"`),
    );
  });

  it.each([
    [
      "modified staged facts",
      (body: ReturnType<typeof actualRunOutput>["body"]) => {
        body.staged.facts[0]!.deployId = "dep-modified";
      },
    ],
    [
      "a transplanted stage receipt",
      (body: ReturnType<typeof actualRunOutput>["body"]) => {
        const receipt = body.rollout.receipts.find(
          (candidate) => candidate.step === RolloutStep.StageTargetServices,
        )!;
        receipt.observationSha256 = `sha256:${sha256Canonical([
          { ...body.staged.facts[0], deployId: "dep-foreign" },
          ...body.staged.facts.slice(1),
        ])}`;
      },
    ],
  ])("fails closed before downstream effects for %s", async (_name, mutate) => {
    writeFixture(mutate);

    await expect(import("./finalize-private-pg17-rollout")).rejects.toThrow(
      "private_pg17_staged_observation_receipt_mismatch",
    );
    expect(boundaries.cleanupWitness).not.toHaveBeenCalled();
    expect(boundaries.resume).not.toHaveBeenCalled();
    expect(boundaries.canary).not.toHaveBeenCalled();
    expect(boundaries.trustedEvidence).not.toHaveBeenCalled();
  });
});
