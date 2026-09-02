import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const databaseUrl =
  process.env.REVIEW_ROUTER_MIGRATION_REHEARSAL_DATABASE_URL ?? "";
const realProofEnabled =
  process.env.REVIEW_ROUTER_MIGRATION81_REAL_PROOF === "1" &&
  databaseUrl.length > 0;

it.skipIf(!realProofEnabled)(
  "proves both migration89 lock orderings against disposable PostgreSQL 17 databases",
  () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve(
          import.meta.dirname,
          "check-codex-rotating-migration-rehearsal.mjs",
        ),
        "--migration89-boundary-only",
      ],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: process.env,
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain(
      "Codex rotating PostgreSQL 17 migration89 two-session boundary passed.",
    );
  },
  125_000,
);
