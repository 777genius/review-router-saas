import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHostedCertificationSecretFree,
  buildHostedCertificationEvidence,
  captureHostedCertificationWorkspace,
} from "./hosted-pool-certification-evidence";

describe("hosted pool certification evidence", () => {
  it("accepts bounded hashed relay evidence", () => {
    expect(() =>
      assertHostedCertificationSecretFree(
        [
          {
            name: "relay",
            value: JSON.stringify({ requestHash: "a".repeat(64) }),
          },
        ],
        ["certification-sentinel"],
      ),
    ).not.toThrow();
  });

  it.each([
    "Bearer credential-material-that-must-not-escape",
    '{"access_token":"credential-material"}',
    '{"tokens":{"account_id":"auth-body-material"}}',
    '{"client_secret":"credential-material"}',
    '{"nested":"{\\"refresh_token\\":\\"credential-material\\"}"}',
    "x-api-key: credential-material-that-must-not-escape",
    "gho_credentialmaterialthatmustnotescape",
    "-----BEGIN PRIVATE KEY-----",
    "certification-sentinel",
  ])("rejects sensitive evidence without echoing it", (secret) => {
    expect(() =>
      assertHostedCertificationSecretFree(
        [{ name: "opaque-source", value: secret }],
        ["certification-sentinel"],
      ),
    ).toThrow(
      /^hosted_certification_sensitive_material_detected:[a-f0-9]{16}$/u,
    );
  });

  it("binds evidence to the exact commit, parent, tree, and migration hashes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rr-hosted-evidence-repo-"));
    const outputDirectory = join(workspace, ".artifacts");
    try {
      git(workspace, ["init"]);
      git(workspace, ["config", "user.email", "certification@example.invalid"]);
      git(workspace, ["config", "user.name", "Certification Test"]);
      await writeFile(join(workspace, "README.md"), "fixture\n");
      git(workspace, ["add", "README.md"]);
      git(workspace, ["commit", "-m", "fixture parent"]);
      const migrations = [
        "packages/platform/db/prisma/migrations/000074_hosted_codex_account_pool/migration.sql",
        "packages/platform/db/prisma/migrations/000075_hosted_codex_security_certification/migration.sql",
        "packages/platform/db/prisma/migrations/000076_hosted_codex_terminalization_restore_invariants/migration.sql",
        "packages/platform/db/prisma/migrations/000077_hosted_codex_r57_security_race_remediation/migration.sql",
      ];
      for (const [index, path] of migrations.entries()) {
        await mkdir(dirname(join(workspace, path)), { recursive: true });
        await writeFile(join(workspace, path), `migration-${index}\n`);
      }
      git(workspace, ["add", "."]);
      git(workspace, ["commit", "-m", "fixture migrations"]);
      const commitSha = git(workspace, ["rev-parse", "HEAD"]);
      const result = await buildHostedCertificationEvidence({
        workspace,
        outputDirectory,
        expectedCommitSha: commitSha,
      });
      const evidence = JSON.parse(await readFile(result.path, "utf8")) as {
        subject: { commitSha: string; parentSha: string; treeSha: string };
        migrations: Array<{ path: string; sha256: string }>;
      };
      expect(evidence.subject).toMatchObject({
        commitSha,
        parentSha: git(workspace, ["rev-parse", "HEAD^"]),
        treeSha: git(workspace, ["rev-parse", "HEAD^{tree}"]),
      });
      expect(evidence.migrations.map(({ path }) => path)).toEqual(migrations);
      expect(
        evidence.migrations.every(({ sha256 }) =>
          /^[a-f0-9]{64}$/u.test(sha256),
        ),
      ).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects tracked changes and untracked bytes instead of certifying only HEAD", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rr-hosted-dirty-repo-"));
    try {
      git(workspace, ["init"]);
      git(workspace, ["config", "user.email", "certification@example.invalid"]);
      git(workspace, ["config", "user.name", "Certification Test"]);
      await writeFile(join(workspace, "tracked.txt"), "clean\n");
      git(workspace, ["add", "tracked.txt"]);
      git(workspace, ["commit", "-m", "fixture"]);
      expect(captureHostedCertificationWorkspace(workspace)).toMatchObject({
        schemaVersion: 1,
      });
      await writeFile(join(workspace, "untracked.txt"), "not-tested\n");
      expect(() => captureHostedCertificationWorkspace(workspace)).toThrow(
        "hosted_certification_workspace_dirty",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}
