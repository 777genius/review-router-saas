import type {
  CapabilityKeyRingPort,
  CapabilitySigningKey,
} from "../application/signed-capability-codec-port";

export type ConfiguredCapabilityVerificationKey = CapabilitySigningKey & {
  readonly verifyUntil: Date | null;
};

export class ConfiguredCapabilityKeyRing implements CapabilityKeyRingPort {
  private readonly activeKey: CapabilitySigningKey;
  private readonly verificationKeys: ReadonlyMap<
    string,
    ConfiguredCapabilityVerificationKey
  >;

  constructor(input: {
    readonly activeKeyId: string;
    readonly keys: readonly ConfiguredCapabilityVerificationKey[];
  }) {
    const keys = new Map<string, ConfiguredCapabilityVerificationKey>();
    for (const key of input.keys) {
      assertConfiguredKey(key);
      if (keys.has(key.keyId)) {
        throw new Error("capability_key_id_duplicate");
      }
      keys.set(key.keyId, copyVerificationKey(key));
    }
    const active = keys.get(input.activeKeyId);
    if (!active || active.verifyUntil !== null) {
      throw new Error("capability_active_key_invalid");
    }
    this.activeKey = copySigningKey(active);
    this.verificationKeys = keys;
  }

  async activeSigningKey(): Promise<CapabilitySigningKey> {
    return copySigningKey(this.activeKey);
  }

  async verificationKey(
    keyId: string,
    verificationTime: Date,
  ): Promise<CapabilitySigningKey | null> {
    if (!Number.isFinite(verificationTime.getTime())) {
      throw new Error("capability_verification_time_invalid");
    }
    const key = this.verificationKeys.get(keyId);
    if (
      !key ||
      (key.verifyUntil !== null && verificationTime > key.verifyUntil)
    ) {
      return null;
    }
    return copySigningKey(key);
  }
}

function assertConfiguredKey(key: ConfiguredCapabilityVerificationKey): void {
  if (
    !/^[A-Za-z0-9._:-]{1,120}$/.test(key.keyId) ||
    key.secret.byteLength < 32 ||
    (key.verifyUntil !== null && !Number.isFinite(key.verifyUntil.getTime()))
  ) {
    throw new Error("capability_configured_key_invalid");
  }
}

function copySigningKey(key: CapabilitySigningKey): CapabilitySigningKey {
  return { keyId: key.keyId, secret: new Uint8Array(key.secret) };
}

function copyVerificationKey(
  key: ConfiguredCapabilityVerificationKey,
): ConfiguredCapabilityVerificationKey {
  return {
    ...copySigningKey(key),
    verifyUntil: key.verifyUntil === null ? null : new Date(key.verifyUntil),
  };
}
