import { Buffer } from "node:buffer";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  reviewActionV2CanonicalizerDigest,
  reviewActionV2PublishedSchemaDigest,
  reviewInvestigationExtensionV1,
} from "@reviewrouter/protocol-review-action-v2";
import { describe, expect, it, vi } from "vitest";
import { createApiApp } from "./app.js";
import {
  reviewActionV2ContextReplayActiveKeyIdEnv,
  reviewActionV2ContextReplayKeysEnv,
  reviewActionV2ContextSessionSecretEnv,
} from "./review-action-v2-context-attestation-composition.js";
import {
  assertReviewIntentRolloutConfiguration,
  composeReviewActionV2ProductionRoutes,
  createTrustedProducerReleaseMaterializer,
  ProductionReviewInvestigationAuthorizationCapability,
  readInvestigationRolloutPolicy,
  reviewActionV2CapabilityActiveKeyIdEnv,
  reviewActionV2CapabilityKeysEnv,
  reviewActionV2ProjectionPolicyVersionEnv,
  reviewActionV2ProviderVoteLanesEnv,
  reviewInvestigationContextCriticEnabledEnv,
  reviewInvestigationEmergencyDisabledEnv,
  reviewInvestigationPrivateMaterialActiveKeyIdEnv,
  reviewInvestigationPrivateMaterialKeysEnv,
  reviewInvestigationPrivateMaterialTtlEnv,
  reviewInvestigationMaintenanceEnabledEnv,
  reviewInvestigationLeaseCapabilityActiveKeyIdEnv,
  reviewInvestigationLeaseCapabilityKeysEnv,
  reviewInvestigationProductionEffectsEnabledEnv,
  reviewInvestigationRecordingEnabledEnv,
  reviewInvestigationShadowEnabledEnv,
  reviewInvestigationVerifiedCleanEnabledEnv,
} from "./review-action-v2-production-composition.js";
import {
  InvestigationRolloutCapability,
  InvestigationRolloutDecision,
  InvestigationRolloutProvider,
  evaluateInvestigationRollout,
} from "@reviewrouter/features-review-investigation-operations";
import { investigationRolloutSelectorsEnv } from "@reviewrouter/features-review-investigation-operations/composition";
import { ReviewInvestigationOperationsDiagnosticCode } from "./review-investigation-operations-composition.js";
import { reviewActionV2ProjectionPolicyVersion } from "./review-action-v2-projection-policy.js";

const runtime = {
  readServerTime: async () => new Date("2026-07-23T00:00:00.000Z"),
  createRequestId: () => "request-1",
};

describe("Review Action v2 production composition", () => {
  it("keeps disabled boot inert without Prisma or v2 secrets", async () => {
    expect(
      composeReviewActionV2ProductionRoutes({
        enabled: false,
        env: {},
        runtime,
      }),
    ).toEqual({
      runControl: runtime,
      execution: runtime,
      investigation: runtime,
      contextAttestation: runtime,
      evidence: runtime,
      snapshot: runtime,
      publication: runtime,
    });

    const app = await createApiApp({
      reviewRunControlV2Enabled: false,
      reviewActionV2Env: {},
    });
    await app.ready();
    await app.close();
  });

  it("fails enabled boot before constructing adapters without Prisma", () => {
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env: productionEnv(),
        runtime,
      }),
    ).toThrow("review_action_v2_prisma_unavailable");
  });

  it.each([
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "REVIEW_ROUTER_PUBLIC_API_URL",
    "REVIEW_ROUTER_ACTION_OIDC_AUDIENCE",
    "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID",
    "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON",
    "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON",
    reviewActionV2ProviderVoteLanesEnv,
    reviewActionV2ProjectionPolicyVersionEnv,
    reviewActionV2CapabilityActiveKeyIdEnv,
    reviewActionV2CapabilityKeysEnv,
    reviewActionV2ContextSessionSecretEnv,
    reviewActionV2ContextReplayActiveKeyIdEnv,
    reviewActionV2ContextReplayKeysEnv,
  ])("fails enabled composition when %s is absent", (name) => {
    const env = { ...productionEnv(), [name]: undefined };
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env,
        runtime,
        prisma: inertPrisma(),
      }),
    ).toThrow();
  });

  it("constructs Prisma-backed enabled handlers only with complete production config", () => {
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env: {
          ...productionEnv(),
          [reviewInvestigationRecordingEnabledEnv]: "1",
          [reviewInvestigationPrivateMaterialActiveKeyIdEnv]: "private-v1",
          [reviewInvestigationPrivateMaterialKeysEnv]: JSON.stringify({
            "private-v1": Buffer.alloc(32, 7).toString("base64url"),
          }),
        },
        runtime,
        prisma: inertPrisma(),
      }),
    ).toThrow("investigation_retention_maintenance_required");

    const routes = composeReviewActionV2ProductionRoutes({
      enabled: true,
      env: productionEnv(),
      runtime,
      prisma: inertPrisma(),
    });

    expect(routes.runControl.authorize?.capabilityEnabled).toBe(true);
    expect(routes.runControl.renew?.capabilityEnabled).toBe(true);
    expect(routes.execution.start?.capabilityEnabled).toBe(true);
    expect(routes.execution.acquireLease?.capabilityEnabled).toBe(true);
    expect(routes.execution.adoptObservation?.capabilityEnabled).toBe(true);
    expect(routes.execution.finalize?.capabilityEnabled).toBe(true);
    expect(routes.contextAttestation.openGateway?.capabilityEnabled).toBe(true);
    expect(routes.contextAttestation.sealGateway?.capabilityEnabled).toBe(true);
    expect(routes.contextAttestation.commitReplay?.capabilityEnabled).toBe(
      true,
    );
    expect(routes.evidence.lookup?.capabilityEnabled).toBe(true);
    expect(routes.evidence.commit?.capabilityEnabled).toBe(true);
    expect(routes.snapshot.restore?.capabilityEnabled).toBe(true);
    expect(routes.publication.request?.capabilityEnabled).toBe(true);
    expect(routes.publication.status?.capabilityEnabled).toBe(true);
    expect(routes.runControl.readServerTime).toBe(runtime.readServerTime);
  });

  it("requires private-material keys only while investigation recording is enabled", () => {
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env: {
          ...productionEnv(),
          [reviewInvestigationPrivateMaterialActiveKeyIdEnv]: "unused-key",
        },
        runtime,
        prisma: inertPrisma(),
      }),
    ).not.toThrow();

    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env: {
          ...productionEnv(),
          [reviewInvestigationRecordingEnabledEnv]: "1",
        },
        runtime,
        prisma: inertPrisma(),
      }),
    ).toThrow("investigation_private_material_configuration_required");

    const routes = composeReviewActionV2ProductionRoutes({
      enabled: true,
      env: {
        ...productionEnv(),
        [reviewInvestigationRecordingEnabledEnv]: "1",
        [reviewInvestigationPrivateMaterialActiveKeyIdEnv]: "private-v1",
        [reviewInvestigationPrivateMaterialKeysEnv]: JSON.stringify({
          "private-v1": Buffer.alloc(32, 7).toString("base64url"),
        }),
        [reviewInvestigationPrivateMaterialTtlEnv]: "300000",
        [reviewInvestigationMaintenanceEnabledEnv]: "1",
      },
      runtime,
      prisma: inertPrisma(),
    });
    expect(routes.investigation.open?.capabilityEnabled).toBe(true);
  });

  it.each([
    reviewInvestigationLeaseCapabilityActiveKeyIdEnv,
    reviewInvestigationLeaseCapabilityKeysEnv,
  ])("requires %s only while investigation recording is enabled", (name) => {
    const dormantEnv = { ...productionEnv(), [name]: undefined };
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env: dormantEnv,
        runtime,
        prisma: inertPrisma(),
      }),
    ).not.toThrow();

    const activeEnv = {
      ...productionEnv(),
      [name]: undefined,
      [reviewInvestigationRecordingEnabledEnv]: "1",
      [reviewInvestigationPrivateMaterialActiveKeyIdEnv]: "private-v1",
      [reviewInvestigationPrivateMaterialKeysEnv]: JSON.stringify({
        "private-v1": Buffer.alloc(32, 7).toString("base64url"),
      }),
      [reviewInvestigationPrivateMaterialTtlEnv]: "300000",
      [reviewInvestigationMaintenanceEnabledEnv]: "1",
    };
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env: activeEnv,
        runtime,
        prisma: inertPrisma(),
      }),
    ).toThrow();
  });

  it("rejects a projection policy version that the producer cannot emit", () => {
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env: {
          ...productionEnv(),
          [reviewActionV2ProjectionPolicyVersionEnv]: "1",
        },
        runtime,
        prisma: inertPrisma(),
      }),
    ).toThrow("review_action_v2_projection_policy_version_unsupported");
  });

  it("accepts a supported prior projection policy during a rolling deploy", () => {
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env: {
          ...productionEnv(),
          [reviewActionV2ProjectionPolicyVersionEnv]:
            "review-projection-policy.v4-t0",
        },
        runtime,
        prisma: inertPrisma(),
      }),
    ).not.toThrow();
  });

  it("rejects malformed capability rotation config without exposing it", () => {
    const env = {
      ...productionEnv(),
      [reviewActionV2CapabilityKeysEnv]: JSON.stringify([
        { keyId: "v2", secretBase64: "short", verifyUntil: null },
      ]),
    };
    expect(() =>
      composeReviewActionV2ProductionRoutes({
        enabled: true,
        env,
        runtime,
        prisma: inertPrisma(),
      }),
    ).toThrow("review_action_v2_capability_key_invalid");
  });

  it("fails closed when intent admission is enabled before ingress dispatch is ready", () => {
    expect(() =>
      assertReviewIntentRolloutConfiguration({
        REVIEW_ROUTER_REVIEW_V2_INTENT_ADMISSION_REQUIRED: "1",
      }),
    ).toThrow("review_action_v2_intent_admission_without_ingress");
    expect(() =>
      assertReviewIntentRolloutConfiguration({
        REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED: "1",
      }),
    ).toThrow("review_action_v2_intent_ingress_dependencies_unavailable");
    expect(() =>
      assertReviewIntentRolloutConfiguration({
        REVIEW_ROUTER_REVIEW_V2_INTENT_INGRESS_ENABLED: "1",
        REVIEW_ROUTER_REVIEW_V2_WORKFLOW_DISPATCH_READY: "1",
        REVIEW_ROUTER_REVIEW_V2_WORKER_ENABLED: "1",
        REVIEW_ROUTER_OUTBOX_FENCED_TAKEOVER_ENABLED: "1",
      }),
    ).not.toThrow();
  });

  it("validates investigation flag dependencies and emergency rollback", () => {
    expect(() =>
      readInvestigationRolloutPolicy({
        [reviewInvestigationVerifiedCleanEnabledEnv]: "1",
      }),
    ).toThrow("rollout_dependency_missing:verified_clean:context_critic");
    const policy = readInvestigationRolloutPolicy({
      [reviewInvestigationRecordingEnabledEnv]: "1",
      [reviewInvestigationShadowEnabledEnv]: "1",
      [reviewInvestigationContextCriticEnabledEnv]: "1",
      [reviewInvestigationProductionEffectsEnabledEnv]: "1",
      [reviewInvestigationVerifiedCleanEnabledEnv]: "1",
      [reviewInvestigationEmergencyDisabledEnv]: "1",
      [investigationRolloutSelectorsEnv]: JSON.stringify({
        [InvestigationRolloutCapability.ProductionEffects]: [
          { repositoryConnectionIds: ["repository-1"] },
        ],
        [InvestigationRolloutCapability.VerifiedClean]: [
          { repositoryConnectionIds: ["repository-1"] },
        ],
      }),
    });
    expect(
      evaluateInvestigationRollout(
        policy,
        InvestigationRolloutCapability.ProductionEffects,
        {
          workspaceId: "workspace-1",
          repositoryConnectionId: "repository-1",
          scmRepositoryIdentityId: "scm-repository-1",
          provider: InvestigationRolloutProvider.Codex,
          trustDomain: "trusted",
          producerReleaseId: "release-1",
        },
      ),
    ).toBe(InvestigationRolloutDecision.EmergencyDisabled);

    const scoped = readInvestigationRolloutPolicy({
      [reviewInvestigationRecordingEnabledEnv]: "1",
      [reviewInvestigationShadowEnabledEnv]: "1",
      [reviewInvestigationContextCriticEnabledEnv]: "1",
      [reviewInvestigationProductionEffectsEnabledEnv]: "1",
      [investigationRolloutSelectorsEnv]: JSON.stringify({
        [InvestigationRolloutCapability.ProductionEffects]: [
          { repositoryConnectionIds: ["repository-allowed"] },
        ],
      }),
    });
    expect(
      evaluateInvestigationRollout(
        scoped,
        InvestigationRolloutCapability.ProductionEffects,
        {
          workspaceId: "workspace-1",
          repositoryConnectionId: "repository-denied",
          scmRepositoryIdentityId: "scm-repository-1",
          provider: InvestigationRolloutProvider.Codex,
          trustDomain: "trusted",
          producerReleaseId: "release-1",
        },
      ),
    ).toBe(InvestigationRolloutDecision.OutsideCohort);
  });

  it("advertises a recording-only target with an explicit V2 grant", async () => {
    const diagnostics = vi.fn();
    const resolveAllowedCapabilitiesForTargets = vi
      .fn()
      .mockResolvedValue([[InvestigationRolloutCapability.Recording]]);
    const capability = new ProductionReviewInvestigationAuthorizationCapability(
      {
        resolveAllowedCapabilitiesForTargets,
      },
      { record: diagnostics },
    );

    await expect(
      capability.resolve({
        target: {
          workspaceId: "workspace-1",
          repositoryConnectionId: "repository-1",
          scmRepositoryIdentityId: "scm-repository-1",
          trustDomain: "trusted",
          producerReleaseId: "release-1",
          providerVoteLanes: [{ providerKind: "codex" }],
        } as never,
        producerRelease: {
          reviewInvestigationProfile: {
            capability: "review_investigation_v1",
            coverageProfileHash: "a".repeat(64),
            policyHash: "b".repeat(64),
          },
        } as never,
      }),
    ).resolves.toEqual({
      authorizationDescriptorVersion: 3,
      capability: "review_investigation_v1",
      coverageProfileHash: "a".repeat(64),
      extensionCanonicalizerDigest:
        reviewInvestigationExtensionV1.canonicalizerDigest,
      extensionId: reviewInvestigationExtensionV1.extensionId,
      extensionSchemaDigest: reviewInvestigationExtensionV1.schemaDigest,
      policyHash: "b".repeat(64),
      providerCapabilities: [
        {
          providerKind: "codex",
          capabilities: [InvestigationRolloutCapability.Recording],
        },
      ],
    });
    expect(resolveAllowedCapabilitiesForTargets).toHaveBeenCalledOnce();
    expect(diagnostics).not.toHaveBeenCalled();
    expect(resolveAllowedCapabilitiesForTargets).toHaveBeenCalledWith({
      targets: [
        expect.objectContaining({
          provider: InvestigationRolloutProvider.Codex,
        }),
      ],
    });
  });

  it.each([
    {
      name: "missing release profile",
      profile: null,
      providerVoteLanes: [{ providerKind: "codex" }],
      rolloutResult: [[InvestigationRolloutCapability.Recording]],
      expected:
        ReviewInvestigationOperationsDiagnosticCode.AuthorizationReleaseProfileMissing,
    },
    {
      name: "unsupported provider",
      profile: {
        capability: "review_investigation_v1",
        coverageProfileHash: "a".repeat(64),
        policyHash: "b".repeat(64),
      },
      providerVoteLanes: [{ providerKind: "openrouter" }],
      rolloutResult: [[InvestigationRolloutCapability.Recording]],
      expected:
        ReviewInvestigationOperationsDiagnosticCode.AuthorizationProviderUnsupported,
    },
    {
      name: "recording not granted",
      profile: {
        capability: "review_investigation_v1",
        coverageProfileHash: "a".repeat(64),
        policyHash: "b".repeat(64),
      },
      providerVoteLanes: [{ providerKind: "codex" }],
      rolloutResult: [[]],
      expected:
        ReviewInvestigationOperationsDiagnosticCode.AuthorizationRecordingNotGranted,
    },
  ])("emits one bounded diagnostic for $name denial", async (testCase) => {
    const diagnostics = vi.fn();
    const resolveAllowedCapabilitiesForTargets = vi
      .fn()
      .mockResolvedValue(testCase.rolloutResult);
    const capability = new ProductionReviewInvestigationAuthorizationCapability(
      { resolveAllowedCapabilitiesForTargets },
      { record: diagnostics },
    );

    await expect(
      capability.resolve({
        target: {
          workspaceId: "workspace-secret",
          repositoryConnectionId: "repository-secret",
          scmRepositoryIdentityId: "scm-secret",
          trustDomain: "trusted",
          producerReleaseId: "release-secret",
          providerVoteLanes: testCase.providerVoteLanes,
        } as never,
        producerRelease: {
          reviewInvestigationProfile: testCase.profile,
        } as never,
      }),
    ).resolves.toBeNull();
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledWith(testCase.expected);
  });

  it("emits one bounded diagnostic when rollout resolution is unavailable", async () => {
    const diagnostics = vi.fn();
    const capability = new ProductionReviewInvestigationAuthorizationCapability(
      {
        resolveAllowedCapabilitiesForTargets: vi
          .fn()
          .mockRejectedValue(new Error("selector with secret identifiers")),
      },
      { record: diagnostics },
    );

    await expect(
      capability.resolve({
        target: {
          workspaceId: "workspace-secret",
          repositoryConnectionId: "repository-secret",
          scmRepositoryIdentityId: "scm-secret",
          trustDomain: "trusted",
          producerReleaseId: "release-secret",
          providerVoteLanes: [{ providerKind: "codex" }],
        } as never,
        producerRelease: {
          reviewInvestigationProfile: {
            capability: "review_investigation_v1",
            coverageProfileHash: "a".repeat(64),
            policyHash: "b".repeat(64),
          },
        } as never,
      }),
    ).resolves.toBeNull();
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledWith(
      ReviewInvestigationOperationsDiagnosticCode.AuthorizationRolloutUnavailable,
    );
  });

  it("preserves the investigation profile while materializing a trusted release", async () => {
    const registerProducerRelease = vi.fn().mockResolvedValue({
      status: "created",
      value: {},
    });
    const reviewInvestigationProfile = {
      capability: "review_investigation_v1",
      coverageProfileHash: "a".repeat(64),
      policyHash: "b".repeat(64),
    } as const;
    const materializer = createTrustedProducerReleaseMaterializer({
      digest: {} as never,
      producerReleases: {
        registerProducerRelease,
      } as never,
      releaseQueries: {
        findProducerReleaseById: vi.fn().mockResolvedValue(null),
      } as never,
      protocolLimitsQueries: {
        findProtocolLimitsProfileById: vi
          .fn()
          .mockResolvedValue({ limitsDigest: "c".repeat(64) }),
      } as never,
      operationalSloQueries: {
        findOperationalSloProfileById: vi
          .fn()
          .mockResolvedValue({ sloDigest: "d".repeat(64) }),
      } as never,
    });

    await materializer.ensureRegistered({
      producerReleaseId: "release-1",
      distributionKind: "public_reusable",
      actionCommitSha: "1".repeat(40),
      runtimeCommitSha: "2".repeat(40),
      wrapperEntrypointDigest: null,
      runtimeEntrypointDigest: "e".repeat(64),
      contextGatewayPolicyVersion: "context-gateway-v4",
      contextGatewayEntrypointDigest: "f".repeat(64),
      schemaDigest: reviewActionV2PublishedSchemaDigest,
      capabilityProfile: "exact_revision_v2",
      protocolLimitsProfileId: "limits-v2",
      operationalSloProfileId: "slo-v2",
      reviewInvestigationProfile,
    } as never);

    expect(registerProducerRelease).toHaveBeenCalledWith({
      candidate: expect.objectContaining({ reviewInvestigationProfile }),
      expectedProtocolLimitsDigest: "c".repeat(64),
      expectedOperationalSloDigest: "d".repeat(64),
    });
  });

  it("emits sorted provider-specific capability rows and omits denied providers", async () => {
    const resolveAllowedCapabilitiesForTargets = vi.fn(
      async ({
        targets,
      }: {
        targets: readonly { provider: InvestigationRolloutProvider }[];
      }) =>
        targets.map((target) =>
          target.provider === InvestigationRolloutProvider.Codex
            ? [
                InvestigationRolloutCapability.ContextCritic,
                InvestigationRolloutCapability.Recording,
                InvestigationRolloutCapability.Shadow,
              ]
            : [],
        ),
    );
    const capability = new ProductionReviewInvestigationAuthorizationCapability(
      { resolveAllowedCapabilitiesForTargets },
    );

    await expect(
      capability.resolve({
        target: {
          workspaceId: "workspace-1",
          repositoryConnectionId: "repository-1",
          scmRepositoryIdentityId: "scm-repository-1",
          trustDomain: "trusted",
          producerReleaseId: "release-1",
          providerVoteLanes: [
            { providerKind: "codex" },
            { providerKind: "claude_code" },
          ],
        } as never,
        producerRelease: {
          reviewInvestigationProfile: {
            capability: "review_investigation_v1",
            coverageProfileHash: "a".repeat(64),
            policyHash: "b".repeat(64),
          },
        } as never,
      }),
    ).resolves.toMatchObject({
      providerCapabilities: [
        {
          providerKind: "codex",
          capabilities: [
            InvestigationRolloutCapability.ContextCritic,
            InvestigationRolloutCapability.Recording,
            InvestigationRolloutCapability.Shadow,
          ],
        },
      ],
    });
    expect(resolveAllowedCapabilitiesForTargets).toHaveBeenCalledOnce();
    expect(resolveAllowedCapabilitiesForTargets).toHaveBeenCalledWith({
      targets: [
        expect.objectContaining({
          provider: InvestigationRolloutProvider.Claude,
        }),
        expect.objectContaining({
          provider: InvestigationRolloutProvider.Codex,
        }),
      ],
    });
  });
});

function productionEnv(): Record<string, string> {
  const actionCommitSha = "a".repeat(40);
  const signingKeys = JSON.stringify([
    {
      keyId: "active-v2",
      secretBase64: Buffer.from("s".repeat(32)).toString("base64"),
      verifyUntil: null,
    },
  ]);
  return {
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
    REVIEW_ROUTER_PUBLIC_API_URL: "https://api.reviewrouter.dev",
    REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: "https://api.reviewrouter.dev",
    REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID: "active-v2",
    REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON: signingKeys,
    REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON: JSON.stringify([
      {
        producerReleaseId: "public-action-v2",
        distributionKind: "public_reusable",
        actionCommitSha,
        runtimeCommitSha: "b".repeat(40),
        wrapperEntrypointDigest: null,
        runtimeEntrypointDigest: "c".repeat(64),
        contextGatewayPolicyVersion: "review-context-gateway.v1",
        contextGatewayEntrypointDigest: "9".repeat(64),
        schemaDigest: reviewActionV2PublishedSchemaDigest,
        canonicalizerDigest: reviewActionV2CanonicalizerDigest,
        capabilityProfile: "exact_revision_v2",
        protocolLimitsProfileId: "limits-v2",
        operationalSloProfileId: "slo-v2",
      },
    ]),
    [reviewActionV2ProviderVoteLanesEnv]: JSON.stringify([
      {
        providerKind: "codex",
        providerVoteIdentityHash: "d".repeat(64),
      },
    ]),
    [reviewActionV2ProjectionPolicyVersionEnv]:
      reviewActionV2ProjectionPolicyVersion,
    [reviewActionV2CapabilityActiveKeyIdEnv]: "active-v2",
    [reviewActionV2CapabilityKeysEnv]: signingKeys,
    [reviewInvestigationLeaseCapabilityActiveKeyIdEnv]: "shadow-v1",
    [reviewInvestigationLeaseCapabilityKeysEnv]: JSON.stringify([
      {
        keyId: "shadow-v1",
        secretBase64: Buffer.from("i".repeat(32)).toString("base64"),
        verifyUntil: null,
      },
    ]),
    [reviewActionV2ContextSessionSecretEnv]: Buffer.from(
      "h".repeat(32),
    ).toString("base64"),
    [reviewActionV2ContextReplayActiveKeyIdEnv]: "context-v1",
    [reviewActionV2ContextReplayKeysEnv]: JSON.stringify([
      {
        keyId: "context-v1",
        secretBase64: Buffer.from("r".repeat(32)).toString("base64"),
      },
    ]),
  };
}

function inertPrisma(): PrismaClient {
  return {} as PrismaClient;
}
