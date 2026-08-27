import { readFileSync } from "node:fs";
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

  it.each([
    [
      "missing field",
      (value: any) => delete value.verificationResult.runInvocationURI,
    ],
    [
      "wrong signer",
      (value: any) =>
        (value.verificationResult.buildSignerURI =
          "https://github.com/owner/repo/.github/workflows/other.yml@refs/heads/main"),
    ],
    [
      "wrong digest",
      (value: any) =>
        (value.verificationResult.buildSignerDigest = "b".repeat(40)),
    ],
    [
      "wrong run",
      (value: any) =>
        (value.verificationResult.runInvocationURI =
          "https://github.com/owner/repo/actions/runs/2/attempts/1"),
    ],
    [
      "wrong attempt",
      (value: any) =>
        (value.verificationResult.runInvocationURI =
          "https://github.com/owner/repo/actions/runs/1001/attempts/2"),
    ],
    [
      "self hosted",
      (value: any) =>
        (value.verificationResult.runnerEnvironment = "self-hosted"),
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
    value.verificationResult.runInvocationURI =
      "https://github.com/owner/repo/actions/runs/9999/attempts/1";
    expect(() => normalizeGhAttestationResult(value, policy)).toThrow(
      "live_catalog_gh_authenticated_subject_mismatch",
    );
  });
});
