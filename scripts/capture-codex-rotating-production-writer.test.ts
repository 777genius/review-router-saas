import { describe, expect, it, vi } from "vitest";
import {
  assertProductionWriterCaptureConfiguration,
  captureProductionWriterObservation,
} from "./capture-codex-rotating-production-writer.mjs";

const validEnv = {
  REVIEW_ROUTER_PRODUCTION_WRITER_OBSERVATION: "1",
  REVIEW_ROUTER_PRODUCTION_WRITER_DATABASE_URL:
    "postgresql://release:secret@writer.internal:5432/review_router",
  REVIEW_ROUTER_RELEASE_COMMIT_SHA: "a".repeat(40),
  REVIEW_ROUTER_RELEASE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  REVIEW_ROUTER_DRAIN_OBSERVATION_INTERVAL_MS: "15000",
};

describe("production-writer rollout observation capture", () => {
  it.each([
    [{}, "acknowledgement is required"],
    [
      { REVIEW_ROUTER_PRODUCTION_WRITER_OBSERVATION: "1" },
      "database URL is required",
    ],
    [
      {
        ...validEnv,
        REVIEW_ROUTER_PRODUCTION_WRITER_DATABASE_URL:
          "postgresql://release:secret@localhost:5432/review_router",
      },
      "cannot use a loopback database",
    ],
    [
      { ...validEnv, REVIEW_ROUTER_RELEASE_COMMIT_SHA: "main" },
      "release commit must be an exact lowercase SHA",
    ],
    [
      { ...validEnv, REVIEW_ROUTER_RELEASE_IMAGE_DIGEST: "latest" },
      "release image must be an exact sha256 digest",
    ],
  ])("rejects unsafe capture configuration", (env, message) => {
    expect(() => assertProductionWriterCaptureConfiguration(env)).toThrow(
      message,
    );
  });

  it("captures DB identity, caller identity, catalog/history, and two stable drain queries", async () => {
    const base = {
      databaseIdentity: {
        currentDatabase: "review_router",
        serverAddress: "10.0.0.2:5432",
        systemIdentifier: "7612345678901234567",
      },
      databaseCaller: {
        databaseRole: "reviewrouter_release",
        sessionUser: "reviewrouter_release",
        applicationName: "reviewrouter-release-migration",
      },
      postgresVersion: "17.6",
      unsafeWork: {
        activeLeasesWithoutEpoch: 0,
        activeManifestsWithoutEpoch: 0,
        pendingIntents: 0,
      },
      fetchedRecoveryOwner: "setup:fetched",
      history: [],
      catalog: { triggers: [], checks: [], indexes: [] },
    };
    const firstDrain = {
      activeLeases: 0,
      fetchedSetups: 0,
      pendingIntents: 0,
      writerInFlight: 0,
      observedAt: "2026-08-09T00:00:00.000Z",
    };
    const secondDrain = {
      ...firstDrain,
      observedAt: "2026-08-09T00:00:15.000Z",
    };
    const query = vi
      .fn()
      .mockReturnValueOnce(base)
      .mockReturnValueOnce(firstDrain)
      .mockReturnValueOnce(secondDrain);
    const sleep = vi.fn(async () => undefined);

    await expect(
      captureProductionWriterObservation(validEnv, { query, sleep }),
    ).resolves.toMatchObject({
      source: "production-postgresql-writer",
      rehearsal: false,
      databaseIdentity: base.databaseIdentity,
      callerIdentity: {
        id: "release-migration",
        applicationName: "reviewrouter-release-migration",
      },
      drainObservations: [firstDrain, secondDrain],
      migrationSources: [
        {
          id: "000060_codex_oauth_setup_serialization",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          id: "000061_codex_oauth_provider_mutation_fence",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          id: "000062_codex_oauth_remote_outcome_unknown",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          id: "000063_codex_oauth_setup_payload_claim",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(15_000);
  });

  it("rejects an observation session not identified by the database", async () => {
    const query = vi.fn().mockReturnValue({
      databaseCaller: { applicationName: "psql" },
    });
    await expect(
      captureProductionWriterObservation(validEnv, {
        query,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("database caller is not the release-migration session");
    expect(query).toHaveBeenCalledOnce();
  });
});
