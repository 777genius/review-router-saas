import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(
  new URL(
    "../.github/workflows/run-historical89-inplace-migration.yml",
    import.meta.url,
  ),
  "utf8",
);
const operation = workflow
  .split("      - name: Run historical89 in-place operation\n")[1]
  .split("\n      - name: Restore original")[0];
const wrapper = operation
  .split("          node --input-type=module <<'NODE'\n")[1]
  .split("\n          NODE")[0]
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n");
const pin = `sha256:${"a".repeat(64)}`;

function execute(output, status = 0) {
  const root = mkdtempSync(join(tmpdir(), "rr-workflow-output-"));
  try {
    for (const name of [
      "scripts",
      "historical89-private",
      "historical89-result",
      "node_modules/tsx",
    ])
      mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, "node_modules/tsx/package.json"),
      '{"type":"module","exports":"./index.mjs"}',
    );
    writeFileSync(join(root, "node_modules/tsx/index.mjs"), "");
    writeFileSync(
      join(root, "scripts/run-historical89-inplace-operation.mjs"),
      `console.log(${JSON.stringify(output)}); console.error('private diagnostic'); process.exit(${status});`,
    );
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      cwd: root,
      input: wrapper,
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: root },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      artifact: JSON.parse(
        readFileSync(join(root, "historical89-result/result.json"), "utf8"),
      ),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("committed result exposes only receipt and outcome", () => {
  const result = execute(
    JSON.stringify({
      outcome: "committed-96",
      receiptDigest: pin,
      password: "secret-value",
    }),
  );
  assert.equal(result.status, 0);
  assert.deepEqual(result.artifact, {
    outcome: "committed-96",
    receiptDigest: pin,
  });
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /secret-value|private diagnostic/,
  );
});
test("nonzero child cannot claim successful migration", () => {
  const result = execute(
    JSON.stringify({ outcome: "committed-96", receiptDigest: pin }),
    1,
  );
  assert.equal(result.status, 1);
  assert.equal(result.artifact.outcome, "fenced-unresolved");
});
test("malformed output cannot succeed or leak diagnostic text", () => {
  const result = execute("secret-value");
  assert.equal(result.status, 1);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /secret-value|private diagnostic/,
  );
});
test("already96 result remains a read-only verification", () => {
  const result = execute(
    JSON.stringify({ outcome: "already-96", receiptDigest: pin }),
  );
  assert.equal(result.status, 0);
  assert.equal(result.artifact.authorizesProductionMutation, false);
});
test("unrecognized receipt fails closed", () => {
  assert.equal(
    execute(
      JSON.stringify({ outcome: "committed-96", receiptDigest: "untrusted" }),
    ).status,
    1,
  );
});
