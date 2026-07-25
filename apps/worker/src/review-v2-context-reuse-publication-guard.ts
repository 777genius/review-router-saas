import { createHash, timingSafeEqual } from "node:crypto";
import {
  ActualModelCompatibilityMode,
  ProviderExecutionProfile,
  ReviewProviderKind as EvidenceProviderKind,
  ReviewReuseEffectMode,
  ReviewTaskKind as EvidenceTaskKind,
  canonicalizeReviewContextReusePolicyVector,
  reviewReuseEligibilityPolicyVersion,
} from "@reviewrouter/features-review-evidence";
import {
  ReviewProviderKind,
  ReviewSafetyDecisionKind,
  ReviewTaskKind,
  canonicalJson,
  type ReviewSafetyDecisionResolverPort,
} from "@reviewrouter/features-review-run-control";
import type { ReviewPublicationPermitIdentity } from "@reviewrouter/features-review-publishing/v2";

export type ContextReusePublicationBinding = Readonly<{
  targetExecutionId: string;
  targetWorkSlotId: string;
  reusePolicyVectorHash: string | null;
  observation: Readonly<{
    observationId: string;
    workspaceId: string;
    repositoryConnectionId: string;
    scmRepositoryIdentityId: string;
    pullRequestNumber: number;
    providerKind: EvidenceProviderKind;
    taskKindSet: readonly EvidenceTaskKind[];
    requestedModel: string;
    actualModel: string;
    providerRuntimeVersion: string;
    producerReleaseId: string;
    selectedProtocolVersion: string;
    trustedCapabilityProfile: string;
    executionProfile: ProviderExecutionProfile;
    sourceExecutionId: string;
    sourceWorkSlotId: string;
    sourceReviewRevisionHash: string;
    attemptId: string;
    sourceLeaseId: string;
    sourceFencingToken: string;
    contextAttestationId: string | null;
    contextAttestationHash: string | null;
    reuseExpiresAtMs: number;
  }>;
  attestation: Readonly<{
    attestationId: string;
    attestationHash: string;
    sessionId: string;
    sourceExecutionId: string;
    sourceWorkSlotId: string;
    sourceReviewRevisionHash: string;
    attemptId: string;
    sourceLeaseId: string;
    sourceFencingToken: string;
    actualModel: string;
    reuseExpiresAtMs: number;
  }> | null;
  session: Readonly<{
    sessionId: string;
    workspaceId: string;
    repositoryConnectionId: string;
    scmRepositoryIdentityId: string;
    pullRequestNumber: number;
    sourceExecutionId: string;
    sourceWorkSlotId: string;
    sourceReviewRevisionHash: string;
    attemptId: string;
    sourceLeaseId: string;
    sourceFencingToken: string;
    requestedModel: string;
    trustedCapabilityProfile: string;
    gatewayPolicyVersion: string;
    gatewayBinaryHash: string;
    producerReleaseId: string;
    selectedProtocolVersion: string;
    state: string;
    expiresAtMs: number;
  }> | null;
}>;

export interface ContextReusePublicationBindingQueryPort {
  findContextReuseBindings(
    executionId: string,
  ): Promise<readonly ContextReusePublicationBinding[] | null>;
}

export interface ContextReuseProducerReleaseQueryPort {
  findContextReuseProducerRelease(producerReleaseId: string): Promise<Readonly<{
    producerReleaseId: string;
    registered: boolean;
    capabilityProfile: string;
    runtimeCommitSha: string;
    contextGatewayPolicyVersion: string | null;
    contextGatewayEntrypointDigest: string | null;
  }> | null>;
}

export interface ReviewV2ContextReusePublicationGuardPort {
  isCurrent(permit: ReviewPublicationPermitIdentity): Promise<boolean>;
}

export class VerifyCurrentContextReusePublicationPolicy implements ReviewV2ContextReusePublicationGuardPort {
  constructor(
    private readonly dependencies: Readonly<{
      bindings: ContextReusePublicationBindingQueryPort;
      releases: ContextReuseProducerReleaseQueryPort;
      safety: ReviewSafetyDecisionResolverPort;
      clock: Readonly<{ now(): Date }>;
    }>,
  ) {}

  async isCurrent(permit: ReviewPublicationPermitIdentity): Promise<boolean> {
    try {
      const bindings =
        await this.dependencies.bindings.findContextReuseBindings(
          permit.executionId,
        );
      if (bindings === null) return false;
      for (const binding of bindings) {
        if (!(await this.verifyBinding(permit, binding))) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async verifyBinding(
    permit: ReviewPublicationPermitIdentity,
    binding: ContextReusePublicationBinding,
  ): Promise<boolean> {
    const { observation, attestation, session } = binding;
    const nowMs = this.dependencies.clock.now().getTime();
    if (
      !attestation ||
      !session ||
      !binding.reusePolicyVectorHash ||
      binding.targetExecutionId !== permit.executionId ||
      observation.workspaceId !== permit.workspaceId ||
      observation.repositoryConnectionId !== permit.repositoryConnectionId ||
      observation.scmRepositoryIdentityId !== permit.scmRepositoryIdentityId ||
      observation.pullRequestNumber !== permit.pullRequestNumber ||
      observation.producerReleaseId !== permit.producerReleaseId ||
      observation.executionProfile !==
        ProviderExecutionProfile.ContextGatewayV1 ||
      observation.contextAttestationId !== attestation.attestationId ||
      observation.contextAttestationHash !== attestation.attestationHash ||
      attestation.sessionId !== session.sessionId ||
      observation.reuseExpiresAtMs <= nowMs ||
      attestation.reuseExpiresAtMs <= nowMs ||
      session.state !== "accepted" ||
      session.workspaceId !== permit.workspaceId ||
      session.repositoryConnectionId !== permit.repositoryConnectionId ||
      session.scmRepositoryIdentityId !== permit.scmRepositoryIdentityId ||
      session.pullRequestNumber !== permit.pullRequestNumber ||
      session.sourceExecutionId !== observation.sourceExecutionId ||
      session.sourceWorkSlotId !== observation.sourceWorkSlotId ||
      session.sourceReviewRevisionHash !==
        observation.sourceReviewRevisionHash ||
      session.attemptId !== observation.attemptId ||
      session.sourceLeaseId !== observation.sourceLeaseId ||
      session.sourceFencingToken !== observation.sourceFencingToken ||
      attestation.sourceExecutionId !== observation.sourceExecutionId ||
      attestation.sourceWorkSlotId !== observation.sourceWorkSlotId ||
      attestation.sourceReviewRevisionHash !==
        observation.sourceReviewRevisionHash ||
      attestation.attemptId !== observation.attemptId ||
      attestation.sourceLeaseId !== observation.sourceLeaseId ||
      attestation.sourceFencingToken !== observation.sourceFencingToken ||
      attestation.actualModel !== observation.actualModel ||
      session.requestedModel !== observation.requestedModel ||
      session.trustedCapabilityProfile !==
        observation.trustedCapabilityProfile ||
      session.producerReleaseId !== observation.producerReleaseId ||
      session.selectedProtocolVersion !== observation.selectedProtocolVersion
    ) {
      return false;
    }
    const release =
      await this.dependencies.releases.findContextReuseProducerRelease(
        observation.producerReleaseId,
      );
    if (
      !release?.registered ||
      release.producerReleaseId !== permit.producerReleaseId ||
      release.capabilityProfile !== observation.trustedCapabilityProfile ||
      release.capabilityProfile !== session.trustedCapabilityProfile ||
      release.runtimeCommitSha !== observation.providerRuntimeVersion ||
      release.contextGatewayPolicyVersion === null ||
      release.contextGatewayEntrypointDigest === null ||
      session.gatewayPolicyVersion !== release.contextGatewayPolicyVersion ||
      session.gatewayBinaryHash !== release.contextGatewayEntrypointDigest
    ) {
      return false;
    }
    const providerTasks = observation.taskKindSet.map((taskKind) => ({
      providerKind: safetyProvider(observation.providerKind),
      taskKind: safetyTask(taskKind),
    }));
    const target = {
      workspaceId: permit.workspaceId,
      repositoryConnectionId: permit.repositoryConnectionId,
      scmRepositoryIdentityId: permit.scmRepositoryIdentityId,
      providerTasks,
    };
    const [exact, prompt, context] = await Promise.all([
      this.dependencies.safety.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.ExactRevisionCrossExecutionReuse,
        target,
      }),
      this.dependencies.safety.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.PromptOnlyCrossRevisionReuse,
        target,
      }),
      this.dependencies.safety.resolveReviewSafetyPolicy({
        decisionKind: ReviewSafetyDecisionKind.ContextGatewayCrossRevisionReuse,
        target,
      }),
    ]);
    if (!context.effectAllowed || context.shadow) return false;
    const safetyDecision = {
      evidenceReuseMode: reuseMode(exact),
      promptOnlyReuseMode: reuseMode(prompt),
      contextGatewayReuseMode: reuseMode(context),
      safetyDecisionHash: sha256(
        canonicalJson({
          exact: exact.safetyDecisionHash,
          prompt: prompt.safetyDecisionHash,
          context: context.safetyDecisionHash,
        }),
      ),
    };
    const expected = sha256(
      canonicalizeReviewContextReusePolicyVector({
        safetyDecision,
        compatibility: {
          registeredProducerReleaseIds: [release.producerReleaseId],
          trustedCapabilityProfiles: [release.capabilityProfile],
          compatibleProviderRuntimeVersions: [release.runtimeCommitSha],
          actualModelMode: ActualModelCompatibilityMode.Exact,
          compatibleActualModels: [],
        },
        eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
        gatewayPolicyVersion: session.gatewayPolicyVersion,
        gatewayBinaryHash: session.gatewayBinaryHash,
        trustedCapabilityProfile: session.trustedCapabilityProfile,
        producerReleaseId: observation.producerReleaseId,
        providerKind: observation.providerKind,
        requestedModel: observation.requestedModel,
        actualModel: observation.actualModel,
      }),
    );
    return sameHash(expected, binding.reusePolicyVectorHash);
  }
}

function safetyProvider(value: EvidenceProviderKind): ReviewProviderKind {
  switch (value) {
    case EvidenceProviderKind.Codex:
      return ReviewProviderKind.Codex;
    case EvidenceProviderKind.ClaudeCode:
      return ReviewProviderKind.ClaudeCode;
    case EvidenceProviderKind.OpenRouter:
      return ReviewProviderKind.OpenRouter;
    case EvidenceProviderKind.Unknown:
      throw new Error("context_reuse_provider_unknown");
    default:
      throw new Error("context_reuse_provider_invalid");
  }
}

function safetyTask(value: EvidenceTaskKind): ReviewTaskKind {
  switch (value) {
    case EvidenceTaskKind.FindingDiscovery:
      return ReviewTaskKind.CodeReview;
    case EvidenceTaskKind.LifecycleRevalidation:
      return ReviewTaskKind.FindingRevalidation;
    case EvidenceTaskKind.Unknown:
      throw new Error("context_reuse_task_unknown");
    default:
      throw new Error("context_reuse_task_invalid");
  }
}

function reuseMode(input: {
  readonly effectAllowed: boolean;
  readonly shadow: boolean;
}): ReviewReuseEffectMode {
  if (!input.effectAllowed) return ReviewReuseEffectMode.Disabled;
  return input.shadow
    ? ReviewReuseEffectMode.Shadow
    : ReviewReuseEffectMode.Enabled;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameHash(left: string, right: string): boolean {
  return (
    /^[a-f0-9]{64}$/.test(left) &&
    /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}
