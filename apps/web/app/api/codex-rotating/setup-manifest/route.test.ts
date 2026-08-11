import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexRotatingSetupManifest,
  codexRotatingSecretName,
  codexRotatingSetupManifestSchema,
  encodeCodexRotatingSetupManifest,
} from "@reviewrouter/features-provider-setup";

const mocks = vi.hoisted(() => ({
  resolveCodexRotatingSetupManifestForNonce: vi.fn(),
}));

vi.mock("../../../../src/server/prisma", () => ({
  getPrisma: () => ({ transaction: "route-test" }),
}));
vi.mock("../../../../src/server/codex-rotating-setup-manifest", () => ({
  resolveCodexRotatingSetupManifestForNonce:
    mocks.resolveCodexRotatingSetupManifestForNonce,
}));

import { GET } from "./route";

const manifest = buildCodexRotatingSetupManifest({
  repositoryFullName: "owner/repository",
  repositoryId: "123456",
  installerUrl: "https://reviewrouter.site/install/codex-rotating",
  installerVersion: "route-test",
  installerSha256: "a".repeat(64),
  setupNonce: "setup:route-test",
  now: new Date("2026-08-10T00:00:00.000Z"),
  generationHashSalt: "g".repeat(43),
  accountFingerprintSalt: "f".repeat(43),
});
const manifestBase64 = encodeCodexRotatingSetupManifest(manifest);

describe("Codex rotating setup manifest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS", "w".repeat(43));
    mocks.resolveCodexRotatingSetupManifestForNonce.mockResolvedValue({
      manifestBase64,
      expiresAt: manifest.expiresAt,
      recoveryExpiresAt: "2026-08-10T01:00:00.000Z",
      payloadClaimed: false,
      recoveryEpoch: "1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes the strict v2 manifest without a setup-time secret name", async () => {
    const response = await GET(
      new Request(
        "https://reviewrouter.site/api/codex-rotating/setup-manifest?nonce=setup%3Aroute-test",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      mocks.resolveCodexRotatingSetupManifestForNonce,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ setupNonce: "setup:route-test" }),
    );
    expect(
      mocks.resolveCodexRotatingSetupManifestForNonce,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseRecoveryWitness: "w".repeat(43),
      }),
    );
    const routedManifest = JSON.parse(
      Buffer.from(body.manifestBase64, "base64url").toString("utf8"),
    );
    expect(codexRotatingSetupManifestSchema.parse(routedManifest)).toEqual(
      manifest,
    );
    expect(routedManifest).not.toHaveProperty("secretName");
    expect(JSON.stringify(body)).not.toContain(codexRotatingSecretName);
  });
});
