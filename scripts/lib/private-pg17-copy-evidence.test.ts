import { describe, expect, it } from "vitest";
import { parsePrivatePg17CopyEvidence } from "./private-pg17-copy-evidence";

const digest =
  "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f";
const evidence = () => ({
  rollout: {},
  releaseImageProvenance: {},
  roleBootstrapRunner: {},
  backup: {},
  quiescence: {
    writerServices: [],
    aclSha256: `sha256:${"a".repeat(64)}`,
    stabilizationSeries: [0, 0, 0],
    reconnectDeniedRoles: ["runtime"],
    legacyAmbiguity: {
      inventorySha256: digest,
      activeLeaseIds: [],
      fetchedSetupIds: [],
      pendingIntentIds: [],
      intentStatuses: [],
      observations: [
        { observedAt: "2026-08-15T00:00:00.000Z", inventorySha256: digest },
        { observedAt: "2026-08-15T00:00:01.000Z", inventorySha256: digest },
      ],
      stable: true,
    },
    fence: {},
    complete: true,
  },
  equivalence: {},
  generationBinding: {},
  roleBootstrap: {},
});

describe("private PG17 copy evidence parser", () => {
  it("accepts the direct quiescence artifact emitted by copy bootstrap", () => {
    expect(parsePrivatePg17CopyEvidence(evidence()).quiescence.complete).toBe(
      true,
    );
  });
  it("rejects the obsolete nested shape and unknown compatibility fields", () => {
    const nested = evidence();
    nested.quiescence = { evidence: nested.quiescence } as never;
    expect(() => parsePrivatePg17CopyEvidence(nested)).toThrow(
      "private_pg17_copy_evidence_shape_invalid",
    );
    expect(() =>
      parsePrivatePg17CopyEvidence({ ...evidence(), compatibility: true }),
    ).toThrow("private_pg17_copy_evidence_shape_invalid");
  });
});
