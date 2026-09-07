// Synthetic populated source-000074 data; never an approved managed baseline.
const h64 = "a".repeat(64);
export const seedLegacyRows = `
  INSERT INTO "Workspace" ("id", "slug", "name", "updatedAt")
    VALUES ('workspace-legacy', 'workspace-legacy', 'Legacy workspace', CURRENT_TIMESTAMP);
  INSERT INTO "RepositoryConnection" (
    "id", "workspaceId", "externalRepositoryId", "owner", "name", "fullName",
    "defaultBranch", "visibility", "updatedAt"
  ) VALUES (
    'repository-legacy', 'workspace-legacy', 'repository-legacy', 'reviewrouter',
    'migration-rehearsal', 'reviewrouter/migration-rehearsal', 'main', 'private',
    CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexPool" (
    "id", "workspaceId", "name", "updatedAt"
  ) VALUES ('pool-legacy', 'workspace-legacy', 'Legacy', CURRENT_TIMESTAMP);
  INSERT INTO "HostedCodexAccount" (
    "id", "workspaceId", "poolId", "label", "accountFingerprint", "state",
    "healthVersion", "activeGeneration", "updatedAt"
  ) VALUES (
    'account-legacy', 'workspace-legacy', 'pool-legacy', 'Legacy', '${h64}',
    'provisioning_pending', 0, NULL, CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexCredentialVersion" (
    "id", "workspaceId", "poolId", "accountId", "generation",
    "databaseIncarnation", "envelopeVersion", "encryptionAlgorithm", "keyId",
    "aadHash", "generationHash", "ciphertextHash", "encryptedCiphertext",
    "envelopeMetadata"
  ) VALUES (
    'credential-legacy', 'workspace-legacy', 'pool-legacy', 'account-legacy', 1,
    'database-incarnation-legacy', 1, 'aes-256-gcm', 'legacy-key',
    '${h64}', '${h64}', '${h64}', 'Y2lwaGVydGV4dA==',
    '{"nonce":"bm9uY2U=","authenticationTag":"dGFn","wrappedDataEncryptionKey":{"keyId":"legacy-key","nonce":"bm9uY2U=","ciphertext":"d3JhcHBlZA==","authenticationTag":"dGFn"}}'::jsonb
  );
  UPDATE "HostedCodexAccount"
  SET "state" = 'healthy', "activeGeneration" = 1, "healthVersion" = 1,
      "lastHealthyAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'account-legacy';
  INSERT INTO "HostedCodexRepositoryBinding" (
    "id", "workspaceId", "poolId", "repositoryConnectionId", "updatedAt"
  ) VALUES (
    'binding-legacy', 'workspace-legacy', 'pool-legacy', 'repository-legacy', CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexInvocationGrant" (
    "id", "invocationId", "workspaceId", "poolId", "repositoryConnectionId",
    "repositoryBindingId", "activeAccountId", "primaryAccountId",
    "reviewRequestId", "providerInvocationKey", "runId", "runAttempt", "model",
    "policyVersion", "policyFingerprint", "runtimeConfigVersion", "bindingRevision",
    "authzEpoch", "capabilityTokenHash", "expiresAt", "maxRequests",
    "maxConcurrentRequests", "maxRequestBytes", "requestCount", "inFlight", "updatedAt"
  ) VALUES (
    'grant-legacy', 'invocation-legacy', 'workspace-legacy', 'pool-legacy',
    'repository-legacy', 'binding-legacy', 'account-legacy', 'account-legacy',
    'review-legacy', 'provider-legacy', 'run-legacy', 1, 'gpt-test', 'v1', '${h64}',
    1, 1, 1, '${h64.replaceAll("a", "b")}', CURRENT_TIMESTAMP + INTERVAL '1 hour',
    4, 4, 4096, 0, 0, CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexRelayRequest" (
    "id", "grantId", "ordinal", "idempotencyKeyHash", "requestHash", "status",
    "requestBytes", "startedAt", "updatedAt"
  ) VALUES (
    'request-legacy', 'grant-legacy', 1, '${h64.replaceAll("a", "c")}', '${h64}',
    'processing', 128, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexCommentRefreshCapability" (
    "id", "grantId", "invocationId", "repositoryBindingId", "workspaceId",
    "poolId", "repositoryConnectionId", "capabilityTokenHash", "expiresAt",
    "maxUses", "updatedAt"
  ) VALUES (
    'comment-capability-legacy', 'grant-legacy', 'invocation-legacy',
    'binding-legacy', 'workspace-legacy', 'pool-legacy', 'repository-legacy',
    '${h64.replaceAll("a", "d")}', CURRENT_TIMESTAMP + INTERVAL '1 hour', 2,
    CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexMutationFence" (
    "accountId", "workspaceId", "poolId", "fenceEpoch", "ownerIdHash",
    "expectedGeneration", "expiresAt", "updatedAt"
  ) VALUES (
    'account-legacy', 'workspace-legacy', 'pool-legacy', 1,
    '${h64.replaceAll("a", "e")}', 1, CURRENT_TIMESTAMP + INTERVAL '1 hour',
    CURRENT_TIMESTAMP
  );
  INSERT INTO "HostedCodexGenerationReceipt" (
    "id", "credentialVersionId", "accountId", "workspaceId", "poolId",
    "generation", "kind", "mutationFenceEpoch", "actorIdHash", "receiptHash"
  ) VALUES (
    'generation-receipt-legacy', 'credential-legacy', 'account-legacy',
    'workspace-legacy', 'pool-legacy', 1, 'credential_created', 1,
    '${h64.replaceAll("a", "f")}', '${h64.replaceAll("a", "9")}'
  );
`;
