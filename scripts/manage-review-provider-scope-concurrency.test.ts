import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("provider scope concurrency rollout control", () => {
  const source = readFileSync(
    join(import.meta.dirname, "manage-review-provider-scope-concurrency.mjs"),
    "utf8",
  );

  it("requires an explicit old-fleet drain before activation", () => {
    expect(source).toContain("--confirm-old-replicas-drained");
    expect(source).toContain("pg_advisory_lock(1381126735, 1381192279)");
    expect(source).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "ReviewInvocationLeaseV2_one_active_provider_vote_lane"',
    );
    expect(source).toContain('SET "activated" = true');
  });

  it("closes first and verifies duplicate lanes are drained before rollback", () => {
    expect(source).toContain("--confirm-no-old-replica-started");
    expect(source).toContain('SET "activated" = false');
    expect(source).toContain(
      "provider_scope_concurrency_rollback_requires_drain",
    );
    expect(source).toContain("HAVING count(*) > 1");
    expect(source).toContain("repairLegacyProviderVoteIndex()");
  });

  it("accepts only the exact valid, ready, unique legacy index and repairs drift", () => {
    expect(source).toContain("index_catalog.indisvalid");
    expect(source).toContain("index_catalog.indisready");
    expect(source).toContain("index_catalog.indisunique");
    expect(source).toContain("pg_get_indexdef(index_catalog.indexrelid)");
    expect(source).toContain(
      "index.definition === legacyProviderVoteIndexDefinition",
    );
    expect(source).toContain(
      'DROP INDEX CONCURRENTLY "ReviewInvocationLeaseV2_one_active_provider_vote_lane"',
    );
    expect(source).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY "ReviewInvocationLeaseV2_one_active_provider_vote_lane"',
    );
    expect(source).not.toContain(
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS",
    );
  });
});
