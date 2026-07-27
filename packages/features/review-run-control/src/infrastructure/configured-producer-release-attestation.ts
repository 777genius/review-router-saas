import type { ProducerReleaseQueryPort } from "../application/ports/producer-release-ports";
import {
  ProducerReleaseAttestationStatus,
  type ProducerReleaseAttestationPort,
  type TrustedProducerReleaseAttestation,
} from "../application/ports/producer-release-attestation-ports";
import {
  ProducerDistributionKind,
  ProducerReleaseState,
  ReviewCapabilityProfile,
  assertCommitSha,
  assertIdentifier,
  assertSha256,
  canonicalJson,
} from "../domain/review-run-control-types";
import {
  createProducerRelease,
  producerReleaseImmutableKey,
} from "../domain/producer-release";

export const reviewRunProducerReleaseAttestationsEnv =
  "REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON";

export class ConfiguredProducerReleaseAttestationRegistry implements ProducerReleaseAttestationPort {
  private readonly byActionCommitSha: ReadonlyMap<
    string,
    TrustedProducerReleaseAttestation
  >;

  constructor(
    attestations: readonly TrustedProducerReleaseAttestation[],
    private readonly releases: ProducerReleaseQueryPort,
  ) {
    if (attestations.length === 0 || attestations.length > 100) {
      throw new Error("producer_release_attestations_count_invalid");
    }
    const entries = new Map<string, TrustedProducerReleaseAttestation>();
    for (const attestation of attestations) {
      assertAttestation(attestation);
      const actionCommitSha = attestation.actionCommitSha.toLowerCase();
      if (entries.has(actionCommitSha)) {
        throw new Error("producer_release_attestation_action_commit_duplicate");
      }
      entries.set(actionCommitSha, Object.freeze({ ...attestation }));
    }
    this.byActionCommitSha = entries;
  }

  async attest(
    input: Parameters<ProducerReleaseAttestationPort["attest"]>[0],
  ): ReturnType<ProducerReleaseAttestationPort["attest"]> {
    const configured = this.byActionCommitSha.get(
      input.actionCommitSha.toLowerCase(),
    );
    if (!configured) {
      return { status: ProducerReleaseAttestationStatus.Unregistered };
    }
    if (
      input.expectedSchemaDigest !== configured.schemaDigest ||
      input.expectedCanonicalizerDigest !== configured.canonicalizerDigest
    ) {
      return { status: ProducerReleaseAttestationStatus.Mismatch };
    }
    const release = await this.releases.findProducerReleaseById(
      configured.producerReleaseId,
    );
    if (!release) {
      return {
        status: ProducerReleaseAttestationStatus.Attested,
        release: createProducerRelease(
          {
            producerReleaseId: configured.producerReleaseId,
            distributionKind: configured.distributionKind,
            actionCommitSha: configured.actionCommitSha,
            runtimeCommitSha: configured.runtimeCommitSha,
            wrapperEntrypointDigest: configured.wrapperEntrypointDigest,
            runtimeEntrypointDigest: configured.runtimeEntrypointDigest,
            contextGatewayPolicyVersion: configured.contextGatewayPolicyVersion,
            contextGatewayEntrypointDigest:
              configured.contextGatewayEntrypointDigest,
            schemaDigest: configured.schemaDigest,
            capabilityProfile: configured.capabilityProfile,
            protocolLimitsProfileId: configured.protocolLimitsProfileId,
            operationalSloProfileId: configured.operationalSloProfileId,
          },
          new Date(0),
        ),
      };
    }
    if (release.state !== ProducerReleaseState.Registered) {
      return { status: ProducerReleaseAttestationStatus.Revoked };
    }
    if (
      producerReleaseImmutableKey(release) !== configuredReleaseKey(configured)
    ) {
      return { status: ProducerReleaseAttestationStatus.Mismatch };
    }
    return { status: ProducerReleaseAttestationStatus.Attested, release };
  }
}

export function readConfiguredProducerReleaseAttestations(
  env: Readonly<Record<string, string | undefined>>,
): readonly TrustedProducerReleaseAttestation[] {
  const raw = env[reviewRunProducerReleaseAttestationsEnv];
  if (!raw) throw new Error("producer_release_attestations_env_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("producer_release_attestations_env_invalid");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("producer_release_attestations_env_invalid");
  }
  return parsed.map(parseAttestation);
}

function parseAttestation(value: unknown): TrustedProducerReleaseAttestation {
  if (!isRecord(value)) {
    throw new Error("producer_release_attestation_invalid");
  }
  const legacyKeys = [
    "producerReleaseId",
    "distributionKind",
    "actionCommitSha",
    "runtimeCommitSha",
    "wrapperEntrypointDigest",
    "runtimeEntrypointDigest",
    "schemaDigest",
    "canonicalizerDigest",
    "capabilityProfile",
    "protocolLimitsProfileId",
    "operationalSloProfileId",
  ].sort();
  const expectedKeys = [
    ...legacyKeys,
    "contextGatewayPolicyVersion",
    "contextGatewayEntrypointDigest",
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    canonicalJson(actualKeys) !== canonicalJson(expectedKeys) &&
    canonicalJson(actualKeys) !== canonicalJson(legacyKeys)
  ) {
    throw new Error("producer_release_attestation_shape_invalid");
  }
  return {
    producerReleaseId: requiredString(value.producerReleaseId),
    distributionKind: parseDistributionKind(value.distributionKind),
    actionCommitSha: requiredString(value.actionCommitSha),
    runtimeCommitSha: requiredString(value.runtimeCommitSha),
    wrapperEntrypointDigest:
      value.wrapperEntrypointDigest === null
        ? null
        : requiredString(value.wrapperEntrypointDigest),
    runtimeEntrypointDigest: requiredString(value.runtimeEntrypointDigest),
    contextGatewayPolicyVersion:
      value.contextGatewayPolicyVersion === undefined ||
      value.contextGatewayPolicyVersion === null
        ? null
        : requiredString(value.contextGatewayPolicyVersion),
    contextGatewayEntrypointDigest:
      value.contextGatewayEntrypointDigest === undefined ||
      value.contextGatewayEntrypointDigest === null
        ? null
        : requiredString(value.contextGatewayEntrypointDigest),
    schemaDigest: requiredString(value.schemaDigest),
    canonicalizerDigest: requiredString(value.canonicalizerDigest),
    capabilityProfile: parseCapabilityProfile(value.capabilityProfile),
    protocolLimitsProfileId: requiredString(value.protocolLimitsProfileId),
    operationalSloProfileId: requiredString(value.operationalSloProfileId),
  };
}

function assertAttestation(value: TrustedProducerReleaseAttestation): void {
  assertIdentifier(value.producerReleaseId, "producer_release_id");
  assertCommitSha(value.actionCommitSha, "action_commit_sha");
  assertCommitSha(value.runtimeCommitSha, "runtime_commit_sha");
  if (value.wrapperEntrypointDigest !== null) {
    assertSha256(value.wrapperEntrypointDigest, "wrapper_entrypoint_digest");
  }
  assertSha256(value.runtimeEntrypointDigest, "runtime_entrypoint_digest");
  if (
    (value.contextGatewayPolicyVersion === null) !==
    (value.contextGatewayEntrypointDigest === null)
  ) {
    throw new Error("producer_release_context_gateway_artifact_incomplete");
  }
  if (
    value.contextGatewayPolicyVersion !== null &&
    value.contextGatewayEntrypointDigest !== null
  ) {
    assertIdentifier(
      value.contextGatewayPolicyVersion,
      "context_gateway_policy_version",
    );
    assertSha256(
      value.contextGatewayEntrypointDigest,
      "context_gateway_entrypoint_digest",
    );
  }
  assertSha256(value.schemaDigest, "schema_digest");
  assertSha256(value.canonicalizerDigest, "canonicalizer_digest");
  assertIdentifier(value.protocolLimitsProfileId, "protocol_limits_profile_id");
  assertIdentifier(value.operationalSloProfileId, "operational_slo_profile_id");
}

function configuredReleaseKey(
  configured: TrustedProducerReleaseAttestation,
): string {
  return canonicalJson({
    distributionKind: configured.distributionKind,
    actionCommitSha: configured.actionCommitSha,
    runtimeCommitSha: configured.runtimeCommitSha,
    wrapperEntrypointDigest: configured.wrapperEntrypointDigest,
    runtimeEntrypointDigest: configured.runtimeEntrypointDigest,
    contextGatewayPolicyVersion: configured.contextGatewayPolicyVersion,
    contextGatewayEntrypointDigest: configured.contextGatewayEntrypointDigest,
    schemaDigest: configured.schemaDigest,
    capabilityProfile: configured.capabilityProfile,
    protocolLimitsProfileId: configured.protocolLimitsProfileId,
    operationalSloProfileId: configured.operationalSloProfileId,
  });
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("producer_release_attestation_value_invalid");
  }
  return value;
}

function parseDistributionKind(value: unknown): ProducerDistributionKind {
  if (value === ProducerDistributionKind.HostedComposite) return value;
  if (value === ProducerDistributionKind.PublicReusable) return value;
  throw new Error("producer_release_attestation_distribution_invalid");
}

function parseCapabilityProfile(value: unknown): ReviewCapabilityProfile {
  if (value === ReviewCapabilityProfile.ExactRevisionV2) return value;
  throw new Error("producer_release_attestation_capability_profile_invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
