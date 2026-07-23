import {
  canonicalizeProviderInvocationManifest,
  canonicalizeProviderRequestEnvelope,
  normalizeProviderInvocationManifest,
  providerInvocationIdentityPreimage,
  type ProviderInvocationIdentity,
  type ProviderInvocationManifest,
  type ProviderRequestEnvelope,
} from "../../domain/provider-invocation-manifest";
import { assertSha256 } from "../../domain/review-evidence-primitives";
import type { Sha256DigestPort } from "../ports/sha256-digest-port";

export async function hashProviderRequestEnvelope(
  digestPort: Sha256DigestPort,
  envelope: ProviderRequestEnvelope,
): Promise<string> {
  const digest = await digestPort.digest(
    canonicalizeProviderRequestEnvelope(envelope),
  );
  assertSha256(digest, "provider_request_envelope_hash");
  return digest;
}

export async function buildProviderInvocationIdentity(
  digestPort: Sha256DigestPort,
  input: {
    readonly manifest: ProviderInvocationManifest;
    readonly providerVoteIdentityHash: string;
  },
): Promise<ProviderInvocationIdentity> {
  assertSha256(input.providerVoteIdentityHash, "provider_vote_identity_hash");
  const manifest = normalizeProviderInvocationManifest(input.manifest);
  const canonicalManifestBytes =
    canonicalizeProviderInvocationManifest(manifest);
  const manifestKey = await digestPort.digest(canonicalManifestBytes);
  assertSha256(manifestKey, "manifest_key");
  const providerInvocationKey = await digestPort.digest(
    providerInvocationIdentityPreimage(
      manifestKey,
      input.providerVoteIdentityHash,
    ),
  );
  assertSha256(providerInvocationKey, "provider_invocation_key");
  return Object.freeze({
    manifest,
    canonicalManifestBytes: new Uint8Array(canonicalManifestBytes),
    manifestKey,
    providerVoteIdentityHash: input.providerVoteIdentityHash,
    providerInvocationKey,
  });
}
