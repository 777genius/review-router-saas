import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { executePrivateGenerationActivation } from "./activate-private-pg17-generation.mjs";
import { sha256Canonical } from "../packages/features/release-rollout/src/index.ts";

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
  REVIEW_ROUTER_TARGET_PREACTIVATION_PRINCIPAL_POLICY_JSON: JSON.stringify({
    version: 1,
    publicPermissions: [],
    principals: [
      {
        principal: "reviewrouter_release_migration",
        mayLogin: true,
        inherit: true,
        connectionLimit: -1,
        validUntil: null,
        permissions: [],
      },
    ],
  }),
  REVIEW_ROUTER_TARGET_PRINCIPAL_POLICY_JSON: JSON.stringify({
    version: 1,
    publicPermissions: [],
    principals: [
      {
        principal: "reviewrouter_release_migration",
        mayLogin: true,
        inherit: true,
        connectionLimit: -1,
        validUntil: null,
        permissions: [],
      },
    ],
  }),
};
const inventory = {
  version: 1,
  database: "review_router",
  sessionPrincipal: "reviewrouter_release_migration",
  roles: [
    {
      name: "reviewrouter_release_migration",
      canLogin: true,
      inherit: true,
      superuser: false,
      bypassRls: false,
      replication: false,
      createDatabase: false,
      createRole: false,
      connectionLimit: -1,
      validUntil: null,
    },
  ],
  memberships: [],
  grants: [],
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
  beforePrincipalInventorySha256: `sha256:${sha256Canonical(inventory)}`,
  beforePrincipalPolicySha256: `sha256:${sha256Canonical(
    JSON.parse(env.REVIEW_ROUTER_TARGET_PREACTIVATION_PRINCIPAL_POLICY_JSON),
  )}`,
  activatedPrincipalInventorySha256: `sha256:${sha256Canonical(inventory)}`,
  activatedPrincipalPolicySha256: `sha256:${sha256Canonical(
    JSON.parse(env.REVIEW_ROUTER_TARGET_PRINCIPAL_POLICY_JSON),
  )}`,
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
        if (
          !options.input ||
          !options.input.includes("stage_principal_evidence")
        )
          return { stdout: `${JSON.stringify(inventory)}\n` };
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
            : { stdout: `${JSON.stringify(inventory)}\n` },
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

  it("rejects swapped durable principal digests", () => {
    const commands = {
      execute: (
        _command: string,
        _args: string[],
        options: { input?: string },
      ) => {
        if (options.input?.includes("read_activation_receipt"))
          return { stdout: "\n" };
        if (options.input?.includes("stage_principal_evidence"))
          return {
            stdout: `${JSON.stringify({
              ...receipt,
              beforePrincipalInventorySha256:
                receipt.beforePrincipalPolicySha256,
              beforePrincipalPolicySha256:
                receipt.beforePrincipalInventorySha256,
            })}\n`,
          };
        return { stdout: `${JSON.stringify(inventory)}\n` };
      },
    };
    expect(() =>
      executePrivateGenerationActivation(env, commands as never),
    ).toThrow("release_activation_receipt_unproven");
  });

  it("rejects a stale durable digest from a different reviewed inventory", () => {
    const commands = {
      execute: (
        _command: string,
        _args: string[],
        options: { input?: string },
      ) => {
        if (options.input?.includes("read_activation_receipt"))
          return { stdout: "\n" };
        if (options.input?.includes("stage_principal_evidence"))
          return {
            stdout: `${JSON.stringify({
              ...receipt,
              activatedPrincipalInventorySha256: `sha256:${"8".repeat(64)}`,
            })}\n`,
          };
        return { stdout: `${JSON.stringify(inventory)}\n` };
      },
    };
    expect(() =>
      executePrivateGenerationActivation(env, commands as never),
    ).toThrow("release_activation_receipt_unproven");
  });

  it("rejects an activated policy changed from the reviewed policy", () => {
    const changedPolicyEnvironment = {
      ...env,
      REVIEW_ROUTER_TARGET_PRINCIPAL_POLICY_JSON: JSON.stringify({
        version: 1,
        publicPermissions: [],
        principals: [
          {
            principal: "reviewrouter_release_migration",
            mayLogin: false,
            inherit: true,
            connectionLimit: -1,
            validUntil: null,
            permissions: [],
          },
        ],
      }),
    };
    const commands = {
      execute: (
        _command: string,
        _args: string[],
        options: { input?: string },
      ) =>
        options.input?.includes("read_activation_receipt")
          ? { stdout: "\n" }
          : { stdout: `${JSON.stringify(inventory)}\n` },
    };
    expect(() =>
      executePrivateGenerationActivation(
        changedPolicyEnvironment,
        commands as never,
      ),
    ).toThrow("effective_principal_policy_rejected");
  });

  it("rejects an activated inventory changed from the reviewed preview", () => {
    let inventoryRead = 0;
    const changed = {
      ...inventory,
      roles: [{ ...inventory.roles[0], canLogin: false }],
    };
    const commands = {
      execute: (
        _command: string,
        _args: string[],
        options: { input?: string },
      ) => {
        if (options.input?.includes("read_activation_receipt"))
          return { stdout: "\n" };
        inventoryRead += 1;
        return {
          stdout: `${JSON.stringify(inventoryRead === 1 ? inventory : changed)}\n`,
        };
      },
    };
    expect(() =>
      executePrivateGenerationActivation(env, commands as never),
    ).toThrow("effective_principal_policy_rejected");
  });
});
