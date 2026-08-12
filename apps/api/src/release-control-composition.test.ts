import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  composeReleaseControlDependencies,
  createReleaseControlApp,
} from "./release-control-composition";
import { createReleaseWitnessApp } from "./release-witness-composition";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const authorityReadiness = (
  roleName: "reviewrouter_release_control" | "reviewrouter_provider_authority",
) => [
  {
    roleName,
    systemIdentifier: "authority-system",
    postgresMajor: 17,
    controlRoutine: true,
    providerRoutine: true,
    installerRoutine: false,
  },
];
const installerReadiness = [
  {
    roleName: "reviewrouter_activation_permit_installer",
    systemIdentifier: "target-system",
    postgresMajor: 17,
    controlRoutine: false,
    providerRoutine: false,
    installerRoutine: true,
  },
];
const witnessReadiness = [
  {
    roleName: "reviewrouter_release_witness",
    postgresMajor: 17,
    witnessRoutine: true,
  },
];

describe("release authority process composition", () => {
  it("builds focused use cases from distinct control and provider connections", () => {
    const dependencies = composeReleaseControlDependencies(
      {} as never,
      {} as never,
      {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    );
    expect(dependencies.authority).not.toBe(dependencies.runnerOperations);
    expect(dependencies.runnerOperations).not.toBe(dependencies.reconciliation);
    expect(dependencies).not.toHaveProperty("cleanupWitness");
    expect(dependencies).not.toHaveProperty("witnessTokenSha256");
  });

  it("rejects malformed process credentials independently", async () => {
    expect(() =>
      composeReleaseControlDependencies({} as never, {} as never, {
        controlTokenSha256: "invalid",
        providerAuthorityTokenSha256: digest("provider"),
      }),
    ).toThrow("release_control_credential_hash_invalid");
    await expect(
      createReleaseWitnessApp({
        witnessPrisma: {} as never,
        witnessTokenSha256: "invalid",
      }),
    ).rejects.toThrow("release_witness_credential_hash_invalid");
  });

  it("installs an authorized permit through the server-owned installer connection", async () => {
    const authorization = {
      rolloutId: "rollout-1",
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
      { $queryRaw: installerQuery } as never,
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
      ]),
    );
  });

  it("retries the same committed authorization after an install timeout", async () => {
    const authorization = {
      rolloutId: "rollout-retry",
      expectedCommitSha: "c".repeat(40),
      postgresMajor: 17 as const,
      migrationChecksum: `sha256:${"7".repeat(64)}`,
      epoch: 4,
      nonce: "d".repeat(32),
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: "200",
      previousReceiptSha256: `sha256:${"b".repeat(64)}`,
      targetDeployIds: ["deploy-1"],
      authorizedAt: "2026-08-12T00:00:00.000Z",
    };
    const authorityQuery = vi
      .fn()
      .mockResolvedValue([{ value: authorization }]);
    const installerQuery = vi
      .fn()
      .mockRejectedValueOnce(new Error("target_database_timeout"))
      .mockResolvedValueOnce([{ result: false }]);
    const app = await createReleaseControlApp({
      controlPrisma: { $queryRaw: authorityQuery } as never,
      providerAuthorityPrisma: {} as never,
      permitInstallerPrisma: { $queryRaw: installerQuery } as never,
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
    expect(authorityQuery).toHaveBeenCalledTimes(2);
    expect(installerQuery).toHaveBeenCalledTimes(2);
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
      credentials: {
        controlTokenSha256: digest("control"),
        providerAuthorityTokenSha256: digest("provider"),
      },
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).json(),
    ).toEqual({
      status: "ok",
      service: "release-control",
    });
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
      composeReleaseControlDependencies({} as never, {} as never, {
        controlTokenSha256: digest("same"),
        providerAuthorityTokenSha256: digest("same"),
      }),
    ).toThrow("release_control_credential_hash_invalid");

    const app = await createReleaseControlApp({
      controlPrisma: {} as never,
      providerAuthorityPrisma: {} as never,
      permitInstallerPrisma: {} as never,
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
    const controlQuery = vi.fn();
    const providerQuery = vi.fn().mockResolvedValue([
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
    const app = await createReleaseControlApp({
      controlPrisma: { $queryRaw: controlQuery } as never,
      providerAuthorityPrisma: { $queryRaw: providerQuery } as never,
      permitInstallerPrisma: {} as never,
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
    expect(providerQuery).toHaveBeenCalledOnce();
    expect(controlQuery).not.toHaveBeenCalled();
    const query = providerQuery.mock.calls[0]?.[0] as {
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

  it("maps durable provider policy conflicts to a redacted 409", async () => {
    const providerQuery = vi
      .fn()
      .mockRejectedValue(new Error("provider authority replay conflict"));
    const app = await createReleaseControlApp({
      controlPrisma: {} as never,
      providerAuthorityPrisma: { $queryRaw: providerQuery } as never,
      permitInstallerPrisma: {} as never,
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
    expect(response.body).not.toContain("replay conflict");
    await app.close();
  });

  it("does not expose control routes from the witness process", async () => {
    const app = await createReleaseWitnessApp({
      witnessPrisma: {
        $queryRaw: vi.fn().mockResolvedValue(witnessReadiness),
      } as never,
      witnessTokenSha256: digest("witness"),
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).json(),
    ).toEqual({
      status: "ok",
      service: "release-witness",
    });
    expect(
      (await app.inject({ method: "POST", url: "/v1/rollouts/claim" }))
        .statusCode,
    ).toBe(404);
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

  it("keeps authority out of the main API and application Prisma chain", () => {
    const appSource = readFileSync("apps/api/src/app.ts", "utf8");
    const serverSource = readFileSync("apps/api/src/server.ts", "utf8");
    const schema = readFileSync(
      "packages/platform/db/prisma/schema.prisma",
      "utf8",
    );
    const mainMigration = readFileSync(
      "packages/platform/db/prisma/migrations/000067_release_rollout_ledger/migration.sql",
      "utf8",
    );
    expect(appSource).not.toContain("release-rollout-ledger");
    expect(serverSource).not.toContain("REVIEW_ROUTER_RELEASE_AUTHORITY_");
    expect(schema).not.toContain("ReleaseRolloutLedger");
    expect(mainMigration).not.toContain("CREATE TABLE");
    expect(mainMigration).toContain("never acquire authority state");
  });
});
