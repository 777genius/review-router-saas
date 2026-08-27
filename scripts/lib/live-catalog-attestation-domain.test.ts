import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import canonicalArtifact from "../../packages/features/release-rollout/src/domain/activation-catalog-policy-artifact.generated.js";
import { gitBlobSha } from "./github-actions-trusted-evidence.mjs";
import {
  assembleLiveCatalogClaim,
  assertLiveCatalogClaimAtProtectedMain,
  assertLiveCatalogCaptureContract,
  assertSourceWorkflowPg17Image,
  canonicalJson,
  extractConfiguredCatalogDigest,
  extractProjectionBytes,
  LIVE_CATALOG_CONTRACT_PATH,
  LIVE_CATALOG_PG17_IMAGE,
  LIVE_CATALOG_PROJECTION_PATH,
  LIVE_CATALOG_SOURCE_WORKFLOW,
  localImportSpecifiers,
  resolveLocalImport,
  sha256Hex,
  sourceClosureFacts,
  validateLiveCatalogClaim,
} from "./live-catalog-attestation-domain.mjs";
import {
  normalizeGhAttestationResult,
  verifyWithGhAttestation,
} from "./live-catalog-gh-attestation-adapter.mjs";

const commit = "a".repeat(40);
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
const producerBundle = Buffer.from(
  `${JSON.stringify({ bundle: "producer" }, null, 2)}\n`,
);

function closureFile(path: string, bytes: Buffer) {
  return {
    path,
    bytes,
    size: bytes.length,
    sha256: sha256Hex(bytes),
    gitBlobSha: gitBlobSha(bytes),
  };
}

const closureFiles = [
  closureFile(LIVE_CATALOG_SOURCE_WORKFLOW, workflow),
  closureFile(LIVE_CATALOG_CONTRACT_PATH, contract),
  closureFile(LIVE_CATALOG_PROJECTION_PATH, projection),
  closureFile("package.json", readFileSync("package.json")),
];

function captureEvidence() {
  return Buffer.from(
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
}

function input(overrides: Record<string, unknown> = {}) {
  const archiveSha256 = "f".repeat(64);
  return {
    repositoryId: 17,
    repositoryName: "owner/repo",
    sourceCommit: commit,
    sourceTree: "b".repeat(40),
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
      runnerName: "GitHub Actions 12",
      labels: ["ubuntu-24.04"],
    },
    runnerEnvironment: "github-hosted",
    artifactId: 301,
    artifactName: `activation-catalog-policy-${commit}-1`,
    artifactRestDigest: `sha256:${archiveSha256}`,
    archiveSha256,
    candidateEntries: [
      ["activation-catalog-policy-candidate-1.json", candidate],
      ["activation-catalog-policy-candidate-2.json", candidate],
    ],
    captureEvidenceBytes: captureEvidence(),
    workflowSourceBytes: workflow,
    contractSourceBytes: contract,
    projectionSourceBytes: projection,
    sourceClosureFiles: closureFiles,
    producerCertificate: {
      repository: "owner/repo",
      signerWorkflow: "owner/repo/.github/workflows/capture-live-catalog.yml",
      signerDigest: commit,
      sourceRef: "refs/heads/main",
      sourceDigest: commit,
      runnerEnvironment: "github-hosted",
      runInvocationURI:
        "https://github.com/owner/repo/actions/runs/1001/attempts/1",
    },
    producerSubject: {
      name: `activation-catalog-policy-${commit}-1`,
      digest: `sha256:${archiveSha256}`,
    },
    producerBundleBytes: producerBundle,
    pg17Image: LIVE_CATALOG_PG17_IMAGE,
    attestorCommit: commit,
    attestorRunId: 401,
    attestorRunAttempt: 1,
    attestorRef: "refs/heads/main",
    attestorRunner: "ubuntu-24.04",
    attestorEnvironment: "production-release",
    ...overrides,
  };
}

describe("dedicated producer workflow semantics", () => {
  it("accepts only the exact checked-in one-job producer", () => {
    expect(() => assertSourceWorkflowPg17Image(workflow)).not.toThrow();
    const parsed = parse(workflow.toString());
    expect(Object.keys(parsed.jobs)).toEqual(["producer"]);
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(parsed.jobs.producer.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
  });

  it.each([
    [
      "sibling job",
      (value: any) =>
        (value.jobs.sibling = { "runs-on": "ubuntu-24.04", steps: [] }),
    ],
    [
      "overwrite",
      (value: any) => (value.jobs.producer.steps[7].with.overwrite = true),
    ],
    [
      "floating action",
      (value: any) =>
        (value.jobs.producer.steps[7].uses = "actions/upload-artifact@v4"),
    ],
    [
      "wrong wiring",
      (value: any) =>
        (value.jobs.producer.steps[8].with["subject-digest"] =
          "sha256:deadbeef"),
    ],
    [
      "job env",
      (value: any) => (value.jobs.producer.env = { BASH_ENV: "/tmp/decoy" }),
    ],
    [
      "shell wrapper",
      (value: any) => (value.jobs.producer.steps[5].shell = "python"),
    ],
    ["container", (value: any) => (value.jobs.producer.container = "ubuntu")],
    [
      "services",
      (value: any) =>
        (value.jobs.producer.services = { postgres: { image: "postgres" } }),
    ],
    ["defaults", (value: any) => (value.defaults = { run: { shell: "bash" } })],
    [
      "extra step",
      (value: any) => value.jobs.producer.steps.push({ run: "true" }),
    ],
  ])("rejects %s decoys", (_name, mutate) => {
    const parsed = parse(workflow.toString());
    mutate(parsed);
    expect(() =>
      assertSourceWorkflowPg17Image(Buffer.from(stringify(parsed))),
    ).toThrow("live_catalog_source_workflow_producer_invalid");
  });

  it("has no capture or upload authorization left in ci.yml", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).not.toContain("activation_catalog_policy_capture");
    expect(ci).not.toContain("live-catalog-successful-capture-evidence.json");
  });
});

describe("capture contract and source closure", () => {
  it("validates the unique narrow contract and literal projection references", () => {
    expect(() => assertLiveCatalogCaptureContract(contract)).not.toThrow();
    expect(() =>
      assertLiveCatalogCaptureContract(
        Buffer.concat([
          contract,
          Buffer.from("\nexport const decoy = true;\n"),
        ]),
      ),
    ).toThrow("live_catalog_contract_semantics_invalid");
  });

  it.each([
    [
      "comment decoy",
      `${contract.toString()}\n// runProjection(migrationReceipt)\n`,
    ],
    [
      "dead branch",
      contract
        .toString()
        .replace(
          "const observedCatalogDigest = String(",
          "if (false) runProjection('decoy');\n  const observedCatalogDigest = String(",
        ),
    ],
    [
      "unused expression",
      contract
        .toString()
        .replace(
          "const observedCatalogDigest = String(",
          "migrationReceipt.postCatalogDigest;\n  const observedCatalogDigest = String(",
        ),
    ],
    [
      "fabricated return",
      contract
        .toString()
        .replace(
          "observedCatalogDigest,",
          "observedCatalogDigest: liveV70V73CatalogDigestSha256,",
        ),
    ],
    [
      "duplicate export",
      `${contract.toString()}\nexport { captureSuccessfulLiveCatalogContract };\n`,
    ],
  ])("rejects %s in the structural capture proof", (_name, source) => {
    expect(() => assertLiveCatalogCaptureContract(Buffer.from(source))).toThrow(
      "live_catalog_contract_semantics_invalid",
    );
  });

  it("binds path, git blob, bytes, size and aggregate digest", () => {
    const facts = sourceClosureFacts(closureFiles);
    expect(facts.entries).toHaveLength(4);
    expect(facts.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() =>
      sourceClosureFacts([
        {
          ...closureFiles[0],
          bytes: Buffer.concat([workflow, Buffer.from("x")]),
        },
      ]),
    ).toThrow("live_catalog_source_closure_entry_invalid");
  });

  it("rejects unresolved and dynamic local imports", () => {
    expect(() =>
      resolveLocalImport(
        "scripts/a.mjs",
        "./missing.mjs",
        new Set(["scripts/a.mjs"]),
      ),
    ).toThrow("live_catalog_source_closure_unresolved_import");
    expect(() =>
      localImportSpecifiers(
        "scripts/a.mjs",
        Buffer.from("await import(target)"),
      ),
    ).toThrow("live_catalog_source_closure_dynamic_import_denied");
  });
});

describe("schema v3 convergence", () => {
  it("assembles exact-main producer certificate, tuple, bundle, and closure", () => {
    const claim = assembleLiveCatalogClaim(input() as any);
    expect(claim.schemaVersion).toBe("reviewrouter.live-catalog-provenance.v3");
    expect(claim.source.commit).toBe(claim.attestor.commit);
    expect(claim.artifact.restDigest).toBe(
      claim.producerAttestation.subject.digest,
    );
    expect(claim.producerAttestation.bundleSha256).toBe(
      sha256Hex(producerBundle),
    );
    expect(() => validateLiveCatalogClaim(claim)).not.toThrow();
  });

  it.each([
    ["ancestor A then B", { attestorCommit: "c".repeat(40) }],
    [
      "REST digest divergence",
      { artifactRestDigest: `sha256:${"e".repeat(64)}` },
    ],
    [
      "artifact replay from another tuple",
      {
        producerSubject: { name: "other", digest: `sha256:${"f".repeat(64)}` },
      },
    ],
    [
      "wrong run",
      {
        producerCertificate: {
          ...input().producerCertificate,
          runInvocationURI:
            "https://github.com/owner/repo/actions/runs/1002/attempts/1",
        },
      },
    ],
    [
      "wrong attempt",
      {
        producerCertificate: {
          ...input().producerCertificate,
          runInvocationURI:
            "https://github.com/owner/repo/actions/runs/1001/attempts/2",
        },
      },
    ],
    [
      "self-hosted",
      {
        producerCertificate: {
          ...input().producerCertificate,
          runnerEnvironment: "self-hosted",
        },
      },
    ],
  ])("fails closed for %s", (_name, mutation) => {
    expect(() => assembleLiveCatalogClaim(input(mutation) as any)).toThrow(
      /live_catalog_/u,
    );
  });

  it("rejects coordinated claim digest divergence", () => {
    const claim: any = JSON.parse(
      canonicalJson(assembleLiveCatalogClaim(input() as any)),
    );
    claim.artifact.archiveSha256 = "e".repeat(64);
    expect(() => validateLiveCatalogClaim(claim)).toThrow(
      "live_catalog_claim_tuple_mismatch",
    );
  });

  it.each([
    ["repository", (claim: any) => (claim.repository.name = "owner/other")],
    ["source ref", (claim: any) => (claim.source.ref = "refs/heads/main")],
    ["source tree", (claim: any) => (claim.source.tree = "c".repeat(40))],
    ["run attempt", (claim: any) => (claim.execution.runAttempt = 2)],
    ["producer job", (claim: any) => (claim.execution.producerJob.id = "0")],
    ["artifact id", (claim: any) => (claim.artifact.id = "0")],
    ["candidate size", (claim: any) => claim.artifact.candidates[0].size++],
    [
      "capture projection",
      (claim: any) =>
        (claim.artifact.captureEvidence.projectionSqlSha256 = "e".repeat(64)),
    ],
    [
      "producer signer",
      (claim: any) =>
        (claim.producerAttestation.certificate.signerDigest = "c".repeat(40)),
    ],
    [
      "closure digest",
      (claim: any) => (claim.sourceClosure.digest = `sha256:${"e".repeat(64)}`),
    ],
    [
      "projection export",
      (claim: any) => (claim.sources.projection.export = "decoy"),
    ],
    [
      "configured digest",
      (claim: any) =>
        (claim.sources.projection.configuredDigest = `sha256:${"e".repeat(64)}`),
    ],
    [
      "observed digest",
      (claim: any) =>
        (claim.observedCatalogDigest = `sha256:${"e".repeat(64)}`),
    ],
    ["attestor run", (claim: any) => (claim.attestor.runId = "0")],
  ])(
    "rejects representative claim/projection mutation: %s",
    (_name, mutate) => {
      const claim: any = JSON.parse(
        canonicalJson(assembleLiveCatalogClaim(input() as any)),
      );
      mutate(claim);
      expect(() => validateLiveCatalogClaim(claim)).toThrow(/live_catalog_/u);
    },
  );

  it("rejects a previously valid claim when protected main advances before consumption", () => {
    const claim = assembleLiveCatalogClaim(input() as any);
    expect(() =>
      assertLiveCatalogClaimAtProtectedMain(claim, "c".repeat(40)),
    ).toThrow("live_catalog_claim_stale_protected_main");
  });
});

describe("deterministic gh JSON normalization", () => {
  const bytes = Buffer.from("producer archive");
  const policy = {
    repository: "owner/repo",
    subjectBytes: bytes,
    subjectName: `activation-catalog-policy-${commit}-1`,
    signerWorkflowPath: LIVE_CATALOG_SOURCE_WORKFLOW,
    signerDigest: commit,
    sourceRef: "refs/heads/main",
    sourceDigest: commit,
    runId: "1001",
  };
  const fixture = () => {
    const value = JSON.parse(
      readFileSync(
        "scripts/fixtures/live-catalog-attestation/gh-verification-result.json",
        "utf8",
      ),
    );
    value.verificationResult.statement.subject[0].digest.sha256 =
      sha256Hex(bytes);
    return value;
  };

  it("normalizes authenticated certificate fields and ignores predicate authority", () => {
    const value = fixture();
    value.verificationResult.statement.predicate = { producerJobId: 999 };
    expect(
      normalizeGhAttestationResult(value, policy).certificate,
    ).toMatchObject({
      signerDigest: commit,
      runInvocationURI:
        "https://github.com/owner/repo/actions/runs/1001/attempts/1",
    });
  });

  it("accepts the documented current gh signature and verified timestamps", () => {
    expect(() => normalizeGhAttestationResult(fixture(), policy)).not.toThrow();
  });

  it.each([
    [
      "signature array",
      (value: any) => (value.verificationResult.signature = []),
    ],
    [
      "signature extra field",
      (value: any) => (value.verificationResult.signature.keyId = "decoy"),
    ],
    [
      "certificate extra field",
      (value: any) =>
        (value.verificationResult.signature.certificate.serialNumber = "1"),
    ],
    [
      "certificate extension wrong type",
      (value: any) =>
        (value.verificationResult.signature.certificate.githubWorkflowSHA = 1),
    ],
    [
      "nested legacy extensions",
      (value: any) => {
        const certificate = value.verificationResult.signature.certificate;
        certificate.extensions = { issuer: certificate.issuer };
      },
    ],
    [
      "missing media type",
      (value: any) => delete value.verificationResult.mediaType,
    ],
    [
      "wrong media type",
      (value: any) => (value.verificationResult.mediaType = "text/plain"),
    ],
    [
      "missing signature",
      (value: any) => delete value.verificationResult.signature,
    ],
    [
      "missing certificate",
      (value: any) => delete value.verificationResult.signature.certificate,
    ],
    [
      "missing OIDC issuer trust field",
      (value: any) =>
        delete value.verificationResult.signature.certificate.issuer,
    ],
    [
      "missing certificate issuer trust field",
      (value: any) =>
        delete value.verificationResult.signature.certificate.certificateIssuer,
    ],
    [
      "unknown certificate field",
      (value: any) =>
        (value.verificationResult.signature.certificate.futureIdentity =
          "decoy"),
    ],
    [
      "optional certificate field wrong type",
      (value: any) =>
        (value.verificationResult.signature.certificate.buildConfigURI = 1),
    ],
    [
      "verified identity wrong shape",
      (value: any) =>
        (value.verificationResult.verifiedIdentity = { arbitrary: true }),
    ],
    [
      "timestamp wrong type",
      (value: any) =>
        (value.verificationResult.verifiedTimestamps[0].timestamp = 1),
    ],
    [
      "timestamp extra field",
      (value: any) =>
        (value.verificationResult.verifiedTimestamps[0].authority = "decoy"),
    ],
    [
      "timestamp URI wrong scheme",
      (value: any) =>
        (value.verificationResult.verifiedTimestamps[0].uri =
          "file:///tmp/rekor"),
    ],
    [
      "invalid calendar timestamp",
      (value: any) =>
        (value.verificationResult.verifiedTimestamps[0].timestamp =
          "2026-02-30T12:00:00Z"),
    ],
    [
      "empty timestamps",
      (value: any) => (value.verificationResult.verifiedTimestamps = []),
    ],
    [
      "unknown result field",
      (value: any) => (value.verificationResult.futureAuthority = true),
    ],
  ])("rejects malformed or unknown current gh field: %s", (_name, mutate) => {
    const value = fixture();
    mutate(value);
    expect(() => normalizeGhAttestationResult(value, policy)).toThrow(
      "live_catalog_gh_result_shape_invalid",
    );
  });

  it.each([
    "buildSignerURI",
    "buildSignerDigest",
    "sourceRepositoryURI",
    "sourceRepositoryDigest",
    "sourceRepositoryRef",
    "runnerEnvironment",
    "runInvocationURI",
  ])("rejects duplicated legacy top-level derived field %s", (key) => {
    const value = fixture();
    value.verificationResult[key] =
      value.verificationResult.signature.certificate[key];
    expect(() => normalizeGhAttestationResult(value, policy)).toThrow(
      "live_catalog_gh_result_shape_invalid",
    );
  });

  it("accepts and binds sigstore-go's documented verified identity", () => {
    const value = fixture();
    const certificate = value.verificationResult.signature.certificate;
    value.verificationResult.verifiedIdentity = {
      subjectAlternativeName: certificate.subjectAlternativeName,
      issuer: certificate.issuer,
    };
    expect(() => normalizeGhAttestationResult(value, policy)).not.toThrow();
    value.verificationResult.verifiedIdentity.issuer = "https://issuer.invalid";
    expect(() => normalizeGhAttestationResult(value, policy)).toThrow(
      "live_catalog_gh_result_shape_invalid",
    );
  });

  it("accepts documented optional result and certificate fields when omitted", () => {
    const value = fixture();
    delete value.verificationResult.verifiedIdentity;
    delete value.verificationResult.signature.certificate
      .sourceRepositoryVisibilityAtSigning;
    expect(() => normalizeGhAttestationResult(value, policy)).not.toThrow();
  });

  it("accepts every documented optional certificate extension as a string", () => {
    const value = fixture();
    Object.assign(value.verificationResult.signature.certificate, {
      buildConfigURI:
        "https://github.com/owner/repo/.github/workflows/capture-live-catalog.yml@refs/heads/main",
      buildConfigDigest: commit,
      buildTrigger: "workflow_dispatch",
    });
    expect(() => normalizeGhAttestationResult(value, policy)).not.toThrow();
  });

  it.each([
    "buildConfigURI",
    "buildConfigDigest",
    "buildTrigger",
    "sourceRepositoryVisibilityAtSigning",
  ])("rejects wrong type for optional certificate extension %s", (key) => {
    const value = fixture();
    value.verificationResult.signature.certificate[key] = 1;
    expect(() => normalizeGhAttestationResult(value, policy)).toThrow(
      "live_catalog_gh_result_shape_invalid",
    );
  });

  it("passes the complete repository/signer/source/runner policy to gh", () => {
    const value = fixture();
    let args: string[] = [];
    const result = verifyWithGhAttestation(
      policy as any,
      (_command, inputArgs) => {
        args = inputArgs as string[];
        return {
          status: 0,
          stdout: JSON.stringify([value]),
          stderr: "",
        } as any;
      },
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--repo",
        "owner/repo",
        "--deny-self-hosted-runners",
        "--signer-digest",
        commit,
        "--source-ref",
        "refs/heads/main",
        "--source-digest",
        commit,
      ]),
    );
    expect(result.subject.digest).toBe(`sha256:${sha256Hex(bytes)}`);
  });

  it("rejects a different authenticated bundle returned by gh", () => {
    const value = fixture();
    expect(() =>
      verifyWithGhAttestation(
        { ...policy, bundleBytes: Buffer.from('{"expected":true}') } as any,
        () =>
          ({
            status: 0,
            stdout: JSON.stringify([value]),
            stderr: "",
          }) as any,
      ),
    ).toThrow("live_catalog_gh_authenticated_bundle_mismatch");
  });

  it.each([
    [
      "missing field",
      (value: any) =>
        delete value.verificationResult.signature.certificate.runInvocationURI,
    ],
    [
      "wrong signer",
      (value: any) =>
        (value.verificationResult.signature.certificate.buildSignerURI =
          "https://github.com/owner/repo/.github/workflows/other.yml@refs/heads/main"),
    ],
    [
      "wrong digest",
      (value: any) =>
        (value.verificationResult.signature.certificate.buildSignerDigest =
          "b".repeat(40)),
    ],
    [
      "wrong run",
      (value: any) =>
        (value.verificationResult.signature.certificate.runInvocationURI =
          "https://github.com/owner/repo/actions/runs/2/attempts/1"),
    ],
    [
      "wrong attempt",
      (value: any) =>
        (value.verificationResult.signature.certificate.runInvocationURI =
          "https://github.com/owner/repo/actions/runs/1001/attempts/2"),
    ],
    [
      "self hosted",
      (value: any) =>
        (value.verificationResult.signature.certificate.runnerEnvironment =
          "self-hosted"),
    ],
    [
      "workflow tuple mismatch",
      (value: any) =>
        (value.verificationResult.signature.certificate.githubWorkflowSHA =
          "b".repeat(40)),
    ],
    [
      "workflow repository tuple mismatch",
      (value: any) =>
        (value.verificationResult.signature.certificate.githubWorkflowRepository =
          "owner/other"),
    ],
    [
      "workflow ref tuple mismatch",
      (value: any) =>
        (value.verificationResult.signature.certificate.githubWorkflowRef =
          "refs/heads/other"),
    ],
    [
      "certificate subject tuple mismatch",
      (value: any) =>
        (value.verificationResult.signature.certificate.subjectAlternativeName =
          "https://github.com/owner/repo/.github/workflows/other.yml@refs/heads/main"),
    ],
    [
      "source tuple mismatch",
      (value: any) =>
        (value.verificationResult.signature.certificate.sourceRepositoryDigest =
          "b".repeat(40)),
    ],
    [
      "source repository tuple mismatch",
      (value: any) =>
        (value.verificationResult.signature.certificate.sourceRepositoryURI =
          "https://github.com/owner/other"),
    ],
    [
      "source ref tuple mismatch",
      (value: any) =>
        (value.verificationResult.signature.certificate.sourceRepositoryRef =
          "refs/heads/other"),
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = fixture();
    mutate(value);
    expect(() => normalizeGhAttestationResult(value, policy)).toThrow(
      /live_catalog_/u,
    );
  });

  it("rejects a validly shaped producer bundle replay from another run", () => {
    const value = fixture();
    value.verificationResult.signature.certificate.runInvocationURI =
      "https://github.com/owner/repo/actions/runs/9999/attempts/1";
    expect(() => normalizeGhAttestationResult(value, policy)).toThrow(
      "live_catalog_gh_result_shape_invalid",
    );
  });

  it("executes a deterministic fake gh for valid, tampered, private-path, and cleanup cases", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-live-catalog-fake-gh-"));
    const executable = join(directory, "gh");
    writeFileSync(
      executable,
      `#!${process.execPath}\n` +
        `import fs from "node:fs";import crypto from "node:crypto";\n` +
        `const a=process.argv.slice(2),at=(f)=>a[a.indexOf(f)+1],one=(f)=>a.filter(v=>v===f).length===1;\n` +
        `if(a[0]!=="attestation"||a[1]!=="verify"||!one("--bundle")||!one("--repo")||!one("--deny-self-hosted-runners")||!one("--signer-workflow")||!one("--signer-digest")||!one("--source-ref")||!one("--source-digest")||!one("--format"))process.exit(2);\n` +
        `if(at("--repo")!=="owner/repo"||at("--signer-workflow")!=="owner/repo/${LIVE_CATALOG_SOURCE_WORKFLOW}"||at("--signer-digest")!=="${commit}"||at("--source-ref")!=="refs/heads/main"||at("--source-digest")!=="${commit}"||at("--format")!=="json")process.exit(3);\n` +
        `const subject=a[2],bundle=JSON.parse(fs.readFileSync(at("--bundle"),"utf8"));if(bundle.valid!==true)process.exit(4);\n` +
        `if(!subject.includes("rr-live-catalog-gh-")||!at("--bundle").includes("rr-live-catalog-gh-"))process.exit(5);\n` +
        `const digest=crypto.createHash("sha256").update(fs.readFileSync(subject)).digest("hex");\n` +
        `const statement={_type:"https://in-toto.io/Statement/v1",predicateType:"https://slsa.dev/provenance/v1",subject:[{name:"activation-catalog-policy-${commit}-1",digest:{sha256:digest}}],predicate:{}};\n` +
        `const verificationResult=JSON.parse(fs.readFileSync("scripts/fixtures/live-catalog-attestation/gh-verification-result.json","utf8")).verificationResult;verificationResult.statement=statement;\n` +
        `process.stdout.write(JSON.stringify([{attestation:bundle,verificationResult}]));\n`,
      { mode: 0o700 },
    );
    chmodSync(executable, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    let temporarySubject = "";
    try {
      expect(() =>
        verifyWithGhAttestation({
          ...policy,
          bundleBytes: Buffer.from('{"valid":true}'),
        }),
      ).not.toThrow();
      expect(() =>
        verifyWithGhAttestation({
          ...policy,
          bundleBytes: Buffer.from('{"valid":false}'),
        }),
      ).toThrow("live_catalog_gh_attestation_invalid");
      expect(() =>
        verifyWithGhAttestation(
          { ...policy, bundleBytes: Buffer.from('{"valid":true}') },
          (command, args, options) => {
            temporarySubject = args[2] as string;
            writeFileSync(temporarySubject, "tampered");
            return spawnSync(command, args, options);
          },
        ),
      ).toThrow(/live_catalog_gh_/u);
    } finally {
      process.env.PATH = originalPath;
    }
    expect(temporarySubject).not.toBe("");
    expect(existsSync(temporarySubject)).toBe(false);
  });
});
