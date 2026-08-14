import { describe, expect, it, vi } from "vitest";
import { AttestReleaseWitnessBinding } from "./release-witness-application";
import { sha256Canonical } from "@reviewrouter/features-release-rollout";
import {
  GitHubReleaseExecutionObservationAdapter,
  PostgresReleaseBindingObservationAdapter,
} from "./release-witness-adapters";
import type {
  ReleaseWitnessDatabaseObservation,
  ReleaseWitnessRequest,
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
  schemaVersion: kind === "authority" ? 11 : 0,
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

const create = (
  overrides: {
    authority?: ReleaseWitnessDatabaseObservation;
    target?: ReleaseWitnessDatabaseObservation;
    observedExecution?: ReleaseWitnessRequest["execution"];
    observedDeployments?: ReleaseWitnessRequest["deployments"];
    observedGenerations?: readonly [
      ReleaseWitnessRequest["source"],
      ReleaseWitnessRequest["target"],
    ];
    now?: () => Date;
  } = {},
) =>
  new AttestReleaseWitnessBinding(
    {
      observeSource: async () => ({
        roleName: "reviewrouter_release_witness",
        databaseIdentity: sourceIdentity,
        systemIdentifier: "100",
        postgresMajor: 16,
      }),
      observeAuthority: async () =>
        overrides.authority ?? observation("authority"),
      observeTarget: async () => overrides.target ?? observation("target"),
    },
    {
      observe: async () => overrides.observedExecution ?? request.execution,
    },
    {
      observe: async () => overrides.observedDeployments ?? request.deployments,
    },
    {
      observe: async () =>
        overrides.observedGenerations ?? [request.source, request.target],
    },
    {
      sign: (bindingSha256) => ({
        algorithm: "Ed25519",
        keyId: "test-key",
        value: Buffer.from(bindingSha256).toString("base64"),
      }),
    },
    policy,
    overrides.now ?? (() => new Date("2026-08-14T00:00:00.000Z")),
  );

describe("release witness binding policy", () => {
  it("attests one exact database, deployment, revision, rollout, run and generation", async () => {
    const result = await create().execute(request);
    const {
      bindingSha256: _bindingSha256,
      signature: _signature,
      ...unsigned
    } = result;
    expect(result.bindingSha256).toBe(`sha256:${sha256Canonical(unsigned)}`);
    expect(result).toMatchObject({
      rolloutId: "rollout-1",
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
  ])("rejects replay through %s", async (_label, operation) => {
    await expect(operation()).rejects.toThrow();
  });

  it("fails closed for partial legacy requests", async () => {
    const { target: _target, ...partial } = request;
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
        },
      ]),
    };
    const authorityTransaction = { marker: "authority" };
    const targetTransaction = { marker: "target" };
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

    await adapter.observeSource();
    await adapter.observeAuthority();
    await adapter.observeTarget();

    expect(sourceTransaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(sourceTransaction.$executeRawUnsafe).toHaveBeenCalledWith(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    expect(
      (observer.mock.calls as unknown as [unknown][]).map(
        ([transaction]) => transaction,
      ),
    ).toEqual([authorityClient, targetClient]);
  });

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
