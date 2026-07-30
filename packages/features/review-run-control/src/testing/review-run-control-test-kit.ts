import type {
  ClockPort,
  IdentifierFactoryPort,
} from "../application/ports/platform-ports";
import type {
  ReviewMutationAuthorityProofFactsQueryPorts,
  ReviewMutationAuthorityProofFactsSnapshot,
} from "../application/ports/review-mutation-authority-proof-ports";
import type {
  ReviewMutationAbortProofFacts,
  ReviewMutationActivationProofFacts,
  ReviewMutationDirectV2InitializationProofFacts,
  ReviewMutationResumeProofFacts,
} from "../domain/review-mutation-authority-proof";
import { ReviewMutationExecutionAuthorityMode } from "../domain/review-mutation-authority-proof";
import { ReviewMutationAuthorityInitializationMode } from "../domain/review-run-control-types";
import {
  JoseRotatingCapabilityCodec,
  type SignedCapabilityCodecPort,
} from "@reviewrouter/platform-signed-capabilities";
import { InMemoryCapabilityKeyRing } from "@reviewrouter/platform-signed-capabilities/testing";
import {
  composeReviewRunControl,
  type ReviewRunControlComposition,
} from "../composition/compose-review-run-control";
import type { ReviewProtocolLimits } from "../domain/producer-release";
import { InMemoryReviewRunControlStore } from "../infrastructure/memory/in-memory-review-run-control-store";
import { ReviewRunAuthorizationSignedCapabilityAdapter } from "../infrastructure/signed-capabilities/review-run-authorization-token-adapter";
import { NodeSha256Digest } from "../infrastructure/node-sha256-digest";

export const testAbsoluteProtocolMaxima: ReviewProtocolLimits = {
  maxWorkSlots: 1_000,
  maxAttemptsPerSlot: 20,
  maxObservationBytes: 10_000_000,
  maxObservationFindings: 10_000,
  maxProjectionBytes: 20_000_000,
  maxProjectionFindings: 20_000,
  maxPublicationOperations: 10_000,
  maxPublicationChunks: 10_000,
  maxPublicationBodyBytes: 10_000_000,
  maxRequestBatchSize: 1_000,
  maxLeaseDurationMs: 3_600_000,
  maxResultReportDurationMs: 7_200_000,
  maxReconciliationDurationMs: 86_400_000,
};

export class MutableClock implements ClockPort {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  set(value: Date): void {
    this.current = new Date(value);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export class SequentialIdentifierFactory implements IdentifierFactoryPort {
  private next = 1;

  nextId(prefix: string): string {
    return `${prefix}_${this.next++}`;
  }
}

export type ReviewRunControlTestKit = {
  readonly clock: MutableClock;
  readonly identifiers: SequentialIdentifierFactory;
  readonly digest: NodeSha256Digest;
  readonly tokens: ReviewRunAuthorizationSignedCapabilityAdapter;
  readonly tokenCodec: SignedCapabilityCodecPort;
  readonly tokenKeyRing: InMemoryCapabilityKeyRing;
  readonly store: InMemoryReviewRunControlStore;
  readonly mutationAuthorityProofFacts: TestReviewMutationAuthorityProofFacts;
  readonly control: ReviewRunControlComposition;
};

export function createReviewRunControlTestKit(input?: {
  readonly now?: Date | undefined;
  readonly absoluteProtocolMaxima?: ReviewProtocolLimits | undefined;
  readonly tokenIssuer?: string | undefined;
}): ReviewRunControlTestKit {
  const clock = new MutableClock(
    input?.now ?? new Date("2026-01-01T00:00:00.000Z"),
  );
  const identifiers = new SequentialIdentifierFactory();
  const digest = new NodeSha256Digest();
  const tokenKeyRing = new InMemoryCapabilityKeyRing({
    keyId: "test-key-v1",
    secret: testSigningSecret("review-run-control-test-secret-v1"),
  });
  const tokenCodec = new JoseRotatingCapabilityCodec(tokenKeyRing, 0);
  const tokens = new ReviewRunAuthorizationSignedCapabilityAdapter(
    tokenCodec,
    tokenKeyRing,
    input?.tokenIssuer,
  );
  const store = new InMemoryReviewRunControlStore();
  const mutationAuthorityProofFacts =
    new TestReviewMutationAuthorityProofFacts();
  const control = composeReviewRunControl({
    clock,
    identifiers,
    digest,
    tokens,
    protocolLimitsQueries: store,
    protocolLimitsCommands: store,
    operationalSloQueries: store,
    operationalSloCommands: store,
    releaseQueries: store,
    releaseCommands: store,
    identityQueries: store,
    identityCommands: store,
    authorityQueries: store,
    authorityCommands: store,
    mutationAuthorityProofFacts,
    mutationAuthorityInitializationPolicy: {
      async selectInitializationMode() {
        return ReviewMutationAuthorityInitializationMode.DirectV2;
      },
    },
    policyQueries: store,
    policyCommands: store,
    emergencyQueries: store,
    emergencyCommands: store,
    safetyInspections: store,
    authorizationQueries: store,
    authorizationCommands: store,
    absoluteProtocolMaxima:
      input?.absoluteProtocolMaxima ?? testAbsoluteProtocolMaxima,
  });
  return {
    clock,
    identifiers,
    digest,
    tokens,
    tokenCodec,
    tokenKeyRing,
    store,
    mutationAuthorityProofFacts,
    control,
  };
}

export class TestReviewMutationAuthorityProofFacts implements ReviewMutationAuthorityProofFactsQueryPorts {
  directV2: ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationDirectV2InitializationProofFacts> =
    {
      factsVersion: "test-direct-v2-v1",
      facts: {
        freshV2OnlyProvisioningProven: true,
        noLegacyCapabilityEverIssued: true,
        workflowInventoryCompatible: true,
        registeredReleaseSelected: true,
        completionWorkerConfigured: true,
        executionAuthorityMode:
          ReviewMutationExecutionAuthorityMode.ManagedDispatch,
        managedWorkflowInventoryHash: "a".repeat(64),
        safetyDecisionEnabled: true,
        activationSafetyDecisionHash: "b".repeat(64),
      },
    };
  abort: ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationAbortProofFacts> =
    {
      factsVersion: "test-abort-v1",
      facts: { noV2AuthorizationOrMutationExists: true },
    };
  activation: ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationActivationProofFacts> =
    {
      factsVersion: "test-activation-v1",
      facts: {
        noTrackedLegacyActivity: true,
        workflowInventoryCompatible: true,
        registeredReleaseSelected: true,
        completionWorkerConfigured: true,
        dispatchCapabilityAvailable: true,
        managedWorkflowInventoryHash: "a".repeat(64),
        safetyDecisionEnabled: true,
        activationSafetyDecisionHash: "b".repeat(64),
      },
    };
  resume: ReviewMutationAuthorityProofFactsSnapshot<ReviewMutationResumeProofFacts> =
    {
      factsVersion: "test-resume-v1",
      facts: {
        unknownEffectsReconciled: true,
        repositoryBound: true,
        registeredReleaseSelected: true,
        dispatchCapabilityAvailable: true,
        safetyDecisionEnabled: true,
        activationSafetyDecisionHash: "b".repeat(64),
      },
    };

  async inspectDirectV2InitializationFacts() {
    return this.directV2;
  }

  async inspectAbortDrainFacts() {
    return this.abort;
  }

  async inspectActivationFacts() {
    return this.activation;
  }

  async inspectResumeFacts() {
    return this.resume;
  }
}

export function testSigningSecret(seed: string): Uint8Array {
  return new TextEncoder().encode(seed.padEnd(32, "."));
}
