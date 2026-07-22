export interface Sha256DigestPort {
  digest(bytes: Uint8Array): Promise<string>;
}
