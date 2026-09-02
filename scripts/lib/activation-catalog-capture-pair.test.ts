import { createHash } from "node:crypto";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activationCatalogCaptureMaxBytes,
  assertActivationCatalogCapturePair,
  readBoundedActivationCatalogBytes,
  readBoundedActivationCatalogCapture,
} from "./activation-catalog-capture-pair.mjs";

const directories: string[] = [];
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const canonical = (value: any): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

function capture(identity: "a" | "b") {
  const database = {
    disposableIdentity: `rr-disposable-12345678-${identity}`,
    configuredIdentity: `configured-${identity}`,
    systemIdentifier: identity === "a" ? "123" : "456",
    recoveryWitnessSha256: "a".repeat(64),
  };
  const value: any = {
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 2,
    policies: { preactivation: { roles: [] }, activated: { roles: [] } },
    capture: {
      commitSha: "c".repeat(40),
      postManifestIdentity: `sha256:${"d".repeat(64)}`,
      database,
      projection: {
        sha256: `sha256:${"e".repeat(64)}`,
        observedDigest: `sha256:${"f".repeat(64)}`,
      },
      custody: {
        captureBaseCommit: "b".repeat(40),
        auditedHead: "c".repeat(40),
        evidenceSha256: "",
      },
    },
  };
  value.capture.custody.evidenceSha256 = `sha256:${sha256(
    canonical({
      auditedHead: value.capture.custody.auditedHead,
      captureBaseCommit: value.capture.custody.captureBaseCommit,
      commitSha: value.capture.commitSha,
      database,
      policies: value.policies,
      postManifestIdentity: value.capture.postManifestIdentity,
      projection: value.capture.projection,
    }),
  )}`;
  return value;
}

function refreshEvidence(value: any) {
  value.capture.custody.evidenceSha256 = `sha256:${sha256(
    canonical({
      auditedHead: value.capture.custody.auditedHead,
      captureBaseCommit: value.capture.custody.captureBaseCommit,
      commitSha: value.capture.commitSha,
      database: value.capture.database,
      policies: value.policies,
      postManifestIdentity: value.capture.postManifestIdentity,
      projection: value.capture.projection,
    }),
  )}`;
}

const entry = (value: any, label: string) => {
  const body = JSON.stringify(value);
  return {
    path: label,
    bytes: Buffer.byteLength(body),
    sha256: sha256(body),
    value,
  };
};

function pair() {
  return [
    entry(capture("a"), "candidate-1.json"),
    entry(capture("b"), "candidate-2.json"),
  ] as const;
}

function expectation(first: any, second: any) {
  const captures = [first, second].map((item) => ({
    label: item.path,
    bytes: item.bytes,
    sha256: item.sha256,
  }));
  const value = {
    kind: "reviewrouter-activation-catalog-raw-capture-evidence",
    version: 1,
    selectedCaptureId: captures[0].label,
    captureSetSha256: "",
    captures,
    capture: {
      baseCommit: "b".repeat(40),
      auditedHead: "c".repeat(40),
      auditedTree: "1".repeat(40),
      workflowRunId: "123",
      runAttempt: 1,
      jobId: "456",
      artifactId: "789",
      artifactName: "activation-catalog-policy-capture",
    },
    postgresImages: {
      sourcePg16: `postgres:16@sha256:${"2".repeat(64)}`,
      targetPg17: `postgres:17@sha256:${"3".repeat(64)}`,
    },
    reviewResult: "GO",
    reviewDecisionId: "RR-RAW-GO",
    projectionSha256: `sha256:${"e".repeat(64)}`,
    liveCatalogDigest: `sha256:${"f".repeat(64)}`,
    postManifestIdentity: `sha256:${"d".repeat(64)}`,
    recoveryWitnessSha256: "a".repeat(64),
  };
  const material = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !["kind", "version", "captureSetSha256"].includes(key),
    ),
  );
  value.captureSetSha256 = `sha256:${sha256(canonical(material))}`;
  return value;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("activation catalog raw capture pair", () => {
  it("accepts exactly four required raw differences and selects capture one", () => {
    const [first, second] = pair();
    expect(assertActivationCatalogCapturePair(first, second).selected).toBe(
      first.value,
    );
  });

  it("rejects a fifth difference and every missing required difference", () => {
    const [first, second] = pair();
    second.value.capture.projection.observedDigest = `sha256:${"0".repeat(64)}`;
    refreshEvidence(second.value);
    expect(() => assertActivationCatalogCapturePair(first, second)).toThrow(
      "activation_catalog_capture_pair_immutable_difference",
    );

    for (const field of [
      "configuredIdentity",
      "disposableIdentity",
      "systemIdentifier",
    ]) {
      const [left, right] = pair();
      right.value.capture.database[field] = left.value.capture.database[field];
      refreshEvidence(right.value);
      expect(() => assertActivationCatalogCapturePair(left, right)).toThrow(
        "activation_catalog_capture_pair_required_difference_missing",
      );
    }
  });

  it("rejects changed witness even with a recomputed self hash", () => {
    const [first, second] = pair();
    const expected = expectation(first, second);
    first.value.capture.database.recoveryWitnessSha256 = "9".repeat(64);
    second.value.capture.database.recoveryWitnessSha256 = "9".repeat(64);
    refreshEvidence(first.value);
    refreshEvidence(second.value);
    expect(() =>
      assertActivationCatalogCapturePair(first, second, expected),
    ).toThrow("activation_catalog_capture_pair_external_binding_invalid");
  });

  it("rejects duplicate, reordered, and capture-two selection labels", () => {
    for (const mutation of [
      (value: any) => (value.captures[1].label = value.captures[0].label),
      (value: any) => value.captures.reverse(),
      (value: any) => (value.selectedCaptureId = value.captures[1].label),
    ]) {
      const [first, second] = pair();
      const expected = expectation(first, second);
      mutation(expected);
      expect(() =>
        assertActivationCatalogCapturePair(first, second, expected),
      ).toThrow("activation_catalog_capture_pair_evidence_invalid");
    }
  });

  it("rejects oversized review bytes before reading the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rr-capture-pair-"));
    directories.push(directory);
    const path = join(directory, "oversized-review.json");
    await writeFile(path, "");
    await truncate(path, activationCatalogCaptureMaxBytes + 1);
    await expect(
      readBoundedActivationCatalogBytes(path, {
        bytes: activationCatalogCaptureMaxBytes + 1,
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow("activation_catalog_capture_pair_size_invalid");
  });

  it("rejects invalid UTF-8 before parsing capture JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rr-capture-pair-"));
    directories.push(directory);
    const path = join(directory, "invalid-utf8.json");
    await writeFile(path, Buffer.from([0xff]));
    await expect(readBoundedActivationCatalogCapture(path)).rejects.toThrow(
      "activation_catalog_capture_pair_invalid",
    );
  });

  it("hashes the same-handle bytes before parsing a pinned capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rr-capture-pair-"));
    directories.push(directory);
    const path = join(directory, "capture.json");
    const reviewed = '{"ok":true}';
    const modified = '{"ok":null}';
    expect(Buffer.byteLength(modified)).toBe(Buffer.byteLength(reviewed));
    await writeFile(path, modified);

    await expect(
      readBoundedActivationCatalogCapture(path, {
        bytes: Buffer.byteLength(reviewed),
        sha256: sha256(reviewed),
      }),
    ).rejects.toThrow("activation_catalog_capture_pair_hash_invalid");
  });
});
