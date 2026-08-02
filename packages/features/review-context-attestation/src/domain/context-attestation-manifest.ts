import {
  canonicalContextDependencyManifest,
  createContextDependencyManifest,
  type ContextDependencyManifest,
} from "./context-dependency-manifest";
import {
  canonicalContextGatewayV4Manifest,
  contextGatewayV4ManifestVersion,
  createContextGatewayV4Manifest,
  type ContextGatewayV4Manifest,
} from "./context-gateway-v4-manifest";

export type ContextAttestationManifest =
  | ContextDependencyManifest
  | ContextGatewayV4Manifest;

export function createContextAttestationManifest(
  candidate: ContextAttestationManifest,
): ContextAttestationManifest {
  switch (candidate.manifestVersion) {
    case 2:
      return createContextDependencyManifest(candidate);
    case contextGatewayV4ManifestVersion:
      return createContextGatewayV4Manifest(candidate);
    default:
      throw new Error("context_attestation_manifest_version_unsupported");
  }
}

export function canonicalContextAttestationManifest(
  manifest: ContextAttestationManifest,
): string {
  const normalized = createContextAttestationManifest(manifest);
  switch (normalized.manifestVersion) {
    case 2:
      return canonicalContextDependencyManifest(normalized);
    case contextGatewayV4ManifestVersion:
      return canonicalContextGatewayV4Manifest(normalized);
  }
}

export function canonicalContextAttestationManifestBytes(
  manifest: ContextAttestationManifest,
): Uint8Array {
  return new TextEncoder().encode(
    canonicalContextAttestationManifest(manifest),
  );
}

export function contextAttestationManifestEventCount(
  manifest: ContextAttestationManifest,
): number {
  const normalized = createContextAttestationManifest(manifest);
  switch (normalized.manifestVersion) {
    case 2:
      return normalized.dependencies.length;
    case contextGatewayV4ManifestVersion:
      return normalized.events.length;
  }
}

export function isLegacyContextDependencyManifest(
  manifest: ContextAttestationManifest,
): manifest is ContextDependencyManifest {
  return manifest.manifestVersion === 2;
}
