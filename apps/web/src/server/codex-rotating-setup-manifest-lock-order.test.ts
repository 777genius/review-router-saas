import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexRotatingSetupManifest,
  fingerprintDatabaseRecoveryWitness,
} from "@reviewrouter/features-provider-setup";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  lockSetupProvider: vi.fn(async () => {
    mocks.events.push("setup-provider-lock");
  }),
  lockProviderRow: vi.fn(async () => {
    mocks.events.push("provider-row-lock");
  }),
  isFenceOwner: vi.fn(async () => true),
}));

vi.mock("./codex-rotating-provider-mutation-fence", () => ({
  lockCodexRotatingSetupProvider: mocks.lockSetupProvider,
  lockCodexRotatingProviderRow: mocks.lockProviderRow,
  isCodexRotatingSetupFenceOwner: mocks.isFenceOwner,
}));

vi.mock("@reviewrouter/platform-config", () => ({
  isCodexRotatingOAuthAllowedForRepository: () => true,
}));

import {
  CodexRotatingSetupManifestStatus,
  resolveCodexRotatingSetupManifestForNonce,
} from "./codex-rotating-setup-manifest";

const setupNonce = "stp:lock-order-proof";
const databaseRecoveryWitness = "w".repeat(43);
const now = new Date("2026-08-10T00:00:00.000Z");
const manifest = buildCodexRotatingSetupManifest({
  repositoryFullName: "owner/repository",
  repositoryId: "900001",
  providerInstanceId: "codex-rotating:900001",
  setupNonce,
  installerUrl: "https://reviewrouter.example/install",
  installerVersion: "lock-order-test",
  installerSha256: "a".repeat(64),
  generationHashSalt: "g".repeat(43),
  accountFingerprintSalt: "i".repeat(43),
  now,
});

describe("setup manifest fetch lock ordering", () => {
  beforeEach(() => {
    mocks.events.length = 0;
    vi.clearAllMocks();
  });

  it("takes provider locks before the manifest row FOR UPDATE lock", async () => {
    const row = {
      id: "manifest:lock-order",
      providerInstanceRowId: "provider:lock-order",
      providerInstanceId: manifest.providerInstanceId,
      repositoryId: "repository:lock-order",
      setupNonce,
      manifestJson: manifest,
      status: CodexRotatingSetupManifestStatus.Issued,
      expiresAt: new Date(manifest.expiresAt),
      consumedAt: null,
      confirmationJson: null,
      mutationEpoch: 1n,
      databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
        databaseRecoveryWitness,
      ),
      recoveryExpiresAt: null,
      payloadVersion: null,
      payloadGenerationHash: null,
      payloadAccountFingerprint: null,
      payloadByteSize: null,
      payloadClaimedAt: null,
    };
    const queryTexts: string[] = [];
    const tx = {
      $queryRaw: vi.fn((strings: readonly string[]) => {
        const sql = Array.from(strings).join("?");
        queryTexts.push(sql);
        mocks.events.push(
          sql.includes("FOR UPDATE") ? "manifest-row-lock" : "locator-read",
        );
        return Promise.resolve(
          sql.includes("FOR UPDATE")
            ? [row]
            : [
                {
                  providerInstanceRowId: row.providerInstanceRowId,
                  providerInstanceId: row.providerInstanceId,
                },
              ],
        );
      }),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(tx)),
    };

    await expect(
      resolveCodexRotatingSetupManifestForNonce({
        prisma: prisma as never,
        setupNonce,
        databaseRecoveryWitness,
        now,
      }),
    ).resolves.toMatchObject({
      payloadClaimed: false,
      recoveryEpoch: "1",
    });

    expect(mocks.events.slice(0, 4)).toEqual([
      "locator-read",
      "setup-provider-lock",
      "provider-row-lock",
      "manifest-row-lock",
    ]);
    expect(queryTexts[0]).not.toContain("FOR UPDATE");
    expect(queryTexts[1]).toContain("FOR UPDATE");
  });
});
