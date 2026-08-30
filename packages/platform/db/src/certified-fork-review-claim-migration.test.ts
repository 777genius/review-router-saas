import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  fileURLToPath(
    new URL(
      "../prisma/migrations/000087_certified_fork_review_claim/migration.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("certified fork review claim migration", () => {
  it("grants claim custody only to the API runtime", () => {
    expect(sql).toContain(
      'REVOKE ALL ON TABLE "CertifiedForkReviewClaim" FROM PUBLIC',
    );
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CertifiedForkReviewClaim"\s+TO reviewrouter_api/u,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE "CertifiedForkReviewClaim" FROM reviewrouter_web/u,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE "CertifiedForkReviewClaim" FROM reviewrouter_worker/u,
    );
  });

  it("persists a bounded operator-recovery state without automatic expiry", () => {
    expect(sql).toContain('"reservationExpiresAt" TIMESTAMP(3) NOT NULL');
    expect(sql).toContain(
      "CHECK (\"recoveryState\" IN ('reserved', 'ambiguous'))",
    );
    expect(sql).not.toMatch(/DELETE[^;]*reservationExpiresAt/iu);
  });
});
