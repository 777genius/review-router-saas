import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { verifyWithGhAttestation } from "./live-catalog-gh-attestation-adapter.mjs";
import {
  assembleLiveCatalogClaim,
  assertSourceWorkflowPg17Image,
  canonicalJson,
  candidateToObservedDigest,
  claimFingerprint,
  extractConfiguredCatalogDigest,
  extractProjectionBytes,
  LIVE_CATALOG_PG17_IMAGE,
  sha256Hex,
  validateLiveCatalogClaim,
} from "./live-catalog-attestation-domain.mjs";
import { verifyLiveCatalogAttestation } from "../verify-live-catalog-attestation.mjs";
import { parseVerifyArguments } from "../verify-live-catalog-attestation.mjs";
import {
  readBoundedRegularFile,
  readExactZipEntries,
} from "./github-actions-trusted-evidence.mjs";
import canonicalActivationCatalogPolicyArtifact from "../../packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js";

const commit = "a".repeat(40);
const attestorCommit = "b".repeat(40);
const candidate = Buffer.from(
  JSON.stringify({
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 1,
    policies: canonicalActivationCatalogPolicyArtifact.policies,
  }),
);
const workflowSource = readFileSync(".github/workflows/ci.yml", "utf8");
const projectionSource = readFileSync(
  "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs",
  "utf8",
);
const configuredDigest = extractConfiguredCatalogDigest(
  Buffer.from(projectionSource),
);
const captureEvidence = Buffer.from(
  canonicalJson({
    kind: "reviewrouter-live-catalog-successful-capture-evidence",
    version: 1,
    observedCatalogDigest: configuredDigest,
    projection: {
      path: "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs",
      export: "fencedLiveV70V73CatalogDigestSql",
      sqlSha256: sha256Hex(
        extractProjectionBytes(Buffer.from(projectionSource)),
      ),
    },
    inputs: [1, 2].map((number) => ({
      disposableDatabaseIdentity: `rr-disposable-1001-1-${number === 1 ? "a" : "b"}`,
      candidateName: `activation-catalog-policy-candidate-${number}.json`,
      candidateSize: candidate.length,
      candidateSha256: sha256Hex(candidate),
      receiptCatalogDigest: configuredDigest,
    })),
  }),
);

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Record<string, Buffer>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(value), 14);
    local.writeUInt32LE(value.length, 18);
    local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, value);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(value), 16);
    central.writeUInt32LE(value.length, 20);
    central.writeUInt32LE(value.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0x80000000, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + value.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function zipWithFalseSmallInflatedSize(value: Buffer) {
  const name = Buffer.from("bomb");
  const compressed = deflateRawSync(value);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(value), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(4, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(value), 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(4, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0x80000000, 38);
  const directoryOffset = local.length + name.length + compressed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

function unixSpecialZip(mode: number, host = 3) {
  const archive = zip({ special: Buffer.from("value") });
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt16LE((host << 8) | 20, central + 4);
  archive.writeUInt32LE((mode << 16) >>> 0, central + 38);
  return archive;
}

function dosSpecialZip(attribute: number) {
  const archive = zip({ special: Buffer.from("value") });
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt32LE(attribute, central + 38);
  return archive;
}

function zipWithExtraField(identifier: number, location: "central" | "local") {
  const archive = zip({ entry: Buffer.from("value") });
  const extra = Buffer.alloc(5);
  extra.writeUInt16LE(identifier, 0);
  extra.writeUInt16LE(1, 2);
  extra[4] = 1;
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const end = archive.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (location === "local") {
    const insertion = 30 + archive.readUInt16LE(26);
    const result = Buffer.concat([
      archive.subarray(0, insertion),
      extra,
      archive.subarray(insertion),
    ]);
    result.writeUInt16LE(extra.length, 28);
    result.writeUInt32LE(central + extra.length, end + extra.length + 16);
    return result;
  }
  const insertion = central + 46 + archive.readUInt16LE(central + 28);
  const result = Buffer.concat([
    archive.subarray(0, insertion),
    extra,
    archive.subarray(insertion),
  ]);
  result.writeUInt16LE(extra.length, central + 30);
  result.writeUInt32LE(
    archive.readUInt32LE(end + 12) + extra.length,
    end + extra.length + 12,
  );
  return result;
}

function writeEvidence(directory: string) {
  mkdirSync(directory);
  writeFileSync(
    join(directory, "artifact.zip"),
    zip({
      "activation-catalog-policy-candidate-1.json": candidate,
      "activation-catalog-policy-candidate-2.json": candidate,
      "live-catalog-successful-capture-evidence.json": captureEvidence,
    }),
  );
  writeFileSync(join(directory, "successful-capture.json"), captureEvidence);
  writeFileSync(join(directory, "source-ci.yml"), workflowSource);
  writeFileSync(
    join(directory, "source-live-catalog-projection.mjs"),
    projectionSource,
  );
}

function claim() {
  return assembleLiveCatalogClaim({
    repositoryId: 17,
    repositoryName: "Owner/Repo",
    sourceCommit: commit,
    sourceTree: "c".repeat(40),
    sourceRef: commit,
    sourceBranch: "main",
    sourceWorkflowPath: ".github/workflows/ci.yml",
    sourceEvent: "workflow_dispatch",
    sourceStatus: "completed",
    sourceConclusion: "success",
    runId: 1001,
    runAttempt: 1,
    producerJob: {
      id: 201,
      name: "Full private PG16 to PG17 rehearsal",
      status: "completed",
      conclusion: "success",
      runnerGroupId: 0,
      runnerGroupName: "GitHub Actions",
      runnerName: "GitHub Actions 1001",
      labels: ["ubuntu-24.04"],
    },
    runnerEnvironment: "github-hosted",
    artifactId: 301,
    artifactName: `activation-catalog-policy-${commit}-1`,
    archiveSha256: sha256Hex(
      zip({
        "activation-catalog-policy-candidate-1.json": candidate,
        "activation-catalog-policy-candidate-2.json": candidate,
        "live-catalog-successful-capture-evidence.json": captureEvidence,
      }),
    ),
    candidateEntries: [
      ["activation-catalog-policy-candidate-1.json", candidate],
      ["activation-catalog-policy-candidate-2.json", candidate],
    ],
    captureEvidenceBytes: captureEvidence,
    workflowSourceBytes: Buffer.from(workflowSource),
    projectionSourceBytes: Buffer.from(projectionSource),
    pg17Image: LIVE_CATALOG_PG17_IMAGE,
    attestorCommit,
    attestorRunId: 401,
    attestorRunAttempt: 1,
    attestorRef: "refs/heads/main",
    attestorRunner: "ubuntu-24.04",
    attestorEnvironment: "production-release",
  });
}

describe("live catalog attestation domain", () => {
  it("assembles deterministic exact tuples", () => {
    const value = claim();
    expect(value.repository.name).toBe("owner/repo");
    expect(value.source.commit).not.toBe(value.attestor.commit);
    expect(value.artifact.candidates[0]).toEqual({
      name: "activation-catalog-policy-candidate-1.json",
      size: candidate.length,
      sha256: sha256Hex(candidate),
    });
    expect(value.candidateToObservedDigest).toBe(
      candidateToObservedDigest(
        value.artifact.candidates,
        value.observedCatalogDigest,
      ),
    );
    expect(claimFingerprint(value)).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it.each([
    ["schema", (value: any) => (value.schemaVersion = "decoy")],
    ["repository", (value: any) => (value.repository.id = "0")],
    [
      "repository name",
      (value: any) => (value.repository.name = "owner/other!"),
    ],
    ["source commit", (value: any) => (value.source.commit = "bad")],
    ["source tree", (value: any) => (value.source.tree = "bad")],
    ["source ref", (value: any) => (value.source.ref = "refs/heads/main")],
    ["non-main", (value: any) => (value.source.branch = "pull/227")],
    ["run", (value: any) => (value.execution.runId = "0")],
    ["attempt", (value: any) => (value.execution.runAttempt = 2)],
    ["event", (value: any) => (value.execution.event = "push")],
    ["source status", (value: any) => (value.execution.status = "queued")],
    [
      "source conclusion",
      (value: any) => (value.execution.conclusion = "failure"),
    ],
    ["producer job ID", (value: any) => (value.execution.producerJob.id = "0")],
    [
      "producer job name",
      (value: any) => (value.execution.producerJob.name = "quality"),
    ],
    [
      "producer job status",
      (value: any) => (value.execution.producerJob.status = "in_progress"),
    ],
    [
      "producer job conclusion",
      (value: any) => (value.execution.producerJob.conclusion = "failure"),
    ],
    [
      "runner group",
      (value: any) => (value.execution.producerJob.runnerGroupId = 1),
    ],
    [
      "runner name",
      (value: any) => (value.execution.producerJob.runnerName = "self-hosted"),
    ],
    [
      "runner group name",
      (value: any) => (value.execution.producerJob.runnerGroupName = "Other"),
    ],
    [
      "runner labels",
      (value: any) => value.execution.producerJob.labels.push("self-hosted"),
    ],
    [
      "runner",
      (value: any) => (value.execution.runnerEnvironment = "self-hosted"),
    ],
    [
      "workflow",
      (value: any) =>
        (value.execution.workflowPath = ".github/workflows/evil.yml"),
    ],
    ["artifact", (value: any) => (value.artifact.id = "0")],
    ["artifact name", (value: any) => (value.artifact.name = "decoy")],
    ["archive digest", (value: any) => (value.artifact.archiveSha256 = "bad")],
    [
      "candidate name",
      (value: any) => (value.artifact.candidates[0].name = "decoy.json"),
    ],
    [
      "candidate size",
      (value: any) => (value.artifact.candidates[1].size += 1),
    ],
    [
      "candidate hash",
      (value: any) => (value.artifact.candidates[1].sha256 = "4".repeat(64)),
    ],
    [
      "observation",
      (value: any) =>
        (value.artifact.captureEvidence.observedCatalogDigest = `sha256:${"5".repeat(64)}`),
    ],
    [
      "capture evidence",
      (value: any) => (value.artifact.captureEvidence.sha256 = "bad"),
    ],
    [
      "capture evidence size",
      (value: any) => (value.artifact.captureEvidence.size = 0),
    ],
    [
      "capture projection digest",
      (value: any) =>
        (value.artifact.captureEvidence.projectionSqlSha256 = "bad"),
    ],
    [
      "capture input",
      (value: any) =>
        (value.artifact.captureEvidence.inputs[0].candidateSize += 1),
    ],
    [
      "capture input identity",
      (value: any) =>
        (value.artifact.captureEvidence.inputs[0].disposableDatabaseIdentity =
          "production"),
    ],
    [
      "capture input name",
      (value: any) =>
        (value.artifact.captureEvidence.inputs[0].candidateName = "decoy"),
    ],
    [
      "capture input digest",
      (value: any) =>
        (value.artifact.captureEvidence.inputs[0].candidateSha256 = "bad"),
    ],
    [
      "capture receipt digest",
      (value: any) =>
        (value.artifact.captureEvidence.inputs[0].receiptCatalogDigest = `sha256:${"8".repeat(64)}`),
    ],
    ["workflow source size", (value: any) => (value.sources.workflow.size = 0)],
    [
      "workflow source",
      (value: any) => (value.sources.workflow.sha256 = "bad"),
    ],
    [
      "projection path",
      (value: any) => (value.sources.projection.path = "decoy"),
    ],
    [
      "projection export",
      (value: any) =>
        (value.sources.projection.export = "liveV70V73CatalogDigestSql"),
    ],
    [
      "configured digest export",
      (value: any) =>
        (value.sources.projection.configuredDigestExport = "decoy"),
    ],
    [
      "configured digest",
      (value: any) =>
        (value.sources.projection.configuredDigest = `sha256:${"7".repeat(64)}`),
    ],
    [
      "projection source size",
      (value: any) => (value.sources.projection.sourceSize = 0),
    ],
    [
      "projection source digest",
      (value: any) => (value.sources.projection.sourceSha256 = "bad"),
    ],
    ["projection size", (value: any) => (value.sources.projection.size = 0)],
    [
      "projection digest",
      (value: any) => (value.sources.projection.sha256 = "bad"),
    ],
    ["image", (value: any) => (value.pg17Image = "postgres:17")],
    [
      "observed digest",
      (value: any) =>
        (value.observedCatalogDigest = `sha256:${"9".repeat(64)}`),
    ],
    [
      "candidate binding",
      (value: any) =>
        (value.candidateToObservedDigest = `sha256:${"a".repeat(64)}`),
    ],
    [
      "attestor workflow",
      (value: any) =>
        (value.attestor.workflowPath = ".github/workflows/evil.yml"),
    ],
    [
      "attestor ref",
      (value: any) => (value.attestor.ref = "refs/pull/227/merge"),
    ],
    ["attestor commit", (value: any) => (value.attestor.commit = "bad")],
    ["attestor run", (value: any) => (value.attestor.runId = "0")],
    ["attestor attempt", (value: any) => (value.attestor.runAttempt = 2)],
    [
      "attestor runner",
      (value: any) => (value.attestor.runner = "self-hosted"),
    ],
    [
      "attestor environment",
      (value: any) => (value.attestor.environment = "unreviewed"),
    ],
    ["extra field", (value: any) => (value.unexpected = true)],
  ])("rejects adversarial %s mismatch", (_name, mutate) => {
    const value = JSON.parse(JSON.stringify(claim()));
    mutate(value);
    expect(() => validateLiveCatalogClaim(value)).toThrow(/live_catalog_/u);
  });

  it("rejects spoofed workflow producer markers", () => {
    expect(() =>
      assertSourceWorkflowPg17Image(
        Buffer.from(
          `jobs:\n  release-authority-pg17-contract:\n    # REVIEW_ROUTER_PG17_ADVERSARIAL_IMAGE: ${LIVE_CATALOG_PG17_IMAGE}\n  quality:\n    # image: ${LIVE_CATALOG_PG17_IMAGE}\n`,
        ),
      ),
    ).toThrow(/live_catalog_source_workflow_/u);
  });

  it.each([
    [
      "comment",
      `// export const fencedLiveV70V73CatalogDigestSql = \`SELECT 'ok'\`;`,
    ],
    [
      "computed",
      `export const fencedLiveV70V73CatalogDigestSql = String.raw\`SELECT 'ok'\`;`,
    ],
    [
      "duplicate",
      `${projectionSource}export const fencedLiveV70V73CatalogDigestSql = \`decoy\`;`,
    ],
    [
      "interpolation",
      `export const fencedLiveV70V73CatalogDigestSql = \`SELECT \${value}\`;`,
    ],
    [
      "export alias",
      `${projectionSource}\nconst decoy = 1; export { decoy as fencedLiveV70V73CatalogDigestSql };`,
    ],
    [
      "exported function",
      `${projectionSource}\nexport function fencedLiveV70V73CatalogDigestSql() {}`,
    ],
    [
      "exported class",
      `${projectionSource}\nexport class fencedLiveV70V73CatalogDigestSql {}`,
    ],
    [
      "exported namespace",
      `${projectionSource}\nexport namespace fencedLiveV70V73CatalogDigestSql {}`,
    ],
    [
      "exported enum",
      `${projectionSource}\nexport enum fencedLiveV70V73CatalogDigestSql { decoy }`,
    ],
    [
      "mutable variable",
      `${projectionSource}\nexport let fencedLiveV70V73CatalogDigestSql;`,
    ],
    [
      "default export",
      `${projectionSource}\nexport default fencedLiveV70V73CatalogDigestSql;`,
    ],
    [
      "default alias",
      `${projectionSource}\nexport { fencedLiveV70V73CatalogDigestSql as default };`,
    ],
    [
      "re-export",
      `${projectionSource}\nexport { decoy as fencedLiveV70V73CatalogDigestSql } from "./decoy.mjs";`,
    ],
    [
      "namespace re-export",
      `${projectionSource}\nexport * as fencedLiveV70V73CatalogDigestSql from "./decoy.mjs";`,
    ],
    ["star re-export", `${projectionSource}\nexport * from "./decoy.mjs";`],
    [
      "default function export",
      `${projectionSource}\nexport default function fencedLiveV70V73CatalogDigestSql() {}`,
    ],
  ])("rejects %s JavaScript export decoys", (_name, source) => {
    expect(() => extractProjectionBytes(Buffer.from(source))).toThrow(
      /live_catalog_/u,
    );
  });

  it.each([
    [
      "comment",
      `// export const liveV70V73CatalogDigestSha256 = "sha256:${"1".repeat(64)}";`,
    ],
    [
      "computed",
      `export const liveV70V73CatalogDigestSha256 = "sha256:" + "${"1".repeat(64)}";`,
    ],
    [
      "duplicate",
      `${projectionSource}export const liveV70V73CatalogDigestSha256 = "sha256:${"1".repeat(64)}";`,
    ],
    [
      "template",
      `export const liveV70V73CatalogDigestSha256 = \`sha256:${"1".repeat(64)}\`;`,
    ],
  ])("rejects %s configured-digest decoys", (_name, source) => {
    expect(() => extractConfiguredCatalogDigest(Buffer.from(source))).toThrow(
      /live_catalog_/u,
    );
  });

  it.each([
    [
      "comment",
      workflowSource.replace(
        "node --import tsx scripts/package-live-catalog-capture-evidence.mjs",
        "# node --import tsx scripts/package-live-catalog-capture-evidence.mjs",
      ),
    ],
    [
      "block scalar",
      workflowSource.replace(
        "    name: Full private PG16 to PG17 rehearsal",
        "    name: |-\n      Full private PG16 to PG17 rehearsal",
      ),
    ],
    [
      "duplicate job",
      workflowSource.replace(
        "      - name: Upload activation catalog policy captures",
        "      - name: Upload activation catalog policy captures\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: activation-catalog-policy-${{ github.sha }}-${{ github.run_attempt }}\n          path: decoy\n      - name: Upload activation catalog policy captures",
      ),
    ],
    [
      "duplicate producer name",
      workflowSource.replace(
        "jobs:\n",
        "jobs:\n  decoy:\n    name: Full private PG16 to PG17 rehearsal\n    runs-on: ubuntu-24.04\n    steps: []\n",
      ),
    ],
    [
      "capture continue-on-error",
      workflowSource.replace(
        "        if: ${{ inputs.activation_catalog_policy_capture }}\n        env:",
        "        if: ${{ inputs.activation_catalog_policy_capture }}\n        continue-on-error: false\n        env:",
      ),
    ],
    [
      "upload run decoy",
      workflowSource.replace(
        "      - name: Upload activation catalog policy captures\n        if: ${{ inputs.activation_catalog_policy_capture }}\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n",
        "      - name: Upload activation catalog policy captures\n        if: ${{ inputs.activation_catalog_policy_capture }}\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        run: echo decoy\n",
      ),
    ],
    [
      "wrong job name",
      workflowSource.replace(
        "Full private PG16 to PG17 rehearsal",
        "Decoy producer",
      ),
    ],
    [
      "computed runs-on",
      workflowSource.replace(
        "runs-on: ubuntu-24.04",
        "runs-on: ${{ matrix.runner }}",
      ),
    ],
    [
      "workflow defaults",
      workflowSource.replace(
        "permissions:\n",
        "defaults:\n  run:\n    shell: bash\n\npermissions:\n",
      ),
    ],
    [
      "workflow permission wrapper",
      workflowSource.replace(
        "permissions:\n  contents: read",
        "permissions:\n  contents: write",
      ),
    ],
    [
      "workflow BASH_ENV",
      workflowSource.replace("env:\n", "env:\n  BASH_ENV: ./decoy.sh\n"),
    ],
    [
      "workflow NODE_OPTIONS",
      workflowSource.replace(
        "env:\n",
        "env:\n  NODE_OPTIONS: --import=./decoy.mjs\n",
      ),
    ],
    [
      "workflow PATH",
      workflowSource.replace("env:\n", "env:\n  PATH: ./decoy-bin\n"),
    ],
    [
      "job defaults",
      workflowSource.replace(
        "    timeout-minutes: 30\n    steps:",
        "    timeout-minutes: 30\n    defaults:\n      run:\n        shell: bash\n    steps:",
      ),
    ],
    [
      "job container",
      workflowSource.replace(
        "    timeout-minutes: 30\n    steps:",
        "    timeout-minutes: 30\n    container: node:24\n    steps:",
      ),
    ],
    [
      "job permissions",
      workflowSource.replace(
        "    timeout-minutes: 30\n    steps:",
        "    timeout-minutes: 30\n    permissions:\n      contents: write\n    steps:",
      ),
    ],
    [
      "capture shell wrapper",
      workflowSource.replace(
        "        run: |\n          export REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY=",
        "        shell: ./decoy-shell\n        run: |\n          export REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY=",
      ),
    ],
    [
      "capture BASH_ENV",
      workflowSource.replace(
        '          REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL: "1"\n          REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY:',
        '          BASH_ENV: ./decoy.sh\n          REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL: "1"\n          REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY:',
      ),
    ],
    [
      "upload environment wrapper",
      workflowSource.replace(
        "      - name: Upload activation catalog policy captures\n        if:",
        "      - name: Upload activation catalog policy captures\n        env:\n          NODE_OPTIONS: --import=./decoy.mjs\n        if:",
      ),
    ],
    [
      "folded capture scalar",
      workflowSource.replace(
        "        run: |\n          export REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY=",
        "        run: >\n          export REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY=",
      ),
    ],
    [
      "producer env wrapper",
      workflowSource.replace(
        "    timeout-minutes: 30\n    steps:",
        "    timeout-minutes: 30\n    env:\n      BASH_ENV: ./wrapper.sh\n    steps:",
      ),
    ],
    [
      "capture shell",
      workflowSource.replace(
        "      - name: Capture two reproducible activation catalog policies\n        if:",
        "      - name: Capture two reproducible activation catalog policies\n        shell: python\n        if:",
      ),
    ],
    [
      "capture PATH",
      workflowSource.replace(
        '          REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL: "1"\n          REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY:',
        '          REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL: "1"\n          PATH: ./bin\n          REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY:',
      ),
    ],
    [
      "quoted capture condition",
      workflowSource.replace(
        "        if: ${{ inputs.activation_catalog_policy_capture }}",
        '        if: "${{ inputs.activation_catalog_policy_capture }}"',
      ),
    ],
  ])("rejects %s YAML semantic decoys", (_name, source) => {
    expect(() => assertSourceWorkflowPg17Image(Buffer.from(source))).toThrow(
      /live_catalog_/u,
    );
  });
});

describe("bounded offline files", () => {
  it.each(["symlink", "hardlink", "fifo", "directory"])(
    "rejects %s input",
    (kind) => {
      const directory = mkdtempSync(join(tmpdir(), "rr-bounded-file-"));
      const source = join(directory, "source");
      const target = join(directory, "target");
      writeFileSync(source, "safe");
      if (kind === "symlink") symlinkSync(source, target);
      if (kind === "hardlink") linkSync(source, target);
      if (kind === "fifo") execFileSync("/usr/bin/mkfifo", [target]);
      if (kind === "directory") mkdirSync(target);
      expect(() => readBoundedRegularFile(target, 16, "test")).toThrow(
        /live_catalog_test_file_/u,
      );
    },
  );

  it("deterministically rejects replacement between identity check and open", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-bounded-race-"));
    const target = join(directory, "target");
    const replacement = join(directory, "replacement");
    writeFileSync(target, "claim-a");
    writeFileSync(replacement, "claim-b");
    expect(() =>
      readBoundedRegularFile(target, 32, "race", {
        afterLstat: () => renameSync(replacement, target),
      }),
    ).toThrow(/live_catalog_race_file_/u);
  });

  it("enforces per-entry zlib output and aggregate ZIP limits", () => {
    expect(() =>
      readExactZipEntries(zip({ one: Buffer.alloc(4) }), {
        maximumArchiveBytes: 8,
      }),
    ).toThrow("trusted evidence ZIP archive is too large");
    expect(() =>
      readExactZipEntries(zipWithFalseSmallInflatedSize(Buffer.alloc(64)), {
        maximumEntryBytes: 16,
        maximumTotalBytes: 32,
      }),
    ).toThrow();
    expect(() =>
      readExactZipEntries(zip({ one: Buffer.alloc(4), two: Buffer.alloc(4) }), {
        maximumEntryBytes: 4,
        maximumTotalBytes: 7,
      }),
    ).toThrow("trusted evidence ZIP uncompressed total is too large");
    expect(() =>
      readExactZipEntries(zip({ one: Buffer.alloc(5) }), {
        maximumCompressedEntryBytes: 4,
      }),
    ).toThrow("trusted evidence ZIP entry is unsafe or unsupported");
    expect(() =>
      readExactZipEntries(zip({ one: Buffer.alloc(4), two: Buffer.alloc(4) }), {
        maximumCompressedEntryBytes: 4,
        maximumTotalCompressedBytes: 7,
      }),
    ).toThrow("trusted evidence ZIP compressed total is too large");
  });

  it.each([
    ["symlink", 0xa000],
    ["fifo", 0x1000],
    ["socket", 0xc000],
    ["character device", 0x2000],
    ["block device", 0x6000],
  ])("rejects a Unix %s ZIP entry", (_name, mode) => {
    expect(() => readExactZipEntries(unixSpecialZip(mode))).toThrow(
      "trusted evidence ZIP entry is unsafe or unsupported",
    );
  });

  it.each([
    ["missing regular-file type", 0, 0],
    ["DOS-host symlink", 0xa000, 0],
    ["NTFS-host socket", 0xc000, 10],
  ])("rejects a %s entry regardless of host marker", (_name, mode, host) => {
    expect(() => readExactZipEntries(unixSpecialZip(mode, host))).toThrow(
      "trusted evidence ZIP entry is unsafe or unsupported",
    );
  });

  it.each([
    ["volume", 0x08],
    ["directory", 0x10],
    ["device", 0x40],
  ])("rejects a DOS %s attribute", (_name, attribute) => {
    expect(() => readExactZipEntries(dosSpecialZip(attribute))).toThrow(
      "trusted evidence ZIP entry is unsafe or unsupported",
    );
  });

  it.each([
    ["central PKWARE Unix", 0x000d, "central"],
    ["local PKWARE Unix", 0x000d, "local"],
    ["central ASi Unix", 0x756e, "central"],
    ["local ASi Unix", 0x756e, "local"],
  ] as const)("rejects %s link metadata", (_name, identifier, location) => {
    expect(() =>
      readExactZipEntries(zipWithExtraField(identifier, location)),
    ).toThrow("trusted evidence ZIP entry is unsafe or unsupported");
  });

  it("enforces the archive cap before parsing or copying input bytes", () => {
    expect(() =>
      readExactZipEntries(zip({ entry: Buffer.alloc(8) }), {
        maximumArchiveBytes: 16,
      }),
    ).toThrow("trusted evidence ZIP archive is too large");
  });
});

describe("offline gh attestation boundary", () => {
  const ghOutput = (bytes: Buffer, bundle: unknown = {}) =>
    JSON.stringify([
      {
        attestation: bundle,
        verificationResult: {
          statement: { subject: [{ digest: { sha256: sha256Hex(bytes) } }] },
        },
      },
    ]);

  it("uses exact repository, signer workflow, main ref, attestor digest, and denies self-hosted", () => {
    const claimBytes = Buffer.from("claim");
    const spawn = vi.fn(() => ({ status: 0, stdout: ghOutput(claimBytes) }));
    verifyWithGhAttestation(
      {
        repository: "owner/repo",
        claimBytes,
        bundleBytes: Buffer.from("{}"),
        attestorCommit,
      },
      spawn as any,
    );
    expect(spawn.mock.calls[0]![1]).toEqual([
      "attestation",
      "verify",
      expect.stringMatching(/\/claim\.json$/u),
      "--bundle",
      expect.stringMatching(/\/bundle\.json$/u),
      "--repo",
      "owner/repo",
      "--deny-self-hosted-runners",
      "--signer-workflow",
      "owner/repo/.github/workflows/attest-live-catalog-digest.yml",
      "--source-ref",
      "refs/heads/main",
      "--source-digest",
      attestorCommit,
      "--format",
      "json",
    ]);
  });

  it("gives gh private snapshots even when the original paths are replaced", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-gh-race-"));
    const originalClaim = join(directory, "claim.json");
    const originalBundle = join(directory, "bundle.json");
    const claimBytes = Buffer.from("claim-a");
    const bundleBytes = Buffer.from('{"bundle":"a"}');
    writeFileSync(originalClaim, claimBytes);
    writeFileSync(originalBundle, bundleBytes);
    const spawn = vi.fn((_command: string, args: string[]) => {
      writeFileSync(originalClaim, "claim-b");
      writeFileSync(originalBundle, '{"bundle":"b"}');
      expect(readFileSync(args[2]!)).toEqual(claimBytes);
      expect(readFileSync(args[4]!)).toEqual(bundleBytes);
      expect(args[2]).not.toBe(originalClaim);
      expect(args[4]).not.toBe(originalBundle);
      return {
        status: 0,
        stdout: ghOutput(claimBytes, { bundle: "a" }),
      };
    });
    verifyWithGhAttestation(
      { repository: "owner/repo", claimBytes, bundleBytes, attestorCommit },
      spawn as any,
    );
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("fails closed when the exact temporary path gh receives is replaced", () => {
    const claimBytes = Buffer.from("claim-a");
    const bundleBytes = Buffer.from('{"bundle":"a"}');
    expect(() =>
      verifyWithGhAttestation(
        { repository: "owner/repo", claimBytes, bundleBytes, attestorCommit },
        ((_command: string, args: string[]) => {
          const replacement = Buffer.from("claim-b");
          writeFileSync(args[2]!, replacement);
          writeFileSync(args[4]!, '{"bundle":"b"}');
          return {
            status: 0,
            stdout: ghOutput(replacement, { bundle: "b" }),
          };
        }) as any,
      ),
    ).toThrow("live_catalog_gh_authenticated_subject_mismatch");
  });

  it("enforces the complete policy tuple through a deterministic real fake-gh process", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-fake-gh-"));
    const executable = join(directory, "gh");
    writeFileSync(
      executable,
      `#!${process.execPath}\n` +
        `const fs=require("node:fs"),crypto=require("node:crypto");\n` +
        `const a=process.argv.slice(2),one=(f)=>a.filter((v)=>v===f).length===1,at=(f)=>a[a.indexOf(f)+1];\n` +
        `if(a[0]!=="attestation"||a[1]!=="verify"||!one("--bundle")||!one("--repo")||!one("--deny-self-hosted-runners")||!one("--signer-workflow")||!one("--source-ref")||!one("--source-digest")||!one("--format"))process.exit(2);\n` +
        `if(at("--repo")!=="owner/repo"||at("--signer-workflow")!=="owner/repo/.github/workflows/attest-live-catalog-digest.yml"||at("--source-ref")!=="refs/heads/main"||at("--source-digest")!=="${attestorCommit}"||at("--format")!=="json")process.exit(3);\n` +
        `const claim=a[2],bundle=at("--bundle");\n` +
        `let b;try{b=JSON.parse(fs.readFileSync(bundle,"utf8"))}catch{process.exit(3)}\n` +
        `if(b.valid!==true)process.exit(4);\n` +
        `const digest=crypto.createHash("sha256").update(fs.readFileSync(claim)).digest("hex");\n` +
        `process.stdout.write(JSON.stringify([{attestation:b,verificationResult:{statement:{subject:[{digest:{sha256:digest}}]}}}]));\n`,
      { mode: 0o700 },
    );
    chmodSync(executable, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    try {
      expect(() =>
        verifyWithGhAttestation({
          repository: "owner/repo",
          claimBytes: Buffer.from("claim-a"),
          bundleBytes: Buffer.from('{"valid":true}'),
          attestorCommit,
        }),
      ).not.toThrow();
      expect(() =>
        verifyWithGhAttestation({
          repository: "owner/repo",
          claimBytes: Buffer.from("claim-a"),
          bundleBytes: Buffer.from('{"valid":false}'),
          attestorCommit,
        }),
      ).toThrow("live_catalog_gh_attestation_invalid");
      for (const input of [
        { repository: "owner/other", attestorCommit },
        { repository: "owner/repo", attestorCommit: "c".repeat(40) },
      ])
        expect(() =>
          verifyWithGhAttestation({
            ...input,
            claimBytes: Buffer.from("claim-a"),
            bundleBytes: Buffer.from('{"valid":true}'),
          }),
        ).toThrow("live_catalog_gh_attestation_invalid");

      const replaceValue =
        (flag: string, value: string) => (args: string[]) => {
          const result = [...args];
          result[result.indexOf(flag) + 1] = value;
          return result;
        };
      const removePair = (flag: string) => (args: string[]) => {
        const result = [...args];
        result.splice(result.indexOf(flag), 2);
        return result;
      };
      const mutations = [
        replaceValue("--repo", "owner/other"),
        removePair("--repo"),
        replaceValue(
          "--signer-workflow",
          "owner/repo/.github/workflows/evil.yml",
        ),
        removePair("--signer-workflow"),
        replaceValue("--source-ref", "refs/pull/227/merge"),
        removePair("--source-ref"),
        replaceValue("--source-digest", "c".repeat(40)),
        removePair("--source-digest"),
        (args: string[]) =>
          args.map((value) =>
            value === "--deny-self-hosted-runners"
              ? "--allow-self-hosted-runners"
              : value,
          ),
        (args: string[]) =>
          args.filter((value) => value !== "--deny-self-hosted-runners"),
      ];
      for (const mutate of mutations) {
        const spawnThroughRealProcess = (
          command: string,
          args: string[],
          options: Parameters<typeof spawnSync>[2],
        ) => spawnSync(command, mutate(args), options);
        expect(() =>
          verifyWithGhAttestation(
            {
              repository: "owner/repo",
              claimBytes: Buffer.from("claim-a"),
              bundleBytes: Buffer.from('{"valid":true}'),
              attestorCommit,
            },
            spawnThroughRealProcess as never,
          ),
        ).toThrow("live_catalog_gh_attestation_invalid");
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("cleans private snapshots in finally when gh fails", () => {
    let snapshotPath = "";
    expect(() =>
      verifyWithGhAttestation(
        {
          repository: "owner/repo",
          claimBytes: Buffer.from("claim"),
          bundleBytes: Buffer.from("{}"),
          attestorCommit,
        },
        ((_command: string, args: string[]) => {
          snapshotPath = args[2]!;
          throw new Error("spawn failed");
        }) as any,
      ),
    ).toThrow("spawn failed");
    expect(snapshotPath).not.toBe("");
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("rejects coordinated claim and subject edits against retained raw evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-live-catalog-test-"));
    const value: any = JSON.parse(JSON.stringify(claim()));
    value.artifact.candidates.forEach(
      (entry: any) => (entry.sha256 = "6".repeat(64)),
    );
    value.artifact.captureEvidence.inputs.forEach(
      (entry: any) => (entry.candidateSha256 = "6".repeat(64)),
    );
    value.candidateToObservedDigest = candidateToObservedDigest(
      value.artifact.candidates,
      value.observedCatalogDigest,
    );
    const claimPath = join(directory, "live-catalog-provenance.claim.json");
    const subjectPath = join(directory, "live-catalog-provenance.subject.json");
    const bundlePath = join(directory, "live-catalog-provenance.bundle.json");
    const evidencePath = join(directory, "live-catalog-provenance.evidence");
    const raw = canonicalJson(value);
    writeFileSync(claimPath, raw);
    writeFileSync(
      subjectPath,
      canonicalJson({
        schemaVersion: "reviewrouter.live-catalog-provenance.v2.subject",
        claimPath: basename(claimPath),
        size: Buffer.byteLength(raw),
        sha256: sha256Hex(Buffer.from(raw)),
        fingerprint: claimFingerprint(value),
      }),
    );
    writeFileSync(bundlePath, "{}\n");
    writeEvidence(evidencePath);
    const ghVerifier = vi.fn();
    expect(() =>
      verifyLiveCatalogAttestation(
        {
          repository: "owner/repo",
          claimPath,
          subjectPath,
          bundlePath,
          evidencePath,
          attestorCommit,
        },
        ghVerifier,
      ),
    ).toThrow("live_catalog_offline_evidence_tuple_mismatch");
    expect(ghVerifier).toHaveBeenCalledOnce();
  });

  it("rejects coordinated claim, subject, and raw evidence edits at the signature boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-live-catalog-test-"));
    const alteredCandidate = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
        policies: canonicalActivationCatalogPolicyArtifact.policies,
      }),
    );
    const alteredCaptureEvidence = Buffer.from(
      captureEvidence
        .toString("utf8")
        .replaceAll(String(candidate.length), String(alteredCandidate.length))
        .replaceAll(sha256Hex(candidate), sha256Hex(alteredCandidate)),
    );
    const alteredArchive = zip({
      "activation-catalog-policy-candidate-1.json": alteredCandidate,
      "activation-catalog-policy-candidate-2.json": alteredCandidate,
      "live-catalog-successful-capture-evidence.json": alteredCaptureEvidence,
    });
    const value: any = JSON.parse(JSON.stringify(claim()));
    value.artifact.archiveSha256 = sha256Hex(alteredArchive);
    value.artifact.candidates.forEach((entry: any) => {
      entry.size = alteredCandidate.length;
      entry.sha256 = sha256Hex(alteredCandidate);
    });
    value.artifact.captureEvidence.size = alteredCaptureEvidence.length;
    value.artifact.captureEvidence.sha256 = sha256Hex(alteredCaptureEvidence);
    value.artifact.captureEvidence.inputs.forEach((entry: any) => {
      entry.candidateSize = alteredCandidate.length;
      entry.candidateSha256 = sha256Hex(alteredCandidate);
    });
    value.candidateToObservedDigest = candidateToObservedDigest(
      value.artifact.candidates,
      value.observedCatalogDigest,
    );
    const claimPath = join(directory, "live-catalog-provenance.claim.json");
    const subjectPath = join(directory, "live-catalog-provenance.subject.json");
    const bundlePath = join(directory, "live-catalog-provenance.bundle.json");
    const evidencePath = join(directory, "live-catalog-provenance.evidence");
    const raw = canonicalJson(value);
    writeFileSync(claimPath, raw);
    writeFileSync(
      subjectPath,
      canonicalJson({
        schemaVersion: "reviewrouter.live-catalog-provenance.v2.subject",
        claimPath: basename(claimPath),
        size: Buffer.byteLength(raw),
        sha256: sha256Hex(Buffer.from(raw)),
        fingerprint: claimFingerprint(value),
      }),
    );
    writeFileSync(bundlePath, "{}\n");
    mkdirSync(evidencePath);
    writeFileSync(join(evidencePath, "artifact.zip"), alteredArchive);
    writeFileSync(
      join(evidencePath, "successful-capture.json"),
      alteredCaptureEvidence,
    );
    writeFileSync(join(evidencePath, "source-ci.yml"), workflowSource);
    writeFileSync(
      join(evidencePath, "source-live-catalog-projection.mjs"),
      projectionSource,
    );
    expect(() =>
      verifyLiveCatalogAttestation(
        {
          repository: "owner/repo",
          claimPath,
          subjectPath,
          bundlePath,
          evidencePath,
          attestorCommit,
        },
        () => {
          throw new Error("live_catalog_gh_attestation_invalid");
        },
      ),
    ).toThrow("live_catalog_gh_attestation_invalid");
  });
});

describe("verify CLI contract", () => {
  const argv = [
    "--repository",
    "owner/repo",
    "--claim",
    "claim.json",
    "--subject",
    "subject.json",
    "--bundle",
    "bundle.json",
    "--evidence",
    "evidence",
    "--attestor-digest",
    attestorCommit,
  ];
  it("accepts the exact argument tuple", () => {
    expect(parseVerifyArguments(argv)).toHaveProperty(
      "repository",
      "owner/repo",
    );
  });
  it.each([
    ["missing", argv.slice(0, -2)],
    ["duplicate", [...argv, "--claim", "other"]],
    ["unknown", [...argv, "--extra", "value"]],
    ["odd", [...argv, "--claim"]],
  ])("rejects %s arguments", (_name, value) => {
    expect(() => parseVerifyArguments(value)).toThrow(
      "live_catalog_verify_usage",
    );
  });
});
