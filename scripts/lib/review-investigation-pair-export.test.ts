import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  chmod,
  readFile,
  stat,
  symlink,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observation } from "../../packages/features/review-evidence/src/tests/fixtures";
import {
  shadowEvidence,
  shadowIssuedAtMs,
} from "../../packages/features/review-evidence/src/tests/investigation-shadow-evidence-fixtures";
import { prepareReviewObservationPayload } from "../../packages/features/review-evidence/src/domain/review-observation";
import {
  canonicalInvestigationShadowCertificate,
  investigationShadowEvidenceRecordCanonicalValue,
  investigationShadowScopeCanonicalValue,
  type InvestigationShadowEvidenceCertificate,
} from "../../packages/features/review-evidence/src/domain/investigation-shadow-evidence";
import { stableJson } from "../../packages/features/review-evidence/src/domain/provider-invocation-manifest";
import {
  assertPairExportPublishable,
  readExactReviewInvestigationPair,
  legacyKeys,
  shadowKeys,
  type PairSelection,
  type TrustedPairScope,
} from "./review-investigation-pair-export";
import {
  readBoundedJson,
  writeRestrictedArtifact as writeGuardedArtifact,
} from "../export-review-investigation-pair";
const writeRestrictedArtifact = (path: string, artifact: unknown) =>
  writeGuardedArtifact(path, artifact, () => {});
const hash = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
function fixture() {
  let l = observation();
  l = {
    ...l,
    payloadHash: hash(
      prepareReviewObservationPayload(l.payload).canonicalBytes,
    ),
    retainUntilMs: shadowIssuedAtMs + 86400000,
  };
  let r = shadowEvidence({
    scope: { ...l.scope, trustDomain: l.trustDomain },
    revision: l.sourceRevision,
    executionId: l.sourceExecutionId,
    workSlotId: l.sourceWorkSlotId,
    providerVoteLaneId: l.providerVoteIdentityHash,
  });
  const c = {
    certificateId: r.certificateId,
    certificateHash: hash("placeholder"),
    investigationId: r.investigationId,
    investigationVersion: r.investigationVersion - 1,
    dossierDigest: hash("dossier"),
    reviewRevisionHash: r.revision.reviewRevisionHash,
    stableReviewUnitKey: r.stableReviewUnitKey,
    providerVoteLaneId: r.providerVoteLaneId,
    coverageContractVersion: "v1",
    expansionRulesVersion: "v1",
    gatewayPolicyVersion: "v1",
    criticPolicyVersion: "v1",
    runtimeProfileVersion: "v1",
    producerReleaseId: r.producerReleaseId,
    conclusion: r.conclusion,
    findingSetHash: hash("findings"),
    obligationSetHash: hash("obligations"),
    receiptSetHash: hash("receipts"),
    scopeHash: hash(
      stableJson(investigationShadowScopeCanonicalValue(r.scope)),
    ),
    coverageStateHash: hash("coverage"),
    contextAttestationSetHash: hash("context"),
    turnProvenanceHash: hash("turn"),
    terminalProviderKind: r.terminalProviderKind,
    terminalActualModel: r.terminalActualModel,
    terminalOutcomeHash: r.terminalOutcomeHash,
    terminalObservationCanonicalJson: r.terminalObservationCanonicalJson,
    criticAttestationId: "critic",
    criticAttestationHash: hash("critic"),
    criticDecision: "accept",
    issuedAt: new Date(r.issuedAtMs).toISOString(),
    expiresAt: new Date(r.issuedAtMs + 1000).toISOString(),
  } as InvestigationShadowEvidenceCertificate;
  const canonical = canonicalInvestigationShadowCertificate(c);
  r = {
    ...r,
    certificateCanonicalJson: canonical,
    certificateHash: hash(canonical),
  };
  r = {
    ...r,
    recordHash: hash(
      stableJson(investigationShadowEvidenceRecordCanonicalValue(r)),
    ),
  };
  const s: PairSelection = {
    version: 1,
    pairing: "same_execution",
    legacyObservationId: l.observationId,
    shadowEvidenceId: r.shadowEvidenceId,
    investigationId: r.investigationId,
    certificateId: r.certificateId,
    scope: r.scope,
    revision: r.revision,
    legacy: Object.fromEntries(
      legacyKeys.map((k) => [k, l[k]]),
    ) as PairSelection["legacy"],
    investigation: Object.fromEntries(
      shadowKeys.map((k) => [k, r[k]]),
    ) as PairSelection["investigation"],
  };
  const trusted: TrustedPairScope = {
    repository: "777genius/review-router-saas-e2e",
    immutableRepositoryId: "1228051727",
    scope: r.scope,
    privacyExportAllowed: true,
    validUntilMs: shadowIssuedAtMs + 86400000,
  };
  return {
    l: structuredClone(l),
    r: structuredClone(r),
    s: structuredClone(s),
    trusted: structuredClone(trusted),
  };
}
type Fixture = ReturnType<typeof fixture>;
async function run(f: Fixture, missing?: "legacy" | "shadow") {
  return readExactReviewInvestigationPair(
    f.s,
    f.trusted,
    {
      observations: {
        findById: async (id: string) => {
          assert.equal(id, f.l.observationId);
          return missing === "legacy" ? null : f.l;
        },
        findCandidates: () => {
          throw new Error("must never discover");
        },
      } as never,
      shadows: {
        findById: async (id) => {
          assert.equal(id, f.r.shadowEvidenceId);
          return missing === "shadow" ? null : f.r;
        },
      },
    },
    () => shadowIssuedAtMs + 2000,
  );
}
test("retained historical exact pair, expired reuse TTL and certificate, version offset, separate model labels and verifiable body", async () => {
  const f = fixture();
  assert.ok(f.l.reuseExpiresAtMs < shadowIssuedAtMs);
  const a = await run(f);
  assert.equal(a.body.investigation.authority, "non_authoritative");
  assert.equal(a.body.evaluation, "NotCompared");
  assert.equal(a.exportBodyHash, hash(stableJson(a.body as never)));
  assert.equal(a.body.hashes.legacy.stored, a.body.hashes.legacy.recomputed);
});
const negative: [string, (f: Fixture) => void][] = [];
for (const key of [
  "workspaceId",
  "repositoryConnectionId",
  "scmRepositoryIdentityId",
  "pullRequestNumber",
  "trustDomain",
  "authorizationScopeHash",
] as const) {
  negative.push([
    `foreign legacy ${key}`,
    (f) => {
      if (key === "trustDomain") (f.l as any).trustDomain = "foreign";
      else (f.l.scope as any)[key] = "foreign";
    },
  ]);
  negative.push([
    `foreign shadow ${key}`,
    (f) => {
      (f.r.scope as any)[key] = "foreign";
    },
  ]);
  negative.push([
    `untrusted selector ${key}`,
    (f) => {
      (f.s.scope as any)[key] = "foreign";
    },
  ]);
}
for (const key of [
  "baseSha",
  "mergeBaseSha",
  "headSha",
  "reviewRevisionHash",
] as const) {
  negative.push([
    `legacy revision ${key}`,
    (f) => {
      f.l = {
        ...f.l,
        sourceRevision: {
          ...f.l.sourceRevision,
          [key]: "f".repeat(key === "reviewRevisionHash" ? 64 : 40),
        },
      };
    },
  ]);
  negative.push([
    `shadow revision ${key}`,
    (f) => {
      f.r = {
        ...f.r,
        revision: {
          ...f.r.revision,
          [key]: "f".repeat(key === "reviewRevisionHash" ? 64 : 40),
        },
      };
    },
  ]);
}
for (const key of legacyKeys)
  negative.push([
    `legacy provenance ${key}`,
    (f) => {
      (f.l as any)[key] = "wrong";
    },
  ]);
for (const key of shadowKeys)
  negative.push([
    `shadow provenance ${key}`,
    (f) => {
      (f.r as any)[key] = "wrong";
    },
  ]);
negative.push(
  [
    "untrusted immutable identity",
    (f) => {
      (f.trusted as any).immutableRepositoryId = "other";
    },
  ],
  [
    "policy revoked",
    (f) => {
      (f.trusted as any).privacyExportAllowed = false;
    },
  ],
  [
    "policy expired",
    (f) => {
      f.trusted.validUntilMs = 0;
    },
  ],
  [
    "separate run",
    (f) => {
      (f.s as any).pairing = "separate_run";
    },
  ],
  [
    "unknown selector",
    (f) => {
      (f.s as any).secret = "sensitive";
    },
  ],
  [
    "oversized selector",
    (f) => {
      f.s.legacyObservationId = "x".repeat(17000);
    },
  ],
  [
    "investigation legacy",
    (f) => {
      (f.l as any).executionProfile = "investigation_gateway_v1";
      (f.s.legacy as any).executionProfile = "investigation_gateway_v1";
    },
  ],
  [
    "certificate baseline",
    (f) => {
      (f.l as any).investigationCertificateId = "certificate";
    },
  ],
  [
    "quality flag",
    (f) => {
      (f.l as any).qualityFlags = ["investigation_findings"];
    },
  ],
  [
    "legacy payload",
    (f) => {
      (f.l.payload.safeUsage as any).inputTokens = 999;
    },
  ],
  [
    "terminal payload",
    (f) => {
      (f.r as any).terminalObservationCanonicalJson =
        f.r.terminalObservationCanonicalJson.replace("10", "11");
    },
  ],
  [
    "noncanonical terminal",
    (f) => {
      (f.r as any).terminalObservationCanonicalJson += " ";
    },
  ],
  [
    "legacy accounting",
    (f) => {
      (f.l as any).byteCount++;
    },
  ],
  [
    "legacy finding count",
    (f) => {
      (f.l as any).findingCount++;
    },
  ],
  [
    "terminal accounting",
    (f) => {
      (f.r as any).terminalPayloadByteCount++;
    },
  ],
  [
    "terminal finding count",
    (f) => {
      (f.r as any).findingCount++;
    },
  ],
  [
    "record digest",
    (f) => {
      (f.r as any).recordHash = hash("bad");
    },
  ],
  [
    "retention legacy",
    (f) => {
      (f.l as any).retainUntilMs = 0;
    },
  ],
  [
    "retention shadow",
    (f) => {
      (f.r as any).retainUntilMs = 0;
    },
  ],
);
for (const key of [
  "scopeHash",
  "investigationId",
  "investigationVersion",
  "stableReviewUnitKey",
  "providerVoteLaneId",
  "producerReleaseId",
  "conclusion",
  "terminalProviderKind",
  "terminalActualModel",
  "terminalOutcomeHash",
  "reviewRevisionHash",
  "issuedAt",
]) {
  negative.push([
    `rehash certificate tamper ${key}`,
    (f) => {
      const c = JSON.parse(f.r.certificateCanonicalJson);
      c[key] =
        key === "investigationVersion"
          ? f.r.investigationVersion
          : key === "issuedAt"
            ? new Date(f.r.issuedAtMs + 1).toISOString()
            : key === "terminalProviderKind"
              ? "claude_code"
              : key === "conclusion"
                ? "inconclusive"
                : hash("wrong");
      (f.r as any).certificateCanonicalJson = stableJson(c);
      (f.r as any).certificateHash = hash(f.r.certificateCanonicalJson);
      (f.r as any).recordHash = hash(
        stableJson(investigationShadowEvidenceRecordCanonicalValue(f.r)),
      );
    },
  ]);
}
for (const [name, mutate] of negative)
  test(name, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(run(f), {
      message: "pair_export_unavailable_or_denied",
    });
  });
for (const missing of ["legacy", "shadow"] as const)
  test(`missing ${missing} never falls back`, async () => {
    await assert.rejects(run(fixture(), missing), {
      message: "pair_export_unavailable_or_denied",
    });
  });
test("denied selection never reads stores, storage error sanitized", async () => {
  const f = fixture();
  let calls = 0;
  const ports = {
    observations: {
      findById: async () => {
        calls++;
        throw new Error("credential and finding");
      },
    },
    shadows: { findById: async () => null },
  };
  await assert.rejects(
    readExactReviewInvestigationPair(
      { ...f.s, extra: true },
      f.trusted,
      ports,
      () => shadowIssuedAtMs,
    ),
    { message: "pair_export_unavailable_or_denied" },
  );
  assert.equal(calls, 0);
  await assert.rejects(
    readExactReviewInvestigationPair(
      f.s,
      f.trusted,
      ports,
      () => shadowIssuedAtMs,
    ),
    { message: "pair_export_unavailable_or_denied" },
  );
});
test("atomic restricted output refuses overwrite and symlink; bounded input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pair-export-test-"));
  try {
    await chmod(dir, 0o700);
    const path = join(dir, "artifact.json");
    await writeRestrictedArtifact(path, { secretFinding: "private" });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const original = await readFile(path, "utf8");
    await assert.rejects(writeRestrictedArtifact(path, { replacement: true }));
    assert.equal(await readFile(path, "utf8"), original);
    await symlink(path, join(dir, "symlink"));
    await assert.rejects(writeRestrictedArtifact(join(dir, "symlink"), {}));
    await assert.rejects(readBoundedJson(join(dir, "symlink")));
    await writeRestrictedArtifact(join(dir, "large"), {
      value: "x".repeat(17000),
    });
    await assert.rejects(readBoundedJson(join(dir, "large")));
    assert.ok(!(await readdir(dir)).some((n) => n.endsWith(".tmp")));
    await chmod(dir, 0o755);
    await assert.rejects(writeRestrictedArtifact(join(dir, "denied"), {}));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent publication has one complete winner, no partial files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pair-export-race-"));
  try {
    const target = join(dir, "pair.json");
    const results = await Promise.allSettled([
      writeRestrictedArtifact(target, { winner: 1 }),
      writeRestrictedArtifact(target, { winner: 2 }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(
      [1, 2].includes(JSON.parse(await readFile(target, "utf8")).winner),
    );
    assert.deepEqual(await readdir(dir), ["pair.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function expiringFixture(expiry: "policy" | "legacy" | "shadow") {
  const f = fixture();
  const deadline =
    expiry === "shadow" ? f.r.retainUntilMs : shadowIssuedAtMs + 10000;
  f.trusted.validUntilMs = deadline + (expiry === "policy" ? 0 : 1000);
  f.l = {
    ...f.l,
    retainUntilMs: deadline + (expiry === "legacy" ? 0 : 1000),
  };
  return f;
}

for (const expiry of ["policy", "legacy", "shadow"] as const) {
  for (const offset of [-1, 0, 1]) {
    test(`delayed reads recheck ${expiry} expiry at offset ${offset}`, async () => {
      const f = expiringFixture(expiry);
      const deadline =
        expiry === "policy"
          ? f.trusted.validUntilMs
          : expiry === "legacy"
            ? f.l.retainUntilMs
            : f.r.retainUntilMs;
      let now = shadowIssuedAtMs + 2000;
      const result = readExactReviewInvestigationPair(
        f.s,
        f.trusted,
        {
          observations: { findById: async () => f.l },
          shadows: {
            findById: async () => {
              await Promise.resolve();
              now = deadline + offset;
              return f.r;
            },
          },
        },
        () => now,
      );
      if (offset < 0) {
        const artifact = await result;
        assert.equal(artifact.body.exportedAtMs, now);
      } else {
        await assert.rejects(result, {
          message: "pair_export_unavailable_or_denied",
        });
      }
    });
  }
  for (const phase of ["before preparation", "during preparation"] as const) {
    test(`publication rejects ${expiry} expiry ${phase}`, async () => {
      const artifact = await run(expiringFixture(expiry));
      const deadline =
        expiry === "policy"
          ? artifact.body.verifiedBindings.trustedScope.validUntilMs
          : expiry === "legacy"
            ? artifact.body.legacy.retainUntilMs
            : artifact.body.investigation.retainUntilMs;
      let now = shadowIssuedAtMs + 2000;
      const dir = await mkdtemp(join(tmpdir(), "pair-export-expiry-"));
      try {
        if (phase === "before preparation") now = deadline;
        await assert.rejects(
          writeGuardedArtifact(
            join(dir, "pair.json"),
            {
              toJSON() {
                // Advance while the writer awaits filesystem preparation,
                // after serialization but before sync/close/publication.
                if (phase === "during preparation") {
                  queueMicrotask(() => {
                    now = deadline;
                  });
                }
                return artifact;
              },
            },
            () => assertPairExportPublishable(artifact, () => now),
          ),
          { message: "pair_export_unavailable_or_denied" },
        );
        assert.deepEqual(await readdir(dir), []);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}
