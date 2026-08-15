import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCodexRotatingMigrationHistoryIsPristine,
  checkedInCodexRotatingMigrationChecksums,
  forwardUnpublishedCodexRotatingMigration,
  immutableCodexRotatingMigrationChecksums,
  obsoleteReleaseRolloutLedgerMigrationAlias,
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

const preflightSource = readFileSync(
  resolve("scripts/preflight-codex-rotating-migration-history.ts"),
  "utf8",
);
const migration66Source = readFileSync(
  resolve(
    "packages/platform/db/prisma/migrations",
    "000066_codex_oauth_rotating_cascade_authority",
    "migration.sql",
  ),
  "utf8",
);

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

  it("pins the exact checked-in digest for the unpublished 000069 no-op marker", () => {
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
    ).toBe("82356ad61a366e22a15f4e53dabf8c97e14bad97c5970ef28710fe9367c06a05");
    expect(checkedInDigest).toBe(
      forwardUnpublishedCodexRotatingMigration.checksum,
    );
  });

  it("keeps 000069 free of application database and authority DDL", () => {
    const source = readFileSync(
      resolve(
        "packages/platform/db/prisma/migrations",
        forwardUnpublishedCodexRotatingMigration.name,
        "migration.sql",
      ),
      "utf8",
    );
    expect(source).toContain("immutable history marker");
    expect(source).toContain("packages/platform/release-authority-db");
    expect(source).not.toMatch(
      /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)\b/iu,
    );
    expect(source).not.toContain("release_rollout_ledger");
    expect(source).not.toMatch(/reviewrouter_release_(?:control|witness)/u);
  });

  it("loads the exact 000069 source digest and queries it plus the obsolete alias", () => {
    const expectedMigrationNames = Object.keys(
      checkedInCodexRotatingMigrationChecksums,
    );
    const sourceMigrationNames =
      /const migrationNames = \[([\s\S]+?)\] as const;/u
        .exec(preflightSource)?.[1]
        ?.match(/"[^"]+"/gu)
        ?.map((name) => JSON.parse(name));
    const queriedMigrationNames = /WHERE "migration_name" IN \(([\s\S]+?)\)/u
      .exec(preflightSource)?.[1]
      ?.match(/'[^']+'/gu)
      ?.map((name) => name.slice(1, -1));

    expect(sourceMigrationNames).toEqual(expectedMigrationNames);
    expect(queriedMigrationNames).toEqual([
      ...expectedMigrationNames.slice(0, -1),
      obsoleteReleaseRolloutLedgerMigrationAlias,
      forwardUnpublishedCodexRotatingMigration.name,
    ]);
    expect(sourceMigrationNames).toContain(
      forwardUnpublishedCodexRotatingMigration.name,
    );
    expect(queriedMigrationNames).toContain(
      forwardUnpublishedCodexRotatingMigration.name,
    );
    expect(queriedMigrationNames).toContain(
      obsoleteReleaseRolloutLedgerMigrationAlias,
    );
  });

  it("does not mint a provider-transition receipt for a repository-only repair", () => {
    const repairFunction =
      /CREATE FUNCTION "codex_oauth_repair_quarantined_provider"\([\s\S]+?END \$\$;/u.exec(
        migration66Source,
      )?.[0];

    expect(repairFunction).toBeDefined();
    expect(repairFunction).toMatch(
      /IF old_workspace_id IS DISTINCT FROM new_workspace_id[\s\S]+?INSERT INTO public\."CodexOAuthDatabaseAuthorityReceipt"[\s\S]+?UPDATE public\."CodexOAuthProviderInstance"/u,
    );
    expect(repairFunction).toContain(
      "A repository-only quarantine can leave the provider identity canonical.",
    );
  });

  it("derives every documented immutable/forward digest from policy and actual migration bytes", () => {
    const runbook = readFileSync(
      resolve("ai-docs/operations/08-codex-rotating-serialization-cutover.md"),
      "utf8",
    );
    const section =
      /## Immutable migration byte contract\n([\s\S]+?)\n## /u.exec(
        runbook,
      )?.[1];
    expect(section).toBeDefined();
    const documented = Object.fromEntries(
      [
        ...(section ?? "").matchAll(
          /\|\s+`([^`]+)`\s+\|\s+`([a-f0-9]{64})`\s+\|/gu,
        ),
      ].map((match) => [match[1], match[2]]),
    );
    expect(documented).toEqual(checkedInCodexRotatingMigrationChecksums);
    for (const [migrationName, policyDigest] of Object.entries(
      checkedInCodexRotatingMigrationChecksums,
    )) {
      const actualDigest = createHash("sha256")
        .update(
          readFileSync(
            resolve(
              "packages/platform/db/prisma/migrations",
              migrationName,
              "migration.sql",
            ),
          ),
        )
        .digest("hex");
      expect(documented[migrationName], migrationName).toBe(policyDigest);
      expect(actualDigest, migrationName).toBe(policyDigest);
    }

    const forwardDigest =
      /000069 no-op marker policy[\s\S]+?exact checked-in SHA-256 is\s+`([a-f0-9]{64})`/u.exec(
        runbook,
      )?.[1];
    expect(forwardDigest).toBe(
      forwardUnpublishedCodexRotatingMigration.checksum,
    );
  });

  it("accepts an empty catalog before first rollout", () => {
    expect(() =>
      assertCodexRotatingMigrationHistoryIsPristine([]),
    ).not.toThrow();
  });

  it("accepts successful immutable migrations including 000073", () => {
    expect(() =>
      assertCodexRotatingMigrationHistoryIsPristine([
        successfulRow("000060_codex_oauth_setup_serialization"),
        successfulRow("000062_codex_oauth_remote_outcome_unknown"),
        successfulRow("000063_codex_oauth_setup_payload_claim"),
        successfulRow("000064_codex_oauth_versioned_secret_namespaces"),
        successfulRow("000065_codex_oauth_authority_acl_hardening"),
        successfulRow("000066_codex_oauth_rotating_cascade_authority"),
        successfulRow("000073_codex_oauth_active_namespace_refresh"),
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

  it("rejects the obsolete 000067 rollout-ledger alias regardless of row state", () => {
    expect(() =>
      assertCodexRotatingMigrationHistoryIsPristine([
        {
          migration_name: obsoleteReleaseRolloutLedgerMigrationAlias,
          checksum: "obsolete-alias-checksum",
          finished_at: null,
          rolled_back_at: null,
          applied_steps_count: 0,
        },
      ]),
    ).toThrow(
      "codex_rotating_obsolete_000067_release_rollout_ledger_alias_forbidden:" +
        "recreate_the_database_from_history_using_000069_release_rollout_ledger",
    );
  });

  it("rejects any prepublication history for forward migration 000069", () => {
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
      "codex_rotating_000069_prepublication_history_forbidden:" +
        "use_the_forward_release_migration_once_from_the_immutable_release_caller",
    );
  });

  it.each(["rewritten", "unfinished", "rolled_back", "duplicate"] as const)(
    "rejects %s prepublication 000069 history rather than blessing it",
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
      ).toThrow("codex_rotating_000069_prepublication_history_forbidden");
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
