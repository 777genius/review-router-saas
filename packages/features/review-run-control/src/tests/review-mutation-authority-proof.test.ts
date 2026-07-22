import { describe, expect, it } from "vitest";
import type { ClockPort } from "../application/ports/platform-ports";
import type {
  ReviewMutationAuthorityProofFactsQueryPorts,
  ReviewMutationAuthorityProofFactsSnapshot,
} from "../application/ports/review-mutation-authority-proof-ports";
import { ReviewMutationAuthorityProofCollector } from "../application/services/review-mutation-authority-proof-collector";
import {
  ManageReviewMutationAuthority,
  ReviewMutationAuthorityCommandKind,
  ReviewMutationAuthorityPreflightStatus,
} from "../application/use-cases/manage-review-mutation-authority";
import {
  ReviewMutationAuthorityProofBlocker,
  reviewMutationAuthorityProofReference,
  type ReviewMutationAbortProofFacts,
  type ReviewMutationActivationProofFacts,
  type ReviewMutationDirectV2InitializationProofFacts,
  type ReviewMutationResumeProofFacts,
} from "../domain/review-mutation-authority-proof";
import {
  ReviewMutationAuthorityInitializationMode,
  ReviewMutationMode,
  ReviewRunControlErrorCode,
} from "../domain/review-run-control-types";
import { InMemoryReviewRunControlStore } from "../infrastructure/memory/in-memory-review-run-control-store";
import { NodeSha256Digest } from "../infrastructure/node-sha256-digest";
import { hashA, hashB } from "./fixtures";

const t0 = new Date("2026-01-01T00:00:00.000Z");
const activationAt = new Date("2026-01-01T00:01:00.000Z");

describe("ReviewMutationAuthority proof contract", () => {
  it("initializes direct V2 only from fresh server-owned proof and restores retries", async () => {
    const harness = emptyHarness();
    const proof = requirePreflightProof(
      await harness.manager.preflight({
        scmRepositoryIdentityId: "scm-direct",
        operation: ReviewMutationAuthorityCommandKind.DirectV2Initialize,
      }),
    );
    const reference = reviewMutationAuthorityProofReference(proof);

    await expect(
      harness.manager.initializeDirectV2({
        scmRepositoryIdentityId: "scm-direct",
        proof: reference,
      }),
    ).resolves.toMatchObject({
      status: "created",
      authority: { mode: ReviewMutationMode.V2Active, version: 1, epoch: 1n },
    });
    await expect(
      harness.manager.initializeDirectV2({
        scmRepositoryIdentityId: "scm-direct",
        proof: reference,
      }),
    ).resolves.toMatchObject({ status: "restored" });
    expect(harness.facts.directV2Inspections).toBe(3);
  });

  it("rejects direct-V2 initialization when server facts drift after preflight", async () => {
    const harness = emptyHarness();
    const proof = requirePreflightProof(
      await harness.manager.preflight({
        scmRepositoryIdentityId: "scm-direct",
        operation: ReviewMutationAuthorityCommandKind.DirectV2Initialize,
      }),
    );
    harness.facts.directV2 = {
      factsVersion: "direct-v2-v2",
      facts: {
        ...harness.facts.directV2.facts,
        noLegacyCapabilityEverIssued: false,
      },
    };

    await expect(
      harness.manager.initializeDirectV2({
        scmRepositoryIdentityId: "scm-direct",
        proof: reviewMutationAuthorityProofReference(proof),
      }),
    ).rejects.toMatchObject({
      code: ReviewRunControlErrorCode.ProofRequired,
      message: "mutation_authority_proof_facts_changed",
    });
    await expect(
      harness.store.findReviewMutationAuthority({
        scmRepositoryIdentityId: "scm-direct",
        laneKind: proof.laneKind,
      }),
    ).resolves.toBeNull();
  });

  it("rejects stale direct-V2 initialization proof before rereading facts", async () => {
    const harness = emptyHarness();
    const proof = requirePreflightProof(
      await harness.manager.preflight({
        scmRepositoryIdentityId: "scm-direct",
        operation: ReviewMutationAuthorityCommandKind.DirectV2Initialize,
      }),
    );
    const inspectionsBefore = harness.facts.directV2Inspections;
    harness.clock.value = new Date(t0.getTime() + 60_001);

    await expect(
      harness.manager.initializeDirectV2({
        scmRepositoryIdentityId: "scm-direct",
        proof: reviewMutationAuthorityProofReference(proof),
      }),
    ).rejects.toMatchObject({
      code: ReviewRunControlErrorCode.ProofRequired,
      message: "mutation_authority_proof_stale",
    });
    expect(harness.facts.directV2Inspections).toBe(inspectionsBefore);
  });

  it("revalidates direct-V2 facts selected by server initialization policy", async () => {
    const harness = emptyHarness(
      ReviewMutationAuthorityInitializationMode.DirectV2,
    );
    const initial = harness.facts.directV2;
    harness.facts.inspectDirectV2InitializationFacts = async () => {
      harness.facts.directV2Inspections += 1;
      return harness.facts.directV2Inspections === 1
        ? initial
        : {
            factsVersion: "direct-v2-raced-v2",
            facts: {
              ...initial.facts,
              freshV2OnlyProvisioningProven: false,
            },
          };
    };

    await expect(
      harness.manager.initialize({
        scmRepositoryIdentityId: "scm-direct-policy",
      }),
    ).rejects.toMatchObject({
      code: ReviewRunControlErrorCode.ProofRequired,
      message: "mutation_authority_proof_facts_changed",
    });
  });

  it("computes activation facts server-side and restores an idempotent retry", async () => {
    const harness = await drainingHarness();
    harness.clock.value = activationAt;

    const preflight = await harness.manager.preflight({
      scmRepositoryIdentityId: "scm-1",
      operation: ReviewMutationAuthorityCommandKind.Activate,
    });
    expect(preflight.status).toBe(ReviewMutationAuthorityPreflightStatus.Ready);
    const proof = requirePreflightProof(preflight);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.facts)).toBe(true);
    expect(Object.isFrozen(harness.facts.activation.facts)).toBe(false);
    const reference = reviewMutationAuthorityProofReference(proof);

    const activated = await harness.manager.activate({
      scmRepositoryIdentityId: "scm-1",
      expectedVersion: 2,
      proof: reference,
    });
    expect(activated).toMatchObject({
      status: "updated",
      authority: { mode: ReviewMutationMode.V2Active, version: 3, epoch: 1n },
    });

    const retry = await harness.manager.activate({
      scmRepositoryIdentityId: "scm-1",
      expectedVersion: 2,
      proof: reference,
    });
    expect(retry).toMatchObject({
      status: "restored",
      authority: { mode: ReviewMutationMode.V2Active, version: 3, epoch: 1n },
    });
  });

  it("uses the segregated abort and resume fact queries", async () => {
    const abortHarness = await drainingHarness();
    const abortPreflight = requirePreflightProof(
      await abortHarness.manager.preflight({
        scmRepositoryIdentityId: "scm-1",
        operation: ReviewMutationAuthorityCommandKind.AbortDrain,
      }),
    );
    await expect(
      abortHarness.manager.abortDrain({
        scmRepositoryIdentityId: "scm-1",
        expectedVersion: 2,
        proof: reviewMutationAuthorityProofReference(abortPreflight),
      }),
    ).resolves.toMatchObject({
      status: "updated",
      authority: { mode: ReviewMutationMode.V1Open, version: 3 },
    });
    expect(abortHarness.facts.abortInspections).toBe(2);

    const resumeHarness = await drainingHarness();
    resumeHarness.clock.value = activationAt;
    const activationProof = requirePreflightProof(
      await resumeHarness.manager.preflight({
        scmRepositoryIdentityId: "scm-1",
        operation: ReviewMutationAuthorityCommandKind.Activate,
      }),
    );
    await resumeHarness.manager.activate({
      scmRepositoryIdentityId: "scm-1",
      expectedVersion: 2,
      proof: reviewMutationAuthorityProofReference(activationProof),
    });
    resumeHarness.clock.value = new Date("2026-01-01T00:02:00.000Z");
    await resumeHarness.manager.pause({
      scmRepositoryIdentityId: "scm-1",
      expectedVersion: 3,
    });
    resumeHarness.clock.value = new Date("2026-01-01T00:03:00.000Z");
    const resumeProof = requirePreflightProof(
      await resumeHarness.manager.preflight({
        scmRepositoryIdentityId: "scm-1",
        operation: ReviewMutationAuthorityCommandKind.Resume,
      }),
    );
    await expect(
      resumeHarness.manager.resume({
        scmRepositoryIdentityId: "scm-1",
        expectedVersion: 4,
        proof: reviewMutationAuthorityProofReference(resumeProof),
      }),
    ).resolves.toMatchObject({
      status: "updated",
      authority: { mode: ReviewMutationMode.V2Active, version: 5, epoch: 2n },
    });
    expect(resumeHarness.facts.resumeInspections).toBe(2);
  });

  it("rejects a proof when facts or their source version changed", async () => {
    const harness = await drainingHarness();
    harness.clock.value = activationAt;
    const proof = requirePreflightProof(
      await harness.manager.preflight({
        scmRepositoryIdentityId: "scm-1",
        operation: ReviewMutationAuthorityCommandKind.Activate,
      }),
    );
    harness.facts.activation = {
      factsVersion: "activation-v2",
      facts: {
        ...harness.facts.activation.facts,
        workflowInventoryCompatible: false,
      },
    };

    await expect(
      harness.manager.activate({
        scmRepositoryIdentityId: "scm-1",
        expectedVersion: 2,
        proof: reviewMutationAuthorityProofReference(proof),
      }),
    ).rejects.toMatchObject({
      code: ReviewRunControlErrorCode.ProofRequired,
      message: "mutation_authority_proof_facts_changed",
    });
  });

  it("rejects expired proofs without consulting mutable facts again", async () => {
    const harness = await drainingHarness();
    harness.clock.value = activationAt;
    const proof = requirePreflightProof(
      await harness.manager.preflight({
        scmRepositoryIdentityId: "scm-1",
        operation: ReviewMutationAuthorityCommandKind.Activate,
      }),
    );
    const inspectionsBefore = harness.facts.activationInspections;
    harness.clock.value = new Date(activationAt.getTime() + 60_001);

    await expect(
      harness.manager.activate({
        scmRepositoryIdentityId: "scm-1",
        expectedVersion: 2,
        proof: reviewMutationAuthorityProofReference(proof),
      }),
    ).rejects.toMatchObject({
      code: ReviewRunControlErrorCode.ProofRequired,
      message: "mutation_authority_proof_stale",
    });
    expect(harness.facts.activationInspections).toBe(inspectionsBefore);
  });

  it("keeps authority-version CAS authoritative after a valid preflight", async () => {
    const harness = await drainingHarness();
    harness.clock.value = activationAt;
    const proof = requirePreflightProof(
      await harness.manager.preflight({
        scmRepositoryIdentityId: "scm-1",
        operation: ReviewMutationAuthorityCommandKind.Activate,
      }),
    );
    harness.clock.value = new Date("2026-01-01T00:01:10.000Z");
    await harness.manager.beginDrain({
      scmRepositoryIdentityId: "scm-1",
      expectedVersion: 2,
      drainPolicyVersion: 2,
      drainWindowMs: 120_000,
    });

    await expect(
      harness.manager.activate({
        scmRepositoryIdentityId: "scm-1",
        expectedVersion: 2,
        proof: reviewMutationAuthorityProofReference(proof),
      }),
    ).rejects.toMatchObject({
      code: ReviewRunControlErrorCode.VersionConflict,
      message: "mutation_authority_version_conflict",
    });
  });

  it("reports every server-owned blocker and never emits a ready proof for a wrong mode", async () => {
    const harness = await drainingHarness();
    harness.clock.value = activationAt;
    harness.facts.activation = {
      factsVersion: "activation-blocked-v1",
      facts: {
        ...harness.facts.activation.facts,
        noTrackedLegacyActivity: false,
        workflowInventoryCompatible: false,
        safetyDecisionEnabled: false,
      },
    };
    const blocked = await harness.manager.preflight({
      scmRepositoryIdentityId: "scm-1",
      operation: ReviewMutationAuthorityCommandKind.Activate,
    });
    expect(blocked).toMatchObject({
      status: ReviewMutationAuthorityPreflightStatus.Blocked,
      blockers: [
        ReviewMutationAuthorityProofBlocker.LegacyActivityExists,
        ReviewMutationAuthorityProofBlocker.WorkflowInventoryIncompatible,
        ReviewMutationAuthorityProofBlocker.MutationSafetyDisabled,
      ],
    });

    const wrongMode = await harness.manager.preflight({
      scmRepositoryIdentityId: "scm-1",
      operation: ReviewMutationAuthorityCommandKind.Resume,
    });
    expect(wrongMode).toMatchObject({
      status: ReviewMutationAuthorityPreflightStatus.Blocked,
      blockers: ["operation_not_allowed_from_v1_draining"],
    });
  });
});

class MutableClock implements ClockPort {
  constructor(public value: Date) {}

  now(): Date {
    return new Date(this.value);
  }
}

class MutableProofFacts implements ReviewMutationAuthorityProofFactsQueryPorts {
  directV2Inspections = 0;
  activationInspections = 0;
  abortInspections = 0;
  resumeInspections = 0;
  directV2: ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationDirectV2InitializationProofFacts> =
    {
      factsVersion: "direct-v2-v1",
      facts: {
        freshV2OnlyProvisioningProven: true,
        noLegacyCapabilityEverIssued: true,
        managedWorkflowInventoryHash: hashA,
        safetyDecisionEnabled: true,
        activationSafetyDecisionHash: hashB,
      },
    };
  abort: ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationAbortProofFacts> =
    {
      factsVersion: "abort-v1",
      facts: { noV2AuthorizationOrMutationExists: true },
    };
  activation: ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationActivationProofFacts> =
    {
      factsVersion: "activation-v1",
      facts: {
        noTrackedLegacyActivity: true,
        workflowInventoryCompatible: true,
        managedWorkflowInventoryHash: hashA,
        safetyDecisionEnabled: true,
        activationSafetyDecisionHash: hashB,
      },
    };
  resume: ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationResumeProofFacts> =
    {
      factsVersion: "resume-v1",
      facts: {
        unknownEffectsReconciled: true,
        repositoryBound: true,
        registeredReleaseSelected: true,
        safetyDecisionEnabled: true,
        activationSafetyDecisionHash: hashA,
      },
    };

  async inspectAbortDrainFacts() {
    this.abortInspections += 1;
    return this.abort;
  }

  async inspectDirectV2InitializationFacts() {
    this.directV2Inspections += 1;
    return this.directV2;
  }

  async inspectActivationFacts() {
    this.activationInspections += 1;
    return this.activation;
  }

  async inspectResumeFacts() {
    this.resumeInspections += 1;
    return this.resume;
  }
}

async function drainingHarness() {
  const harness = emptyHarness();
  const { manager } = harness;
  await manager.initialize({ scmRepositoryIdentityId: "scm-1" });
  await manager.beginDrain({
    scmRepositoryIdentityId: "scm-1",
    expectedVersion: 1,
    drainPolicyVersion: 1,
    drainWindowMs: 60_000,
  });
  return harness;
}

function emptyHarness(
  initializationMode = ReviewMutationAuthorityInitializationMode.V1,
) {
  const clock = new MutableClock(t0);
  const facts = new MutableProofFacts();
  const store = new InMemoryReviewRunControlStore();
  const proofs = new ReviewMutationAuthorityProofCollector({
    digest: new NodeSha256Digest(),
    facts,
    proofTtlMs: 60_000,
  });
  const manager = new ManageReviewMutationAuthority({
    clock,
    queries: store,
    commands: store,
    proofs,
    initializationPolicy: {
      async selectInitializationMode() {
        return initializationMode;
      },
    },
  });
  return { clock, facts, manager, store };
}

function requirePreflightProof(
  preflight: Awaited<ReturnType<ManageReviewMutationAuthority["preflight"]>>,
) {
  if (!("proof" in preflight) || !preflight.proof) {
    throw new Error("expected_mutation_authority_proof");
  }
  return preflight.proof;
}
