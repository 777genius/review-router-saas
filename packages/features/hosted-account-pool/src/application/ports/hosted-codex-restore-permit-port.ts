export type HostedCodexRestorePermit = {
  readonly inventoryHash: string;
  readonly databaseResourceIdentity: string;
  readonly sourceIncarnation: string;
  readonly targetIncarnation: string;
  readonly sourceKmsKeyArn: string;
  readonly targetKmsKeyArn: string;
  readonly authorityKeyId: string;
  readonly actorId: string;
  readonly nonce: string;
  readonly expiresAt: Date;
};

export interface HostedCodexRestorePermitVerifierPort {
  verify(input: {
    readonly token: string;
    readonly databaseResourceIdentity: string;
    readonly targetIncarnation: string;
    readonly inventoryHash: string;
  }): HostedCodexRestorePermit;
}
