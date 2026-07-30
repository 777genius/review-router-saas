import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { psqlConnectionUrl } from "./lib/psql-connection-url.mjs";

describe("Review v2 migration psql connection URL", () => {
  it("removes Prisma schema parameters and preserves libpq parameters", () => {
    expect(
      psqlConnectionUrl(
        "postgresql://reviewrouter:secret@postgres:5432/review_router?schema=public&sslmode=require&application_name=review-v2-migrate",
      ),
    ).toBe(
      "postgresql://reviewrouter:secret@postgres:5432/review_router?sslmode=require&application_name=review-v2-migrate",
    );
  });

  it("accepts the postgres protocol and encoded credentials", () => {
    expect(
      psqlConnectionUrl(
        "postgres://reviewrouter:p%40ss%2Fword@postgres/review_router?schema=public",
      ),
    ).toBe("postgres://reviewrouter:p%40ss%2Fword@postgres/review_router");
  });

  it("rejects invalid and non-PostgreSQL URLs", () => {
    expect(() => psqlConnectionUrl("not-a-url")).toThrow(
      "DATABASE_URL must be a valid PostgreSQL URL",
    );
    expect(() => psqlConnectionUrl("mysql://db/review_router")).toThrow(
      "DATABASE_URL must use postgresql:// or postgres://",
    );
  });
});

describe("Review v2 migration restart safety", () => {
  it("requires the emergency stop only until each guarded step completes", () => {
    const source = readFileSync(
      new URL("./review-v2-migrate.mjs", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "initialEmergencyStopGuardSql(\n      reviewV2ExpandGuardStep",
    );
    expect(source).toContain(
      "initialEmergencyStopGuardSql(\n      reviewV2ReadyDisabledStep",
    );
    expect(source).toContain(`AND "status" = 'completed'`);
    expect(source).toContain(
      "the current emergency-control state was preserved",
    );
  });
});
