#!/usr/bin/env node
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const activationCatalogCaptureMaxBytes = 16 * 1024 * 1024;
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const exact = (v, f) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...f].sort().join(",");
const fail = (r = "invalid") => {
  throw new Error(`activation_catalog_capture_pair_${r}`);
};
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

export async function readBoundedActivationCatalogCapture(path, expected) {
  const handle = await open(path, "r");
  let bytes;
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(activationCatalogCaptureMaxBytes) ||
      (expected && Number(before.size) !== expected.bytes)
    )
      fail("size_invalid");

    const bounded = Buffer.alloc(activationCatalogCaptureMaxBytes + 1);
    let offset = 0;
    while (offset < bounded.byteLength) {
      const read = await handle.read(
        bounded,
        offset,
        bounded.byteLength - offset,
        offset,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset < 1 ||
      offset > activationCatalogCaptureMaxBytes ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.size !== BigInt(offset)
    )
      fail("size_invalid");
    bytes = bounded.subarray(0, offset);
  } finally {
    await handle.close();
  }

  const hash = sha256(bytes);
  if (expected && hash !== expected.sha256) fail("hash_invalid");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail();
  }
  return Object.freeze({ path, bytes: bytes.byteLength, sha256: hash, value });
}

function raw(v) {
  const c = v?.capture,
    d = c?.database,
    p = c?.projection,
    u = c?.custody;
  if (
    !exact(v, ["kind", "version", "policies", "capture"]) ||
    v.kind !== "reviewrouter-activation-catalog-policy-artifact-candidate" ||
    v.version !== 2 ||
    !exact(v.policies, ["preactivation", "activated"]) ||
    !exact(c, [
      "commitSha",
      "postManifestIdentity",
      "database",
      "projection",
      "custody",
    ]) ||
    !/^[a-f0-9]{40}$/u.test(c.commitSha ?? "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(c.postManifestIdentity ?? "") ||
    !exact(d, [
      "disposableIdentity",
      "configuredIdentity",
      "systemIdentifier",
      "recoveryWitnessSha256",
    ]) ||
    !exact(p, ["sha256", "observedDigest"]) ||
    !exact(u, ["captureBaseCommit", "auditedHead", "evidenceSha256"]) ||
    u.auditedHead !== c.commitSha ||
    !/^[a-f0-9]{40}$/u.test(u.captureBaseCommit ?? "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(u.evidenceSha256 ?? "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(p.sha256 ?? "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(p.observedDigest ?? "") ||
    !/^[a-f0-9]{64}$/u.test(d.recoveryWitnessSha256 ?? "") ||
    typeof d.configuredIdentity !== "string" ||
    typeof d.disposableIdentity !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(d.systemIdentifier ?? "")
  )
    fail();
  const evidence = {
    auditedHead: u.auditedHead,
    captureBaseCommit: u.captureBaseCommit,
    commitSha: c.commitSha,
    database: d,
    policies: v.policies,
    postManifestIdentity: c.postManifestIdentity,
    projection: p,
  };
  if (u.evidenceSha256 !== `sha256:${sha256(canonical(evidence))}`)
    fail("self_hash_invalid");
  return v;
}

function normalized(v) {
  return {
    ...v,
    capture: {
      ...v.capture,
      database: {
        ...v.capture.database,
        configuredIdentity: null,
        disposableIdentity: null,
        systemIdentifier: null,
      },
      custody: { ...v.capture.custody, evidenceSha256: null },
    },
  };
}

export function assertActivationCatalogCapturePair(first, second, expected) {
  const a = raw(first.value),
    b = raw(second.value);
  if (canonical(normalized(a)) !== canonical(normalized(b)))
    fail("immutable_difference");
  const pairs = [
    [a.capture.custody.evidenceSha256, b.capture.custody.evidenceSha256],
    [
      a.capture.database.configuredIdentity,
      b.capture.database.configuredIdentity,
    ],
    [
      a.capture.database.disposableIdentity,
      b.capture.database.disposableIdentity,
    ],
    [a.capture.database.systemIdentifier, b.capture.database.systemIdentifier],
  ];
  if (pairs.some(([x, y]) => x === y)) fail("required_difference_missing");
  if (expected) {
    if (
      expected.kind !==
        "reviewrouter-activation-catalog-raw-capture-evidence" ||
      expected.version !== 1 ||
      !Array.isArray(expected.captures) ||
      expected.captures.length !== 2 ||
      expected.captures[0]?.label === expected.captures[1]?.label ||
      expected.selectedCaptureId !== expected.captures[0]?.label
    )
      fail("evidence_invalid");
    const actual = [first, second].map((entry, i) => ({
      label: expected.captures[i]?.label,
      bytes: entry.bytes,
      sha256: entry.sha256,
    }));
    const captureSetMaterial = Object.fromEntries(
      Object.entries(expected).filter(
        ([key]) => !["kind", "version", "captureSetSha256"].includes(key),
      ),
    );
    if (
      canonical(actual) !== canonical(expected.captures) ||
      expected.captureSetSha256 !==
        `sha256:${sha256(canonical(captureSetMaterial))}`
    )
      fail("evidence_invalid");
    if (
      expected.capture?.baseCommit !== a.capture.custody.captureBaseCommit ||
      expected.capture?.auditedHead !== a.capture.commitSha ||
      expected.postgresImages == null ||
      typeof expected.reviewDecisionId !== "string"
    )
      fail("external_binding_invalid");
    for (const v of [a, b])
      if (
        v.capture.projection.sha256 !== expected.projectionSha256 ||
        v.capture.projection.observedDigest !== expected.liveCatalogDigest ||
        v.capture.postManifestIdentity !== expected.postManifestIdentity ||
        v.capture.database.recoveryWitnessSha256 !==
          expected.recoveryWitnessSha256
      )
        fail("external_binding_invalid");
  }
  return Object.freeze({
    selected: a,
    captures: Object.freeze([first, second]),
  });
}

export async function readAndAssertActivationCatalogCapturePair(
  paths,
  expected,
) {
  if (!Array.isArray(paths) || paths.length !== 2) fail();
  const captures = await Promise.all(
    paths.map((p, i) =>
      readBoundedActivationCatalogCapture(p, expected?.captures?.[i]),
    ),
  );
  return assertActivationCatalogCapturePair(captures[0], captures[1], expected);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await readAndAssertActivationCatalogCapturePair(process.argv.slice(2));
    process.stdout.write("activation catalog capture pair valid\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
