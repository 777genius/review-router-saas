import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  LIVE_CATALOG_PG17_IMAGE,
  sanitizeOneObservation,
  sha256Hex,
  validateLiveCatalogClaim,
} from "./live-catalog-attestation-domain.mjs";
import { verifyLiveCatalogAttestation } from "../verify-live-catalog-attestation.mjs";

const commit = "a".repeat(40);
const attestorCommit = "b".repeat(40);
const candidate = Buffer.from(
  JSON.stringify({
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 1,
    policies: { preactivation: { value: 1 }, activated: { value: 1 } },
  }),
);
const observationLine =
  `Quality Gates\tStop containers\t2026-08-26T22:49:15.6169885Z  ` +
  `2026-08-26 22:49:13.883 UTC [2032] DETAIL:  expected=sha256:${"1".repeat(64)} ` +
  `observed=sha256:${"2".repeat(64)}`;
const workflowSource = `jobs:
  release-authority-pg17-contract:
    env:
      REVIEW_ROUTER_PG17_ADVERSARIAL_IMAGE: ${LIVE_CATALOG_PG17_IMAGE}
  quality:
    services:
      postgres:
        image: ${LIVE_CATALOG_PG17_IMAGE}
`;
const projectionSource =
  `export const fencedLiveV70V73CatalogDigestSql = \`SELECT 'ok'\`;\n` +
  `export const liveV70V73CatalogDigestSha256 = "sha256:${"1".repeat(64)}";\n`;

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

function writeEvidence(directory: string) {
  mkdirSync(directory);
  writeFileSync(
    join(directory, "artifact.zip"),
    zip({
      "activation-catalog-policy-candidate-1.json": candidate,
      "activation-catalog-policy-candidate-2.json": candidate,
    }),
  );
  writeFileSync(join(directory, "quality.log"), `${observationLine}\n`);
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
    sourceBranch: "fix/pr227-r41-ci-remediation",
    sourceWorkflowPath: ".github/workflows/ci.yml",
    sourceEvent: "workflow_dispatch",
    runId: 101,
    runAttempt: 1,
    qualityJob: { id: 201, name: "Quality Gates", conclusion: "success" },
    pg17Job: {
      id: 202,
      name: "Dedicated Release Authority PG17 contract",
      conclusion: "success",
    },
    runnerEnvironment: "github-hosted",
    artifactId: 301,
    artifactName: `activation-catalog-policy-${commit}-1`,
    archiveSha256: sha256Hex(
      zip({
        "activation-catalog-policy-candidate-1.json": candidate,
        "activation-catalog-policy-candidate-2.json": candidate,
      }),
    ),
    candidateEntries: [
      ["activation-catalog-policy-candidate-1.json", candidate],
      ["activation-catalog-policy-candidate-2.json", candidate],
    ],
    qualityLogBytes: Buffer.from(`${observationLine}\n`),
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
    ["source ref", (value: any) => (value.source.ref = "refs/heads/main")],
    ["attempt", (value: any) => (value.execution.runAttempt = 2)],
    [
      "quality job",
      (value: any) => (value.execution.qualityJob.name = "quality"),
    ],
    [
      "PG17 job",
      (value: any) => (value.execution.pg17Job.conclusion = "failure"),
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
        (value.qualityLog.observation.observedDigest = `sha256:${"5".repeat(64)}`),
    ],
    [
      "projection export",
      (value: any) =>
        (value.sources.projection.export = "liveV70V73CatalogDigestSql"),
    ],
    [
      "configured digest",
      (value: any) =>
        (value.sources.projection.configuredDigest = `sha256:${"7".repeat(64)}`),
    ],
    ["image", (value: any) => (value.pg17Image = "postgres:17")],
    [
      "attestor ref",
      (value: any) => (value.attestor.ref = "refs/pull/227/merge"),
    ],
    [
      "attestor runner",
      (value: any) => (value.attestor.runner = "self-hosted"),
    ],
    ["extra field", (value: any) => (value.unexpected = true)],
  ])("rejects adversarial %s mismatch", (_name, mutate) => {
    const value = JSON.parse(JSON.stringify(claim()));
    mutate(value);
    expect(() => validateLiveCatalogClaim(value)).toThrow(/live_catalog_/u);
  });

  it("requires exactly one sanitized observation", () => {
    const duplicate = Buffer.from(`${observationLine}\n${observationLine}\n`);
    expect(() => sanitizeOneObservation(duplicate)).toThrow(
      "live_catalog_observation_count_not_one",
    );
  });

  it("rejects loose or spoofed observation and workflow image markers", () => {
    expect(() =>
      sanitizeOneObservation(
        Buffer.from(
          `arbitrary step expected=sha256:${"1".repeat(64)} observed=sha256:${"2".repeat(64)}`,
        ),
      ),
    ).toThrow("live_catalog_observation_count_not_one");
    expect(() =>
      assertSourceWorkflowPg17Image(
        Buffer.from(
          `jobs:\n  release-authority-pg17-contract:\n    # REVIEW_ROUTER_PG17_ADVERSARIAL_IMAGE: ${LIVE_CATALOG_PG17_IMAGE}\n  quality:\n    # image: ${LIVE_CATALOG_PG17_IMAGE}\n`,
        ),
      ),
    ).toThrow("live_catalog_source_workflow_pg17_image_unpinned");
  });
});

describe("offline gh attestation boundary", () => {
  it("uses exact repository, signer workflow, main ref, attestor digest, and denies self-hosted", () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    verifyWithGhAttestation(
      {
        repository: "owner/repo",
        claimPath: "claim.json",
        bundlePath: "bundle.json",
        attestorCommit,
      },
      spawn as any,
    );
    expect(spawn.mock.calls[0]![1]).toEqual([
      "attestation",
      "verify",
      "claim.json",
      "--bundle",
      "bundle.json",
      "--repo",
      "owner/repo",
      "--deny-self-hosted-runners",
      "--signer-workflow",
      "owner/repo/.github/workflows/attest-live-catalog-digest.yml",
      "--source-ref",
      "refs/heads/main",
      "--source-digest",
      attestorCommit,
    ]);
  });

  it("rejects coordinated claim and subject edits against retained raw evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-live-catalog-test-"));
    const value: any = JSON.parse(JSON.stringify(claim()));
    value.artifact.candidates.forEach(
      (entry: any) => (entry.sha256 = "6".repeat(64)),
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
        schemaVersion: "reviewrouter.live-catalog-provenance.v1.subject",
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
    expect(ghVerifier).not.toHaveBeenCalled();
  });

  it("rejects coordinated claim, subject, and raw evidence edits at the signature boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-live-catalog-test-"));
    const alteredCandidate = Buffer.from(
      JSON.stringify({
        kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
        version: 1,
        policies: { preactivation: { value: 2 }, activated: { value: 2 } },
      }),
    );
    const alteredArchive = zip({
      "activation-catalog-policy-candidate-1.json": alteredCandidate,
      "activation-catalog-policy-candidate-2.json": alteredCandidate,
    });
    const value: any = JSON.parse(JSON.stringify(claim()));
    value.artifact.archiveSha256 = sha256Hex(alteredArchive);
    value.artifact.candidates.forEach((entry: any) => {
      entry.size = alteredCandidate.length;
      entry.sha256 = sha256Hex(alteredCandidate);
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
        schemaVersion: "reviewrouter.live-catalog-provenance.v1.subject",
        claimPath: basename(claimPath),
        size: Buffer.byteLength(raw),
        sha256: sha256Hex(Buffer.from(raw)),
        fingerprint: claimFingerprint(value),
      }),
    );
    writeFileSync(bundlePath, "{}\n");
    mkdirSync(evidencePath);
    writeFileSync(join(evidencePath, "artifact.zip"), alteredArchive);
    writeFileSync(join(evidencePath, "quality.log"), `${observationLine}\n`);
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
