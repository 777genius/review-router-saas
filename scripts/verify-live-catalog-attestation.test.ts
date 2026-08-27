import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import canonicalArtifact from "../packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js";
import { gitBlobSha } from "./lib/github-actions-trusted-evidence.mjs";
import {
  assembleLiveCatalogClaim,
  canonicalJson,
  claimFingerprint,
  extractConfiguredCatalogDigest,
  extractProjectionBytes,
  LIVE_CATALOG_CLAIM_SCHEMA,
  LIVE_CATALOG_CONTRACT_PATH,
  LIVE_CATALOG_PG17_IMAGE,
  LIVE_CATALOG_PROJECTION_PATH,
  LIVE_CATALOG_SOURCE_WORKFLOW,
  sha256Hex,
} from "./lib/live-catalog-attestation-domain.mjs";
import {
  parseVerifyArguments,
  trustedCurrentMainFromArguments,
  verifyLiveCatalogAttestation,
} from "./verify-live-catalog-attestation.mjs";

const commit = "a".repeat(40);
const tree = "b".repeat(40);
const workflow = readFileSync(LIVE_CATALOG_SOURCE_WORKFLOW);
const contract = readFileSync(LIVE_CATALOG_CONTRACT_PATH);
const projection = readFileSync(LIVE_CATALOG_PROJECTION_PATH);
const configuredDigest = extractConfiguredCatalogDigest(projection);
const candidate = Buffer.from(
  JSON.stringify({
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 1,
    policies: canonicalArtifact.policies,
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

function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "rr-offline-verifier-"));
  const evidencePath = join(directory, "evidence");
  mkdirSync(evidencePath);
  const capture = Buffer.from(
    canonicalJson({
      kind: "reviewrouter-live-catalog-successful-capture-evidence",
      version: 1,
      observedCatalogDigest: configuredDigest,
      projection: {
        path: LIVE_CATALOG_PROJECTION_PATH,
        export: "fencedLiveV70V73CatalogDigestSql",
        sqlSha256: sha256Hex(extractProjectionBytes(projection)),
      },
      inputs: ["a", "b"].map((suffix, index) => ({
        disposableDatabaseIdentity: `rr-disposable-1001-1-${suffix}`,
        candidateName: `activation-catalog-policy-candidate-${index + 1}.json`,
        candidateSize: candidate.length,
        candidateSha256: sha256Hex(candidate),
        receiptCatalogDigest: configuredDigest,
      })),
    }),
  );
  const archive = zip({
    "activation-catalog-policy-candidate-1.json": candidate,
    "activation-catalog-policy-candidate-2.json": candidate,
    "live-catalog-successful-capture-evidence.json": capture,
  });
  const bundle = Buffer.from('{"valid":true}');
  const closureFiles = [
    [LIVE_CATALOG_SOURCE_WORKFLOW, workflow],
    [LIVE_CATALOG_CONTRACT_PATH, contract],
    [LIVE_CATALOG_PROJECTION_PATH, projection],
    ["package.json", readFileSync("package.json")],
  ].map(([path, bytes]) => ({
    path: path as string,
    bytes: bytes as Buffer,
    size: (bytes as Buffer).length,
    sha256: sha256Hex(bytes as Buffer),
    gitBlobSha: gitBlobSha(bytes as Buffer),
  }));
  const claim = assembleLiveCatalogClaim({
    repositoryId: 17,
    repositoryName: "owner/repo",
    sourceCommit: commit,
    sourceTree: tree,
    sourceRef: commit,
    sourceBranch: "main",
    sourceWorkflowPath: LIVE_CATALOG_SOURCE_WORKFLOW,
    sourceEvent: "workflow_dispatch",
    sourceStatus: "completed",
    sourceConclusion: "success",
    runId: 1001,
    runAttempt: 1,
    producerJob: {
      id: 203,
      name: "Capture live catalog producer",
      status: "completed",
      conclusion: "success",
      runnerGroupId: 0,
      runnerGroupName: "GitHub Actions",
      runnerName: "GitHub Actions 3",
      labels: ["ubuntu-24.04"],
    },
    runnerEnvironment: "github-hosted",
    artifactId: 301,
    artifactName: `activation-catalog-policy-${commit}-1`,
    artifactRestDigest: `sha256:${sha256Hex(archive)}`,
    archiveSha256: sha256Hex(archive),
    candidateEntries: [
      ["activation-catalog-policy-candidate-1.json", candidate],
      ["activation-catalog-policy-candidate-2.json", candidate],
    ],
    captureEvidenceBytes: capture,
    workflowSourceBytes: workflow,
    projectionSourceBytes: projection,
    contractSourceBytes: contract,
    sourceClosureFiles: closureFiles,
    producerCertificate: {
      repository: "owner/repo",
      signerWorkflow: `owner/repo/${LIVE_CATALOG_SOURCE_WORKFLOW}`,
      signerDigest: commit,
      sourceRef: "refs/heads/main",
      sourceDigest: commit,
      runnerEnvironment: "github-hosted",
      runInvocationURI:
        "https://github.com/owner/repo/actions/runs/1001/attempts/1",
    },
    producerSubject: {
      name: `activation-catalog-policy-${commit}-1`,
      digest: `sha256:${sha256Hex(archive)}`,
    },
    producerBundleBytes: bundle,
    pg17Image: LIVE_CATALOG_PG17_IMAGE,
    attestorCommit: commit,
    attestorRunId: 401,
    attestorRunAttempt: 1,
    attestorRef: "refs/heads/main",
    attestorRunner: "ubuntu-24.04",
    attestorEnvironment: "production-release",
  } as any);
  const claimBytes = Buffer.from(canonicalJson(claim));
  const claimPath = join(directory, "claim.json");
  const subjectPath = join(directory, "subject.json");
  const bundlePath = join(directory, "bundle.json");
  writeFileSync(claimPath, claimBytes);
  writeFileSync(
    subjectPath,
    canonicalJson({
      schemaVersion: `${LIVE_CATALOG_CLAIM_SCHEMA}.subject`,
      claimPath: basename(claimPath),
      size: claimBytes.length,
      sha256: sha256Hex(claimBytes),
      fingerprint: claimFingerprint(claim),
    }),
  );
  writeFileSync(bundlePath, bundle);
  writeFileSync(join(evidencePath, "artifact.zip"), archive);
  writeFileSync(join(evidencePath, "successful-capture.json"), capture);
  writeFileSync(join(evidencePath, "producer.bundle.json"), bundle);
  writeFileSync(
    join(evidencePath, "source-closure.json"),
    canonicalJson({
      schemaVersion: "reviewrouter.live-catalog.source-closure-evidence.v1",
      files: closureFiles.map(({ path, size, sha256, gitBlobSha, bytes }) => ({
        path,
        gitBlobSha,
        size,
        sha256,
        contentBase64: bytes.toString("base64"),
      })),
    }),
  );
  return {
    directory,
    evidencePath,
    claimPath,
    subjectPath,
    bundlePath,
    claim,
    claimBytes,
  };
}

const argumentsFor = (fixture: ReturnType<typeof makeFixture>) => [
  "--repository",
  "owner/repo",
  "--claim",
  fixture.claimPath,
  "--subject",
  fixture.subjectPath,
  "--bundle",
  fixture.bundlePath,
  "--evidence",
  fixture.evidencePath,
  "--trusted-current-main",
  commit,
];

describe("offline verifier executable and trust boundary", () => {
  it("requires exactly one separately trusted current-main value or file", () => {
    const fixture = makeFixture();
    const parsed = parseVerifyArguments(argumentsFor(fixture));
    expect(trustedCurrentMainFromArguments(parsed)).toBe(commit);
    const trustedFile = join(fixture.directory, "trusted-main");
    writeFileSync(trustedFile, `${commit}\n`);
    const fileArgs = argumentsFor(fixture)
      .slice(0, -2)
      .concat(["--trusted-current-main-file", trustedFile]);
    expect(
      trustedCurrentMainFromArguments(parseVerifyArguments(fileArgs)),
    ).toBe(commit);
    expect(() =>
      parseVerifyArguments(argumentsFor(fixture).slice(0, -2)),
    ).toThrow("live_catalog_verify_usage");
    expect(() =>
      parseVerifyArguments(
        argumentsFor(fixture).concat([
          "--trusted-current-main-file",
          trustedFile,
        ]),
      ),
    ).toThrow("live_catalog_verify_usage");
  });

  it("rejects a signed main-A claim after protected main advances to B", () => {
    const fixture = makeFixture();
    expect(() =>
      verifyLiveCatalogAttestation(
        {
          repository: "owner/repo",
          ...fixture,
          trustedCurrentMainCommit: "c".repeat(40),
        },
        vi.fn(),
      ),
    ).toThrow("live_catalog_claim_stale_protected_main");
  });

  it("verifies producer then final bytes and rejects coordinated retained-evidence tamper", () => {
    const fixture = makeFixture();
    const verifier = vi.fn((input: any) => ({
      certificate: {
        repository: "owner/repo",
        signerWorkflow: `owner/repo/${input.signerWorkflowPath}`,
        signerDigest: input.signerDigest,
        sourceRef: input.sourceRef,
        sourceDigest: input.sourceDigest,
        runnerEnvironment: "github-hosted",
        runInvocationURI: `https://github.com/owner/repo/actions/runs/${input.runId}/attempts/1`,
      },
      subject: {
        name: input.subjectName,
        digest: `sha256:${sha256Hex(input.subjectBytes)}`,
      },
      bundleBytes: input.bundleBytes,
    }));
    expect(() =>
      verifyLiveCatalogAttestation(
        {
          repository: "owner/repo",
          ...fixture,
          trustedCurrentMainCommit: commit,
        },
        verifier,
      ),
    ).not.toThrow();
    expect(verifier).toHaveBeenCalledTimes(2);
    writeFileSync(
      join(fixture.evidencePath, "successful-capture.json"),
      "{}\n",
    );
    expect(() =>
      verifyLiveCatalogAttestation(
        {
          repository: "owner/repo",
          ...fixture,
          trustedCurrentMainCommit: commit,
        },
        verifier,
      ),
    ).toThrow("live_catalog_offline_capture_evidence_mismatch");
  });

  it("rejects producer and final bundle byte changes at their signature boundaries", () => {
    const fixture = makeFixture();
    const originalBundle = Buffer.from('{"valid":true}');
    const verifier = vi.fn((input: any) => {
      if (!input.bundleBytes.equals(originalBundle))
        throw new Error("live_catalog_gh_attestation_invalid");
      return {
        certificate: {
          repository: "owner/repo",
          signerWorkflow: `owner/repo/${input.signerWorkflowPath}`,
          signerDigest: input.signerDigest,
          sourceRef: input.sourceRef,
          sourceDigest: input.sourceDigest,
          runnerEnvironment: "github-hosted",
          runInvocationURI: `https://github.com/owner/repo/actions/runs/${input.runId}/attempts/1`,
        },
        subject: {
          name: input.subjectName,
          digest: `sha256:${sha256Hex(input.subjectBytes)}`,
        },
        bundleBytes: input.bundleBytes,
      };
    });
    writeFileSync(
      join(fixture.evidencePath, "producer.bundle.json"),
      '{"valid":false}',
    );
    expect(() =>
      verifyLiveCatalogAttestation(
        {
          repository: "owner/repo",
          ...fixture,
          trustedCurrentMainCommit: commit,
        },
        verifier,
      ),
    ).toThrow("live_catalog_offline_producer_digest_mismatch");
    writeFileSync(
      join(fixture.evidencePath, "producer.bundle.json"),
      originalBundle,
    );
    writeFileSync(fixture.bundlePath, '{"valid":false}');
    expect(() =>
      verifyLiveCatalogAttestation(
        {
          repository: "owner/repo",
          ...fixture,
          trustedCurrentMainCommit: commit,
        },
        verifier,
      ),
    ).toThrow("live_catalog_gh_attestation_invalid");
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it("rejects coordinated claim and retained producer-evidence tamper", () => {
    const fixture = makeFixture();
    const tamperedBundle = Buffer.from('{"valid":"tampered"}');
    writeFileSync(
      join(fixture.evidencePath, "producer.bundle.json"),
      tamperedBundle,
    );
    const altered: any = JSON.parse(canonicalJson(fixture.claim));
    altered.producerAttestation.bundleSha256 = sha256Hex(tamperedBundle);
    const alteredBytes = Buffer.from(canonicalJson(altered));
    writeFileSync(fixture.claimPath, alteredBytes);
    writeFileSync(
      fixture.subjectPath,
      canonicalJson({
        schemaVersion: `${LIVE_CATALOG_CLAIM_SCHEMA}.subject`,
        claimPath: basename(fixture.claimPath),
        size: alteredBytes.length,
        sha256: sha256Hex(alteredBytes),
        fingerprint: claimFingerprint(altered),
      }),
    );
    expect(() =>
      verifyLiveCatalogAttestation(
        {
          repository: "owner/repo",
          ...fixture,
          trustedCurrentMainCommit: commit,
        },
        (input: any) => {
          if (input.bundleBytes.equals(tamperedBundle))
            throw new Error("live_catalog_gh_attestation_invalid");
          throw new Error("unexpected_verification_stage");
        },
      ),
    ).toThrow("live_catalog_gh_attestation_invalid");
  });

  it("rejects coordinated claim and subject edits at the final signature boundary", () => {
    const fixture = makeFixture();
    const altered: any = JSON.parse(canonicalJson(fixture.claim));
    altered.attestor.runId = "402";
    const alteredBytes = Buffer.from(canonicalJson(altered));
    writeFileSync(fixture.claimPath, alteredBytes);
    writeFileSync(
      fixture.subjectPath,
      canonicalJson({
        schemaVersion: `${LIVE_CATALOG_CLAIM_SCHEMA}.subject`,
        claimPath: basename(fixture.claimPath),
        size: alteredBytes.length,
        sha256: sha256Hex(alteredBytes),
        fingerprint: claimFingerprint(altered),
      }),
    );
    let calls = 0;
    expect(() =>
      verifyLiveCatalogAttestation(
        {
          repository: "owner/repo",
          ...fixture,
          trustedCurrentMainCommit: commit,
        },
        (input: any) => {
          calls++;
          if (calls === 2 && !input.subjectBytes.equals(fixture.claimBytes))
            throw new Error("live_catalog_gh_attestation_invalid");
          return {
            certificate: {
              repository: "owner/repo",
              signerWorkflow: `owner/repo/${input.signerWorkflowPath}`,
              signerDigest: input.signerDigest,
              sourceRef: input.sourceRef,
              sourceDigest: input.sourceDigest,
              runnerEnvironment: "github-hosted",
              runInvocationURI: `https://github.com/owner/repo/actions/runs/${input.runId}/attempts/1`,
            },
            subject: {
              name: input.subjectName,
              digest: `sha256:${sha256Hex(input.subjectBytes)}`,
            },
            bundleBytes: input.bundleBytes,
          };
        },
      ),
    ).toThrow("live_catalog_gh_attestation_invalid");
    expect(calls).toBe(2);
  });

  it("runs the actual CLI with a real fake-gh executable", () => {
    const fixture = makeFixture();
    const bin = join(fixture.directory, "bin");
    mkdirSync(bin);
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}\n` +
        `import fs from "node:fs";import crypto from "node:crypto";const a=process.argv.slice(2),at=f=>a[a.indexOf(f)+1];\n` +
        `const bytes=fs.readFileSync(a[2]),bundle=JSON.parse(fs.readFileSync(at("--bundle"),"utf8")),digest=crypto.createHash("sha256").update(bytes).digest("hex");\n` +
        `const workflow=at("--signer-workflow"),run=workflow.endsWith("capture-live-catalog.yml")?"1001":"401",name=workflow.endsWith("capture-live-catalog.yml")?"activation-catalog-policy-${commit}-1":"claim.json";\n` +
        `const statement={_type:"https://in-toto.io/Statement/v1",predicateType:"https://slsa.dev/provenance/v1",subject:[{name,digest:{sha256:digest}}],predicate:{}};\n` +
        `const verificationResult=JSON.parse(fs.readFileSync("scripts/fixtures/live-catalog-attestation/gh-verification-result.json","utf8")).verificationResult;verificationResult.statement=statement;const certificate=verificationResult.signature.certificate;certificate.subjectAlternativeName="https://github.com/"+workflow+"@refs/heads/main";certificate.buildSignerURI=certificate.subjectAlternativeName;certificate.runInvocationURI="https://github.com/owner/repo/actions/runs/"+run+"/attempts/1";verificationResult.verifiedIdentity.subjectAlternativeName=certificate.subjectAlternativeName;\n` +
        `process.stdout.write(JSON.stringify([{attestation:bundle,verificationResult}]));\n`,
      { mode: 0o700 },
    );
    chmodSync(gh, 0o700);
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/verify-live-catalog-attestation.mjs",
        ...argumentsFor(fixture),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      },
    );
    expect(JSON.parse(output)).toMatchObject({ verified: true });
  });
});
