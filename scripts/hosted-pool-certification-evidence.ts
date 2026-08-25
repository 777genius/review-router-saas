import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import pg from "pg";

const forbiddenPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/iu,
  /"(?:access_token|refresh_token|id_token|authorization|auth_json|authJson|client_secret|api_key|password|private_key|session_token|tokens)"\s*:/iu,
  /\b(?:sk|gh[oprsu]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/u,
  /\b(?:authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\s,;]{8,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, // gitleaks:allow -- detector signature, never key material
  /\b(?:CODEX_AUTH_JSON|REVIEWROUTER_CODEX_AUTH_JSON|OPENAI_API_KEY|GITHUB_TOKEN)\s*[:=]/u,
] as const;

export type CertificationScanSource = Readonly<{
  name: string;
  value: string;
}>;

type HostedCertificationWorkspaceSnapshot = Readonly<{
  schemaVersion: 1;
  commitSha: string;
  treeSha: string;
  contentSha256: string;
}>;

export function captureHostedCertificationWorkspace(
  workspace: string,
): HostedCertificationWorkspaceSnapshot {
  const status = git(workspace, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
  ]);
  if (status !== "") throw new Error("hosted_certification_workspace_dirty");
  const commitSha = git(workspace, ["rev-parse", "HEAD"]);
  const treeSha = git(workspace, ["rev-parse", "HEAD^{tree}"]);
  return {
    schemaVersion: 1,
    commitSha,
    treeSha,
    contentSha256: sha256(`${commitSha}\0${treeSha}\0clean-tracked-untracked`),
  };
}

export function assertHostedCertificationSecretFree(
  sources: readonly CertificationScanSource[],
  sentinels: readonly string[],
): void {
  const usableSentinels = sentinels.filter(
    (value) => value.length >= 16 && value.trim() === value,
  );
  if (
    usableSentinels.length !== sentinels.length ||
    usableSentinels.length < 1 ||
    new Set(usableSentinels).size !== usableSentinels.length
  )
    throw new Error("hosted_certification_secret_sentinels_required");
  for (const source of sources) {
    const candidates = [
      source.value,
      source.value.replaceAll('\\"', '"').replaceAll("\\n", "\n"),
    ];
    const forbidden = candidates.some((candidate) =>
      forbiddenPatterns.some((pattern) => pattern.test(candidate)),
    );
    const sentinel = usableSentinels.some((value) =>
      candidates.some((candidate) => candidate.includes(value)),
    );
    if (forbidden || sentinel) {
      // Never include source bytes, matched text, or a reversible identifier.
      throw new Error(
        `hosted_certification_sensitive_material_detected:${sha256(source.name).slice(0, 16)}`,
      );
    }
  }
}

export async function buildHostedCertificationEvidence(input: {
  readonly workspace: string;
  readonly outputDirectory: string;
  readonly expectedCommitSha: string;
  readonly databaseUrl?: string;
  readonly sentinels?: readonly string[];
  readonly gateStatuses?: Readonly<Record<string, string>>;
  readonly workspaceSnapshotPath?: string;
}) {
  const before = input.workspaceSnapshotPath
    ? (JSON.parse(
        await readFile(input.workspaceSnapshotPath, "utf8"),
      ) as HostedCertificationWorkspaceSnapshot)
    : captureHostedCertificationWorkspace(input.workspace);
  const after = captureHostedCertificationWorkspace(input.workspace);
  if (
    before.schemaVersion !== 1 ||
    before.commitSha !== after.commitSha ||
    before.treeSha !== after.treeSha ||
    before.contentSha256 !== after.contentSha256
  ) {
    throw new Error("hosted_certification_tested_content_changed");
  }
  const commitSha = git(input.workspace, ["rev-parse", "HEAD"]);
  if (
    commitSha !== input.expectedCommitSha ||
    !/^[a-f0-9]{40}$/u.test(commitSha)
  ) {
    throw new Error("hosted_certification_commit_identity_mismatch");
  }
  const parentSha = git(input.workspace, ["rev-parse", "HEAD^"]);
  const treeSha = git(input.workspace, ["rev-parse", "HEAD^{tree}"]);
  const migrationPaths = [
    "packages/platform/db/prisma/migrations/000074_hosted_codex_account_pool/migration.sql",
    "packages/platform/db/prisma/migrations/000075_hosted_codex_security_certification/migration.sql",
    "packages/platform/db/prisma/migrations/000076_hosted_codex_terminalization_restore_invariants/migration.sql",
    "packages/platform/db/prisma/migrations/000077_hosted_codex_r57_security_race_remediation/migration.sql",
    "packages/platform/db/prisma/migrations/000078_review_investigation_maintenance_checkpoint/migration.sql",
    "packages/platform/db/prisma/migrations/000079_hosted_codex_output_limits/migration.sql",
    "packages/platform/db/prisma/migrations/000080_hosted_codex_attempt_generation/migration.sql",
  ];
  const sources: CertificationScanSource[] = [];
  const logsDirectory = join(input.outputDirectory, "logs");
  for (const name of await listFiles(logsDirectory)) {
    sources.push({ name: `log:${name}`, value: await readFile(name, "utf8") });
  }
  if (input.databaseUrl) {
    sources.push(...(await readRelayEffectRows(input.databaseUrl)));
  }
  const gateNames = [
    "hosted-pool:verify",
    "hosted-pool:migration-rehearsal",
    "hosted-pool:e2e:postgres",
  ] as const;
  const gates = gateNames.map((name) => ({
    name,
    status: input.gateStatuses?.[name] ?? "missing",
  }));
  if (gates.some((gate) => gate.status !== "success")) {
    throw new Error("hosted_certification_gate_failed");
  }
  const evidence = {
    schemaVersion: 2,
    subject: {
      commitSha,
      parentSha,
      treeSha,
      testedContent: { before, after },
    },
    migrations: await Promise.all(
      migrationPaths.map(async (path) => ({
        path,
        sha256: sha256(gitBytes(input.workspace, ["show", `HEAD:${path}`])),
      })),
    ),
    gates,
    scan: {
      policyVersion: "hosted-certification-sensitive-scan-v2",
      sourceCount: sources.length + 1,
      relayEffectRowsIncluded:
        Boolean(input.databaseUrl) ||
        sources.some((source) =>
          source.name.includes("relay-effect-rows.jsonl"),
        ),
    },
  };
  const canonical = JSON.stringify(evidence);
  assertHostedCertificationSecretFree(
    [...sources, { name: "evidence", value: canonical }],
    input.sentinels ?? [],
  );
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  const path = join(
    input.outputDirectory,
    "hosted-certification-evidence.json",
  );
  await writeFile(
    path,
    `${JSON.stringify({ ...evidence, evidenceSha256: sha256(canonical) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    path,
    commitSha,
    parentSha,
    treeSha,
    evidenceSha256: sha256(canonical),
  };
}

async function readRelayEffectRows(databaseUrl: string) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT 'relay_request' AS kind, row_to_json(r)::text AS body
      FROM "HostedCodexRelayRequest" r
      UNION ALL
      SELECT 'upstream_effect' AS kind, row_to_json(e)::text AS body
      FROM "HostedCodexUpstreamEffectAttempt" e
    `);
    return result.rows.map((row, index) => ({
      name: `database:${String(row.kind)}:${index}`,
      value: String(row.body),
    }));
  } finally {
    await client.end();
  }
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
      }),
    );
    return nested.flat().sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
}

function gitBytes(workspace: string, args: readonly string[]): Buffer {
  return execFileSync("/usr/bin/git", args, {
    cwd: workspace,
    encoding: "buffer",
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const workspace = process.cwd();
  if (process.argv.includes("--capture-workspace")) {
    const snapshotPath = String(
      process.env.REVIEW_ROUTER_HOSTED_CERTIFICATION_WORKSPACE_SNAPSHOT ?? "",
    ).trim();
    if (!snapshotPath)
      throw new Error("hosted_certification_workspace_snapshot_required");
    const snapshot = captureHostedCertificationWorkspace(workspace);
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(
      `${JSON.stringify({ status: "captured", contentSha256: snapshot.contentSha256 })}\n`,
    );
    return;
  }
  const result = await buildHostedCertificationEvidence({
    workspace,
    outputDirectory: resolve(
      process.env.REVIEW_ROUTER_HOSTED_CERTIFICATION_OUTPUT ??
        ".artifacts/hosted-certification",
    ),
    expectedCommitSha: String(process.env.GITHUB_SHA ?? "").trim(),
    workspaceSnapshotPath:
      process.env.REVIEW_ROUTER_HOSTED_CERTIFICATION_WORKSPACE_SNAPSHOT,
    databaseUrl: process.env.DATABASE_URL,
    sentinels: JSON.parse(
      process.env.REVIEW_ROUTER_HOSTED_CERTIFICATION_SENTINELS_JSON ?? "[]",
    ) as string[],
    gateStatuses: {
      "hosted-pool:verify":
        process.env.REVIEW_ROUTER_HOSTED_VERIFY_STATUS ?? "unknown",
      "hosted-pool:migration-rehearsal":
        process.env.REVIEW_ROUTER_HOSTED_MIGRATION_STATUS ?? "unknown",
      "hosted-pool:e2e:postgres":
        process.env.REVIEW_ROUTER_HOSTED_POSTGRES_STATUS ?? "unknown",
    },
  });
  process.stdout.write(`${JSON.stringify({ status: "passed", ...result })}\n`);
}

if (process.argv[1]?.endsWith("hosted-pool-certification-evidence.ts")) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "hosted_certification_failed"}\n`,
    );
    process.exitCode = 1;
  });
}
