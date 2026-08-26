import { createHash } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { Clock } from "@reviewrouter/shared";
import type { GitHubAppCommentTokenIssuerPort } from "@reviewrouter/features-action-control-plane";
import {
  CredentialEnvelopeVault,
  HostedCommentTokenMintProtocol,
  PrismaHostedCommentTokenMintLedger,
  type HostedCommentTokenMintLedgerPort,
  type HostedCommentTokenPreparedSecretVaultPort,
  type HostedCommentTokenSecretVaultPort,
} from "@reviewrouter/features-hosted-account-pool";

export class HostedCodexCommentTokenIssuer extends HostedCommentTokenMintProtocol {
  constructor(dependencies: {
    readonly prisma: PrismaClient;
    readonly commentTokens: GitHubAppCommentTokenIssuerPort &
      Required<Pick<GitHubAppCommentTokenIssuerPort, "prepareCommentToken">>;
    readonly clock: Clock;
    readonly mintLedger?: HostedCommentTokenMintLedgerPort;
    readonly secretVault: HostedCommentTokenPreparedSecretVaultPort;
  }) {
    super({
      commentTokens: dependencies.commentTokens,
      clock: dependencies.clock,
      mintLedger:
        dependencies.mintLedger ??
        new PrismaHostedCommentTokenMintLedger(dependencies.prisma),
      secretVault: dependencies.secretVault,
    });
  }
}

export class HostedCommentTokenEnvelopeVault implements HostedCommentTokenPreparedSecretVaultPort {
  constructor(
    private readonly vault: CredentialEnvelopeVault,
    private readonly databaseIncarnation: string,
    private readonly databaseResourceIdentity: string,
  ) {}
  async prepareSeal(
    input: Parameters<
      HostedCommentTokenPreparedSecretVaultPort["prepareSeal"]
    >[0],
  ) {
    const prepared = await this.vault.prepareEncrypt(
      this.context(input),
      input.signal,
    );
    return {
      capture: (token: string) => {
        const plaintext = Buffer.from(token, "utf8");
        try {
          return toHostedEnvelope(prepared.capture(plaintext));
        } finally {
          plaintext.fill(0);
        }
      },
      destroy: () => prepared.destroy(),
    };
  }
  async seal(input: Parameters<HostedCommentTokenSecretVaultPort["seal"]>[0]) {
    const plaintext = Buffer.from(input.token, "utf8");
    try {
      const envelope = await this.vault.encrypt(plaintext, this.context(input));
      return toHostedEnvelope(envelope);
    } finally {
      plaintext.fill(0);
    }
  }
  async open(input: Parameters<HostedCommentTokenSecretVaultPort["open"]>[0]) {
    const encryptedDataKey = Buffer.from(input.envelope.encryptedDataKey);
    let plaintext: Uint8Array | undefined;
    try {
      const wrappedDataEncryptionKey = JSON.parse(
        encryptedDataKey.toString("utf8"),
      ) as {
        keyId: string;
        nonce: string;
        ciphertext: string;
        authenticationTag: string;
      };
      plaintext = await this.vault.decrypt(
        {
          schemaVersion: 1,
          encryptionAlgorithm: "aes-256-gcm",
          keyId: input.envelope.keyId,
          nonce: encodeBase64(input.envelope.iv),
          ciphertext: encodeBase64(input.envelope.ciphertext),
          authenticationTag: encodeBase64(input.envelope.authTag),
          wrappedDataEncryptionKey,
          associatedDataHash: input.envelope.aadHash,
          ciphertextHash: sha256Bytes(input.envelope.ciphertext),
        },
        this.context(input),
        input.signal,
      );
      return Buffer.from(plaintext);
    } finally {
      encryptedDataKey.fill(0);
      plaintext?.fill(0);
      zeroEnvelope(input.envelope);
    }
  }
  private context(input: {
    mintId: string;
    workspaceId: string;
    poolId: string;
  }) {
    return {
      workspaceId: input.workspaceId,
      poolId: input.poolId,
      accountId: input.mintId,
      generation: 1,
      databaseIncarnation: this.databaseIncarnation,
      databaseResourceIdentity: this.databaseResourceIdentity,
    };
  }
}

function toHostedEnvelope(
  envelope: Awaited<ReturnType<CredentialEnvelopeVault["encrypt"]>>,
) {
  return {
    ciphertext: Buffer.from(envelope.ciphertext, "base64"),
    encryptedDataKey: Buffer.from(
      JSON.stringify(envelope.wrappedDataEncryptionKey),
      "utf8",
    ),
    iv: Buffer.from(envelope.nonce, "base64"),
    authTag: Buffer.from(envelope.authenticationTag, "base64"),
    keyId: envelope.keyId,
    aadHash: envelope.associatedDataHash,
  };
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function zeroEnvelope(envelope: {
  ciphertext: Uint8Array;
  encryptedDataKey: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}) {
  envelope.ciphertext.fill(0);
  envelope.encryptedDataKey.fill(0);
  envelope.iv.fill(0);
  envelope.authTag.fill(0);
}

function encodeBase64(value: Uint8Array): string {
  const copy = Buffer.from(value);
  try {
    return copy.toString("base64");
  } finally {
    copy.fill(0);
  }
}
