import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { withDrainedTargetAuthorityPools } from "./quiesced-target-authority";

describe("canonical migration target authority drain", () => {
  it("waits for both pools, then leaves reconnection to subsequent verification", async () => {
    const events = ["permit_installed"];
    let finishDrain!: () => void;
    const pendingDrain = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    const permitInstallerPrisma = {
      $disconnect: vi.fn(async () => {
        await pendingDrain;
        events.push("permit_drained");
      }),
    };
    const targetReceiptReaderPrisma = {
      $disconnect: vi.fn(async () => {
        events.push("receipt_drained");
      }),
    };
    const migrate = vi.fn(() => {
      expect(events).toEqual([
        "permit_installed",
        "receipt_drained",
        "permit_drained",
      ]);
      events.push("migration");
      return "catalog_candidate_ready";
    });
    const result = withDrainedTargetAuthorityPools(
      { permitInstallerPrisma, targetReceiptReaderPrisma },
      migrate,
    );
    await Promise.resolve();
    expect(migrate).not.toHaveBeenCalled();
    finishDrain();
    await expect(result).resolves.toBe("catalog_candidate_ready");
    expect(events.at(-1)).toBe("migration");
  });

  it("does not migrate when either pool cannot drain", async () => {
    for (const failed of ["permit", "receipt"]) {
      const disconnect = (name: string) =>
        vi.fn(async () => {
          if (name === failed) throw new Error("pool_drain_failed");
        });
      const permitInstallerPrisma = { $disconnect: disconnect("permit") };
      const targetReceiptReaderPrisma = { $disconnect: disconnect("receipt") };
      const migrate = vi.fn();
      await expect(
        withDrainedTargetAuthorityPools(
          { permitInstallerPrisma, targetReceiptReaderPrisma },
          migrate,
        ),
      ).rejects.toThrow("pool_drain_failed");
      expect(permitInstallerPrisma.$disconnect).toHaveBeenCalledOnce();
      expect(targetReceiptReaderPrisma.$disconnect).toHaveBeenCalledOnce();
      expect(migrate).not.toHaveBeenCalled();
    }
  });

  it("preserves a migration guard rejection", async () => {
    const client = { $disconnect: async () => {} };
    await expect(
      withDrainedTargetAuthorityPools(
        { permitInstallerPrisma: client, targetReceiptReaderPrisma: client },
        () => {
          throw new Error("workflow_provisioning_writer_quiescence_required");
        },
      ),
    ).rejects.toThrow("workflow_provisioning_writer_quiescence_required");
  });

  it("wraps the actual canonical migration port after permit validation", () => {
    const source = readFileSync(
      "scripts/rehearse-private-pg17-rollout.mjs",
      "utf8",
    );
    const port = source.slice(
      source.indexOf("const runReleaseMigrationPort ="),
      source.indexOf("if (migration.captureOnlyStatus"),
    );
    expect(port).toContain("releaseMigrationPermitFromEnv(migrationEnv)");
    expect(port).toMatch(
      /await withDrainedTargetAuthorityPools\(\s*facts,\s*\(\) =>\s*executeCanonicalReleaseMigration\(migrationEnv, canonicalRun\)/,
    );
    expect(
      port.indexOf("releaseMigrationPermitFromEnv(migrationEnv)"),
    ).toBeLessThan(port.indexOf("await withDrainedTargetAuthorityPools("));
    expect(source).toContain("runReleaseMigration: runReleaseMigrationPort");
  });
});
