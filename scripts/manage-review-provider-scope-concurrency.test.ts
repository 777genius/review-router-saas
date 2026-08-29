import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProviderScopeConcurrencyOperation } from "./manage-review-provider-scope-concurrency.mjs";

describe("provider scope concurrency rollout control", () => {
  const source = readFileSync(
    join(import.meta.dirname, "manage-review-provider-scope-concurrency.mjs"),
    "utf8",
  );
  const pg17Proof = readFileSync(
    join(import.meta.dirname, "run-hosted-pool-postgres-e2e.mjs"),
    "utf8",
  );

  it("requires an explicit old-fleet drain before activation", () => {
    expect(source).toContain("--confirm-old-replicas-drained");
    expect(source).toContain(
      'activate: "reviewrouter_provider_scope_concurrency_activate"',
    );
  });

  it("closes first and verifies duplicate lanes are drained before rollback", () => {
    expect(source).toContain("--confirm-no-old-replica-started");
    expect(source).toContain(
      'verifyRollback: "reviewrouter_provider_scope_concurrency_verify_rollback"',
    );
    expect(source).toContain("status.duplicateActiveVoteLanes === 0");
    expect(source).toContain("status.legacyProviderVoteIndex?.exact === true");
  });

  it("reconciles ambiguous commits by reading desired state and retrying", () => {
    expect(source).toContain("ambiguousConnectionCodes");
    expect(source).toContain("reconciledAfterAmbiguousCommit: true");
    expect(source).toContain("isDesiredState(operation, status)");
    expect(source).toContain("maxAttempts = 3");
  });

  it("returns success when an activation committed before its response was lost", async () => {
    let activated = false;
    let discarded = false;
    const result = await runProviderScopeConcurrencyOperation({
      operation: "activate",
      databaseUrl: "postgresql://restricted.invalid/review_router",
      createClient: () => ({
        connect: async () => undefined,
        end: async () => undefined,
        query: async (statement: string) => {
          if (statement.includes("_activate")) {
            activated = true;
            discarded = true;
            throw Object.assign(new Error("connection lost after commit"), {
              code: "08006",
            });
          }
          return {
            rows: [
              {
                status: {
                  activated,
                  duplicateActiveVoteLanes: 0,
                  legacyProviderVoteIndex: activated ? null : { exact: true },
                },
              },
            ],
          };
        },
      }),
    });

    expect(discarded).toBe(true);
    expect(result).toEqual({
      reconciledAfterAmbiguousCommit: true,
      status: {
        activated: true,
        duplicateActiveVoteLanes: 0,
        legacyProviderVoteIndex: null,
      },
    });
  });

  it("uses only restricted routines and never assumes schema-owner authority", () => {
    expect(source).toContain("SELECT public.${routineName}() AS status");
    expect(source).not.toContain("SET LOCAL ROLE");
    expect(source).not.toContain("reviewrouter_release_schema_owner");
    expect(source).not.toContain("DROP INDEX");
    expect(source).not.toContain(
      'UPDATE "ReviewProviderScopeConcurrencyControl"',
    );
  });

  it("runs the real PG17 activation and rollback proof as the restricted release login", () => {
    expect(pg17Proof).toContain(
      "proveProviderScopeConcurrencyRollout(\n      releaseMigrationDatabaseUrl,\n      databaseUrl,",
    );
    expect(pg17Proof).not.toContain(
      "proveProviderScopeConcurrencyRollout(databaseUrl)",
    );
    expect(pg17Proof).toContain("owner_memberships !== 0");
    expect(pg17Proof).not.toContain(
      "GRANT reviewrouter_release_schema_owner TO reviewrouter_release_migration",
    );
    expect(pg17Proof).toContain(
      "provider_scope_concurrency_release_authority_invalid",
    );
    expect(pg17Proof).toContain("reconciledAfterAmbiguousCommit !== true");
    expect(pg17Proof).toContain(
      "provider_scope_concurrency_commit_response_loss_recovery_invalid",
    );
    expect(pg17Proof).toContain(
      "provider_scope_concurrency_restricted_dml_present",
    );
    expect(pg17Proof).not.toContain("SET LOCAL ROLE");
  });
});
