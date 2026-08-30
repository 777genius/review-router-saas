import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
  REVIEW_ROUTER_COMMENT_TOKEN_CUSTODY_DATABASE_URL:
    "postgresql://reviewrouter_comment_token_custody:custody@db.internal/review_router",
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
  canonicalPrivilegesSha256: `sha256:${"9".repeat(64)}`,
  catalogFactsSha256: `sha256:${"e".repeat(64)}`,
  preactivationCatalogPolicySha256: `sha256:${"1".repeat(64)}`,
  activatedCatalogPolicySha256: `sha256:${"2".repeat(64)}`,
  beforePrincipalInventorySha256: `sha256:${"4".repeat(64)}`,
  beforePrincipalPolicySha256: `sha256:${"5".repeat(64)}`,
  activatedPrincipalInventorySha256: `sha256:${"6".repeat(64)}`,
  activatedPrincipalPolicySha256: `sha256:${"7".repeat(64)}`,
  firstWriteReceiptSha256: `sha256:${"f".repeat(64)}`,
  transactionId: "42",
  activatedAt: "2026-08-12T10:00:00.000Z",
  firstWriteBoundary: true,
};

describe("private target activation runner", () => {
  it("sends transaction-verified evidence and accepts the permit-bound receipt", () => {
    let input = "";
    const commands = {
      execute: (
        _command: string,
        _args: string[],
        options: { input?: string },
      ) => {
        if (options.input?.includes("read_activation_receipt"))
          return { stdout: "\n" };
        if (!options.input?.includes("stage_principal_evidence"))
          return { stdout: "\n" };
        input = options.input;
        return {
          stdout: `${JSON.stringify(receipt)}\n`,
        };
      },
    };
    const result = executePrivateGenerationActivation(env, commands as never);
    expect(result.facts.permitNonce).toBe(receipt.permitNonce);
    expect(input).toContain("reviewrouter_activation.activate_generation");
    expect(input).toContain("reviewrouter_activation.stage_principal_evidence");
    expect(input).not.toContain(receipt.permitNonce);
    expect(input).not.toContain(receipt.targetDeployIds[0]);
    expect(input).not.toContain(receipt.canonicalPrivilegesSha256);
    expect(input).not.toContain("publicPermissions");
    expect(input).not.toContain("before_inventory");
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
      execute: (
        _command: string,
        _args: string[],
        options: { input?: string },
      ) =>
        options.input?.includes("read_activation_receipt")
          ? { stdout: "\n" }
          : options.input?.includes("stage_principal_evidence")
            ? {
                stdout: `${JSON.stringify({ ...receipt, postgresMajor: 16 })}\n`,
              }
            : { stdout: "\n" },
    };
    expect(() =>
      executePrivateGenerationActivation(env, commands as never),
    ).toThrow("release_activation_receipt_unproven");
  });

  it("recovers the exact durable receipt without re-observing principal state", () => {
    const execute = vi.fn(() => ({ stdout: `${JSON.stringify(receipt)}\n` }));
    const recovered = executePrivateGenerationActivation(env, {
      execute,
    } as never);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(recovered.facts).toMatchObject(receipt);
    expect(recovered.facts.observationSha256).toBe(
      `sha256:${createHash("sha256").update(JSON.stringify(receipt)).digest("hex")}`,
    );
  });

  it("rejects malformed server-derived digest fields", () => {
    const commands = {
      execute: (
        _command: string,
        _args: string[],
        options: { input?: string },
      ) =>
        options.input?.includes("read_activation_receipt")
          ? { stdout: "\n" }
          : {
              stdout: `${JSON.stringify({
                ...receipt,
                activatedPrincipalInventorySha256: "caller-forged",
              })}\n`,
            },
    };
    expect(() =>
      executePrivateGenerationActivation(env, commands as never),
    ).toThrow("release_activation_receipt_unproven");
  });

  it("never serializes legacy caller-attested policy or inventory evidence", () => {
    let activationSql = "";
    const commands = {
      execute: (
        _command: string,
        _args: string[],
        options: { input?: string },
      ) => {
        if (options.input?.includes("read_activation_receipt"))
          return { stdout: "\n" };
        activationSql = options.input ?? "";
        return { stdout: `${JSON.stringify(receipt)}\n` };
      },
    };
    executePrivateGenerationActivation(
      {
        ...env,
        REVIEW_ROUTER_TARGET_PRINCIPAL_POLICY_JSON:
          '{"version":1,"forgedClean":true}',
      },
      commands as never,
    );
    expect(activationSql).not.toContain("forgedClean");
    expect(activationSql).not.toContain("::jsonb");
    expect(activationSql).toContain(
      "stage_principal_evidence(\n  'rollout-activation-1'",
    );
  });
});
