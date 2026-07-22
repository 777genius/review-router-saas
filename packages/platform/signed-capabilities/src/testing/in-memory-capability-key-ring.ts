import type {
  CapabilityKeyRingPort,
  CapabilitySigningKey,
} from "../application/signed-capability-codec-port";

export class InMemoryCapabilityKeyRing implements CapabilityKeyRingPort {
  private activeKeyId: string;
  private readonly keys = new Map<string, CapabilitySigningKey>();

  constructor(initialKey: CapabilitySigningKey) {
    this.activeKeyId = initialKey.keyId;
    this.keys.set(initialKey.keyId, copyKey(initialKey));
  }

  rotate(next: CapabilitySigningKey): void {
    this.keys.set(next.keyId, copyKey(next));
    this.activeKeyId = next.keyId;
  }

  retire(keyId: string): void {
    if (keyId === this.activeKeyId) {
      throw new Error("capability_active_key_cannot_be_retired");
    }
    this.keys.delete(keyId);
  }

  async activeSigningKey(): Promise<CapabilitySigningKey> {
    return copyKey(this.keys.get(this.activeKeyId)!);
  }

  async verificationKey(
    keyId: string,
    verificationTime: Date,
  ): Promise<CapabilitySigningKey | null> {
    void verificationTime;
    const key = this.keys.get(keyId);
    return key ? copyKey(key) : null;
  }
}

function copyKey(key: CapabilitySigningKey): CapabilitySigningKey {
  return { keyId: key.keyId, secret: new Uint8Array(key.secret) };
}
