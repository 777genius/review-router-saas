import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { codexRotatingSetupTerminalClaimStatuses } from "@reviewrouter/features-provider-setup";
import {
  completeSetupRecoveryAssociation,
  PrismaCodexRotatingSetupPayloadClaim,
  retireAttemptAndNamespace,
} from "./prisma-codex-rotating-setup-payload-claim";

const recoveryWitness = "w".repeat(43);
const manifest = {
  protocolVersion: 2 as const,
  repositoryFullName: "owner/repository",
  repositoryId: "123456",
  providerInstanceId: "codex-rotating:123456",
  setupNonce: "setup:writer-proof",
  authMode: "codex_subscription_oauth_rotating" as const,
  generatedAt: "2999-01-01T00:00:00.000Z",
  expiresAt: "2999-01-02T00:00:00.000Z",
  installer: {
    url: "https://example.test/install",
    version: "test",
    sha256: "b".repeat(64),
  },
  generationHashSalt: "s".repeat(43),
  accountFingerprintSalt: "f".repeat(43),
};
const claim = {
  id: "claim:writer-proof",
  providerInstanceRowId: "provider:writer-proof",
  githubRepositoryId: "123456",
  manifestId: "manifest:writer-proof",
  manifestDigest: createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex"),
  recoveryRequestId: null,
  recoveryEpoch: 1n,
  operationId: "operation:writer-proof",
  payloadVersion: 2,
  canonicalizationVersion: 1,
  generationHash: "g".repeat(43),
  accountIdentityHash: "i".repeat(43),
  accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
  authByteSize: 100,
  installerVersion: "test",
  installerDigest: "b".repeat(64),
  databaseIncarnation: "7612345678901234567",
  databaseRecoveryWitness: createHash("sha256")
    .update(recoveryWitness)
    .digest("hex"),
  status: "prepared",
  claimVersion: 1,
  prepareReplayExpiresAt: new Date("2999-01-01T00:00:00Z"),
  recoveryExpiresAt: new Date("2999-01-02T00:00:00Z"),
  confirmedAttemptId: null,
};
const expectedFence = {
  providerInstanceRowId: claim.providerInstanceRowId,
  ownerId: claim.manifestId,
  epoch: claim.recoveryEpoch,
} as const;
const terminalClaimReplayCases = codexRotatingSetupTerminalClaimStatuses.map(
  (status) => [status, "codex_rotating_setup_recovery_required"] as const,
);

function retirementRow(
  attempt: {
    attemptId: string;
    namespaceId: string;
    status: string;
  },
  overrides: Record<string, unknown> = {},
) {
  return {
    attemptId: attempt.attemptId,
    attemptClaimId: claim.id,
    attemptNamespaceId: attempt.namespaceId,
    attemptStatus: attempt.status,
    attemptRetiredAt: null,
    namespaceProviderInstanceRowId: claim.providerInstanceRowId,
    namespaceEpoch: 1n,
    namespaceSecretName:
      "REVIEWROUTER_CODEX_AUTH_JSON_R123456_P0000000000000000_E1_00000000000000000000000000000000",
    namespaceStatus: attempt.status,
    namespacePermanentlyRetired: false,
    namespaceRetiredAt: null,
    claimProviderInstanceRowId: claim.providerInstanceRowId,
    claimRecoveryEpoch: claim.recoveryEpoch,
    claimManifestId: claim.manifestId,
    providerMutationOwner: "setup",
    providerMutationOwnerId: claim.manifestId,
    providerMutationEpoch: claim.recoveryEpoch,
    ...overrides,
  };
}

describe("Prisma rotating setup writer proof", () => {
  it("rejects a zero-row recovery-request completion", async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(0) };
    await expect(
      completeSetupRecoveryAssociation(
        tx as never,
        {
          providerInstanceRowId: claim.providerInstanceRowId,
          recoveryRequestId: "recovery:exact",
          recoveryEpoch: 2n,
          manifestId: claim.manifestId,
        },
        new Date("2026-08-10T00:00:00.000Z"),
      ),
    ).rejects.toThrow("codex_rotating_setup_recovery_transition_conflict");
  });

  it("requires zero recovery associations for explicit non-recovery activation", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: "drift" }]) };
    await expect(
      completeSetupRecoveryAssociation(
        tx as never,
        {
          providerInstanceRowId: claim.providerInstanceRowId,
          recoveryRequestId: null,
          recoveryEpoch: 2n,
          manifestId: claim.manifestId,
        },
        new Date("2026-08-10T00:00:00.000Z"),
      ),
    ).rejects.toThrow("codex_rotating_setup_recovery_association_conflict");
  });

  it("accepts exact recovery and explicit zero-association completion", async () => {
    await expect(
      completeSetupRecoveryAssociation(
        { $executeRaw: vi.fn().mockResolvedValue(1) } as never,
        {
          providerInstanceRowId: claim.providerInstanceRowId,
          recoveryRequestId: "recovery:exact",
          recoveryEpoch: 2n,
          manifestId: claim.manifestId,
        },
        new Date("2026-08-10T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      completeSetupRecoveryAssociation(
        { $queryRaw: vi.fn().mockResolvedValue([]) } as never,
        {
          providerInstanceRowId: claim.providerInstanceRowId,
          recoveryRequestId: null,
          recoveryEpoch: 2n,
          manifestId: claim.manifestId,
        },
        new Date("2026-08-10T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
  });
  it.each([
    [{ writer: false, databaseIncarnation: claim.databaseIncarnation }],
    [{ writer: true, databaseIncarnation: "7999999999999999999" }],
  ])("fails status closed on replica or changed incarnation", async (proof) => {
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([proof]),
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const ledger = new PrismaCodexRotatingSetupPayloadClaim(
      prisma as never,
      recoveryWitness,
    );
    await expect(ledger.status(claim.id)).rejects.toThrow(
      "codex_rotating_retryable_uncommitted",
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("returns the stable database incarnation from a proven writer", async () => {
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([
          { writer: true, databaseIncarnation: claim.databaseIncarnation },
        ])
        .mockResolvedValueOnce([]),
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const ledger = new PrismaCodexRotatingSetupPayloadClaim(
      prisma as never,
      recoveryWitness,
    );
    await expect(ledger.status(claim.id)).resolves.toMatchObject({
      status: "prepared",
      databaseIncarnation: claim.databaseIncarnation,
      databaseRecoveryWitnessFingerprint: claim.databaseRecoveryWitness,
      attempt: null,
    });
  });

  it.each(codexRotatingSetupTerminalClaimStatuses)(
    "returns %s as durable terminal status",
    async (status) => {
      const terminalClaim = { ...claim, status };
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([terminalClaim])
          .mockResolvedValueOnce([
            { writer: true, databaseIncarnation: claim.databaseIncarnation },
          ])
          .mockResolvedValueOnce([]),
      };
      const prisma = { $transaction: vi.fn((callback) => callback(tx)) };
      const ledger = new PrismaCodexRotatingSetupPayloadClaim(
        prisma as never,
        recoveryWitness,
      );

      await expect(ledger.status(claim.id)).resolves.toMatchObject({
        status,
        attempt: null,
      });
    },
  );

  it.each(codexRotatingSetupTerminalClaimStatuses)(
    "keeps %s terminal across dispatch, confirmation, and activation",
    async (status) => {
      for (const operation of ["dispatch", "confirm", "activate"] as const) {
        const terminalClaim = { ...claim, status };
        const tx = {
          $executeRawUnsafe: vi.fn().mockResolvedValue(0),
          $queryRaw: vi
            .fn()
            .mockResolvedValueOnce([terminalClaim])
            .mockResolvedValueOnce([
              { writer: true, databaseIncarnation: claim.databaseIncarnation },
            ])
            .mockResolvedValueOnce([{ id: claim.providerInstanceRowId }])
            .mockResolvedValueOnce([terminalClaim]),
        };
        const prisma = { $transaction: vi.fn((callback) => callback(tx)) };
        const ledger = new PrismaCodexRotatingSetupPayloadClaim(
          prisma as never,
          recoveryWitness,
        );
        const result =
          operation === "dispatch"
            ? ledger.authorizeDispatch({
                claimId: claim.id,
                idempotencyKey: "dispatch:terminal-replay",
              })
            : operation === "confirm"
              ? ledger.recordDispatchOutcome({
                  claimId: claim.id,
                  attemptId: "attempt:terminal-replay",
                  outcome: "definite_success",
                  responseCode: 204,
                })
              : ledger.activate({
                  claimId: claim.id,
                  attemptId: "attempt:terminal-replay",
                  namespaceId: "namespace:terminal-replay",
                  namespaceEpoch: "1",
                  secretName:
                    "REVIEWROUTER_CODEX_AUTH_JSON_R123456_P0000000000000000_E1_00000000000000000000000000000000",
                  repositoryId: claim.githubRepositoryId,
                  workflowPath: ".github/workflows/reviewrouter-codex.yml",
                  workflowSourceCommitSha: "a".repeat(40),
                  workflowSourceBlobSha: "b".repeat(40),
                  workflowSourceSha256: "c".repeat(64),
                  workflowSemanticSha256: "d".repeat(64),
                  sourceTrust: "trusted_default_branch_revision",
                });

        await expect(result).rejects.toThrow(
          "codex_rotating_setup_namespace_retired",
        );
        expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
      }
    },
  );

  it.each([
    ["active", "codex_rotating_setup_confirmation_stale_epoch"],
    ...terminalClaimReplayCases,
  ] as const)("rejects a %s claim replay", async (status, expectedError) => {
    vi.stubEnv("REVIEW_ROUTER_ENABLE_CODEX_ROTATING_OAUTH", "1");
    const manifestRow = {
      id: claim.manifestId,
      workspaceId: "workspace:writer-proof",
      repositoryId: "repository:writer-proof",
      providerInstanceRowId: claim.providerInstanceRowId,
      providerInstanceId: manifest.providerInstanceId,
      setupNonce: manifest.setupNonce,
      manifestJson: manifest,
      databaseRecoveryWitness: claim.databaseRecoveryWitness,
      status: "fetched",
      mutationEpoch: claim.recoveryEpoch,
      recoveryExpiresAt: claim.recoveryExpiresAt,
    };
    const terminalClaim = { ...claim, status };
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([
          { writer: true, databaseIncarnation: claim.databaseIncarnation },
        ])
        .mockResolvedValueOnce([manifestRow])
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([{ id: claim.providerInstanceRowId }])
        .mockResolvedValueOnce([manifestRow])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([terminalClaim]),
      codexOAuthProviderInstance: {
        findUnique: vi.fn().mockResolvedValue({
          providerInstanceId: manifest.providerInstanceId,
          repository: { githubRepositoryId: 123456n },
          mutationEpoch: claim.recoveryEpoch,
          mutationOwner: "setup",
          mutationOwnerId: claim.manifestId,
        }),
      },
    };
    const prisma = { $transaction: vi.fn((callback) => callback(tx)) };
    const ledger = new PrismaCodexRotatingSetupPayloadClaim(
      prisma as never,
      recoveryWitness,
    );

    try {
      await expect(
        ledger.claim({
          payloadVersion: 2,
          canonicalizationVersion: 1,
          operationId: claim.operationId,
          repositoryId: claim.githubRepositoryId,
          providerInstanceId: manifest.providerInstanceId,
          setupNonce: manifest.setupNonce,
          manifestDigest: claim.manifestDigest,
          recoveryEpoch: claim.recoveryEpoch.toString(),
          generationHash: claim.generationHash,
          accountIdentityHash: claim.accountIdentityHash,
          accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
          authByteSize: claim.authByteSize,
          installerVersion: claim.installerVersion,
          installerDigest: claim.installerDigest,
        }),
      ).rejects.toThrow(expectedError);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(tx.$queryRaw).toHaveBeenCalledTimes(7);
  });

  it.each([
    ["setup-recovery:recovery:other", 8n],
    ["setup-recovery:recovery:exact-prisma-fence", 9n],
  ] as const)(
    "rejects retirement outside the exact recovery owner/epoch fence",
    async (mutationOwnerId, mutationEpoch) => {
      const tx = {
        $executeRawUnsafe: vi.fn().mockResolvedValue(0),
        $executeRaw: vi.fn().mockResolvedValue(0),
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ acquired: true }])
          .mockResolvedValueOnce([{ id: claim.providerInstanceRowId }]),
        codexOAuthProviderInstance: {
          findUnique: vi.fn().mockResolvedValue({
            id: claim.providerInstanceRowId,
            mutationOwner: "recovery",
            mutationOwnerId,
            mutationEpoch,
          }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            mutationOwner: "recovery",
            mutationOwnerId,
            mutationEpoch,
          }),
        },
      };
      const prisma = { $transaction: vi.fn((callback) => callback(tx)) };
      const ledger = new PrismaCodexRotatingSetupPayloadClaim(
        prisma as never,
        recoveryWitness,
      );

      await expect(
        ledger.retireProviderGeneration({
          providerInstanceId: manifest.providerInstanceId,
          recoveryRequestId: "recovery:exact-prisma-fence",
          recoveryEpoch: 8n,
        }),
      ).rejects.toThrow("codex_rotating_setup_recovery_required");
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it("keeps exact recovery retirement idempotently terminal", async () => {
    const mutationOwnerId = "setup-recovery:recovery:exact-prisma-retirement";
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([{ id: claim.providerInstanceRowId }])
        .mockResolvedValueOnce([{ count: 0n }])
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([{ id: claim.providerInstanceRowId }])
        .mockResolvedValueOnce([{ count: 0n }]),
      codexOAuthProviderInstance: {
        findUnique: vi.fn().mockResolvedValue({
          id: claim.providerInstanceRowId,
          mutationOwner: "recovery",
          mutationOwnerId,
          mutationEpoch: 8n,
        }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          mutationOwner: "recovery",
          mutationOwnerId,
          mutationEpoch: 8n,
        }),
      },
    };
    const prisma = { $transaction: vi.fn((callback) => callback(tx)) };
    const ledger = new PrismaCodexRotatingSetupPayloadClaim(
      prisma as never,
      recoveryWitness,
    );
    const recoveryFence = {
      providerInstanceId: manifest.providerInstanceId,
      recoveryRequestId: "recovery:exact-prisma-retirement",
      recoveryEpoch: 8n,
    } as const;

    await expect(
      ledger.retireProviderGeneration(recoveryFence),
    ).resolves.toBeUndefined();
    await expect(
      ledger.retireProviderGeneration(recoveryFence),
    ).resolves.toBeUndefined();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(6);
  });

  it("commits an expired authorization tombstone before failing replay closed", async () => {
    const now = new Date("2999-01-01T00:11:00.000Z");
    const attempt = {
      claimId: claim.id,
      attemptId: "attempt:writer-proof",
      namespaceId: "namespace:writer-proof",
      namespaceEpoch: 1n,
      secretName:
        "REVIEWROUTER_CODEX_AUTH_JSON_R123456_P0000000000000000_E1_00000000000000000000000000000000",
      status: "dispatch_authorized",
      dispatchExpiresAt: new Date("2999-01-01T00:10:00.000Z"),
    };
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([
          { writer: true, databaseIncarnation: claim.databaseIncarnation },
        ])
        .mockResolvedValueOnce([{ id: claim.providerInstanceRowId }])
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([
          {
            mutationOwner: "setup",
            mutationOwnerId: claim.manifestId,
            mutationEpoch: claim.recoveryEpoch,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: claim.manifestId,
            status: "fetched",
            mutationEpoch: claim.recoveryEpoch,
            recoveryExpiresAt: claim.recoveryExpiresAt,
            manifestJson: manifest,
          },
        ])
        .mockResolvedValueOnce([attempt])
        .mockResolvedValueOnce([retirementRow(attempt)]),
    };
    let transactionCommitted = false;
    const prisma = {
      $transaction: vi.fn(async (callback) => {
        const result = await callback(tx);
        transactionCommitted = true;
        return result;
      }),
    };
    const ledger = new PrismaCodexRotatingSetupPayloadClaim(
      prisma as never,
      recoveryWitness,
      { now: () => now },
    );

    await expect(
      ledger.authorizeDispatch({
        claimId: claim.id,
        idempotencyKey: "dispatch:writer-proof",
      }),
    ).rejects.toThrow("codex_rotating_setup_dispatch_expired");
    expect(transactionCommitted).toBe(true);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(8);
    const sql = tx.$queryRaw.mock.calls.map(([strings]) =>
      Array.from(strings as readonly string[]).join("?"),
    );
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /CodexOAuthSetupPayloadClaim[\s\S]*LIMIT 1 FOR UPDATE/u,
        ),
        expect.stringMatching(
          /CodexOAuthSetupDispatchAttempt[\s\S]*FOR UPDATE OF a, n/u,
        ),
      ]),
    );
  });

  it("re-locks and commits an expired outcome tombstone before rejecting confirmation", async () => {
    const now = new Date("2999-01-01T00:11:00.000Z");
    const attempt = {
      claimId: claim.id,
      attemptId: "attempt:writer-proof",
      namespaceId: "namespace:writer-proof",
      namespaceEpoch: 1n,
      secretName:
        "REVIEWROUTER_CODEX_AUTH_JSON_R123456_P0000000000000000_E1_00000000000000000000000000000000",
      status: "dispatch_authorized",
      dispatchExpiresAt: new Date("2999-01-01T00:10:00.000Z"),
    };
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([
          { writer: true, databaseIncarnation: claim.databaseIncarnation },
        ])
        .mockResolvedValueOnce([{ id: claim.providerInstanceRowId }])
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([
          {
            mutationOwner: "setup",
            mutationOwnerId: claim.manifestId,
            mutationEpoch: claim.recoveryEpoch,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: claim.manifestId,
            status: "fetched",
            mutationEpoch: claim.recoveryEpoch,
            recoveryExpiresAt: claim.recoveryExpiresAt,
            manifestJson: manifest,
          },
        ])
        .mockResolvedValueOnce([attempt])
        .mockResolvedValueOnce([retirementRow(attempt)]),
    };
    let transactionCommitted = false;
    const prisma = {
      $transaction: vi.fn(async (callback) => {
        const result = await callback(tx);
        transactionCommitted = true;
        return result;
      }),
    };
    const ledger = new PrismaCodexRotatingSetupPayloadClaim(
      prisma as never,
      recoveryWitness,
      { now: () => now },
    );

    await expect(
      ledger.recordDispatchOutcome({
        claimId: claim.id,
        attemptId: attempt.attemptId,
        outcome: "definite_success",
        responseCode: 204,
      }),
    ).rejects.toThrow("codex_rotating_setup_dispatch_expired");
    expect(transactionCommitted).toBe(true);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const sql = tx.$queryRaw.mock.calls.map(([strings]) =>
      Array.from(strings as readonly string[]).join("?"),
    );
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /CodexOAuthSetupPayloadClaim[\s\S]*LIMIT 1 FOR UPDATE/u,
        ),
        expect.stringMatching(
          /CodexOAuthSetupDispatchAttempt[\s\S]*FOR UPDATE OF a, n/u,
        ),
      ]),
    );
  });

  it("uses the isolated signer before confirming a definite setup effect", async () => {
    const now = new Date("2026-08-10T00:00:00.000Z");
    const attempt = {
      claimId: claim.id,
      attemptId: "attempt:definite-success",
      namespaceId: "namespace:definite-success",
      namespaceEpoch: 1n,
      secretName:
        "REVIEWROUTER_CODEX_AUTH_JSON_R123456_P0000000000000000_E1_11111111111111111111111111111111",
      status: "dispatch_authorized",
      dispatchExpiresAt: new Date("2026-08-10T00:10:00.000Z"),
    };
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([
          { writer: true, databaseIncarnation: claim.databaseIncarnation },
        ])
        .mockResolvedValueOnce([{ id: claim.providerInstanceRowId }])
        .mockResolvedValueOnce([claim])
        .mockResolvedValueOnce([
          {
            mutationOwner: "setup",
            mutationOwnerId: claim.manifestId,
            mutationEpoch: claim.recoveryEpoch,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: claim.manifestId,
            status: "fetched",
            mutationEpoch: claim.recoveryEpoch,
            recoveryExpiresAt: claim.recoveryExpiresAt,
            manifestJson: manifest,
          },
        ])
        .mockResolvedValueOnce([attempt])
        .mockResolvedValueOnce([
          { challenge: '["reviewrouter_web",1,2,"setup",204]' },
        ]),
    };
    const authority = {
      $queryRaw: vi.fn().mockResolvedValue([{ signature: "a".repeat(64) }]),
    };
    const prisma = { $transaction: vi.fn((callback) => callback(tx)) };
    const ledger = new PrismaCodexRotatingSetupPayloadClaim(
      prisma as never,
      recoveryWitness,
      { now: () => now },
      process.env,
      authority as never,
    );

    await expect(
      ledger.recordDispatchOutcome({
        claimId: claim.id,
        attemptId: attempt.attemptId,
        outcome: "definite_success",
        responseCode: 204,
      }),
    ).resolves.toEqual({ status: "confirmed_candidate" });
    expect(authority.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(5);
    expect(
      Array.from(tx.$executeRaw.mock.calls[0]?.[0] as readonly string[]).join(
        "?",
      ),
    ).toContain("codex_oauth_authorize_setup_confirmation");
  });

  it("requires both retirement writes to affect exactly one bound row", async () => {
    const attempt = {
      attemptId: "attempt:strict-retirement",
      namespaceId: "namespace:strict-retirement",
      status: "dispatch_authorized",
    };
    for (const counts of [
      [0, 1],
      [1, 0],
    ]) {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([retirementRow(attempt)]),
        $executeRaw: vi
          .fn()
          .mockResolvedValueOnce(counts[0])
          .mockResolvedValueOnce(counts[1]),
      };
      await expect(
        retireAttemptAndNamespace(
          tx as never,
          attempt.attemptId,
          attempt.namespaceId,
          new Date("2999-01-01T00:05:00Z"),
          expectedFence,
        ),
      ).rejects.toThrow("codex_rotating_setup_retirement_conflict");
    }
  });

  it("accepts a repeated retirement only after exact terminal-state proof", async () => {
    const attempt = {
      attemptId: "attempt:retired",
      namespaceId: "namespace:retired",
      status: "retired_ambiguous",
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        retirementRow(attempt, {
          attemptRetiredAt: new Date("2999-01-01T00:05:00Z"),
          namespaceStatus: "retired_ambiguous",
          namespacePermanentlyRetired: true,
          namespaceRetiredAt: new Date("2999-01-01T00:05:00Z"),
        }),
      ]),
      $executeRaw: vi.fn(),
    };
    await expect(
      Promise.all([
        retireAttemptAndNamespace(
          tx as never,
          attempt.attemptId,
          attempt.namespaceId,
          new Date("2999-01-01T00:06:00Z"),
          expectedFence,
        ),
        retireAttemptAndNamespace(
          tx as never,
          attempt.attemptId,
          attempt.namespaceId,
          new Date("2999-01-01T00:06:00Z"),
          expectedFence,
        ),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("serializes concurrent retirement on the attempt, namespace, claim, and provider", async () => {
    const attempt = {
      attemptId: "attempt:concurrent",
      namespaceId: "namespace:concurrent",
      status: "dispatch_authorized",
    };
    const terminal = retirementRow(
      { ...attempt, status: "retired_ambiguous" },
      {
        attemptRetiredAt: new Date("2999-01-01T00:05:00Z"),
        namespaceStatus: "retired_ambiguous",
        namespacePermanentlyRetired: true,
        namespaceRetiredAt: new Date("2999-01-01T00:05:00Z"),
      },
    );
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([retirementRow(attempt)])
        .mockResolvedValueOnce([terminal]),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    await expect(
      Promise.all([
        retireAttemptAndNamespace(
          tx as never,
          attempt.attemptId,
          attempt.namespaceId,
          new Date("2999-01-01T00:05:00Z"),
          expectedFence,
        ),
        retireAttemptAndNamespace(
          tx as never,
          attempt.attemptId,
          attempt.namespaceId,
          new Date("2999-01-01T00:05:00Z"),
          expectedFence,
        ),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const lockSql = Array.from(
      tx.$queryRaw.mock.calls[0]![0] as readonly string[],
    ).join("?");
    expect(lockSql).toMatch(
      /FOR UPDATE OF attempt, namespace, claim, provider/u,
    );
  });

  it("rejects mixed terminal state and stale provider epochs", async () => {
    const attempt = {
      attemptId: "attempt:mixed",
      namespaceId: "namespace:mixed",
      status: "retired_ambiguous",
    };
    for (const overrides of [
      {
        attemptRetiredAt: new Date("2999-01-01T00:05:00Z"),
        namespaceStatus: "dispatch_authorized",
      },
      { providerMutationEpoch: 0n },
    ]) {
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValue([retirementRow(attempt, overrides)]),
        $executeRaw: vi.fn(),
      };
      await expect(
        retireAttemptAndNamespace(
          tx as never,
          attempt.attemptId,
          attempt.namespaceId,
          new Date("2999-01-01T00:06:00Z"),
          expectedFence,
        ),
      ).rejects.toThrow("codex_rotating_setup_retirement_conflict");
    }
  });

  it("activates a confirmed namespace after dispatch expiry within the recovery window", async () => {
    const now = new Date("2999-01-01T00:11:00.000Z");
    const confirmedClaim = {
      ...claim,
      status: "confirmed_candidate",
      confirmedAttemptId: "attempt:writer-proof",
    };
    const attempt = {
      claimId: claim.id,
      attemptId: "attempt:writer-proof",
      namespaceId: "namespace:writer-proof",
      namespaceEpoch: 1n,
      secretName:
        "REVIEWROUTER_CODEX_AUTH_JSON_R123456_P0000000000000000_E1_00000000000000000000000000000000",
      status: "confirmed",
      dispatchExpiresAt: new Date("2999-01-01T00:10:00.000Z"),
    };
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $executeRaw: vi
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([confirmedClaim])
        .mockResolvedValueOnce([
          { writer: true, databaseIncarnation: claim.databaseIncarnation },
        ])
        .mockResolvedValueOnce([{ id: claim.providerInstanceRowId }])
        .mockResolvedValueOnce([confirmedClaim])
        .mockResolvedValueOnce([attempt])
        .mockResolvedValueOnce([
          {
            mutationOwner: "setup",
            mutationOwnerId: claim.manifestId,
            mutationEpoch: claim.recoveryEpoch,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: claim.manifestId,
            status: "fetched",
            mutationEpoch: claim.recoveryEpoch,
            recoveryExpiresAt: claim.recoveryExpiresAt,
            manifestJson: manifest,
          },
        ])
        .mockResolvedValueOnce([]),
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const ledger = new PrismaCodexRotatingSetupPayloadClaim(
      prisma as never,
      recoveryWitness,
      { now: () => now },
    );

    await expect(
      ledger.activate({
        claimId: claim.id,
        attemptId: attempt.attemptId,
        namespaceId: attempt.namespaceId,
        namespaceEpoch: attempt.namespaceEpoch.toString(),
        secretName: attempt.secretName,
        repositoryId: claim.githubRepositoryId,
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSourceCommitSha: "a".repeat(40),
        workflowSourceBlobSha: "b".repeat(40),
        workflowSourceSha256: "c".repeat(64),
        workflowSemanticSha256: "d".repeat(64),
        sourceTrust: "trusted_default_branch_revision",
      }),
    ).resolves.toEqual({ status: "active" });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(6);
  });
});
