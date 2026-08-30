import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/000088_codex_zero_login_namespace_rollover/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("zero-login namespace rollover migration", () => {
  it("serializes one global intent and binds an existing exact E+1 candidate", () => {
    expect(migration).toContain('"activeGlobalSlot" integer UNIQUE');
    expect(migration).toContain('"activeGlobalSlot" = 1');
    expect(migration).toContain(
      "candidate.\"status\" IN ('dispatch_authorized','confirmed_candidate')",
    );
    expect(migration).toContain(
      'NEW."candidateNamespaceEpoch" <> COALESCE(active_epoch + 1, 1)',
    );
  });

  it("forbids deletion and makes durable identity and staged facts immutable", () => {
    expect(migration).toContain("codex_zero_login_rollover_delete_forbidden");
    for (const field of [
      '"operationId"',
      '"repositoryFullName"',
      '"sourceWorkflowCommitSha"',
      '"sourceDefaultHeadSha"',
      '"verifiedScheduleCompletedAt"',
      '"releaseEvidenceDigest"',
      '"renderOverlapEvidenceJson"',
      '"candidateNamespaceId"',
      '"createdAt"',
    ]) {
      expect(migration).toContain(`OLD.${field} IS DISTINCT FROM NEW.${field}`);
    }
    expect(migration).toContain("codex_zero_login_rollover_staged_evidence_changed");
    expect(migration).toContain('OLD."setupPullRequestHeadSha" IS NOT NULL');
    expect(migration).toContain('OLD."writebackGenerationHash" IS NOT NULL');
  });

  it("permits only evidence-backed state transitions and a slot iff nonterminal", () => {
    expect(migration).toContain("codex_zero_login_rollover_transition_invalid");
    expect(migration).toContain("codex_zero_login_rollover_provider_confirmation_unproven");
    expect(migration).toContain("codex_zero_login_rollover_predispatch_abort_unproven");
    expect(migration).toContain("codex_zero_login_rollover_setup_pr_unproven");
    expect(migration).toContain("codex_zero_login_rollover_activation_unproven");
    expect(migration).toContain("codex_zero_login_rollover_active_slot_state_invalid");
    expect(migration).toContain("NEW.\"state\" IN ('prepared','put_authorized','provider_confirmed','setup_pr_open')");
  });

  it("requires setup claim, confirmed attempt and setup mutation ownership for reused candidates", () => {
    expect(migration).toContain('NEW."state"=\'provider_confirmed\'');
    expect(migration).toContain('attempt."status"=\'confirmed\'');
    expect(migration).toContain('claim."status"=\'confirmed_candidate\'');
    expect(migration).toContain('provider."mutationOwner"=\'setup\'');
    expect(migration).toContain('provider."mutationOwnerId"=claim."manifestId"');
  });

  it("uses a dedicated signed long-wait rollover authority without widening normal runtime completion", () => {
    expect(migration).toContain('CREATE FUNCTION "codex_oauth_authorize_rollover_completion"');
    expect(migration).toContain("caller_role NOT IN ('reviewrouter_web', 'reviewrouter_release_migration')");
    expect(migration).toContain('rollover."state"=\'setup_pr_open\'');
    expect(migration).toContain('lease."status"=\'finalized\'');
    expect(migration).toContain('candidate."status"=\'confirmed_candidate\'');
    expect(migration).toContain('intent."executorLeaseExpiresAt" > clock_timestamp()');
    expect(migration).not.toContain("caller_role NOT IN ('reviewrouter_api', 'reviewrouter_web'");
  });

  it("sets explicit least-privilege runtime ACLs", () => {
    expect(migration).toContain('REVOKE ALL ON TABLE "CodexOAuthNamespaceRolloverIntent" FROM PUBLIC');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE "CodexOAuthNamespaceRolloverIntent" TO reviewrouter_api');
    expect(migration).toContain('GRANT SELECT, UPDATE ON TABLE "CodexOAuthNamespaceRolloverIntent" TO reviewrouter_web');
    expect(migration).toContain('REVOKE ALL ON TABLE "CodexOAuthNamespaceRolloverIntent" FROM reviewrouter_worker');
  });

  it("pins exact rerun and target V5 release facts", () => {
    expect(migration).toContain(
      'UNIQUE ("providerInstanceRowId", "sourceRunId", "expectedRerunAttempt")',
    );
    expect(migration).toContain('CHECK ("targetWorkflowSchemaVersion" = 5)');
    expect(migration).toContain(
      '"expectedRerunAttempt"::numeric = "sourceRunAttempt"::numeric + 1',
    );
  });

  it("retires an ambiguous PUT candidate permanently", () => {
    expect(migration).toContain("NEW.\"state\" = 'provider_outcome_unknown'");
    expect(migration).toContain('"permanentlyRetired"=true');
    expect(migration).toContain('NEW."activeGlobalSlot" := NULL');
  });
});
