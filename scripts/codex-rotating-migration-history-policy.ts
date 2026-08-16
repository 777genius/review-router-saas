export type CodexRotatingMigrationHistoryRow = Readonly<{
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
  applied_steps_count: number;
}>;

export const immutableCodexRotatingMigrationChecksums = Object.freeze({
  "000060_codex_oauth_setup_serialization":
    "f24ab69f681349332e47e121adc72bd3edb14e24bcbffcd26fce4f03ba0d7395",
  "000061_codex_oauth_provider_mutation_fence":
    "bba689c8b80580ec649cc3262fb2ee9c97be758f3c4ab7094c48c84d002aeb30",
  "000062_codex_oauth_remote_outcome_unknown":
    "0e8bb62933a270d745530f2c4984520e1753f42d8531c24ffdfa4acfe46a73f4",
  "000063_codex_oauth_setup_payload_claim":
    "33100d6f5f3f59cd9a4c22f041d19caba6a0e0be88de4a0ee4d543af50619481",
  "000064_codex_oauth_versioned_secret_namespaces":
    "4da4352108efd684a8bc6ddefa19353181a8a74758c32ed890527c2aec2ae666",
  "000065_codex_oauth_authority_acl_hardening":
    "ca8d554dd71cbdeaf0a66e007aa7ef391627c0a9d97b10a27e1113308087342c",
  "000066_codex_oauth_rotating_cascade_authority":
    "3b9b6385fde3120793aff052ba00c1afbd09011585d73a8184d0e73de8934af8",
  "000073_codex_oauth_active_namespace_refresh":
    "3e5b6606f22c8bec6f75f52f48b693806d597fa283155f6e033844c4f6be4de6",
});

export const forwardUnpublishedCodexRotatingMigration = Object.freeze({
  name: "000069_release_rollout_ledger",
  checksum: "82356ad61a366e22a15f4e53dabf8c97e14bad97c5970ef28710fe9367c06a05",
});

export const obsoleteReleaseRolloutLedgerMigrationAlias =
  "000067_release_rollout_ledger";

export const checkedInCodexRotatingMigrationChecksums = Object.freeze({
  ...immutableCodexRotatingMigrationChecksums,
  [forwardUnpublishedCodexRotatingMigration.name]:
    forwardUnpublishedCodexRotatingMigration.checksum,
});

export const unpublishedNonAtomicCodexOAuthSetupPayloadClaimChecksum =
  "a0693a88ea2c9a60d673e5be48e44047b865fabcecd46b8b66640381b4ed7667";

const editedBeforeRolloutMigration =
  "000061_codex_oauth_provider_mutation_fence";

/**
 * Fail closed on every migration name that may already be registered. 000061
 * was repaired before its first rollout and therefore must be absent. The
 * other historical migrations may be absent or have exactly one successful
 * row bearing the immutable checked-in checksum. The non-atomic 000063 digest
 * existed only on an unpublished local side branch and is never accepted as
 * released history. Forward migration 000069 is an immutable no-op marker: it
 * is pinned above but remains unpublished, so this pre-release policy rejects
 * every preexisting 000069 history row. Release Authority state lives only in
 * its dedicated external PostgreSQL database.
 */
export function assertCodexRotatingMigrationHistoryIsPristine(
  rows: readonly CodexRotatingMigrationHistoryRow[],
): void {
  if (
    rows.some(
      (row) =>
        row.migration_name === obsoleteReleaseRolloutLedgerMigrationAlias,
    )
  ) {
    throw new Error(
      "codex_rotating_obsolete_000067_release_rollout_ledger_alias_forbidden:" +
        "recreate_the_database_from_history_using_000069_release_rollout_ledger",
    );
  }
  if (
    rows.some(
      (row) =>
        row.migration_name === forwardUnpublishedCodexRotatingMigration.name,
    )
  ) {
    throw new Error(
      "codex_rotating_000069_prepublication_history_forbidden:" +
        "use_the_forward_release_migration_once_from_the_immutable_release_caller",
    );
  }
  const editedRows = rows.filter(
    (row) => row.migration_name === editedBeforeRolloutMigration,
  );
  if (editedRows.length !== 0) {
    throw new Error("codex_rotating_000061_preexisting_history_forbidden");
  }

  for (const [migrationName, expectedChecksum] of Object.entries(
    immutableCodexRotatingMigrationChecksums,
  )) {
    if (migrationName === editedBeforeRolloutMigration) continue;
    const matchingRows = rows.filter(
      (row) => row.migration_name === migrationName,
    );
    if (matchingRows.length === 0) continue;
    if (
      migrationName === "000063_codex_oauth_setup_payload_claim" &&
      matchingRows.some(
        (row) =>
          row.checksum ===
          unpublishedNonAtomicCodexOAuthSetupPayloadClaimChecksum,
      )
    ) {
      throw new Error(
        "codex_rotating_unpublished_non_atomic_000063_history_forbidden:" +
          "recreate_the_local_sandbox_database_from_a_clean_baseline;" +
          "do_not_resolve_mark_applied_or_bless_this_checksum",
      );
    }
    if (
      matchingRows.length !== 1 ||
      matchingRows[0]!.checksum !== expectedChecksum ||
      matchingRows[0]!.finished_at === null ||
      matchingRows[0]!.rolled_back_at !== null ||
      matchingRows[0]!.applied_steps_count !== 1
    ) {
      throw new Error(
        `codex_rotating_immutable_migration_history_mismatch:${migrationName}`,
      );
    }
  }
}
