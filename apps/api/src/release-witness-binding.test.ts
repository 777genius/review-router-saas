import { describe, expect, it, vi } from "vitest";
import { AttestReleaseWitnessBinding } from "./release-witness-application";
import {
  releaseAuthoritySchemaVersion,
  sha256Canonical,
} from "@reviewrouter/features-release-rollout";
import {
  GitHubReleaseExecutionObservationAdapter,
  PostgresReleaseBindingObservationAdapter,
} from "./release-witness-adapters";
import type {
  ReleaseWitnessDatabaseObservation,
  ReleaseWitnessGenerationObservation,
  ReleaseWitnessRequest,
  ReleaseWitnessAttestation,
  TrustedReleaseWitnessPolicy,
} from "./release-witness-domain";

const hex = (value: string) => value.repeat(64).slice(0, 64);
const digest = (value: string) => `sha256:${hex(value)}`;
const sourceIdentity = {
  serverIdentity: "100",
  databaseIdentity: "16384",
  databaseName: "source",
};
const authorityIdentity = {
  serverIdentity: "300",
  databaseIdentity: "16385",
  databaseName: "authority",
};
const targetIdentity = {
  serverIdentity: "200",
  databaseIdentity: "16386",
  databaseName: "target",
};
const request: ReleaseWitnessRequest = {
  rolloutId: "rollout-1",
  execution: {
    repository: "rr-control/releases",
    workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
    workflowRef: "refs/heads/main",
    commitSha: "a".repeat(40),
    runId: "123",
    runAttempt: 1,
  },
  source: {
    renderResourceId: "dpg-source",
    databaseName: "source",
    systemIdentifier: "100",
    majorVersion: 16,
    recoveryWitnessSha256: hex("b"),
  },
  target: {
    renderResourceId: "dpg-target",
    databaseName: "target",
    systemIdentifier: "200",
    majorVersion: 17,
    recoveryWitnessSha256: hex("c"),
  },
  deployments: [
    {
      serviceId: "srv-api",
      deployId: "dep-api",
      revision: digest("d"),
    },
  ],
};
const policy: TrustedReleaseWitnessPolicy = {
  repository: request.execution.repository,
  workflowPath: request.execution.workflowPath,
  sourceDatabaseIdentity: sourceIdentity,
  authorityDatabaseIdentity: authorityIdentity,
  targetDatabaseIdentity: targetIdentity,
  sourceGeneration: request.source,
  targetGeneration: request.target,
  authorityCatalogFingerprint: digest("1"),
  authorityCatalogVerifier: "release-authority-catalog-v1",
  authorityMigrationManifestIdentity: digest("2"),
  activationMigrationManifestIdentity: digest("3"),
  activationNamespaceFingerprint: digest("4"),
  installerRoutineBodySha256: hex("5"),
  readerRoutineBodySha256: hex("6"),
  maximumAgeMilliseconds: 300_000,
};
const observation = (
  kind: "authority" | "target",
): ReleaseWitnessDatabaseObservation => ({
  roleName:
    kind === "authority"
      ? "reviewrouter_release_witness"
      : "reviewrouter_activation_receipt_reader",
  databaseIdentity: kind === "authority" ? authorityIdentity : targetIdentity,
  systemIdentifier: kind === "authority" ? "300" : "200",
  postgresMajor: 17,
  schemaVersion: kind === "authority" ? releaseAuthoritySchemaVersion : 0,
  migrationManifestIdentity: policy.authorityMigrationManifestIdentity,
  catalogFingerprint: policy.authorityCatalogFingerprint,
  catalogVerifier: policy.authorityCatalogVerifier,
  activationMigrationManifestIdentity:
    policy.activationMigrationManifestIdentity,
  activationNamespaceFingerprint: policy.activationNamespaceFingerprint,
  installerRoutineBodySha256: policy.installerRoutineBodySha256,
  readerRoutineBodySha256: policy.readerRoutineBodySha256,
  exact: true,
});

const unsignedAttestation = (result: ReleaseWitnessAttestation) => ({
  schemaVersion: result.schemaVersion,
  rolloutId: result.rolloutId,
  deploymentRevision: result.deploymentRevision,
  artifactDigest: result.artifactDigest,
  execution: result.execution,
  sourceDatabaseIdentity: result.sourceDatabaseIdentity,
  authorityDatabaseIdentity: result.authorityDatabaseIdentity,
  targetDatabaseIdentity: result.targetDatabaseIdentity,
  releaseAuthority: result.releaseAuthority,
  activation: result.activation,
  source: result.source,
  target: result.target,
  deployments: result.deployments,
  observedAt: result.observedAt,
  expiresAt: result.expiresAt,
});

const create = (
  overrides: {
    authority?: ReleaseWitnessDatabaseObservation;
    target?: ReleaseWitnessDatabaseObservation;
    sourceGeneration?: ReleaseWitnessGenerationObservation;
    targetGeneration?: ReleaseWitnessGenerationObservation;
    observedExecution?: ReleaseWitnessRequest["execution"];
    observedDeployments?: ReleaseWitnessRequest["deployments"];
    observedGenerations?: readonly [
      ReleaseWitnessRequest["source"],
      ReleaseWitnessRequest["target"],
    ];
    now?: () => Date;
    events?: string[];
    forceNew?: () => Promise<void>;
  } = {},
) =>
  new AttestReleaseWitnessBinding(
    {
      observeSource: async () => {
        overrides.events?.push("database");
        return (
          overrides.sourceGeneration ?? {
            roleName: "reviewrouter_release_witness",
            databaseIdentity: sourceIdentity,
            systemIdentifier: "100",
            postgresMajor: 16,
            recoveryWitnessSha256: request.source.recoveryWitnessSha256,
          }
        );
      },
      observeAuthority: async () => {
        overrides.events?.push("database");
        return overrides.authority ?? observation("authority");
      },
      observeTarget: async () => {
        overrides.events?.push("database");
        return overrides.target ?? observation("target");
      },
      observeTargetGeneration: async () => {
        overrides.events?.push("database");
        return (
          overrides.targetGeneration ?? {
            roleName: "reviewrouter_activation_receipt_reader",
            databaseIdentity: targetIdentity,
            systemIdentifier: "200",
            postgresMajor: 17,
            recoveryWitnessSha256: request.target.recoveryWitnessSha256,
          }
        );
      },
    },
    {
      observe: async () => {
        overrides.events?.push("provider");
        return overrides.observedExecution ?? request.execution;
      },
    },
    {
      observe: async () => {
        overrides.events?.push("provider");
        return overrides.observedDeployments ?? request.deployments;
      },
    },
    {
      observe: async () => {
        overrides.events?.push("provider");
        return (
          overrides.observedGenerations ?? [request.source, request.target]
        );
      },
    },
    {
      sign: (bindingSha256) => {
        overrides.events?.push("sign");
        return {
          algorithm: "Ed25519",
          keyId: "test-key",
          value: Buffer.from(bindingSha256).toString("base64"),
        };
      },
    },
    policy,
    {
      deploymentRevision: request.execution.commitSha,
      artifactDigest: digest("9"),
    },
    overrides.now ?? (() => new Date("2026-08-14T00:00:00.000Z")),
    overrides.forceNew
      ? {
          assertOrdinary: async () => undefined,
          assertForceNew: overrides.forceNew,
        }
      : undefined,
  );

describe("release witness binding policy", () => {
  it("forces a post-provider full observation before database evidence and signing", async () => {
    const events: string[] = [];
    await create({
      events,
      forceNew: async () => {
        events.push("force-new");
      },
    }).execute(request);
    expect(events.slice(0, 3)).toEqual(["provider", "provider", "provider"]);
    expect(events[3]).toBe("force-new");
    expect(events.slice(4, 8)).toEqual([
      "database",
      "database",
      "database",
      "database",
    ]);
    expect(events.at(-1)).toBe("sign");

    const denied: string[] = [];
    await expect(
      create({
        events: denied,
        forceNew: async () => {
          denied.push("force-new");
          throw new Error("drift");
        },
      }).execute(request),
    ).rejects.toThrow("drift");
    expect(denied).not.toContain("database");
    expect(denied).not.toContain("sign");
  });
  it("attests one exact database, deployment, revision, rollout, run and generation", async () => {
    const result = await create().execute(request);
    const unsigned = unsignedAttestation(result);
    expect(result.bindingSha256).toBe(`sha256:${sha256Canonical(unsigned)}`);
    expect(result).toMatchObject({
      rolloutId: "rollout-1",
      deploymentRevision: request.execution.commitSha,
      artifactDigest: digest("9"),
      execution: request.execution,
      sourceDatabaseIdentity: sourceIdentity,
      authorityDatabaseIdentity: authorityIdentity,
      targetDatabaseIdentity: targetIdentity,
      source: request.source,
      target: request.target,
      deployments: request.deployments,
      bindingSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });

  it("includes runtime deployment revision and artifact digest in the signed hash", async () => {
    const result = await create().execute(request);
    const unsigned = unsignedAttestation(result);
    expect(result.bindingSha256).toBe(`sha256:${sha256Canonical(unsigned)}`);
    expect(
      `sha256:${sha256Canonical({
        ...unsigned,
        deploymentRevision: "f".repeat(40),
      })}`,
    ).not.toBe(result.bindingSha256);
    expect(
      `sha256:${sha256Canonical({
        ...unsigned,
        artifactDigest: digest("8"),
      })}`,
    ).not.toBe(result.bindingSha256);
  });

  it.each([
    [
      "source",
      {
        roleName: "reviewrouter_release_witness",
        databaseIdentity: sourceIdentity,
        systemIdentifier: "100",
        postgresMajor: 16,
        recoveryWitnessSha256: hex("f"),
      },
    ],
    [
      "target",
      {
        roleName: "reviewrouter_activation_receipt_reader",
        databaseIdentity: targetIdentity,
        systemIdentifier: "200",
        postgresMajor: 17,
        recoveryWitnessSha256: hex("f"),
      },
    ],
  ] as const)(
    "fails closed before signing when the %s session observes another recovery marker",
    async (kind, generation) => {
      const events: string[] = [];
      await expect(
        create({
          events,
          ...(kind === "source"
            ? { sourceGeneration: generation }
            : { targetGeneration: generation }),
        }).execute(request),
      ).rejects.toThrow("release_witness_database_binding_mismatch");
      expect(events).not.toContain("sign");
    },
  );

  it.each([
    [
      "another workflow run",
      () =>
        create({
          observedExecution: { ...request.execution, runId: "999" },
        }).execute(request),
    ],
    [
      "another deployment",
      () =>
        create({
          observedDeployments: [
            { ...request.deployments[0]!, deployId: "dep-replayed" },
          ],
        }).execute(request),
    ],
    [
      "another target database",
      () =>
        create({
          target: {
            ...observation("target"),
            databaseIdentity: { ...targetIdentity, databaseIdentity: "99999" },
          },
        }).execute(request),
    ],
    [
      "another target generation",
      () =>
        create({
          target: { ...observation("target"), systemIdentifier: "999" },
        }).execute(request),
    ],
    [
      "another provider database resource",
      () =>
        create({
          observedGenerations: [
            { ...request.source, renderResourceId: "dpg-replayed" },
            request.target,
          ],
        }).execute(request),
    ],
    [
      "another recovery witness generation",
      () =>
        create().execute({
          ...request,
          target: { ...request.target, recoveryWitnessSha256: hex("f") },
        }),
    ],
    [
      "role confusion",
      () =>
        create({
          target: {
            ...observation("target"),
            roleName: "reviewrouter_release_control",
          },
        }).execute(request),
    ],
  ])("rejects replay through %s", async (label, operation) => {
    expect(label).toBeTypeOf("string");
    await expect(operation()).rejects.toThrow();
  });

  it("fails closed for partial legacy requests", async () => {
    const partial = {
      rolloutId: request.rolloutId,
      execution: request.execution,
      source: request.source,
      deployments: request.deployments,
    };
    expect(partial).not.toHaveProperty("target");
    await expect(
      create().execute(partial as ReleaseWitnessRequest),
    ).rejects.toThrow("release_witness_binding_request_invalid");
  });

  it("rejects an observation that exceeds the freshness window", async () => {
    const times = [
      new Date("2026-08-14T00:00:00.000Z"),
      new Date("2026-08-14T00:05:00.001Z"),
    ];
    await expect(
      create({ now: () => times.shift()! }).execute(request),
    ).rejects.toThrow("release_witness_observation_stale");
  });
});

describe("release witness observation adapters", () => {
  it("pins the source snapshot and never mixes the three configured connections", async () => {
    const sourceTransaction = {
      $executeRawUnsafe: vi.fn(async () => undefined),
      $queryRaw: vi.fn(async () => [
        {
          roleName: "reviewrouter_release_witness",
          databaseIdentity: sourceIdentity,
          systemIdentifier: "100",
          postgresMajor: 16,
          databaseComment: JSON.stringify({
            recoveryWitnessSha256: request.source.recoveryWitnessSha256,
          }),
        },
      ]),
    };
    const authorityTransaction = { marker: "authority" };
    const targetTransaction = {
      $executeRawUnsafe: vi.fn(async () => undefined),
      $queryRaw: vi.fn(async () => [
        {
          roleName: "reviewrouter_activation_receipt_reader",
          databaseIdentity: targetIdentity,
          systemIdentifier: "200",
          postgresMajor: 17,
          databaseComment: JSON.stringify({
            recoveryWitnessSha256: request.target.recoveryWitnessSha256,
          }),
        },
      ]),
    };
    const client = (transaction: object) => ({
      $transaction: vi.fn(async (callback: (value: object) => unknown) =>
        callback(transaction),
      ),
    });
    const observer = vi.fn(async () => ({
      ...observation("authority"),
      authorityOwnerRoleName: "owner",
      migrationManifest: [],
    }));
    const sourceClient = client(sourceTransaction);
    const authorityClient = client(authorityTransaction);
    const targetClient = client(targetTransaction);
    const adapter = new PostgresReleaseBindingObservationAdapter(
      sourceClient as never,
      authorityClient as never,
      targetClient as never,
      observer as never,
    );

    const observedSource = await adapter.observeSource();
    await adapter.observeAuthority();
    await adapter.observeTarget();
    const observedTarget = await adapter.observeTargetGeneration();

    expect(sourceTransaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(targetTransaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(observedSource.recoveryWitnessSha256).toBe(
      request.source.recoveryWitnessSha256,
    );
    expect(observedTarget.recoveryWitnessSha256).toBe(
      request.target.recoveryWitnessSha256,
    );
    for (const transaction of [sourceTransaction, targetTransaction]) {
      const query = (
        transaction.$queryRaw.mock.calls as unknown[][]
      )[0]?.[0] as { strings?: readonly string[] } | undefined;
      expect(query).toBeDefined();
      expect(query?.strings?.join(" ")).toContain(
        "shobj_description(database.oid, 'pg_database')",
      );
      expect(query?.strings?.join(" ")).toContain('AS "databaseComment"');
    }
    expect(sourceTransaction.$executeRawUnsafe).toHaveBeenCalledWith(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    expect(
      (observer.mock.calls as unknown as [unknown][]).map(
        ([transaction]) => transaction,
      ),
    ).toEqual([authorityClient, targetClient]);
  });

  it.each([
    ["source", "missing", null],
    ["target", "missing", null],
    [
      "source",
      "malformed",
      '{"recoveryWitnessSha256":"plaintext-recovery-secret"',
    ],
    [
      "target",
      "malformed",
      '{"recoveryWitnessSha256":"plaintext-recovery-secret"',
    ],
  ] as const)(
    "rejects and redacts a %s-session %s recovery marker",
    async (kind, markerCase, databaseComment) => {
      expect(markerCase).toMatch(/^(?:missing|malformed)$/u);
      const transaction = {
        $executeRawUnsafe: vi.fn(async () => undefined),
        $queryRaw: vi.fn(async () => [
          {
            roleName:
              kind === "source"
                ? "reviewrouter_release_witness"
                : "reviewrouter_activation_receipt_reader",
            databaseIdentity:
              kind === "source" ? sourceIdentity : targetIdentity,
            systemIdentifier: kind === "source" ? "100" : "200",
            postgresMajor: kind === "source" ? 16 : 17,
            databaseComment,
          },
        ]),
      };
      const client = {
        $transaction: vi.fn(
          async (callback: (value: typeof transaction) => unknown) =>
            callback(transaction),
        ),
      };
      const unused = {
        $transaction: vi.fn(async () => {
          throw new Error("unused_database_session");
        }),
      };
      const adapter = new PostgresReleaseBindingObservationAdapter(
        (kind === "source" ? client : unused) as never,
        unused as never,
        (kind === "target" ? client : unused) as never,
      );

      const failure = await (
        kind === "source"
          ? adapter.observeSource()
          : adapter.observeTargetGeneration()
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        `release_witness_${kind}_generation_unavailable`,
      );
      expect((failure as Error).message).not.toContain(
        "plaintext-recovery-secret",
      );
    },
  );

  it("rejects a rollout replay even when the run coordinates otherwise match", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 123,
            repository: { full_name: request.execution.repository },
            path: request.execution.workflowPath,
            head_sha: request.execution.commitSha,
            head_branch: "main",
            run_attempt: 1,
            event: "workflow_dispatch",
            status: "in_progress",
            conclusion: null,
            display_title: "private-pg17:other-rollout",
            updated_at: new Date().toISOString(),
          }),
          { status: 200 },
        ),
    );
    await expect(
      new GitHubReleaseExecutionObservationAdapter(
        "read-token",
        fetchImpl,
      ).observe(request.execution, request.rolloutId),
    ).rejects.toThrow("release_witness_github_execution_mismatch");
  });
});
