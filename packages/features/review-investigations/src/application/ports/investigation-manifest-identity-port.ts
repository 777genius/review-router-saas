export interface InvestigationManifestIdentityPort {
  computeManifestKey(canonicalJson: string): Promise<string>;
}
