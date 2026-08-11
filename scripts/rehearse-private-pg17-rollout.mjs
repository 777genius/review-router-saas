#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const imagePattern =
  /^postgres:(16\.13|17(?:\.[0-9]+)?)-bookworm@sha256:[a-f0-9]{64}$/u;

export function validateRehearsalConfiguration(env) {
  if (env.REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL !== "1")
    throw new Error("private_pg17_rehearsal_explicit_opt_in_required");
  const sourceImage = env.REVIEW_ROUTER_REHEARSAL_PG16_IMAGE;
  const targetImage = env.REVIEW_ROUTER_REHEARSAL_PG17_IMAGE;
  if (
    !imagePattern.test(sourceImage ?? "") ||
    !imagePattern.test(targetImage ?? "")
  )
    throw new Error("private_pg17_rehearsal_immutable_images_required");
  if (
    !sourceImage.startsWith("postgres:16.13-") ||
    !targetImage.startsWith("postgres:17")
  )
    throw new Error("private_pg17_rehearsal_versions_invalid");
  return Object.freeze({ sourceImage, targetImage });
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function executeDisposableRehearsal(
  env = process.env,
  execute = (args, options = {}) => {
    const result = spawnSync("docker", args, {
      encoding: options.encoding ?? "utf8",
      input: options.input,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`private_pg17_rehearsal_docker_failed:${args[0]}`);
    return result.stdout;
  },
) {
  const images = validateRehearsalConfiguration(env);
  const suffix = randomBytes(6).toString("hex");
  const source = `rr-pg16-${suffix}`;
  const target = `rr-pg17-${suffix}`;
  const network = `rr-pg-cutover-${suffix}`;
  const directory = mkdtempSync(join(tmpdir(), "reviewrouter-pg17-rehearsal-"));
  const dumpPath = join(directory, "source.dump");
  const password = "disposable-reviewrouter-only";
  let networkCreated = false;
  const createdContainers = [];
  const docker = (...args) => execute(args);
  const sql = (container, statement) =>
    docker(
      "exec",
      container,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "reviewrouter",
      "-Atqc",
      statement,
    ).trim();
  try {
    docker("network", "create", network);
    networkCreated = true;
    for (const [name, image] of [
      [source, images.sourceImage],
      [target, images.targetImage],
    ]) {
      docker(
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        network,
        "--network-alias",
        name,
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "--env",
        "POSTGRES_DB=reviewrouter",
        image,
      );
      createdContainers.push(name);
    }
    for (const name of [source, target]) {
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          docker(
            "exec",
            name,
            "pg_isready",
            "-U",
            "postgres",
            "-d",
            "reviewrouter",
          );
          ready = true;
          break;
        } catch {
          docker("exec", name, "sh", "-c", "sleep 1");
        }
      }
      if (!ready) throw new Error("private_pg17_rehearsal_database_timeout");
    }
    if (
      !sql(source, "SHOW server_version_num").startsWith("160") ||
      !sql(target, "SHOW server_version_num").startsWith("170")
    )
      throw new Error("private_pg17_rehearsal_server_version_mismatch");
    sql(
      source,
      `COMMENT ON DATABASE reviewrouter IS '{"recoveryWitnessSha256":"${"a".repeat(64)}"}'; CREATE TABLE rehearsal_items(id bigserial PRIMARY KEY, value text NOT NULL UNIQUE); CREATE TABLE "_prisma_migrations"(migration_name text PRIMARY KEY, checksum text NOT NULL); INSERT INTO rehearsal_items(value) VALUES ('one'),('two'),('three'); INSERT INTO "_prisma_migrations" VALUES ('rehearsal_001','${"b".repeat(64)}');`,
    );
    sql(
      target,
      `COMMENT ON DATABASE reviewrouter IS '{"recoveryWitnessSha256":"${"c".repeat(64)}"}'`,
    );
    const dump = execute(
      [
        "exec",
        source,
        "pg_dump",
        "-U",
        "postgres",
        "-d",
        "reviewrouter",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
      ],
      { encoding: "buffer" },
    );
    writeFileSync(dumpPath, dump);
    docker("cp", dumpPath, `${target}:/tmp/source.dump`);
    docker(
      "exec",
      target,
      "pg_restore",
      "-U",
      "postgres",
      "-d",
      "reviewrouter",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "/tmp/source.dump",
    );
    const snapshotSql = `SELECT json_build_object('rows',(SELECT count(*) FROM rehearsal_items),'hash',(SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) FROM rehearsal_items t),'sequence',(SELECT last_value FROM rehearsal_items_id_seq),'constraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace),'indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public'),'migrations',(SELECT json_agg(m ORDER BY migration_name) FROM "_prisma_migrations" m))`;
    const sourceSnapshot = sql(source, snapshotSql);
    const targetSnapshot = sql(target, snapshotSql);
    if (sourceSnapshot !== targetSnapshot)
      throw new Error("private_pg17_rehearsal_equivalence_failed");
    sql(
      target,
      `CREATE ROLE reviewrouter_api LOGIN; GRANT CONNECT ON DATABASE reviewrouter TO reviewrouter_api; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO reviewrouter_api; BEGIN; REVOKE CONNECT ON DATABASE reviewrouter FROM reviewrouter_api; REVOKE INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public FROM reviewrouter_api; CREATE TABLE "ReleaseGenerationActivationReceipt"("rolloutId" text PRIMARY KEY, "activatedAt" timestamptz NOT NULL DEFAULT transaction_timestamp()); COMMIT;`,
    );
    if (
      sql(
        target,
        "SELECT has_table_privilege('reviewrouter_api','rehearsal_items','INSERT')",
      ) !== "f"
    )
      throw new Error("private_pg17_rehearsal_acl_gate_open");
    sql(
      target,
      `BEGIN; GRANT CONNECT ON DATABASE reviewrouter TO reviewrouter_api; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO reviewrouter_api; INSERT INTO "ReleaseGenerationActivationReceipt"("rolloutId") VALUES ('disposable-rehearsal'); COMMIT;`,
    );
    if (
      sql(
        target,
        'SELECT count(*) FROM "ReleaseGenerationActivationReceipt" WHERE "rolloutId"=\'disposable-rehearsal\'',
      ) !== "1" ||
      sql(
        target,
        "SELECT has_table_privilege('reviewrouter_api','rehearsal_items','INSERT')",
      ) !== "t"
    )
      throw new Error("private_pg17_rehearsal_activation_failed");
    return Object.freeze({
      schemaVersion: 1,
      disposable: true,
      sourceMajor: 16,
      targetMajor: 17,
      dumpSha256: sha256(dump),
      equivalenceSha256: sha256(sourceSnapshot),
      aclGateBeforeActivation: "closed",
      activationReceipt: "disposable-rehearsal",
      cleanupVerified: true,
    });
  } finally {
    for (const name of createdContainers.reverse())
      docker("rm", "--force", name);
    if (networkCreated) docker("network", "rm", network);
    rmSync(directory, { force: true, recursive: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.includes("--check-only"))
      validateRehearsalConfiguration(process.env);
    else
      process.stdout.write(`${JSON.stringify(executeDisposableRehearsal())}\n`);
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof Error ? error.message : "private_pg17_rehearsal_failed"}\n`,
    );
    process.exitCode = 1;
  }
}
