import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("000077 hosted Codex r57 remediation", () => {
  const sql = readFileSync(
    resolve(
      import.meta.dirname,
      "../prisma/migrations/000077_hosted_codex_r57_security_race_remediation/migration.sql",
    ),
    "utf8",
  );
  const effects = readFileSync(
    resolve(
      import.meta.dirname,
      "../../../features/hosted-account-pool/src/infrastructure/prisma/prisma-hosted-codex-upstream-effect-ledger.ts",
    ),
    "utf8",
  );
  const restore = readFileSync(
    resolve(
      import.meta.dirname,
      "../../../features/hosted-account-pool/src/infrastructure/prisma/prisma-hosted-codex-restore-reconciler.ts",
    ),
    "utf8",
  );

  it("serializes only active matching restore scopes while retaining fresh completed retries", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "HostedCodexRestoreOperation_active_inventory_target_key"',
    );
    expect(sql).toContain(
      `WHERE "state" IN ('witnessed', 'reconciling', 'reconciled')`,
    );
    expect(sql).not.toMatch(/WHERE "state" IN \([^)]*(?:promoted|failed)/u);
    expect(restore).toContain("pg_advisory_xact_lock");
    expect(restore).toContain(
      'state: { in: ["witnessed", "reconciling", "reconciled"] }',
    );
  });

  it("rechecks mutable account and grant authority at prepare and dispatch", () => {
    expect(
      effects.match(/assertCurrentDispatchAuthority\(/gu)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(effects).toContain("grant.activeAccountId !== accountId");
    expect(effects).toContain(
      '!["issued", "exhausted"].includes(grant.status)',
    );
    expect(effects).toContain('grant.account.state === "healthy"');
  });

  it("poisons issued and exhausted capabilities without zeroing sibling accounting", () => {
    const poison = sql.match(
      /CREATE OR REPLACE FUNCTION "hosted_codex_terminal_unknown_poison_grant"[\s\S]+?END;\n\$\$;/u,
    )?.[0];
    expect(poison).toBeDefined();
    expect(poison).toContain(`"status" IN ('issued', 'exhausted')`);
    expect(poison).not.toContain('"inFlight" = 0');
    expect(sql).toContain('SET "inFlight" = live.count');
    expect(sql).toContain('"HostedCodexCommentRefreshCapability"');
  });

  it("permits only a witnessed failed-no-effect request to resume in place", () => {
    expect(sql).toContain(`OLD."errorCode" = 'upstream_dispatch_not_started'`);
    expect(sql).toContain(`e."state" = 'failed_no_effect'`);
    expect(sql).toContain("NEW.\"status\" = 'processing'");
    expect(sql).toContain('NEW."completedAt" IS NULL');
    expect(sql).toContain("hosted_codex_relay_request_terminal_status");
  });
});
