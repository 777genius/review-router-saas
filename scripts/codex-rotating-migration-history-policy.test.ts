import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCodexRotatingMigrationHistoryIsPristine,
  checkedInCodexRotatingMigrationChecksums,
  forwardUnpublishedCodexRotatingMigration,
  immutableCodexRotatingMigrationChecksums,
  unpublishedNonAtomicCodexOAuthSetupPayloadClaimChecksum,
  type CodexRotatingMigrationHistoryRow,
} from "./codex-rotating-migration-history-policy";

const successfulRow = (
  migration_name: keyof typeof immutableCodexRotatingMigrationChecksums,
): CodexRotatingMigrationHistoryRow => ({
  migration_name,
  checksum: immutableCodexRotatingMigrationChecksums[migration_name],
  finished_at: new Date("2026-08-10T00:00:00.000Z"),
  rolled_back_at: null,
  applied_steps_count: 1,
});

describe("Codex rotating immutable migration history policy", () => {
  it("pins the exact checked-in digest for the atomic 000063 migration", () => {
    const checkedInDigest = createHash("sha256")
      .update(
        readFileSync(
          resolve(
            "packages/platform/db/prisma/migrations",
            "000063_codex_oauth_setup_payload_claim",
            "migration.sql",
          ),
        ),
      )
      .digest("hex");
    expect(
      immutableCodexRotatingMigrationChecksums[
        "000063_codex_oauth_setup_payload_claim"
      ],
    ).toBe("33100d6f5f3f59cd9a4c22f041d19caba6a0e0be88de4a0ee4d543af50619481");
    expect(checkedInDigest).toBe(
      immutableCodexRotatingMigrationChecksums[
        "000063_codex_oauth_setup_payload_claim"
      ],
    );
  });

  it("pins the exact checked-in digest for the unpublished forward 000064 migration", () => {
    const checkedInDigest = createHash("sha256")
      .update(
        readFileSync(
          resolve(
            "packages/platform/db/prisma/migrations",
            forwardUnpublishedCodexRotatingMigration.name,
            "migration.sql",
          ),
        ),
      )
      .digest("hex");
    expect(
      checkedInCodexRotatingMigrationChecksums[
        forwardUnpublishedCodexRotatingMigration.name
      ],
    ).toBe("d349e7bc2a114571070cf451e07ac2c9b0124dfa7565eb4e2e2ccd1c3d788718");
    expect(checkedInDigest).toBe(
      forwardUnpublishedCodexRotatingMigration.checksum,
    );
  });

  it("derives the documented 000064 digest from the enforced migration policy", () => {
    const runbook = readFileSync(
      resolve("ai-docs/operations/08-codex-rotating-serialization-cutover.md"),
      "utf8",
    );
    const documented =
      /000064 forward-publication policy[\s\S]+?exact checked-in SHA-256 is\s+`([a-f0-9]{64})`/u.exec(
        runbook,
      )?.[1];
    expect(documented).toBe(forwardUnpublishedCodexRotatingMigration.checksum);
  });

  it("accepts an empty catalog before first rollout", () => {
    expect(() =>
      assertCodexRotatingMigrationHistoryIsPristine([]),
    ).not.toThrow();
  });

  it("accepts successful 000060, 000062, and atomic-release 000063 checksums", () => {
    expect(() =>
      assertCodexRotatingMigrationHistoryIsPristine([
        successfulRow("000060_codex_oauth_setup_serialization"),
        successfulRow("000062_codex_oauth_remote_outcome_unknown"),
        successfulRow("000063_codex_oauth_setup_payload_claim"),
      ]),
    ).not.toThrow();
  });

  it("rejects the unpublished non-atomic 000063 checksum with sandbox recovery guidance", () => {
    const row = successfulRow("000063_codex_oauth_setup_payload_claim");
    expect(() =>
      assertCodexRotatingMigrationHistoryIsPristine([
        {
          ...row,
          checksum: unpublishedNonAtomicCodexOAuthSetupPayloadClaimChecksum,
        },
      ]),
    ).toThrow(
      "codex_rotating_unpublished_non_atomic_000063_history_forbidden:" +
        "recreate_the_local_sandbox_database_from_a_clean_baseline;" +
        "do_not_resolve_mark_applied_or_bless_this_checksum",
    );
  });

  it("rejects any history for edited-before-rollout 000061", () => {
    expect(() =>
      assertCodexRotatingMigrationHistoryIsPristine([
        {
          migration_name: "000061_codex_oauth_provider_mutation_fence",
          checksum: "any-checksum",
          finished_at: new Date("2026-08-10T00:00:00.000Z"),
          rolled_back_at: null,
          applied_steps_count: 1,
        },
      ]),
    ).toThrow("codex_rotating_000061_preexisting_history_forbidden");
  });

  it("rejects any prepublication history for forward migration 000064", () => {
    expect(() =>
      assertCodexRotatingMigrationHistoryIsPristine([
        {
          migration_name: forwardUnpublishedCodexRotatingMigration.name,
          checksum: forwardUnpublishedCodexRotatingMigration.checksum,
          finished_at: new Date("2026-08-10T00:00:00.000Z"),
          rolled_back_at: null,
          applied_steps_count: 1,
        },
      ]),
    ).toThrow(
      "codex_rotating_000064_prepublication_history_forbidden:" +
        "use_the_forward_release_migration_once_from_the_immutable_release_caller",
    );
  });

  it.each(["rewritten", "unfinished", "rolled_back", "duplicate"] as const)(
    "rejects %s prepublication 000064 history rather than blessing it",
    (kind) => {
      const original: CodexRotatingMigrationHistoryRow = {
        migration_name: forwardUnpublishedCodexRotatingMigration.name,
        checksum: forwardUnpublishedCodexRotatingMigration.checksum,
        finished_at: new Date("2026-08-10T00:00:00.000Z"),
        rolled_back_at: null,
        applied_steps_count: 1,
      };
      const row = {
        ...original,
        ...(kind === "rewritten" ? { checksum: "rewritten" } : {}),
        ...(kind === "unfinished" ? { finished_at: null } : {}),
        ...(kind === "rolled_back"
          ? { rolled_back_at: new Date("2026-08-10T00:01:00.000Z") }
          : {}),
      };
      expect(() =>
        assertCodexRotatingMigrationHistoryIsPristine(
          kind === "duplicate" ? [row, row] : [row],
        ),
      ).toThrow("codex_rotating_000064_prepublication_history_forbidden");
    },
  );

  it.each(["rewritten", "unfinished", "rolled_back", "duplicate"])(
    "rejects %s immutable 000063 history",
    (kind) => {
      const original = successfulRow("000063_codex_oauth_setup_payload_claim");
      const rows =
        kind === "duplicate"
          ? [original, original]
          : [
              {
                ...original,
                ...(kind === "rewritten" ? { checksum: "rewritten" } : {}),
                ...(kind === "unfinished" ? { finished_at: null } : {}),
                ...(kind === "rolled_back"
                  ? { rolled_back_at: new Date("2026-08-10T00:01:00.000Z") }
                  : {}),
              },
            ];
      expect(() => assertCodexRotatingMigrationHistoryIsPristine(rows)).toThrow(
        "codex_rotating_immutable_migration_history_mismatch:000063_codex_oauth_setup_payload_claim",
      );
    },
  );
});
