import {
  parseRetainedFact,
  type RetainedFactInput,
} from "../infrastructure/prisma/certified-fork-proof-fact-types.js";

// Disposable storage DTOs. These do not establish authenticated domain facts.
export const fixtureHash = (n: number) => n.toString(16).padStart(64, "0");
export function inventoryFact(
  id = "inventory",
): RetainedFactInput<"inventory"> {
  return {
    proofId: id,
    kind: "inventory",
    scope: {
      workspaceId: "tenant",
      repositoryConnectionId: "repo",
      familyKey: fixtureHash(1),
      reviewHash: fixtureHash(2),
    },
    provenance: {
      producerKind: "planner",
      producerId: "disposable",
      producerVersion: "v1",
      sourceKey: `source:${id}`,
      sourceRevision: "1",
      observedAtMs: 1,
      validUntilMs: 2,
    },
    payload: {
      plan: [],
      dependencies: [],
      expectedEffectKeys: [],
      plannerVersion: "1",
      renderVersion: "1",
      limitsVersion: "1",
      outputProof: null,
    },
  };
}
export function outputFact(id = "output"): RetainedFactInput<"output"> {
  const base = inventoryFact(id);
  return parseRetainedFact({
    ...base,
    kind: "output",
    payload: {
      modelOutput: JSON.parse(
        '{"constructor":{"prototype":{"safe":true}},"__proto__":{"polluted":true},"prototype":"code","token":"identifier","authorization":"documented field"}',
      ),
      outputBytes:
        '  // Bearer example; eyJexample.payload.signature\r\nconst token = "not a credential";\n' +
        "源🙂".repeat(1500),
      filePaths: ["src/auth.ts"],
      bindingHash: fixtureHash(3),
      contextHash: fixtureHash(4),
      requestHash: fixtureHash(5),
      effectKey: fixtureHash(6),
      successEvidenceProof: "success",
      outputCommitmentHash: fixtureHash(7),
      commitIdentity: "commit",
      committedAtMs: 1,
      sourceArtifact: { bytes: "source" },
    },
  }) as RetainedFactInput<"output">;
}
