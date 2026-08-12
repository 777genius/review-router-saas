import { describe, expect, it } from "vitest";
import { executePrivateGenerationActivation } from "./activate-private-pg17-generation.mjs";

const env = {
  REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:
    "postgresql://reviewrouter_release_migration:release@db.internal/review_router",
  REVIEW_ROUTER_API_DATABASE_URL:
    "postgresql://reviewrouter_api:api@db.internal/review_router",
  REVIEW_ROUTER_WEB_DATABASE_URL:
    "postgresql://reviewrouter_web:web@db.internal/review_router",
  REVIEW_ROUTER_WORKER_DATABASE_URL:
    "postgresql://reviewrouter_worker:worker@db.internal/review_router",
  REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
    "postgresql://reviewrouter_codex_effect_authority:effect@db.internal/review_router",
  REVIEW_ROUTER_RELEASE_COMMIT_SHA: "a".repeat(40),
  REVIEW_ROUTER_RELEASE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  REVIEW_ROUTER_ROLLOUT_ID: "rollout-activation-1",
};

const receipt = {
  rolloutId: "rollout-activation-1",
  sourceSystemIdentifier: "100",
  targetSystemIdentifier: "200",
  postgresMajor: 17,
  expectedCommitSha: "a".repeat(40),
  migrationChecksum: `sha256:${"c".repeat(64)}`,
  targetDeployIds: ["dep-target"],
  permitEpoch: 1,
  permitNonce: "d".repeat(32),
  canonicalPrivilegesSha256: "",
  catalogFactsSha256: `sha256:${"e".repeat(64)}`,
  firstWriteReceiptSha256: `sha256:${"f".repeat(64)}`,
  transactionId: "42",
  activatedAt: "2026-08-12T10:00:00.000Z",
  firstWriteBoundary: true,
};

describe("private target activation runner", () => {
  it("sends only rollout identity and accepts the permit-bound receipt", () => {
    let input = "";
    const commands = {
      execute: (
        _command: string,
        _args: string[],
        options: { input: string },
      ) => {
        input = options.input;
        const digest = input.match(/'(sha256:[a-f0-9]{64})'\n\);/u)?.[1];
        return {
          stdout: `${JSON.stringify({ ...receipt, canonicalPrivilegesSha256: digest })}\n`,
        };
      },
    };
    const result = executePrivateGenerationActivation(env, commands as never);
    expect(result.facts.permitNonce).toBe(receipt.permitNonce);
    expect(input).toContain("reviewrouter_activation.activate_generation");
    expect(input).not.toContain(receipt.permitNonce);
    expect(input).not.toContain(receipt.targetDeployIds[0]);
  });

  it.each([
    "REVIEW_ROUTER_ACTIVATION_FENCE_JSON",
    "REVIEW_ROUTER_ACTIVATION_PERMIT_JSON",
    "REVIEW_ROUTER_ACTIVATION_PERMIT_INSTALLER_DATABASE_URL",
    "REVIEW_ROUTER_ACTIVATION_RECEIPT_GUARD_DATABASE_URL",
  ])("rejects cutover authority environment %s", (name) => {
    expect(() =>
      executePrivateGenerationActivation(
        { ...env, [name]: "forbidden" },
        {} as never,
      ),
    ).toThrow(`release_activation_authority_environment_forbidden:${name}`);
  });

  it("rejects a tampered receipt", () => {
    const commands = {
      execute: () => ({
        stdout: `${JSON.stringify({ ...receipt, postgresMajor: 16 })}\n`,
      }),
    };
    expect(() =>
      executePrivateGenerationActivation(env, commands as never),
    ).toThrow("release_activation_receipt_unproven");
  });
});
