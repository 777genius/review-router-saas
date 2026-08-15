import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { ReleaseAuthorityDatabaseReadiness } from "./release-authority/application/readiness";
import { releaseControlDatabaseSetIsReady } from "./release-authority/application/readiness";
import {
  composeReleaseControlDependencies,
  createReleaseControlApp as createReleaseControlAppBase,
  trustedTargetIdentityForPhase,
} from "./release-control-composition";
import { createReleaseWitnessApp as createReleaseWitnessAppBase } from "./release-witness-composition";
import {
  canonicalActivationCatalogPolicies,
  canonicalActivationCatalogPolicyDigests,
  createReleaseMigrationTransition,
} from "@reviewrouter/features-release-rollout";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

afterEach(() => {
  vi.useRealTimers();
});

const trustedDatabaseIdentity = {
  authorityDatabaseIdentity: {
    serverIdentity: "1",
    databaseIdentity: "16384",
    databaseName: "authority",
  },
  targetDatabaseIdentity: {
    serverIdentity: "2",
    databaseIdentity: "16385",
    databaseName: "target",
  },
  authorityOwnerRoleName: "reviewrouter_release_authority_owner",
  activationGuardRoleName: "reviewrouter_activation_receipt_guard",
  installerRoutineBodySha256: "a".repeat(64),
  readerRoutineBodySha256: "b".repeat(64),
  targetMigrationManifestIdentity:
    "sha256:dac2d257a6b60be214b96b0a809df0ee18cc7615ffae21520802fe568debf554",
  activationNamespaceFingerprint: `sha256:${"d".repeat(64)}`,
} as const;
const trustedActivationCatalogPolicies = canonicalActivationCatalogPolicies;
const trustedMigrationTransition = createReleaseMigrationTransition({
  commitSha: "0".repeat(40),
  releaseImageDigest: `sha256:${"0".repeat(64)}`,
});
const explicitCompositionTestGate = {
  execute: async <Result>(
    sequence: Parameters<
      import("./release-authority/application/services").ReleaseAuthorityHighRiskMutationGate["execute"]
    >[0],
  ): Promise<Result> =>
    (await sequence(async (target, mutation) =>
      mutation({
        systemIdentifier:
          target === "installer" || target === "reader" ? "200" : "100",
        recoveryWitnessSha256:
          target === "installer" || target === "reader" ? "f".repeat(64) : "",
      }),
    )) as Result,
};

const testReadinessObserver = async (
  prisma: PrismaClient,
  options?: Readonly<{ signal?: AbortSignal }>,
) => {
  options?.signal?.throwIfAborted();
  const rows = await (
    prisma.$queryRaw as unknown as (query: {
      text: string;
    }) => Promise<ReleaseAuthorityDatabaseReadiness[]>
  )({ text: "WITH facts AS" });
  if (!rows[0]) throw new Error("test_readiness_unavailable");
  return rows[0];
};

const createReleaseWitnessApp = (
  input: Parameters<typeof createReleaseWitnessAppBase>[0],
) =>
  createReleaseWitnessAppBase({
    ...input,
    deploymentRevision: input.deploymentRevision ?? "0".repeat(40),
    artifactDigest: input.artifactDigest ?? `sha256:${"0".repeat(64)}`,
    authorityOwnerRoleName:
      input.authorityOwnerRoleName ?? "reviewrouter_release_authority_owner",
    activationGuardRoleName:
      input.activationGuardRoleName ?? "reviewrouter_activation_receipt_guard",
    trustedDatabaseIdentity:
      input.trustedDatabaseIdentity ??
      trustedDatabaseIdentity.authorityDatabaseIdentity,
    readinessObserver: input.readinessObserver ?? testReadinessObserver,
  });

const withAtomicTestTransaction = (prisma: PrismaClient): PrismaClient => {
  if (
    typeof prisma.$transaction === "function" ||
    !(prisma.$queryRaw as unknown as { atomicTest?: boolean } | undefined)
      ?.atomicTest
  )
    return prisma;
  return Object.assign(prisma, {
    $transaction: async (
      operation: (connection: {
        $queryRaw: PrismaClient["$queryRaw"];
        $executeRawUnsafe: PrismaClient["$executeRawUnsafe"];
      }) => Promise<unknown>,
    ) =>
      operation({
        $queryRaw: prisma.$queryRaw,
        $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      }),
  });
};

const createReleaseControlApp = (
  input: Parameters<typeof createReleaseControlAppBase>[0],
) =>
  createReleaseControlAppBase({
    ...input,
    controlPrisma: withAtomicTestTransaction(input.controlPrisma),
    providerAuthorityPrisma: withAtomicTestTransaction(
      input.providerAuthorityPrisma,
    ),
    permitInstallerPrisma: withAtomicTestTransaction(
      input.permitInstallerPrisma,
    ),
    targetReceiptReaderPrisma: withAtomicTestTransaction(
      input.targetReceiptReaderPrisma,
    ),
    deploymentRevision: input.deploymentRevision ?? "0".repeat(40),
    artifactDigest: input.artifactDigest ?? `sha256:${"0".repeat(64)}`,
    trustedDatabaseIdentity:
      input.trustedDatabaseIdentity ?? trustedDatabaseIdentity,
    readinessObserver: input.readinessObserver ?? testReadinessObserver,
    atomicReadinessObserver:
      input.atomicReadinessObserver ??
      (testReadinessObserver as NonNullable<
        Parameters<
          typeof createReleaseControlAppBase
        >[0]["atomicReadinessObserver"]
      >),
    trustedActivationCatalogPolicies:
      input.trustedActivationCatalogPolicies ??
      trustedActivationCatalogPolicies,
  });

const authorityReadiness = (
  roleName:
    | "reviewrouter_release_control"
    | "reviewrouter_provider_authority"
    | "reviewrouter_release_witness",
): ReleaseAuthorityDatabaseReadiness[] => [
  {
    roleName,
    authorityOwnerRoleName: trustedDatabaseIdentity.authorityOwnerRoleName,
    systemIdentifier: "1",
    recoveryWitnessSha256: "",
    databaseIdentity: trustedDatabaseIdentity.authorityDatabaseIdentity,
    postgresMajor: 17,
    schemaVersion: 13,
    catalogFingerprint: "sha256:canonical-catalog",
    expectedCatalogFingerprint: "sha256:canonical-catalog",
    catalogVerifier: "complete_catalog_v3_acl_exact",
    catalogExact: true,
    defaultAclExact: true,
    finalAclExact: true,
    migrationManifest: [
      [
        "000001_release_authority",
        "eb4039b43228a07c241593d4d6dd863eceac7731d5898b0264e9bc67b3d746cf",
      ],
      [
        "000002_external_effect_protocol",
        "66a1cd48303f31691596ae4e64d952d0fe3543444d042b17243c1a60efb10201",
      ],
      [
        "000002_transactional_service_transition",
        "5f52fdc1fcf6e37fabe9a69908d3c4e4bf82dfa6ab24c6b2ee9c4f3cda2a1099",
      ],
      [
        "000003_partial_source_freeze",
        "02dcd03e3d86c362598537e2ac7afc1dff2d20713fa01158f65e02db621d0da5",
      ],
      [
        "000004_selective_source_recovery",
        "c86e2546a9e135f5b23142a2ef1eb70bc12a0b41345f29abd5d2e5b7cbcaed97",
      ],
      [
        "000005_late_runner_effects",
        "35db45ebd364e6f8cbeafbfb0ab6ac0056fe7e51de2b5fe844b91f1207ba1cfb",
      ],
      [
        "000006_runner_provider_creation_boundary",
        "4ee3a75a1528870df6d66a24eded9fc588aed2681b82aef57335ad7bbadf1260",
      ],
      [
        "000007_compensation_effect_fence",
        "99e384395f93e2c82ea900fdfd86a810f5067bfafec5c32fe5ccd7d51a8d93a9",
      ],
      [
        "000008_trigger_helper_acl",
        "550e7c1e5f11bd795a867c03873d09a6b681c559f07b2101b8e8a3dbea3408c8",
      ],
      [
        "000009_authority_history_and_forward_repairs",
        "bc2fb62a012ad9676ce696a5652abc8d29f2110243f0072dc75bcdcfb0ac8e25",
      ],
      [
        "000010_recovery_effect_permits",
        "a7f1f5063b83f53dfd95dda6bf70740fd2e586dbed368903d7098190cf6200fd",
      ],
      [
        "000011_default_and_final_acl_exactness",
        "727a6615bb6c1af3aee4e69ed33648726b581adb4f4b2f7610be9f5518347420",
      ],
      [
        "000012_provider_mutation_resource_fence",
        "45eb81a2715cf8c254cdacc2ca4ce8c80fc6c6527c009fe9dce63c3f80a510b1",
      ],
      [
        "000013_phase_aware_application_manifest",
        "c14c52ce2594f49a23663a22a16ca789454e059bdb9abd6070d1b773cc847465",
      ],
    ].map(([migrationName, checksum], index) => ({
      position: index + 1,
      migrationName: migrationName!,
      checksumSha256: `sha256:${checksum}`,
      byteVariant: "canonical" as const,
    })),
    controlRoutine: true,
    providerRoutine: true,
    installerRoutine: false,
    readerRoutine: false,
    installerRoutineBodySha256: "",
    readerRoutineBodySha256: "",
    applicationMigrationManifestIdentity: "",
    applicationPostCatalogDigest: "",
    activationNamespaceFingerprint: "",
    authorityRoleTopologyExact: true,
    activationGuardExact: false,
    activationRuntimePrivilegesExact: false,
    externalEffectProtocol: true,
    sourceFreezeProtocol: true,
    selectiveRecoveryProtocol: true,
    lateRunnerEffectProtocol: true,
    recoveryEffectProtocol: true,
    compensationCheckpointDefinition: true,
    runnerProviderBoundary: true,
    cleanupWitnessTemporalSemantics: true,
    requiredTriggers: true,
    authorityOwnershipExact: true,
    authorityAclExact: true,
    publicAuthorityRevoked: true,
    authorityTablesRevoked: true,
  },
];
const installerReadiness = [
  {
    roleName: "reviewrouter_activation_permit_installer",
    authorityOwnerRoleName: "",
    systemIdentifier: "2",
    recoveryWitnessSha256: "f".repeat(64),
    databaseIdentity: trustedDatabaseIdentity.targetDatabaseIdentity,
    postgresMajor: 17,
    schemaVersion: 0,
    catalogFingerprint: "sha256:empty-catalog",
    expectedCatalogFingerprint: "",
    catalogVerifier: "",
    catalogExact: false,
    defaultAclExact: false,
    finalAclExact: false,
    migrationManifest: [],
    controlRoutine: false,
    providerRoutine: false,
    installerRoutine: true,
    readerRoutine: true,
    installerRoutineBodySha256: "a".repeat(64),
    readerRoutineBodySha256: "b".repeat(64),
    applicationMigrationManifestIdentity:
      trustedDatabaseIdentity.targetMigrationManifestIdentity,
    applicationPostCatalogDigest: "",
    activationNamespaceFingerprint:
      trustedDatabaseIdentity.activationNamespaceFingerprint,
    authorityRoleTopologyExact: false,
    activationGuardExact: true,
    activationRuntimePrivilegesExact: true,
    externalEffectProtocol: false,
    sourceFreezeProtocol: false,
    selectiveRecoveryProtocol: false,
    lateRunnerEffectProtocol: false,
    recoveryEffectProtocol: false,
    compensationCheckpointDefinition: false,
    runnerProviderBoundary: false,
    cleanupWitnessTemporalSemantics: false,
    requiredTriggers: false,
    authorityOwnershipExact: false,
    authorityAclExact: false,
    publicAuthorityRevoked: false,
    authorityTablesRevoked: false,
  },
];
const readerReadiness = [
  {
    roleName: "reviewrouter_activation_receipt_reader",
    authorityOwnerRoleName: "",
    systemIdentifier: "2",
    recoveryWitnessSha256: "f".repeat(64),
    databaseIdentity: trustedDatabaseIdentity.targetDatabaseIdentity,
    postgresMajor: 17,
    schemaVersion: 0,
    catalogFingerprint: "sha256:empty-catalog",
    expectedCatalogFingerprint: "",
    catalogVerifier: "",
    catalogExact: false,
    defaultAclExact: false,
    finalAclExact: false,
    migrationManifest: [],
    controlRoutine: false,
    providerRoutine: false,
    installerRoutine: false,
    readerRoutine: true,
    installerRoutineBodySha256: "a".repeat(64),
    readerRoutineBodySha256: "b".repeat(64),
    applicationMigrationManifestIdentity:
      trustedDatabaseIdentity.targetMigrationManifestIdentity,
    applicationPostCatalogDigest: "",
    activationNamespaceFingerprint:
      trustedDatabaseIdentity.activationNamespaceFingerprint,
    authorityRoleTopologyExact: false,
    activationGuardExact: true,
    activationRuntimePrivilegesExact: true,
    externalEffectProtocol: false,
    sourceFreezeProtocol: false,
    selectiveRecoveryProtocol: false,
    lateRunnerEffectProtocol: false,
    recoveryEffectProtocol: false,
    compensationCheckpointDefinition: false,
    runnerProviderBoundary: false,
    cleanupWitnessTemporalSemantics: false,
    requiredTriggers: false,
    authorityOwnershipExact: false,
    authorityAclExact: false,
    publicAuthorityRevoked: false,
    authorityTablesRevoked: false,
  },
];
const postMigrationReadiness = <T extends readonly Record<string, unknown>[]>(
  rows: T,
) =>
  rows.map((row) => ({
    ...row,
    applicationMigrationManifestIdentity:
      trustedMigrationTransition.postManifestIdentity,
    applicationPostCatalogDigest: trustedMigrationTransition.postCatalogDigest,
  }));
const targetEndpointReadiness = <T extends readonly Record<string, unknown>[]>(
  rows: T,
  manifestIdentity: string,
  postCatalogDigest: string,
) =>
  rows.map((row) => ({
    ...row,
    applicationMigrationManifestIdentity: manifestIdentity,
    applicationPostCatalogDigest: postCatalogDigest,
  }));
const witnessReadiness = authorityReadiness("reviewrouter_release_witness");
type QueryOperation = (query: { text?: string }) => unknown;
const readinessQuery = (
  value: readonly unknown[],
  operation: QueryOperation = () => undefined,
) => {
  const query = vi.fn((query: { text?: string }) => {
    const sql = String(query?.text);
    if (sql.includes("set_config") || sql.includes("pg_advisory_xact_lock"))
      return Promise.resolve([{ locked: true }]);
    if (sql.includes('current_user AS "roleName"')) {
      const readiness = value[0] as ReleaseAuthorityDatabaseReadiness;
      return Promise.resolve([
        {
          roleName: readiness.roleName,
          serverIdentity: readiness.databaseIdentity.serverIdentity,
          databaseIdentity: readiness.databaseIdentity.databaseIdentity,
          databaseName: readiness.databaseIdentity.databaseName,
          postgresMajor: readiness.postgresMajor,
        },
      ]);
    }
    if (sql.includes('AS "authorityPresent"')) {
      const readiness = value[0] as Record<string, unknown>;
      return Promise.resolve([
        {
          roleName: readiness.roleName,
          authorityOwnerRoleName: readiness.authorityOwnerRoleName,
          systemIdentifier: readiness.systemIdentifier,
          postgresMajor: readiness.postgresMajor,
          authorityPresent: readiness.schemaVersion === 12,
          installerRoutine: readiness.installerRoutine,
          readerRoutine: readiness.readerRoutine,
          installerRoutineBodySha256: readiness.installerRoutineBodySha256,
          readerRoutineBodySha256: readiness.readerRoutineBodySha256,
          authorityRoleTopologyExact: readiness.authorityRoleTopologyExact,
          activationGuardExact: readiness.activationGuardExact,
          activationRuntimePrivilegesExact:
            readiness.activationRuntimePrivilegesExact,
        },
      ]);
    }
    return sql.includes("WITH facts AS")
      ? Promise.resolve(value)
      : operation(query);
  });
  return Object.assign(query, { atomicTest: true });
};

const createReleaseControlHealthApp = async (
  controlOverrides: Record<string, unknown> = {},
) => {
  const app = await createReleaseControlApp({
    controlPrisma: {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          ...authorityReadiness("reviewrouter_release_control")[0],
          ...controlOverrides,
        },
      ]),
    } as never,
    providerAuthorityPrisma: {
      $queryRaw: vi
        .fn()
        .mockResolvedValue(
          authorityReadiness("reviewrouter_provider_authority"),
        ),
    } as never,
    permitInstallerPrisma: {
      $queryRaw: vi.fn().mockResolvedValue(installerReadiness),
    } as never,
    targetReceiptReaderPrisma: {
      $queryRaw: vi.fn().mockResolvedValue(readerReadiness),
    } as never,
    credentials: {
      controlTokenSha256: digest("control"),
      providerAuthorityTokenSha256: digest("provider"),
    },
    trustedDatabaseIdentity,
  });
  await app.inject({
    method: "POST",
    url: "/v1/rollouts/claim",
    headers: { authorization: "Bearer control" },
    payload: {
      rolloutId: "health-warmup",
      expectedCommitSha: "a".repeat(40),
      runId: "1",
      runAttempt: 1,
      sourceSystemIdentifier: "1",
      targetSystemIdentifier: "2",
    },
  });
  return app;
};

describe("release authority process composition", () => {
  it.each([
    ["pre", "pre_migration", "pre", "untrusted", true],
    ["pre wrong endpoint", "pre_migration", "wrong", "untrusted", false],
    ["recovery pre", "migration_recovery", "pre", "untrusted", true],
    ["recovery post", "migration_recovery", "post", "post", true],
    ["recovery wrong catalog", "migration_recovery", "post", "wrong", false],
    ["recovery wrong endpoint", "migration_recovery", "wrong", "post", false],
    ["post", "post_migration", "post", "post", true],
    ["post wrong catalog", "post_migration", "post", "wrong", false],
    ["post wrong endpoint", "post_migration", "wrong", "post", false],
  ] as const)(
    "applies the exact coordinator target endpoint policy: %s",
    (_name, phase, manifestKind, catalogKind, expected) => {
      const manifest =
        manifestKind === "pre"
          ? trustedMigrationTransition.preManifestIdentity
          : manifestKind === "post"
            ? trustedMigrationTransition.postManifestIdentity
            : `sha256:${"9".repeat(64)}`;
      const catalog =
        catalogKind === "post"
          ? trustedMigrationTransition.postCatalogDigest
          : catalogKind === "wrong"
            ? `sha256:${"8".repeat(64)}`
            : "untrusted";
      const trusted = trustedTargetIdentityForPhase(
        trustedDatabaseIdentity,
        trustedMigrationTransition,
        phase,
        phase === "post_migration"
          ? trustedMigrationTransition.postManifestIdentity
          : trustedMigrationTransition.preManifestIdentity,
      );
      expect(
        releaseControlDatabaseSetIsReady(
          {
            control: authorityReadiness("reviewrouter_release_control")[0]!,
            provider: authorityReadiness("reviewrouter_provider_authority")[0]!,
            installer: targetEndpointReadiness(
              installerReadiness,
              manifest,
              catalog,
            )[0]!,
            reader: targetEndpointReadiness(
              readerReadiness,
              manifest,
              catalog,
            )[0]!,
          },
          trusted,
        ),
      ).toBe(expected);
    },
  );

  it("health reports cached lease state without amplifying catalog observations", async () => {
    const control = {
      $queryRaw: vi.fn().mockResolvedValue([{ value: "claimed" }]),
    } as never;
    const provider = { $queryRaw: vi.fn() } as never;
    const installer = { $queryRaw: vi.fn() } as never;
    const reader = { $queryRaw: vi.fn() } as never;
    let releaseInitial!: () => void;
    const initialPending = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const observer = vi.fn(async (prisma: PrismaClient) => {
      await initialPending;
      return prisma === control
        ? authorityReadiness("reviewrouter_release_control")[0]!
        : prisma === provider
          ? authorityReadiness("reviewrouter_provider_authority")[0]!
          : prisma === installer
            ? installerReadiness[0]!
            : readerReadiness[0]!;
    });
    const app = await createReleaseControlApp({
      controlPrisma: control,
      providerAuthorityPrisma: provider,
      permitInstallerPrisma: installer,
      targetReceiptReaderPrisma: reader,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
      readinessObserver: observer as never,
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(503);
    expect(observer).toHaveBeenCalledTimes(2);
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(503);
    expect(observer).toHaveBeenCalledTimes(2);
    releaseInitial();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(200);
    expect(observer).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("builds focused use cases from distinct control and provider connections", () => {
    const dependencies = composeReleaseControlDependencies(
      {} as never,
      {} as never,
      {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
      trustedDatabaseIdentity,
      explicitCompositionTestGate,
      undefined,
      undefined,
    );
    expect(dependencies.authority).not.toBe(dependencies.runnerOperations);
    expect(dependencies.runnerOperations).not.toBe(dependencies.reconciliation);
    expect(dependencies).not.toHaveProperty("cleanupWitness");
    expect(dependencies).not.toHaveProperty("witnessTokenSha256");
  });

  it("refuses every composition that omits the high-risk mutation gate", () => {
    expect(() =>
      composeReleaseControlDependencies(
        {} as never,
        {} as never,
        {
          controlTokenSha256: digest("control"),
          providerAuthorityTokenSha256: digest("provider"),
        },
        trustedDatabaseIdentity,
        undefined as never,
      ),
    ).toThrow("release_authority_high_risk_mutation_gate_missing");
  });

  it("threads configured pool wait and transaction timeout into routine fences", async () => {
    const connection = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([
          {
            roleName: "reviewrouter_release_control",
            ...trustedDatabaseIdentity.authorityDatabaseIdentity,
            postgresMajor: 17,
          },
        ])
        .mockResolvedValueOnce([{ value: "claimed" }]),
    };
    const transaction = vi.fn(
      async (operation: (connection: unknown) => unknown, options: unknown) => {
        expect(options).toEqual({ maxWait: 123, timeout: 456 });
        return operation(connection);
      },
    );
    const dependencies = composeReleaseControlDependencies(
      { $transaction: transaction } as never,
      {} as never,
      {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
      trustedDatabaseIdentity,
      {
        execute: async (sequence) =>
          sequence(async (target, mutation) =>
            mutation({
              systemIdentifier: target === "installer" ? "2" : "1",
              recoveryWitnessSha256:
                target === "installer" ? "f".repeat(64) : "",
            }),
          ),
      },
      undefined,
      undefined,
      {
        maxWaitMilliseconds: 123,
        transactionTimeoutMilliseconds: 456,
      },
      createReleaseMigrationTransition({
        commitSha: "a".repeat(40),
        releaseImageDigest: `sha256:${"e".repeat(64)}`,
      }),
    );
    await expect(
      dependencies.authority.claim({
        rolloutId: "fence-timing",
        expectedCommitSha: "a".repeat(40),
        runId: "1",
        runAttempt: 1,
        sourceSystemIdentifier: "1",
        targetSystemIdentifier: "2",
        targetRecoveryWitnessSha256: "f".repeat(64),
        migrationTransition: createReleaseMigrationTransition({
          commitSha: "a".repeat(40),
          releaseImageDigest: `sha256:${"e".repeat(64)}`,
        }),
      }),
    ).resolves.toBe("claimed");
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 123,
      timeout: 456,
    });
  });

  it("rejects malformed process credentials independently", async () => {
    expect(() =>
      composeReleaseControlDependencies(
        {} as never,
        {} as never,
        {
          controlTokenSha256: "invalid",
          providerAuthorityTokenSha256: digest("provider"),
        },
        trustedDatabaseIdentity,
        undefined as never,
      ),
    ).toThrow("release_control_credential_hash_invalid");
    await expect(
      createReleaseWitnessApp({
        witnessPrisma: {} as never,
        triggerTokenSha256: "invalid",
        renderReadToken: "read-only",
      }),
    ).rejects.toThrow("release_witness_credential_hash_invalid");
  });

  it("installs an authorized permit through the server-owned installer connection", async () => {
    const authorization = {
      rolloutId: "rollout-1",
      expectedCommitSha: "c".repeat(40),
      postgresMajor: 17 as const,
      migrationChecksum: `sha256:${"7".repeat(64)}`,
      transitionSha256: `sha256:${"8".repeat(64)}`,
      postManifestIdentity: `sha256:${"7".repeat(64)}`,
      epoch: 2,
      nonce: "a".repeat(32),
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: "200",
      previousReceiptSha256: `sha256:${"b".repeat(64)}`,
      targetDeployIds: ["deploy-1"],
      authorizedAt: "2026-08-12T00:00:00.000Z",
    };
    const authorityQuery = vi
      .fn()
      .mockResolvedValue([{ value: authorization }]);
    const installerQuery = vi.fn().mockResolvedValue([{ result: false }]);
    const dependencies = composeReleaseControlDependencies(
      { $queryRaw: authorityQuery } as never,
      {} as never,
      {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
      trustedDatabaseIdentity,
      explicitCompositionTestGate,
      { $queryRaw: installerQuery } as never,
      undefined,
      undefined,
    );
    await expect(
      dependencies.authority.authorizeAndInstall({
        expectedCommitSha: "c".repeat(40),
        runId: "run-1",
        jobId: "job-1",
        runAttempt: 1,
        rolloutId: "rollout-1",
        sourceSystemIdentifier: "100",
        targetSystemIdentifier: "200",
        previousReceiptSha256: `sha256:${"b".repeat(64)}`,
        targetDeployIds: ["deploy-1"],
        postgresMajor: 17,
        migrationChecksum: authorization.migrationChecksum,
        transitionSha256: authorization.transitionSha256,
        postManifestIdentity: authorization.postManifestIdentity,
      }),
    ).resolves.toEqual(authorization);
    expect(authorityQuery).toHaveBeenCalledOnce();
    expect(installerQuery).toHaveBeenCalledOnce();
    const installerSql = installerQuery.mock.calls[0]?.[0] as {
      text: string;
      values: readonly unknown[];
    };
    expect(installerSql.text).not.toContain("_prisma_migrations");
    expect(installerSql.text).not.toContain("WITH migration");
    expect(installerSql.values).toEqual(
      expect.arrayContaining([
        authorization.expectedCommitSha,
        authorization.postgresMajor,
        authorization.migrationChecksum,
        trustedActivationCatalogPolicies.preactivation.sha256,
        trustedActivationCatalogPolicies.activated.sha256,
        JSON.stringify(trustedActivationCatalogPolicies.preactivation.policy),
        JSON.stringify(trustedActivationCatalogPolicies.activated.policy),
      ]),
    );
  });

  it("keeps target receipt reads isolated from installer and authority connections", async () => {
    const authorization = {
      rolloutId: "rollout-proof",
      expectedCommitSha: "c".repeat(40),
      postgresMajor: 17 as const,
      migrationChecksum: `sha256:${"7".repeat(64)}`,
      epoch: 2,
      nonce: "a".repeat(32),
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: "200",
      previousReceiptSha256: `sha256:${"b".repeat(64)}`,
      targetDeployIds: ["deploy-1"],
      authorizedAt: "2026-08-12T00:00:00.000Z",
    };
    const targetReceipt = {
      rolloutId: authorization.rolloutId,
      expectedCommitSha: authorization.expectedCommitSha,
      sourceSystemIdentifier: authorization.sourceSystemIdentifier,
      targetSystemIdentifier: authorization.targetSystemIdentifier,
      postgresMajor: 17 as const,
      migrationChecksum: authorization.migrationChecksum,
      targetDeployIds: authorization.targetDeployIds,
      permitEpoch: authorization.epoch,
      permitNonce: authorization.nonce,
      canonicalPrivilegesSha256: `sha256:${"1".repeat(64)}`,
      catalogFactsSha256: `sha256:${"2".repeat(64)}`,
      ...canonicalActivationCatalogPolicyDigests,
      beforePrincipalInventorySha256: `sha256:${"4".repeat(64)}`,
      beforePrincipalPolicySha256: `sha256:${"5".repeat(64)}`,
      activatedPrincipalInventorySha256: `sha256:${"6".repeat(64)}`,
      activatedPrincipalPolicySha256: `sha256:${"8".repeat(64)}`,
      transactionId: "12345",
      firstWriteReceiptSha256: `sha256:${"3".repeat(64)}`,
      firstWriteBoundary: true as const,
      activatedAt: "2026-08-12T00:01:00.000Z",
    };
    const receipt = {
      step: "activate_target_generation" as const,
      receiptId: "receipt-1",
      observedAt: targetReceipt.activatedAt,
      rolloutId: targetReceipt.rolloutId,
      expectedCommitSha: targetReceipt.expectedCommitSha,
      runId: "run-1",
      runAttempt: 1,
      sourceSystemIdentifier: targetReceipt.sourceSystemIdentifier,
      targetSystemIdentifier: targetReceipt.targetSystemIdentifier,
      provider: { renderDeployIds: ["deploy-1"] },
      observationSha256: `sha256:${digest(JSON.stringify(targetReceipt))}`,
      previousReceiptSha256: authorization.previousReceiptSha256,
      receiptSha256: `sha256:${"e".repeat(64)}`,
      canonicalPrivilegesSha256: targetReceipt.canonicalPrivilegesSha256,
      catalogFactsSha256: targetReceipt.catalogFactsSha256,
      preactivationCatalogPolicySha256:
        targetReceipt.preactivationCatalogPolicySha256,
      activatedCatalogPolicySha256: targetReceipt.activatedCatalogPolicySha256,
      beforePrincipalInventorySha256:
        targetReceipt.beforePrincipalInventorySha256,
      beforePrincipalPolicySha256: targetReceipt.beforePrincipalPolicySha256,
      activatedPrincipalInventorySha256:
        targetReceipt.activatedPrincipalInventorySha256,
      activatedPrincipalPolicySha256:
        targetReceipt.activatedPrincipalPolicySha256,
      transactionId: targetReceipt.transactionId,
      firstWriteReceiptSha256: targetReceipt.firstWriteReceiptSha256,
      firstWriteBoundary: targetReceipt.firstWriteBoundary,
      postgresMajor: targetReceipt.postgresMajor,
      migrationChecksum: targetReceipt.migrationChecksum,
      permitEpoch: targetReceipt.permitEpoch,
      permitNonce: targetReceipt.permitNonce,
      targetDeployIds: targetReceipt.targetDeployIds,
    };
    const authorityOperation = vi.fn().mockResolvedValue([{ value: true }]);
    const authorityQuery = readinessQuery(
      authorityReadiness("reviewrouter_release_control"),
      authorityOperation,
    );
    const installerOperation = vi.fn();
    const installerQuery = readinessQuery(
      postMigrationReadiness(installerReadiness),
      installerOperation,
    );
    const readerOperation = vi.fn().mockResolvedValue([
      {
        value: targetReceipt,
      },
    ]);
    const readerQuery = readinessQuery(
      postMigrationReadiness(readerReadiness),
      readerOperation,
    );
    const app = await createReleaseControlApp({
      controlPrisma: { $queryRaw: authorityQuery } as never,
      providerAuthorityPrisma: {
        $queryRaw: readinessQuery(
          authorityReadiness("reviewrouter_provider_authority"),
        ),
      } as never,
      permitInstallerPrisma: { $queryRaw: installerQuery } as never,
      targetReceiptReaderPrisma: { $queryRaw: readerQuery } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });
    const finalize = (activationReceipt: typeof receipt) =>
      app.inject({
        method: "POST",
        url: `/v1/rollouts/${authorization.rolloutId}/activation-finalize`,
        headers: { authorization: "Bearer control" },
        payload: {
          authorization,
          provider: receipt.provider,
          nextReceiptSha256: receipt.receiptSha256,
          activationReceipt,
        },
      });

    expect(
      (await finalize({ ...receipt, transactionId: "forged" })).json(),
    ).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "target_activation_receipt_mismatch",
    });
    expect(authorityOperation).not.toHaveBeenCalled();

    expect((await finalize(receipt)).json()).toEqual({ changed: true });
    expect(readerOperation).toHaveBeenCalledTimes(2);
    expect(authorityOperation).toHaveBeenCalledOnce();
    expect(installerOperation).not.toHaveBeenCalled();
    expect(String(readerOperation.mock.calls[0]?.[0].text)).toContain(
      "read_activation_receipt",
    );
    expect(String(authorityOperation.mock.calls[0]?.[0].text)).toContain(
      "release_rollout_finalize_activation",
    );
    await app.close();
  });

  it("retries the same committed authorization after an install timeout", async () => {
    const authorization = {
      rolloutId: "rollout-retry",
      expectedCommitSha: "c".repeat(40),
      postgresMajor: 17 as const,
      migrationChecksum: trustedMigrationTransition.postManifestIdentity,
      transitionSha256: trustedMigrationTransition.transitionSha256,
      postManifestIdentity: trustedMigrationTransition.postManifestIdentity,
      epoch: 4,
      nonce: "d".repeat(32),
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: "200",
      previousReceiptSha256: `sha256:${"b".repeat(64)}`,
      targetDeployIds: ["deploy-1"],
      authorizedAt: "2026-08-12T00:00:00.000Z",
    };
    const authorityOperation = vi
      .fn()
      .mockResolvedValue([{ value: authorization }]);
    const installerOperation = vi
      .fn()
      .mockRejectedValueOnce(new Error("target_database_timeout"))
      .mockResolvedValueOnce([{ result: false }]);
    const authorityQuery = readinessQuery(
      authorityReadiness("reviewrouter_release_control"),
      authorityOperation,
    );
    const installerQuery = readinessQuery(
      postMigrationReadiness(installerReadiness),
      installerOperation,
    );
    const app = await createReleaseControlApp({
      controlPrisma: { $queryRaw: authorityQuery } as never,
      providerAuthorityPrisma: {
        $queryRaw: readinessQuery(
          authorityReadiness("reviewrouter_provider_authority"),
        ),
      } as never,
      permitInstallerPrisma: { $queryRaw: installerQuery } as never,
      targetReceiptReaderPrisma: {
        $queryRaw: readinessQuery(postMigrationReadiness(readerReadiness)),
      } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });
    const payload = {
      rolloutId: authorization.rolloutId,
      expectedCommitSha: "c".repeat(40),
      runId: "run-1",
      jobId: "job-1",
      runAttempt: 1,
      sourceSystemIdentifier: authorization.sourceSystemIdentifier,
      targetSystemIdentifier: authorization.targetSystemIdentifier,
      previousReceiptSha256: authorization.previousReceiptSha256,
      targetDeployIds: authorization.targetDeployIds,
      postgresMajor: authorization.postgresMajor,
      migrationChecksum: authorization.migrationChecksum,
      transitionSha256: authorization.transitionSha256,
      postManifestIdentity: authorization.postManifestIdentity,
    };
    const authorize = () =>
      app.inject({
        method: "POST",
        url: `/v1/rollouts/${authorization.rolloutId}/activation-authorization`,
        headers: { authorization: "Bearer control" },
        payload,
      });

    expect((await authorize()).statusCode).toBe(500);
    const retry = await authorize();
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ authorization });
    expect(authorityOperation).toHaveBeenCalledTimes(2);
    expect(installerOperation).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("does not expose witness writes from the control process", async () => {
    const app = await createReleaseControlApp({
      controlPrisma: {
        $queryRaw: vi
          .fn()
          .mockResolvedValue(
            authorityReadiness("reviewrouter_release_control"),
          ),
      } as never,
      providerAuthorityPrisma: {
        $queryRaw: vi
          .fn()
          .mockResolvedValue(
            authorityReadiness("reviewrouter_provider_authority"),
          ),
      } as never,
      permitInstallerPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(installerReadiness),
      } as never,
      targetReceiptReaderPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(readerReadiness),
      } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(503);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/v1/runner-jobs/job/provider-witness",
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("keeps control and provider authority credentials mutually exclusive", async () => {
    expect(() =>
      composeReleaseControlDependencies(
        {} as never,
        {} as never,
        {
          controlTokenSha256: digest("same"),
          providerAuthorityTokenSha256: digest("same"),
        },
        trustedDatabaseIdentity,
        undefined as never,
      ),
    ).toThrow("release_control_credential_hash_invalid");

    const app = await createReleaseControlApp({
      controlPrisma: {} as never,
      providerAuthorityPrisma: {} as never,
      permitInstallerPrisma: {} as never,
      targetReceiptReaderPrisma: {} as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/provider-authority/decisions",
          headers: { authorization: "Bearer control" },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/rollouts/claim",
          headers: { authorization: "Bearer provider" },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });

  it("routes provider decisions only through the provider authority login", async () => {
    const controlOperation = vi.fn();
    const controlQuery = readinessQuery(
      authorityReadiness("reviewrouter_release_control"),
      controlOperation,
    );
    const providerOperation = vi.fn().mockResolvedValue([
      {
        value: {
          rolloutId: "rollout-provider",
          operation: "deploy_target",
          sourceSystemIdentifier: "100",
          targetSystemIdentifier: "200",
          expectedReceiptSha256: `sha256:${"a".repeat(64)}`,
          activationBoundary: "before",
          decision: "allow",
          decisionId: "decision-1",
          decidedAt: "2026-08-12T00:00:00.000Z",
        },
      },
    ]);
    const providerQuery = readinessQuery(
      authorityReadiness("reviewrouter_provider_authority"),
      providerOperation,
    );
    const app = await createReleaseControlApp({
      controlPrisma: { $queryRaw: controlQuery } as never,
      providerAuthorityPrisma: { $queryRaw: providerQuery } as never,
      permitInstallerPrisma: {
        $queryRaw: readinessQuery(postMigrationReadiness(installerReadiness)),
      } as never,
      targetReceiptReaderPrisma: {
        $queryRaw: readinessQuery(postMigrationReadiness(readerReadiness)),
      } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/provider-authority/decisions",
      headers: { authorization: "Bearer provider" },
      payload: {
        rolloutId: "rollout-provider",
        operation: "deploy_target",
        sourceSystemIdentifier: "100",
        targetSystemIdentifier: "200",
        expectedReceiptSha256: `sha256:${"a".repeat(64)}`,
        activationBoundary: "before",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(providerOperation).toHaveBeenCalledOnce();
    expect(controlOperation).not.toHaveBeenCalled();
    const query = providerOperation.mock.calls[0]?.[0] as {
      values?: readonly unknown[];
    };
    expect(query.values).toContainEqual(
      JSON.stringify({
        rolloutId: "rollout-provider",
        operation: "deploy_target",
        sourceSystemIdentifier: "100",
        targetSystemIdentifier: "200",
        expectedReceiptSha256: `sha256:${"a".repeat(64)}`,
        activationBoundary: "before",
      }),
    );
    await app.close();
  });

  it("authenticates provider mutation callers with the provider bearer but routes routines through release control", async () => {
    const permit = {
      rolloutId: "rollout-provider-mutation",
      operation: "freeze:srv-one",
      resource: { provider: "render", kind: "service", id: "srv-one" },
      ownerId: "actor-one",
      epoch: 1,
      permitId: "a".repeat(64),
      token: "b".repeat(64),
      expected: { fingerprint: `sha256:${"c".repeat(64)}`, version: null },
      issuedAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      singleUse: true,
    };
    const controlOperation = vi.fn().mockResolvedValue([{ value: permit }]);
    const providerOperation = vi.fn();
    const app = await createReleaseControlApp({
      controlPrisma: {
        $queryRaw: readinessQuery(
          authorityReadiness("reviewrouter_release_control"),
          controlOperation,
        ),
      } as never,
      providerAuthorityPrisma: {
        $queryRaw: readinessQuery(
          authorityReadiness("reviewrouter_provider_authority"),
          providerOperation,
        ),
      } as never,
      permitInstallerPrisma: {
        $queryRaw: readinessQuery(postMigrationReadiness(installerReadiness)),
      } as never,
      targetReceiptReaderPrisma: {
        $queryRaw: readinessQuery(postMigrationReadiness(readerReadiness)),
      } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/provider-mutations/issue",
      headers: { authorization: "Bearer provider" },
      payload: {
        rolloutId: permit.rolloutId,
        operation: permit.operation,
        resource: permit.resource,
        ownerId: permit.ownerId,
        expected: permit.expected,
        leaseSeconds: 60,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(permit);
    expect(controlOperation).toHaveBeenCalledOnce();
    expect(providerOperation).not.toHaveBeenCalled();
    expect(String(controlOperation.mock.calls[0]?.[0]?.text)).toContain(
      "release_provider_mutation_issue",
    );

    const controlCredentialResponse = await app.inject({
      method: "POST",
      url: "/v1/provider-mutations/issue",
      headers: { authorization: "Bearer control" },
      payload: {
        rolloutId: permit.rolloutId,
        operation: permit.operation,
        resource: permit.resource,
        ownerId: permit.ownerId,
        expected: permit.expected,
        leaseSeconds: 60,
      },
    });
    expect(controlCredentialResponse.statusCode).toBe(401);
    expect(controlOperation).toHaveBeenCalledOnce();
    await app.close();
  });

  it("bypasses a healthy lease for provider mutations while retaining it for ordinary control calls", async () => {
    let catalogDrifted = false;
    const controlOperation = vi.fn((query: { text?: string }) =>
      Promise.resolve([
        {
          value: String(query.text).includes("release_rollout_claim")
            ? "claimed"
            : null,
        },
      ]),
    );
    const atomicQuery = <T extends ReturnType<typeof vi.fn>>(query: T): T =>
      Object.assign(query, { atomicTest: true });
    const control = {
      $queryRaw: atomicQuery(controlOperation),
    } as unknown as PrismaClient;
    const provider = {
      $queryRaw: atomicQuery(vi.fn()),
    } as unknown as PrismaClient;
    const installer = {
      $queryRaw: atomicQuery(vi.fn()),
    } as unknown as PrismaClient;
    const reader = {
      $queryRaw: atomicQuery(vi.fn()),
    } as unknown as PrismaClient;
    const observedConnections: string[] = [];
    const observer = vi.fn(async (prisma: PrismaClient) => {
      const query = prisma.$queryRaw;
      if (prisma === control || query === control.$queryRaw) {
        observedConnections.push("control");
        return {
          ...authorityReadiness("reviewrouter_release_control")[0]!,
          catalogExact: !catalogDrifted,
        };
      }
      if (prisma === provider || query === provider.$queryRaw) {
        observedConnections.push("provider");
        return authorityReadiness("reviewrouter_provider_authority")[0]!;
      }
      if (prisma === installer || query === installer.$queryRaw) {
        observedConnections.push("installer");
        return installerReadiness[0]!;
      }
      observedConnections.push("reader");
      return readerReadiness[0]!;
    });
    const app = await createReleaseControlApp({
      controlPrisma: control,
      providerAuthorityPrisma: provider,
      permitInstallerPrisma: installer,
      targetReceiptReaderPrisma: reader,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
      readinessObserver: observer as never,
      atomicReadinessObserver: observer as never,
    });
    expect(
      releaseControlDatabaseSetIsReady(
        {
          control: authorityReadiness("reviewrouter_release_control")[0]!,
          provider: authorityReadiness("reviewrouter_provider_authority")[0]!,
          installer: installerReadiness[0]!,
          reader: readerReadiness[0]!,
        },
        trustedDatabaseIdentity,
      ),
    ).toBe(true);
    const claim = () =>
      app.inject({
        method: "POST",
        url: "/v1/rollouts/claim",
        headers: { authorization: "Bearer control" },
        payload: {
          rolloutId: "rollout-fresh-gate",
          expectedCommitSha: "0".repeat(40),
          runId: "1",
          runAttempt: 1,
          sourceSystemIdentifier: "100",
          targetSystemIdentifier: "2",
          targetRecoveryWitnessSha256: "f".repeat(64),
          migrationTransition: trustedMigrationTransition,
        },
      });
    const firstClaim = await claim();
    expect(
      firstClaim.statusCode,
      `${firstClaim.body}:${observedConnections.join(",")}`,
    ).toBe(200);
    expect(observer).toHaveBeenCalledTimes(12);
    catalogDrifted = true;

    expect((await claim()).statusCode).toBe(503);
    expect(observer).toHaveBeenCalledTimes(14);
    const protectedMutation = await app.inject({
      method: "POST",
      url: "/v1/provider-mutations/issue",
      headers: { authorization: "Bearer provider" },
      payload: {
        rolloutId: "rollout-fresh-gate",
        operation: "freeze:srv-one",
        resource: { provider: "render", kind: "service", id: "srv-one" },
        ownerId: "actor-one",
        expected: { fingerprint: `sha256:${"c".repeat(64)}`, version: null },
        leaseSeconds: 60,
      },
    });
    expect(protectedMutation.statusCode).toBe(503);
    expect(observer).toHaveBeenCalledTimes(16);
    expect(controlOperation).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("maps durable provider policy conflicts to a redacted 409", async () => {
    const providerOperation = vi.fn().mockRejectedValue(
      Object.assign(new Error("prisma query failed"), {
        code: "P2010",
        message:
          "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `P0001`. Message: `provider authority state denied`",
      }),
    );
    const providerQuery = readinessQuery(
      authorityReadiness("reviewrouter_provider_authority"),
      providerOperation,
    );
    const app = await createReleaseControlApp({
      controlPrisma: {
        $queryRaw: readinessQuery(
          authorityReadiness("reviewrouter_release_control"),
        ),
      } as never,
      providerAuthorityPrisma: { $queryRaw: providerQuery } as never,
      permitInstallerPrisma: {
        $queryRaw: readinessQuery(postMigrationReadiness(installerReadiness)),
      } as never,
      targetReceiptReaderPrisma: {
        $queryRaw: readinessQuery(postMigrationReadiness(readerReadiness)),
      } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/provider-authority/decisions",
      headers: { authorization: "Bearer provider" },
      payload: {
        rolloutId: "rollout-provider",
        operation: "deploy_target",
        sourceSystemIdentifier: "100",
        targetSystemIdentifier: "200",
        expectedReceiptSha256: `sha256:${"a".repeat(64)}`,
        activationBoundary: "before",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe("provider_authority_decision_denied");
    expect(response.body).not.toContain("state denied");
    expect(response.body).not.toContain("P0001");
    await app.close();
  });

  it("does not expose control routes from the witness process", async () => {
    const app = await createReleaseWitnessApp({
      witnessPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(witnessReadiness),
      } as never,
      triggerTokenSha256: digest("witness"),
      renderReadToken: "read-only",
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(503);
    expect(
      (await app.inject({ method: "POST", url: "/v1/rollouts/claim" }))
        .statusCode,
    ).toBe(404);
    await app.close();
  });

  it("bounds a hung witness readiness observation", async () => {
    vi.useFakeTimers();
    const app = await createReleaseWitnessApp({
      witnessPrisma: {} as never,
      triggerTokenSha256: digest("witness"),
      renderReadToken: "read-only",
      readinessObserver: () => new Promise<never>(() => undefined),
      readinessPolicy: {
        observationDeadlineMilliseconds: 25,
        transactionTimeoutMilliseconds: 20,
        statementTimeoutMilliseconds: 15,
        lockTimeoutMilliseconds: 2,
        poolWaitMilliseconds: 2,
      },
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      service: "release-witness",
      reason: "database_unavailable",
    });
    expect(response.body).not.toContain(
      "release_witness_readiness_unavailable",
    );
    await app.close();
  });

  it("reports degraded readiness without leaking database failures", async () => {
    const app = await createReleaseControlApp({
      controlPrisma: {
        $queryRaw: vi
          .fn()
          .mockRejectedValue(new Error("secret database detail")),
      } as never,
      providerAuthorityPrisma: {
        $queryRaw: vi
          .fn()
          .mockResolvedValue(
            authorityReadiness("reviewrouter_provider_authority"),
          ),
      } as never,
      permitInstallerPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(installerReadiness),
      } as never,
      targetReceiptReaderPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(readerReadiness),
      } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      service: "release-control",
      reason: "database_unavailable",
    });
    expect(response.body).not.toContain("secret database detail");
    await app.close();
  });

  it("keeps health responsive and sanitized when a database probe hangs", async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const app = await createReleaseControlApp({
      controlPrisma: {
        $queryRaw: vi.fn(() => never),
      } as never,
      providerAuthorityPrisma: {
        $queryRaw: vi
          .fn()
          .mockResolvedValue(
            authorityReadiness("reviewrouter_provider_authority"),
          ),
      } as never,
      permitInstallerPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(installerReadiness),
      } as never,
      targetReceiptReaderPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(readerReadiness),
      } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
      readinessPolicy: {
        observationDeadlineMilliseconds: 25,
        transactionTimeoutMilliseconds: 20,
        statementTimeoutMilliseconds: 15,
        lockTimeoutMilliseconds: 2,
        poolWaitMilliseconds: 2,
      },
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      service: "release-control",
      reason: "database_unavailable",
    });
    expect(response.body).not.toContain(
      "release_control_readiness_unavailable",
    );
    await app.close();
  });

  it("withholds mutation authority when exact ACL readiness is degraded", async () => {
    const mutation = vi.fn().mockResolvedValue([{ value: true }]);
    const app = await createReleaseControlApp({
      controlPrisma: {
        $queryRaw: readinessQuery(
          [
            {
              ...authorityReadiness("reviewrouter_release_control")[0],
              authorityAclExact: false,
            },
          ],
          mutation,
        ),
      } as never,
      providerAuthorityPrisma: {
        $queryRaw: readinessQuery(
          authorityReadiness("reviewrouter_provider_authority"),
        ),
      } as never,
      permitInstallerPrisma: {
        $queryRaw: readinessQuery(installerReadiness),
      } as never,
      targetReceiptReaderPrisma: {
        $queryRaw: readinessQuery(readerReadiness),
      } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/rollouts/claim",
      headers: { authorization: "Bearer control" },
      payload: {
        rolloutId: "rollout-degraded",
        expectedCommitSha: "a".repeat(40),
        runId: "1",
        runAttempt: 1,
        sourceSystemIdentifier: "100",
        targetSystemIdentifier: "2",
        targetRecoveryWitnessSha256: "f".repeat(64),
        migrationTransition: createReleaseMigrationTransition({
          commitSha: "a".repeat(40),
          releaseImageDigest: `sha256:${"0".repeat(64)}`,
        }),
      },
    });
    expect(response.statusCode).toBe(503);
    expect(mutation).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns a sanitized unavailable response for mutation readiness failures", async () => {
    const app = await createReleaseControlApp({
      controlPrisma: {
        $queryRaw: vi
          .fn()
          .mockRejectedValue(new Error("secret database connection detail")),
      } as never,
      providerAuthorityPrisma: {
        $queryRaw: vi
          .fn()
          .mockResolvedValue(
            authorityReadiness("reviewrouter_provider_authority"),
          ),
      } as never,
      permitInstallerPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(installerReadiness),
      } as never,
      targetReceiptReaderPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(readerReadiness),
      } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/rollouts/claim",
      headers: { authorization: "Bearer control" },
      payload: {
        rolloutId: "rollout-readiness-failure",
        expectedCommitSha: "a".repeat(40),
        runId: "1",
        runAttempt: 1,
        sourceSystemIdentifier: "100",
        targetSystemIdentifier: "2",
        targetRecoveryWitnessSha256: "f".repeat(64),
        migrationTransition: createReleaseMigrationTransition({
          commitSha: "a".repeat(40),
          releaseImageDigest: `sha256:${"0".repeat(64)}`,
        }),
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("release_control_readiness_unavailable");
    expect(response.body).not.toContain("secret database connection detail");
    await app.close();
  });

  it("fails health when the required 000002 external-effect routines are absent", async () => {
    const app = await createReleaseControlApp({
      controlPrisma: {
        $queryRaw: vi.fn().mockResolvedValue([
          {
            ...authorityReadiness("reviewrouter_release_control")[0],
            externalEffectProtocol: false,
          },
        ]),
      } as never,
      providerAuthorityPrisma: {
        $queryRaw: vi
          .fn()
          .mockResolvedValue(
            authorityReadiness("reviewrouter_provider_authority"),
          ),
      } as never,
      permitInstallerPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(installerReadiness),
      } as never,
      targetReceiptReaderPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(readerReadiness),
      } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(503);
    await app.close();
  });

  it("fails health for an authority database stopped after 000003", async () => {
    const app = await createReleaseControlApp({
      controlPrisma: {
        $queryRaw: vi.fn().mockResolvedValue([
          {
            ...authorityReadiness("reviewrouter_release_control")[0],
            schemaVersion: 3,
            selectiveRecoveryProtocol: false,
            lateRunnerEffectProtocol: false,
            requiredTriggers: false,
          },
        ]),
      } as never,
      providerAuthorityPrisma: {
        $queryRaw: vi
          .fn()
          .mockResolvedValue(
            authorityReadiness("reviewrouter_provider_authority"),
          ),
      } as never,
      permitInstallerPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(installerReadiness),
      } as never,
      targetReceiptReaderPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(readerReadiness),
      } as never,
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(503);
    await app.close();
  });

  it.each([
    "authorityAclExact",
    "authorityOwnershipExact",
    "publicAuthorityRevoked",
    "authorityTablesRevoked",
  ] as const)(
    "fails health when the authority %s invariant is false",
    async (acl) => {
      const app = await createReleaseControlApp({
        controlPrisma: {
          $queryRaw: vi.fn().mockResolvedValue([
            {
              ...authorityReadiness("reviewrouter_release_control")[0],
              [acl]: false,
            },
          ]),
        } as never,
        providerAuthorityPrisma: {
          $queryRaw: vi
            .fn()
            .mockResolvedValue(
              authorityReadiness("reviewrouter_provider_authority"),
            ),
        } as never,
        permitInstallerPrisma: {
          $queryRaw: vi.fn().mockResolvedValue(installerReadiness),
        } as never,
        targetReceiptReaderPrisma: {
          $queryRaw: vi.fn().mockResolvedValue(readerReadiness),
        } as never,
        credentials: {
          controlTokenSha256: digest("control"),
          providerAuthorityTokenSha256: digest("provider"),
        },
      });
      expect(
        (await app.inject({ method: "GET", url: "/health" })).statusCode,
      ).toBe(503);
      await app.close();
    },
  );

  it.each([
    "catalogExact",
    "selectiveRecoveryProtocol",
    "lateRunnerEffectProtocol",
    "recoveryEffectProtocol",
    "compensationCheckpointDefinition",
    "runnerProviderBoundary",
    "cleanupWitnessTemporalSemantics",
    "requiredTriggers",
  ] as const)(
    "fails health when the required %s proof is absent",
    async (proof) => {
      const app = await createReleaseControlHealthApp({ [proof]: false });
      expect(
        (await app.inject({ method: "GET", url: "/health" })).statusCode,
      ).toBe(503);
      await app.close();
    },
  );

  it("fails health when ordered migration identity evidence is incomplete", async () => {
    const manifest = authorityReadiness(
      "reviewrouter_release_control",
    )[0]!.migrationManifest.slice(0, -1);
    const app = await createReleaseControlHealthApp({
      migrationManifest: manifest,
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(503);
    await app.close();
  });

  it("accepts the exact previously published 000001/000002 byte variants after 000009", async () => {
    const migrationManifest = authorityReadiness(
      "reviewrouter_release_control",
    )[0]!.migrationManifest.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            checksumSha256:
              "sha256:e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b",
            byteVariant: "legacy_equivalent",
          }
        : index === 1
          ? {
              ...entry,
              checksumSha256:
                "sha256:cd50e36c2b357fe03a81204b99f38c5c1e6b9ff94660dfecb9a2fccb782a512e",
              byteVariant: "legacy_equivalent",
            }
          : entry,
    );
    const app = await createReleaseControlHealthApp({ migrationManifest });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("rejects a mixed 000001/000002 byte-variant manifest", async () => {
    const migrationManifest = authorityReadiness(
      "reviewrouter_release_control",
    )[0]!.migrationManifest.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            checksumSha256:
              "sha256:e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b",
            byteVariant: "legacy_equivalent" as const,
          }
        : entry,
    );
    const app = await createReleaseControlHealthApp({ migrationManifest });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(503);
    await app.close();
  });

  it("fails witness health when centralized temporal proof is absent", async () => {
    const app = await createReleaseWitnessApp({
      witnessPrisma: {
        $queryRaw: vi.fn().mockResolvedValue([
          {
            ...witnessReadiness[0],
            cleanupWitnessTemporalSemantics: false,
          },
        ]),
      } as never,
      triggerTokenSha256: digest("witness"),
      renderReadToken: "read-only",
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(503);
    await app.close();
  });

  it("keeps authority out of the main API and application Prisma chain", () => {
    const appSource = readFileSync("apps/api/src/app.ts", "utf8");
    const serverSource = readFileSync("apps/api/src/server.ts", "utf8");
    const schema = readFileSync(
      "packages/platform/db/prisma/schema.prisma",
      "utf8",
    );
    const mainMigration = readFileSync(
      "packages/platform/db/prisma/migrations/000069_release_rollout_ledger/migration.sql",
      "utf8",
    );
    expect(appSource).not.toContain("release-rollout-ledger");
    expect(serverSource).not.toContain("REVIEW_ROUTER_RELEASE_AUTHORITY_");
    expect(schema).not.toContain("ReleaseRolloutLedger");
    expect(mainMigration).not.toContain("CREATE TABLE");
    expect(mainMigration).toContain("never acquire authority state");
  });
});
