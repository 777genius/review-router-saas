// Exact PostgreSQL objects owned by migrations 000060 through 000064.
// Production capture and verification import this manifest independently of
// migration execution so an omitted or unexpected catalog object fails closed.

const c = (table, name, type, nullable, defaultExpression = null) =>
  Object.freeze({ table, name, type, nullable, defaultExpression });

export const codexRotatingOwnedTables = Object.freeze([
  "CodexOAuthChildIdentityQuarantine",
  "CodexOAuthDatabaseAuthorityKey",
  "CodexOAuthDatabaseAuthorityReceipt",
  "CodexOAuthProviderIdentityQuarantine",
  "CodexOAuthSecretNamespace",
  "CodexOAuthSetupDispatchAttempt",
  "CodexOAuthSetupPayloadClaim",
  "CodexOAuthSetupRecoveryRequest",
]);

export const codexRotatingCatalogTables = Object.freeze([
  "CodexOAuthChildIdentityQuarantine",
  "CodexOAuthDatabaseAuthorityKey",
  "CodexOAuthDatabaseAuthorityReceipt",
  "CodexOAuthLease",
  "CodexOAuthProviderIdentityQuarantine",
  "CodexOAuthProviderInstance",
  "CodexOAuthSecretNamespace",
  "CodexOAuthSetupDispatchAttempt",
  "CodexOAuthSetupManifest",
  "CodexOAuthSetupPayloadClaim",
  "CodexOAuthSetupRecoveryRequest",
  "CodexOAuthWritebackIntent",
]);

export const codexRotatingProviderRuntimeUpdateColumns = Object.freeze([
  "state",
  "latestGeneration",
  "latestGenerationHash",
  "activeLeaseId",
  "activeLeaseExpiresAt",
  "mutationEpoch",
  "mutationOwner",
  "mutationOwnerId",
  "activeSecretNamespaceId",
  "activeSecretNamespaceEpoch",
  "activeSecretNamespaceName",
  "activeAccountIdentityHash",
  "updatedAt",
]);

// This inventory is deliberately exhaustive for every rotating-OAuth table,
// including the columns that predate the migration-owned subset below. The
// production capture returns the unfiltered catalog names and the verifier
// compares them with these lists so an unexpected object cannot be hidden by
// an allowlist in the observation query.
const legacyCatalogColumns = Object.freeze([
  ...[
    ["id", "text", false],
    ["workspaceId", "text", false],
    ["repositoryId", "text", false],
    ["providerInstanceId", "text", false],
    ["authMode", "text", false],
    ["secretName", "text", false],
    ["state", "text", false, "'setup_pending'::text"],
    ["latestGeneration", "integer", false, "1"],
    ["latestGenerationHash", "text", true],
    ["generationHashSalt", "text", false],
    ["accountFingerprintSalt", "text", false],
    ["activeLeaseId", "text", true],
    ["activeLeaseExpiresAt", "timestamp(3) without time zone", true],
    ["createdAt", "timestamp(3) without time zone", false, "CURRENT_TIMESTAMP"],
    ["updatedAt", "timestamp(3) without time zone", false],
  ].map(([name, type, nullable, defaultExpression]) =>
    c("CodexOAuthProviderInstance", name, type, nullable, defaultExpression),
  ),
  ...[
    ["id", "text", false],
    ["workspaceId", "text", false],
    ["repositoryId", "text", false],
    ["providerInstanceRowId", "text", false],
    ["providerInstanceId", "text", false],
    ["setupNonce", "text", false],
    ["manifestJson", "jsonb", false],
    ["status", "text", false, "'issued'::text"],
    ["expiresAt", "timestamp(3) without time zone", false],
    ["createdAt", "timestamp(3) without time zone", false, "CURRENT_TIMESTAMP"],
    ["lastFetchedAt", "timestamp(3) without time zone", true],
    ["consumedAt", "timestamp(3) without time zone", true],
  ].map(([name, type, nullable, defaultExpression]) =>
    c("CodexOAuthSetupManifest", name, type, nullable, defaultExpression),
  ),
  ...[
    ["id", "text", false],
    ["providerInstanceRowId", "text", false],
    ["providerInstanceId", "text", false],
    ["workspaceId", "text", false],
    ["repositoryId", "text", false],
    ["githubRunId", "text", false],
    ["githubRunAttempt", "text", false],
    ["pullRequestNumber", "integer", true],
    ["leaseKey", "text", false],
    ["status", "text", false, "'preleased'::text"],
    ["restoredGenerationHash", "text", true],
    ["nextGeneration", "integer", true],
    ["writebackPreflightKeyId", "text", true],
    ["writebackPreflightedAt", "timestamp(3) without time zone", true],
    ["expiresAt", "timestamp(3) without time zone", false],
    ["createdAt", "timestamp(3) without time zone", false, "CURRENT_TIMESTAMP"],
    ["finalizedAt", "timestamp(3) without time zone", true],
    ["completedAt", "timestamp(3) without time zone", true],
  ].map(([name, type, nullable, defaultExpression]) =>
    c("CodexOAuthLease", name, type, nullable, defaultExpression),
  ),
  ...[
    ["id", "text", false],
    ["providerInstanceRowId", "text", false],
    ["leaseId", "text", false],
    ["providerInstanceId", "text", false],
    ["idempotencyKey", "text", false],
    ["generation", "integer", false],
    ["latestGenerationHash", "text", false],
    ["encryptedPayloadDigest", "text", false],
    ["keyId", "text", false],
    ["status", "text", false, "'pending'::text"],
    ["safeErrorCode", "text", true],
    ["createdAt", "timestamp(3) without time zone", false, "CURRENT_TIMESTAMP"],
    ["updatedAt", "timestamp(3) without time zone", false],
    ["completedAt", "timestamp(3) without time zone", true],
  ].map(([name, type, nullable, defaultExpression]) =>
    c("CodexOAuthWritebackIntent", name, type, nullable, defaultExpression),
  ),
]);

export const codexRotatingOwnedColumns = Object.freeze([
  ...[
    ["singleton", "boolean", false, "true"],
    [
      "keyMaterial",
      "text",
      false,
      "(replace((gen_random_uuid())::text, '-'::text, ''::text) || replace((gen_random_uuid())::text, '-'::text, ''::text))",
    ],
    ["createdAt", "timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"],
  ].map(([name, type, nullable, defaultExpression]) =>
    c(
      "CodexOAuthDatabaseAuthorityKey",
      name,
      type,
      nullable,
      defaultExpression,
    ),
  ),
  ...[
    ["databaseRole", "text", false],
    ["backendPid", "integer", false],
    ["transactionId", "bigint", false],
    ["effect", "text", false],
    ["ownerId", "text", false],
    ["effectCode", "integer", false],
    ["createdAt", "timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"],
    ["consumedAt", "timestamp(3) with time zone", true],
  ].map(([name, type, nullable, defaultExpression]) =>
    c(
      "CodexOAuthDatabaseAuthorityReceipt",
      name,
      type,
      nullable,
      defaultExpression,
    ),
  ),
  c("CodexOAuthProviderInstance", "mutationEpoch", "bigint", false, "0"),
  c("CodexOAuthProviderInstance", "mutationOwner", "text", true),
  c("CodexOAuthProviderInstance", "mutationOwnerId", "text", true),
  c("CodexOAuthProviderInstance", "activeSecretNamespaceId", "text", true),
  c("CodexOAuthProviderInstance", "activeSecretNamespaceEpoch", "bigint", true),
  c("CodexOAuthProviderInstance", "activeSecretNamespaceName", "text", true),
  c("CodexOAuthProviderInstance", "activeAccountIdentityHash", "text", true),
  c("CodexOAuthSetupManifest", "confirmationJson", "jsonb", true),
  c("CodexOAuthSetupManifest", "mutationEpoch", "bigint", true),
  c("CodexOAuthSetupManifest", "payloadVersion", "integer", true),
  c("CodexOAuthSetupManifest", "payloadGenerationHash", "text", true),
  c("CodexOAuthSetupManifest", "payloadAccountFingerprint", "text", true),
  c("CodexOAuthSetupManifest", "payloadByteSize", "integer", true),
  c(
    "CodexOAuthSetupManifest",
    "payloadClaimedAt",
    "timestamp(3) with time zone",
    true,
  ),
  c(
    "CodexOAuthSetupManifest",
    "recoveryExpiresAt",
    "timestamp(3) with time zone",
    true,
  ),
  c("CodexOAuthSetupManifest", "databaseRecoveryWitness", "text", true),
  c("CodexOAuthLease", "mutationEpoch", "bigint", true),
  c("CodexOAuthLease", "secretNamespaceId", "text", true),
  c("CodexOAuthLease", "secretNamespaceEpoch", "bigint", true),
  c("CodexOAuthWritebackIntent", "mutationEpoch", "bigint", true),
  c("CodexOAuthWritebackIntent", "dispatchAttemptId", "text", true),
  c("CodexOAuthWritebackIntent", "secretNamespaceId", "text", true),
  c(
    "CodexOAuthWritebackIntent",
    "dispatchAuthorizedAt",
    "timestamp(3) with time zone",
    true,
  ),
  c("CodexOAuthWritebackIntent", "providerResponseCode", "integer", true),
  c(
    "CodexOAuthWritebackIntent",
    "providerConfirmedAt",
    "timestamp(3) with time zone",
    true,
  ),
  c(
    "CodexOAuthWritebackIntent",
    "namespaceRetiredAt",
    "timestamp(3) with time zone",
    true,
  ),
  c("CodexOAuthWritebackIntent", "databaseIncarnation", "text", true),
  c("CodexOAuthWritebackIntent", "databaseRecoveryWitness", "text", true),
  c("CodexOAuthWritebackIntent", "accountIdentityHash", "text", true),
  c("CodexOAuthWritebackIntent", "accountIdentityAlgorithm", "text", true),
  c("CodexOAuthWritebackIntent", "recoveryRequestRowId", "text", true),
  c(
    "CodexOAuthWritebackIntent",
    "recoveryResolvedAt",
    "timestamp(3) with time zone",
    true,
  ),
  c("CodexOAuthWritebackIntent", "executorOwner", "text", true),
  c(
    "CodexOAuthWritebackIntent",
    "executorLeaseExpiresAt",
    "timestamp(3) with time zone",
    true,
  ),

  c(
    "CodexOAuthProviderIdentityQuarantine",
    "providerInstanceRowId",
    "text",
    false,
  ),
  c(
    "CodexOAuthProviderIdentityQuarantine",
    "observedWorkspaceId",
    "text",
    false,
  ),
  c(
    "CodexOAuthProviderIdentityQuarantine",
    "observedRepositoryId",
    "text",
    false,
  ),
  c(
    "CodexOAuthProviderIdentityQuarantine",
    "observedProviderInstanceId",
    "text",
    false,
  ),
  c(
    "CodexOAuthProviderIdentityQuarantine",
    "expectedProviderInstanceId",
    "text",
    true,
  ),
  c("CodexOAuthProviderIdentityQuarantine", "reason", "text", false),
  c("CodexOAuthProviderIdentityQuarantine", "evidenceJson", "jsonb", false),
  c(
    "CodexOAuthProviderIdentityQuarantine",
    "quarantinedAt",
    "timestamp(3) without time zone",
    false,
    "CURRENT_TIMESTAMP",
  ),
  c(
    "CodexOAuthProviderIdentityQuarantine",
    "resolvedAt",
    "timestamp(3) without time zone",
    true,
  ),

  c("CodexOAuthChildIdentityQuarantine", "childKind", "text", false),
  c("CodexOAuthChildIdentityQuarantine", "childId", "text", false),
  c(
    "CodexOAuthChildIdentityQuarantine",
    "providerInstanceRowId",
    "text",
    false,
  ),
  c("CodexOAuthChildIdentityQuarantine", "reason", "text", false),
  c("CodexOAuthChildIdentityQuarantine", "evidenceJson", "jsonb", false),
  c(
    "CodexOAuthChildIdentityQuarantine",
    "quarantinedAt",
    "timestamp(3) without time zone",
    false,
    "CURRENT_TIMESTAMP",
  ),
  c(
    "CodexOAuthChildIdentityQuarantine",
    "resolvedAt",
    "timestamp(3) without time zone",
    true,
  ),

  ...[
    ["id", "text", false],
    ["providerInstanceRowId", "text", false],
    ["recoveryRequestId", "text", false],
    ["actor", "text", false],
    ["acknowledgement", "text", false],
    ["mutationEpoch", "bigint", false],
    ["mode", "text", false],
    ["state", "text", false],
    ["latestManifestId", "text", true],
    ["databaseRecoveryWitness", "text", true],
    [
      "requestedAt",
      "timestamp(3) without time zone",
      false,
      "CURRENT_TIMESTAMP",
    ],
    [
      "activatedAt",
      "timestamp(3) without time zone",
      false,
      "CURRENT_TIMESTAMP",
    ],
    ["completedAt", "timestamp(3) without time zone", true],
    ["updatedAt", "timestamp(3) without time zone", false],
  ].map(([name, type, nullable, defaultExpression]) =>
    c(
      "CodexOAuthSetupRecoveryRequest",
      name,
      type,
      nullable,
      defaultExpression,
    ),
  ),

  ...[
    ["id", "text", false],
    ["providerInstanceRowId", "text", false],
    ["workspaceId", "text", false],
    ["repositoryId", "text", false],
    ["githubRepositoryId", "text", false],
    ["manifestId", "text", false],
    ["manifestDigest", "text", false],
    ["recoveryRequestId", "text", true],
    ["recoveryEpoch", "bigint", false],
    ["operationId", "text", false],
    ["payloadVersion", "integer", false],
    ["canonicalizationVersion", "integer", false],
    ["generationHash", "text", false],
    ["accountIdentityHash", "text", false],
    ["accountIdentityAlgorithm", "text", false],
    ["authByteSize", "integer", false],
    ["installerVersion", "text", false],
    ["installerDigest", "text", false],
    ["databaseIncarnation", "text", false],
    ["databaseRecoveryWitness", "text", false],
    ["status", "text", false],
    ["claimVersion", "integer", false, "1"],
    ["prepareReplayExpiresAt", "timestamp(3) with time zone", false],
    ["recoveryExpiresAt", "timestamp(3) with time zone", false],
    ["confirmedAttemptId", "text", true],
    ["createdAt", "timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"],
    ["updatedAt", "timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"],
    ["confirmedAt", "timestamp(3) with time zone", true],
    ["activatedAt", "timestamp(3) with time zone", true],
  ].map(([name, type, nullable, defaultExpression]) =>
    c("CodexOAuthSetupPayloadClaim", name, type, nullable, defaultExpression),
  ),

  ...[
    ["id", "text", false],
    ["providerInstanceRowId", "text", false],
    ["githubRepositoryId", "text", false],
    ["namespaceEpoch", "bigint", false],
    ["secretName", "text", false],
    ["databaseRecoveryWitness", "text", false],
    ["status", "text", false],
    ["permanentlyRetired", "boolean", false, "false"],
    ["workflowPath", "text", true],
    ["workflowSourceCommitSha", "text", true],
    ["workflowSourceBlobSha", "text", true],
    ["workflowSourceSha256", "text", true],
    ["workflowSemanticSha256", "text", true],
    ["workflowSourceTrust", "text", true],
    ["attestedRepositoryId", "text", true],
    ["createdAt", "timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"],
    ["confirmedAt", "timestamp(3) with time zone", true],
    ["activatedAt", "timestamp(3) with time zone", true],
    ["retiredAt", "timestamp(3) with time zone", true],
  ].map(([name, type, nullable, defaultExpression]) =>
    c("CodexOAuthSecretNamespace", name, type, nullable, defaultExpression),
  ),

  ...[
    ["id", "text", false],
    ["claimId", "text", false],
    ["namespaceId", "text", false],
    ["ordinal", "integer", false],
    ["idempotencyKey", "text", false],
    ["status", "text", false],
    ["authorizedAt", "timestamp(3) with time zone", false],
    ["dispatchExpiresAt", "timestamp(3) with time zone", false],
    ["definiteResponseCode", "integer", true],
    ["confirmedAt", "timestamp(3) with time zone", true],
    ["retiredAt", "timestamp(3) with time zone", true],
    ["createdAt", "timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"],
    ["updatedAt", "timestamp(3) with time zone", false, "CURRENT_TIMESTAMP"],
  ].map(([name, type, nullable, defaultExpression]) =>
    c(
      "CodexOAuthSetupDispatchAttempt",
      name,
      type,
      nullable,
      defaultExpression,
    ),
  ),
]);

export const codexRotatingCatalogColumns = Object.freeze([
  ...legacyCatalogColumns,
  ...codexRotatingOwnedColumns,
]);

export const codexRotatingCatalogColumnKeys = Object.freeze(
  codexRotatingCatalogColumns.map(catalogColumnKey),
);

export const codexRotatingCatalogCheckNames = Object.freeze([
  "CodexOAuthDatabaseAuthorityKey_singleton_check",
  "CodexOAuthLease_epoch_check",
  "CodexOAuthLease_pullRequestNumber_check",
  "CodexOAuthLease_secret_namespace_pair_check",
  "CodexOAuthProviderInstance_active_namespace_pair_check",
  "CodexOAuthProviderInstance_mutation_fence_check",
  "CodexOAuthSecretNamespace_lifecycle_check",
  "CodexOAuthSecretNamespace_name_check",
  "CodexOAuthSecretNamespace_recovery_witness_check",
  "CodexOAuthSetupDispatchAttempt_lifecycle_check",
  "CodexOAuthSetupManifest_database_recovery_witness_check",
  "CodexOAuthSetupManifest_epoch_check",
  "CodexOAuthSetupManifest_payload_claim_complete_check",
  "CodexOAuthSetupManifest_recovery_expiry_check",
  "CodexOAuthSetupPayloadClaim_payload_check",
  "CodexOAuthSetupRecoveryRequest_contract_check",
  "CodexOAuthSetupRecoveryRequest_database_recovery_witness_check",
  "CodexOAuthSetupRecoveryRequest_epoch_check",
  "CodexOAuthWritebackIntent_account_identity_check",
  "CodexOAuthWritebackIntent_database_incarnation_check",
  "CodexOAuthWritebackIntent_database_recovery_witness_check",
  "CodexOAuthWritebackIntent_epoch_check",
  "CodexOAuthWritebackIntent_executor_lease_check",
  "CodexOAuthWritebackIntent_provider_response_check",
  "CodexOAuthWritebackIntent_recovery_resolution_check",
  "CodexOAuthWritebackIntent_versioned_dispatch_check",
]);

// SHA-256 of PostgreSQL 17 pg_get_constraintdef output after canonical
// whitespace normalization. Full-definition equality is deliberate: checking
// for a few tokens would accept weakened expressions such as `... AND false`.
export const codexRotatingCheckDefinitions = Object.freeze([
  Object.freeze({
    name: "CodexOAuthDatabaseAuthorityKey_singleton_check",
    definitionSha256:
      "0a780c77dfabbc15def3d17957997d352de196c1233a0d25fccc97a40d2d6f41",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_executor_lease_check",
    definitionSha256:
      "0352f0e18e4b7c15bdeed25b333c17198ad82bbf204023f8e51c7e7573a04b64",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthLease_pullRequestNumber_check",
    definitionSha256:
      "d14f18df46cdc8bfb78e693d251751184d62f0ed075c730d3405b4e156bec824",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthLease_epoch_check",
    definitionSha256:
      "b89d9bb7f19cf5f9855b65e9124eac1b8709fc7d76b035d00b119954a32243fb",
    validated: false,
  }),
  Object.freeze({
    name: "CodexOAuthLease_secret_namespace_pair_check",
    definitionSha256:
      "2b16671648c567ec1295f234d609b3901c8de67aaadc056b9060b82598fa8ae6",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthProviderInstance_active_namespace_pair_check",
    definitionSha256:
      "aa893026cb47a41f4fe83e469e67f0bbe6fdd767c2e779a0ae8c848787d6ee7c",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthProviderInstance_mutation_fence_check",
    definitionSha256:
      "f32765dd1b8b45e21c7295ed7e8856d6a9e7d059ab2530114c5ad7a1b2b26f71",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthSecretNamespace_lifecycle_check",
    definitionSha256:
      "e6df564a21d2150ff9bf585e87d670662ad388b2548fb6836a184824812b5c7c",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthSecretNamespace_name_check",
    definitionSha256:
      "cd003ecf87035c2dc1626e5d9b566a240e9a43188e65425cf4b99c23fa7d3a4b",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthSecretNamespace_recovery_witness_check",
    definitionSha256:
      "6b3da4927a9d509107aeb3b5c2e1edb11bc65fb06c7230aab2fea4840be11ca2",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthSetupDispatchAttempt_lifecycle_check",
    definitionSha256:
      "37f6d8864fad7962599d2139e40158ce8f4976ff00025e02a14af9ac396ca12a",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthSetupManifest_database_recovery_witness_check",
    definitionSha256:
      "498a0b1914b42b3a76504453fb3d0a5fe0ad5cb6b79a21fd38f647f0934c687e",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthSetupManifest_epoch_check",
    definitionSha256:
      "3e77eb89d5da7a603ddacca8d42dd5d73ca6bfe7478d3eff159b248b2b84b26c",
    validated: false,
  }),
  Object.freeze({
    name: "CodexOAuthSetupManifest_payload_claim_complete_check",
    definitionSha256:
      "d718675eaa50adba8df1784bb2e2a409bb2ed42c4fdf2d4cf4bb1f20e8da4c27",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthSetupManifest_recovery_expiry_check",
    definitionSha256:
      "2218261175fb1f15afb1c06f6b9429a6257501064444f8d0b133864a2858d6cb",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthSetupPayloadClaim_payload_check",
    definitionSha256:
      "e51c73230a67411c1eef23e6ebd02077edf882b92c4b8223d82da5fd727995ba",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthSetupRecoveryRequest_contract_check",
    definitionSha256:
      "09f1b59acf31c49d5e25ca34f3bd66135ca62bcea3df301f95902351ca16abda",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthSetupRecoveryRequest_database_recovery_witness_check",
    definitionSha256:
      "498a0b1914b42b3a76504453fb3d0a5fe0ad5cb6b79a21fd38f647f0934c687e",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthSetupRecoveryRequest_epoch_check",
    definitionSha256:
      "4eedd4bf1f2134995db46b88329424c4500d7c56ec2d6fea0db16d1986454fa9",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_account_identity_check",
    definitionSha256:
      "d74da3db774363ee07fb67315e4fa0ce6e434a40bd54b6e15065e4606e21bebf",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_database_incarnation_check",
    definitionSha256:
      "fe4a2a988f9eb4501c9bbca357799b20d5f2659c78b92f7feca6fba27f307052",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_database_recovery_witness_check",
    definitionSha256:
      "498a0b1914b42b3a76504453fb3d0a5fe0ad5cb6b79a21fd38f647f0934c687e",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_epoch_check",
    definitionSha256:
      "9bf0bd8d507afda6e6428f8450cb0ed6574a2cfbf9f02d1a637e021c1fa83461",
    validated: false,
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_provider_response_check",
    definitionSha256:
      "6d20a6df403b8914702f3310e6ab0df61c4e47aaec871f91eff044405b2c7f20",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_recovery_resolution_check",
    definitionSha256:
      "fe758b51efdacba47574fea6f3fd65b767fe7f24fe060693a06f68f46f99f159",
    validated: true,
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_versioned_dispatch_check",
    definitionSha256:
      "4ad90c3c72a58bdb4aaabbf7e1e0ad0c19f00ae4a3e8ec6290d9451a12a37b04",
    validated: true,
  }),
]);

export const codexRotatingPartialIndexPredicates = Object.freeze([
  Object.freeze({
    name: "CodexOAuthSetupManifest_one_active_provider_key",
    predicateSha256:
      "b6ac8a83f3f2e47bd70f903937a980fc82419474a3719a63cd30b4479d544fbd",
  }),
  Object.freeze({
    name: "CodexOAuthSetupRecoveryRequest_one_active_provider_key",
    predicateSha256:
      "4d445f55171718009d7adfadb4792b98bbe9fa5135567d20da610c76fe9a0292",
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_versioned_lease_key",
    predicateSha256:
      "ee382cb1dfa031e43fbfe45051f846b535d56e106fba80ab033985df34b24d84",
  }),
]);

export const codexRotatingIndexDefinitions = Object.freeze([
  ...[
    [
      "CodexOAuthLease_expiresAt_idx",
      "3eaa795b832b25e89b1b61e1b4e859753b5ecae3c6e07b775ae2b630e6e5953f",
    ],
    [
      "CodexOAuthLease_providerInstanceId_status_idx",
      "1b7524f5148a811b1f281f15b3a99eac97790a2ec5c5278407b5decf37a8e245",
    ],
    [
      "CodexOAuthLease_repositoryId_status_idx",
      "0a3c7971412137a6ef32061dd8eb9ac1b6e77640cd64dff11278ae77f7cc8404",
    ],
    [
      "CodexOAuthLease_workspaceId_status_idx",
      "d81de8b4218dc7135f838b7697c14216864d14b5376dde97b96824fa3e2d8d25",
    ],
    [
      "CodexOAuthProviderInstance_activeLeaseExpiresAt_idx",
      "ad8973e9a744a140fbbda9d2560fc7cfc73660b0b770b25416bd97c3bcf0d0d9",
    ],
    [
      "CodexOAuthProviderInstance_providerInstanceId_key",
      "7d26191d774013220ebcc55e0750ed51141ff2c77634b4ac9339a1961029c38c",
    ],
    [
      "CodexOAuthProviderInstance_repositoryId_authMode_key",
      "5c93020d2d1c05517654edcab32b4d0d5c3884a376825a5860aeb78d18bc1477",
    ],
    [
      "CodexOAuthProviderInstance_repositoryId_state_idx",
      "788baa109acb4219055617c137266e51352cb664e5181d95e821063ff044ed8a",
    ],
    [
      "CodexOAuthProviderInstance_workspaceId_state_idx",
      "457271b7d95543fc5193ac41776029733c5c33cbfd5619905d22826d7e6900a8",
    ],
    [
      "CodexOAuthSetupManifest_expiresAt_idx",
      "186e0837764eab0a661302f4e50718660bda2fc57ea3c97d6cf8f288f5856c9b",
    ],
    [
      "CodexOAuthSetupManifest_providerInstanceId_status_idx",
      "7d930c433530a68c31bc233492d53d897663aa0ae718fc2bfbdcfb5b10709bbc",
    ],
    [
      "CodexOAuthSetupManifest_repositoryId_status_idx",
      "c7dda7465841cb6c39e425bd58bea3524598f168e688d3132d8def3519a664d6",
    ],
    [
      "CodexOAuthSetupManifest_setupNonce_key",
      "6e9d67e61019a0d1afc8356d0134885ff30daaf1a5dd67114fd30d59aefb0a90",
    ],
    [
      "CodexOAuthWritebackIntent_leaseId_status_idx",
      "3ab7eecbb55af6e188a1d707fc0a15bd99edaec8d6913c7d6fc5ebc064342d69",
    ],
    [
      "CodexOAuthWritebackIntent_providerInstanceId_status_idx",
      "e67582e2ed1cbeccd6a254fdb378f0fc9af20cc6d81f8108eeb234feb6cda06c",
    ],
  ].map(([name, definitionSha256]) =>
    Object.freeze({ name, definitionSha256 }),
  ),
  Object.freeze({
    name: "CodexOAuthLease_leaseKey_key",
    definitionSha256:
      "f4009eb710a277cddd24cb950e5fe5562f3bcc3328ddd4a5705f24d88bec9e56",
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_providerInstanceId_idempotencyKey_key",
    definitionSha256:
      "7005b3e0855cdc54adeff78c8ed6644aba5748e9ff1dbc2e7b3075bf7e18221d",
  }),
  Object.freeze({
    name: "CodexOAuthChildIdentityQuarantine_provider_idx",
    definitionSha256:
      "26e48370f686df432fcae20558e0cfbe59c9762852c5aa75c0a327d80ea53212",
  }),
  Object.freeze({
    name: "CodexOAuthLease_provider_epoch_idx",
    definitionSha256:
      "1934158b515ebc08bf8d1b4bd52415ea45a1c183dfae5cf4ce37ac12243d3188",
  }),
  Object.freeze({
    name: "CodexOAuthProviderInstance_activeSecretNamespaceId_key",
    definitionSha256:
      "b2dc3f79efeae1355bdd376b1524911cb82b0f32f4c633a45b73eb795af90474",
  }),
  Object.freeze({
    name: "CodexOAuthProviderInstance_mutation_owner_idx",
    definitionSha256:
      "279acd9b7ea0633dc99c93ced630c4c7f204c3c378f2babb56e98f4dac79dc21",
  }),
  Object.freeze({
    name: "CodexOAuthSecretNamespace_id_epoch_key",
    definitionSha256:
      "99282c553103f87063e5bec5d8defe7904b7855199b3fac4a4f44e9da3a0d028",
  }),
  Object.freeze({
    name: "CodexOAuthSecretNamespace_id_epoch_name_key",
    definitionSha256:
      "6252f1ae5d3ba87f94f9648487a643c674d15876f06619b4717e13f2314bb2ad",
  }),
  Object.freeze({
    name: "CodexOAuthSecretNamespace_provider_epoch_key",
    definitionSha256:
      "5aabac9d221724cb4a23209275ae81a08e63316c4577e2120236f6a5e960747d",
  }),
  Object.freeze({
    name: "CodexOAuthSecretNamespace_provider_id_key",
    definitionSha256:
      "ee431641a6ced891525b9f3eb6e92de17757e18d8690d40762d604aa9227b3f2",
  }),
  Object.freeze({
    name: "CodexOAuthSecretNamespace_provider_status_idx",
    definitionSha256:
      "310a63efff6184248e78e67c8f0f146340ae6fe1d05672ec418d3d4ac27bfd0d",
  }),
  Object.freeze({
    name: "CodexOAuthSecretNamespace_secretName_key",
    definitionSha256:
      "c36a7dc9c872adf741376860b55ec5eda8273391e48741caed9dc45ea89223f2",
  }),
  Object.freeze({
    name: "CodexOAuthSetupDispatchAttempt_claim_idempotency_key",
    definitionSha256:
      "69cd507d9ce3c45d20f83b25fcfa09906e18daafb3b13d9dee79c1044e4d82f3",
  }),
  Object.freeze({
    name: "CodexOAuthSetupDispatchAttempt_claim_ordinal_key",
    definitionSha256:
      "23a31d879a065ba87f9a171bbb9422ba7ae158246622ecf16f3f3b8c4dc040c8",
  }),
  Object.freeze({
    name: "CodexOAuthSetupDispatchAttempt_claim_status_idx",
    definitionSha256:
      "1aa88719d524de770d146ca246128353dfb92b62ffcd0a9690a28e128a239ad9",
  }),
  Object.freeze({
    name: "CodexOAuthSetupDispatchAttempt_namespaceId_key",
    definitionSha256:
      "500549c7f1e82c93150c5d39f6346bd0cc87df296991111dd52fcb4cfc35ef37",
  }),
  Object.freeze({
    name: "CodexOAuthSetupManifest_one_active_provider_key",
    definitionSha256:
      "0c9e2a1e6ce97aaccb0b1c1a5de947b0e71afd78e247617b9a19978d35fac572",
  }),
  Object.freeze({
    name: "CodexOAuthSetupManifest_provider_epoch_idx",
    definitionSha256:
      "8a48aaf5e61e75f5ad2e1bf198ac7841f2d18eb21f4eabfa548c89aa0f180892",
  }),
  Object.freeze({
    name: "CodexOAuthSetupManifest_recovery_expiry_idx",
    definitionSha256:
      "8a570613641cc9eaa5ff32307b86de7367556d923fc949cf846c5d86358626e6",
  }),
  Object.freeze({
    name: "CodexOAuthSetupPayloadClaim_confirmedAttemptId_key",
    definitionSha256:
      "8cd525d8d93b61e1dc7264b6d4d00dd62cfa46e3a8c5194a54226f982e7295a1",
  }),
  Object.freeze({
    name: "CodexOAuthSetupPayloadClaim_provider_epoch_key",
    definitionSha256:
      "45177e820bbe4351aefb1c73d3d9b3547466c57f33d96794e8d403dd86a595b9",
  }),
  Object.freeze({
    name: "CodexOAuthSetupPayloadClaim_provider_operation_key",
    definitionSha256:
      "fad278906eb3a143d5a251de7cfb9fb3ee006a0b881857a681bd3780f4a42008",
  }),
  Object.freeze({
    name: "CodexOAuthSetupPayloadClaim_provider_status_idx",
    definitionSha256:
      "31283ca1ccffe54e50b9f7c2da215f0d9609bed410c7f10ae3a24cbfb0555a08",
  }),
  Object.freeze({
    name: "CodexOAuthSetupRecoveryRequest_latestManifestId_key",
    definitionSha256:
      "45ef8f33f8b92e1632862abe22c2f8ffc5d7287717fe91d0286f864688cb12e8",
  }),
  Object.freeze({
    name: "CodexOAuthSetupRecoveryRequest_one_active_provider_key",
    definitionSha256:
      "e1f139e2207944a4c53e0029d4ae5c919f8e3f5db0920c206f8570a9f06a7900",
  }),
  Object.freeze({
    name: "CodexOAuthSetupRecoveryRequest_provider_request_key",
    definitionSha256:
      "82e74bb1cb1fee0b2d05b5754345820e97c1421981577a9c8060c1a1364f308e",
  }),
  Object.freeze({
    name: "CodexOAuthSetupRecoveryRequest_provider_state_idx",
    definitionSha256:
      "80c70ea110007d0eff711fd86d0de8ce117615a382ebae505b6dfaa308746108",
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_dispatchAttemptId_key",
    definitionSha256:
      "00f3adb6bd9b60b767cc0d380d0209bd6ecccb91741031dfc013d6f440eec3de",
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_provider_epoch_idx",
    definitionSha256:
      "362e24efcec988141dd90f185f8a3844aaf4e38687d9a1de1077be05f470f741",
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_secretNamespaceId_key",
    definitionSha256:
      "ad2bdbc8b95be2d211cebf815fc203124c2f5417c6d621d046ffe63a3b2f8c60",
  }),
  Object.freeze({
    name: "CodexOAuthWritebackIntent_versioned_lease_key",
    definitionSha256:
      "41e8490a6a7a01df0a34a610a7dc95961912cad96175d4a80ab3684d79c4b457",
  }),
]);

export const codexRotatingDatabaseRoles = Object.freeze({
  releaseMigration: "reviewrouter_release_migration",
  effectAuthority: "reviewrouter_codex_effect_authority",
  runtime: Object.freeze([
    "reviewrouter_api",
    "reviewrouter_web",
    "reviewrouter_worker",
  ]),
});

export const codexRotatingCatalogIndexNames = Object.freeze([
  "CodexOAuthChildIdentityQuarantine_pkey",
  "CodexOAuthChildIdentityQuarantine_provider_idx",
  "CodexOAuthDatabaseAuthorityKey_pkey",
  "CodexOAuthDatabaseAuthorityReceipt_pkey",
  "CodexOAuthLease_expiresAt_idx",
  "CodexOAuthLease_leaseKey_key",
  "CodexOAuthLease_pkey",
  "CodexOAuthLease_provider_epoch_idx",
  "CodexOAuthLease_providerInstanceId_status_idx",
  "CodexOAuthLease_repositoryId_status_idx",
  "CodexOAuthLease_workspaceId_status_idx",
  "CodexOAuthProviderIdentityQuarantine_pkey",
  "CodexOAuthProviderInstance_activeLeaseExpiresAt_idx",
  "CodexOAuthProviderInstance_activeSecretNamespaceId_key",
  "CodexOAuthProviderInstance_mutation_owner_idx",
  "CodexOAuthProviderInstance_pkey",
  "CodexOAuthProviderInstance_providerInstanceId_key",
  "CodexOAuthProviderInstance_repositoryId_authMode_key",
  "CodexOAuthProviderInstance_repositoryId_state_idx",
  "CodexOAuthProviderInstance_workspaceId_state_idx",
  "CodexOAuthSecretNamespace_id_epoch_key",
  "CodexOAuthSecretNamespace_id_epoch_name_key",
  "CodexOAuthSecretNamespace_pkey",
  "CodexOAuthSecretNamespace_provider_epoch_key",
  "CodexOAuthSecretNamespace_provider_id_key",
  "CodexOAuthSecretNamespace_provider_status_idx",
  "CodexOAuthSecretNamespace_secretName_key",
  "CodexOAuthSetupDispatchAttempt_claim_idempotency_key",
  "CodexOAuthSetupDispatchAttempt_claim_ordinal_key",
  "CodexOAuthSetupDispatchAttempt_claim_status_idx",
  "CodexOAuthSetupDispatchAttempt_namespaceId_key",
  "CodexOAuthSetupDispatchAttempt_pkey",
  "CodexOAuthSetupManifest_expiresAt_idx",
  "CodexOAuthSetupManifest_one_active_provider_key",
  "CodexOAuthSetupManifest_pkey",
  "CodexOAuthSetupManifest_provider_epoch_idx",
  "CodexOAuthSetupManifest_providerInstanceId_status_idx",
  "CodexOAuthSetupManifest_recovery_expiry_idx",
  "CodexOAuthSetupManifest_repositoryId_status_idx",
  "CodexOAuthSetupManifest_setupNonce_key",
  "CodexOAuthSetupPayloadClaim_confirmedAttemptId_key",
  "CodexOAuthSetupPayloadClaim_pkey",
  "CodexOAuthSetupPayloadClaim_provider_epoch_key",
  "CodexOAuthSetupPayloadClaim_provider_operation_key",
  "CodexOAuthSetupPayloadClaim_provider_status_idx",
  "CodexOAuthSetupRecoveryRequest_latestManifestId_key",
  "CodexOAuthSetupRecoveryRequest_one_active_provider_key",
  "CodexOAuthSetupRecoveryRequest_pkey",
  "CodexOAuthSetupRecoveryRequest_provider_request_key",
  "CodexOAuthSetupRecoveryRequest_provider_state_idx",
  "CodexOAuthWritebackIntent_dispatchAttemptId_key",
  "CodexOAuthWritebackIntent_leaseId_status_idx",
  "CodexOAuthWritebackIntent_pkey",
  "CodexOAuthWritebackIntent_provider_epoch_idx",
  "CodexOAuthWritebackIntent_providerInstanceId_idempotencyKey_key",
  "CodexOAuthWritebackIntent_providerInstanceId_status_idx",
  "CodexOAuthWritebackIntent_secretNamespaceId_key",
  "CodexOAuthWritebackIntent_versioned_lease_key",
]);

const prismaModeledRecoveryLedgerForeignKeys = [];
const defineForeignKey = (name, table, definition) =>
  Object.freeze({ name, table, definition });
const fk = (name, table, definition) => {
  const foreignKey = defineForeignKey(name, table, definition);
  prismaModeledRecoveryLedgerForeignKeys.push(foreignKey);
  return foreignKey;
};
const databaseOnlyFk = defineForeignKey;

// Exact pre-000060 constraints that remain part of the rotating writer
// catalog. Names alone are insufficient: a same-name constraint can otherwise
// be repointed or weakened without changing the inventory.
export const codexRotatingLegacyForeignKeys = Object.freeze([
  defineForeignKey(
    "CodexOAuthLease_providerInstanceRowId_fkey",
    "CodexOAuthLease",
    'FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"(id) ON UPDATE CASCADE ON DELETE CASCADE',
  ),
  defineForeignKey(
    "CodexOAuthLease_repositoryId_fkey",
    "CodexOAuthLease",
    'FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"(id) ON UPDATE CASCADE ON DELETE CASCADE',
  ),
  defineForeignKey(
    "CodexOAuthLease_workspaceId_fkey",
    "CodexOAuthLease",
    'FOREIGN KEY ("workspaceId") REFERENCES "Workspace"(id) ON UPDATE CASCADE ON DELETE CASCADE',
  ),
  defineForeignKey(
    "CodexOAuthProviderInstance_repositoryId_fkey",
    "CodexOAuthProviderInstance",
    'FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"(id) ON UPDATE CASCADE ON DELETE CASCADE',
  ),
  defineForeignKey(
    "CodexOAuthProviderInstance_workspaceId_fkey",
    "CodexOAuthProviderInstance",
    'FOREIGN KEY ("workspaceId") REFERENCES "Workspace"(id) ON UPDATE CASCADE ON DELETE CASCADE',
  ),
  defineForeignKey(
    "CodexOAuthSetupManifest_providerInstanceRowId_fkey",
    "CodexOAuthSetupManifest",
    'FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"(id) ON UPDATE CASCADE ON DELETE CASCADE',
  ),
  defineForeignKey(
    "CodexOAuthSetupManifest_repositoryId_fkey",
    "CodexOAuthSetupManifest",
    'FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"(id) ON UPDATE CASCADE ON DELETE CASCADE',
  ),
  defineForeignKey(
    "CodexOAuthSetupManifest_workspaceId_fkey",
    "CodexOAuthSetupManifest",
    'FOREIGN KEY ("workspaceId") REFERENCES "Workspace"(id) ON UPDATE CASCADE ON DELETE CASCADE',
  ),
]);

// pg_get_constraintdef output for every recovery-ledger FK owned or replaced
// by migration 000064. Source table and the complete deparsed definition are
// both part of the contract so a same-name constraint cannot be repointed or
// weakened without failing production capture and the PostgreSQL rehearsal.
export const codexRotatingRecoveryLedgerForeignKeys = Object.freeze([
  fk(
    "CodexOAuthSetupRecoveryRequest_providerInstanceRowId_fkey",
    "CodexOAuthSetupRecoveryRequest",
    'FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"(id) ON UPDATE CASCADE ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthSetupRecoveryRequest_latestManifestId_fkey",
    "CodexOAuthSetupRecoveryRequest",
    'FOREIGN KEY ("latestManifestId") REFERENCES "CodexOAuthSetupManifest"(id) ON UPDATE CASCADE ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthSetupPayloadClaim_provider_fkey",
    "CodexOAuthSetupPayloadClaim",
    'FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"(id) ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthSetupPayloadClaim_workspace_fkey",
    "CodexOAuthSetupPayloadClaim",
    'FOREIGN KEY ("workspaceId") REFERENCES "Workspace"(id) ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthSetupPayloadClaim_repository_fkey",
    "CodexOAuthSetupPayloadClaim",
    'FOREIGN KEY ("repositoryId") REFERENCES "RepositoryConnection"(id) ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthSetupPayloadClaim_manifest_fkey",
    "CodexOAuthSetupPayloadClaim",
    'FOREIGN KEY ("manifestId") REFERENCES "CodexOAuthSetupManifest"(id) ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthSetupPayloadClaim_recovery_request_fkey",
    "CodexOAuthSetupPayloadClaim",
    'FOREIGN KEY ("providerInstanceRowId", "recoveryRequestId") REFERENCES "CodexOAuthSetupRecoveryRequest"("providerInstanceRowId", "recoveryRequestId") ON UPDATE CASCADE ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthSetupPayloadClaim_confirmed_attempt_fkey",
    "CodexOAuthSetupPayloadClaim",
    'FOREIGN KEY ("confirmedAttemptId") REFERENCES "CodexOAuthSetupDispatchAttempt"(id) ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthSecretNamespace_provider_fkey",
    "CodexOAuthSecretNamespace",
    'FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"(id) ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthSetupDispatchAttempt_claim_fkey",
    "CodexOAuthSetupDispatchAttempt",
    'FOREIGN KEY ("claimId") REFERENCES "CodexOAuthSetupPayloadClaim"(id) ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthSetupDispatchAttempt_namespace_fkey",
    "CodexOAuthSetupDispatchAttempt",
    'FOREIGN KEY ("namespaceId") REFERENCES "CodexOAuthSecretNamespace"(id) ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthProviderInstance_active_namespace_fkey",
    "CodexOAuthProviderInstance",
    'FOREIGN KEY ("activeSecretNamespaceId") REFERENCES "CodexOAuthSecretNamespace"(id) ON DELETE RESTRICT',
  ),
  databaseOnlyFk(
    "CodexOAuthProviderInstance_active_namespace_epoch_fkey",
    "CodexOAuthProviderInstance",
    'FOREIGN KEY ("activeSecretNamespaceId", "activeSecretNamespaceEpoch") REFERENCES "CodexOAuthSecretNamespace"(id, "namespaceEpoch") ON DELETE RESTRICT',
  ),
  databaseOnlyFk(
    "CodexOAuthProviderInstance_active_namespace_identity_fkey",
    "CodexOAuthProviderInstance",
    'FOREIGN KEY ("activeSecretNamespaceId", "activeSecretNamespaceEpoch", "activeSecretNamespaceName") REFERENCES "CodexOAuthSecretNamespace"(id, "namespaceEpoch", "secretName") ON DELETE RESTRICT',
  ),
  databaseOnlyFk(
    "CodexOAuthProviderInstance_active_namespace_owner_fkey",
    "CodexOAuthProviderInstance",
    'FOREIGN KEY (id, "activeSecretNamespaceId") REFERENCES "CodexOAuthSecretNamespace"("providerInstanceRowId", id) ON DELETE RESTRICT',
  ),
  databaseOnlyFk(
    "CodexOAuthLease_secret_namespace_epoch_fkey",
    "CodexOAuthLease",
    'FOREIGN KEY ("secretNamespaceId", "secretNamespaceEpoch") REFERENCES "CodexOAuthSecretNamespace"(id, "namespaceEpoch") ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthWritebackIntent_secret_namespace_fkey",
    "CodexOAuthWritebackIntent",
    'FOREIGN KEY ("secretNamespaceId") REFERENCES "CodexOAuthSecretNamespace"(id) ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthWritebackIntent_recovery_request_fkey",
    "CodexOAuthWritebackIntent",
    'FOREIGN KEY ("recoveryRequestRowId") REFERENCES "CodexOAuthSetupRecoveryRequest"(id) ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthWritebackIntent_providerInstanceRowId_fkey",
    "CodexOAuthWritebackIntent",
    'FOREIGN KEY ("providerInstanceRowId") REFERENCES "CodexOAuthProviderInstance"(id) ON DELETE RESTRICT',
  ),
  fk(
    "CodexOAuthWritebackIntent_leaseId_fkey",
    "CodexOAuthWritebackIntent",
    'FOREIGN KEY ("leaseId") REFERENCES "CodexOAuthLease"(id) ON DELETE RESTRICT',
  ),
]);

export const codexRotatingRecoveryLedgerForeignKeyNames = Object.freeze(
  codexRotatingRecoveryLedgerForeignKeys.map(({ name }) => name),
);

export const codexRotatingCatalogForeignKeys = Object.freeze([
  ...codexRotatingLegacyForeignKeys,
  ...codexRotatingRecoveryLedgerForeignKeys,
]);

// These are the same frozen definitions from the complete catalog contract,
// excluding database-only strengthening constraints that Prisma cannot model
// alongside their owning relations. Schema tests derive map/onUpdate from this
// view instead of maintaining a second foreign-key inventory.
export const codexRotatingPrismaModeledRecoveryLedgerForeignKeys =
  Object.freeze([...prismaModeledRecoveryLedgerForeignKeys]);

export const codexRotatingCatalogForeignKeyNames = Object.freeze([
  ...codexRotatingCatalogForeignKeys.map(({ name }) => name),
]);

export const codexRotatingPrimaryKeys = Object.freeze(
  [
    [
      "CodexOAuthChildIdentityQuarantine_pkey",
      "CodexOAuthChildIdentityQuarantine",
      'PRIMARY KEY ("childKind", "childId")',
    ],
    [
      "CodexOAuthDatabaseAuthorityReceipt_pkey",
      "CodexOAuthDatabaseAuthorityReceipt",
      'PRIMARY KEY ("databaseRole", "backendPid", "transactionId", effect, "ownerId", "effectCode")',
    ],
    [
      "CodexOAuthDatabaseAuthorityKey_pkey",
      "CodexOAuthDatabaseAuthorityKey",
      "PRIMARY KEY (singleton)",
    ],
    ["CodexOAuthLease_pkey", "CodexOAuthLease", "PRIMARY KEY (id)"],
    [
      "CodexOAuthProviderIdentityQuarantine_pkey",
      "CodexOAuthProviderIdentityQuarantine",
      'PRIMARY KEY ("providerInstanceRowId")',
    ],
    [
      "CodexOAuthProviderInstance_pkey",
      "CodexOAuthProviderInstance",
      "PRIMARY KEY (id)",
    ],
    [
      "CodexOAuthSecretNamespace_pkey",
      "CodexOAuthSecretNamespace",
      "PRIMARY KEY (id)",
    ],
    [
      "CodexOAuthSetupDispatchAttempt_pkey",
      "CodexOAuthSetupDispatchAttempt",
      "PRIMARY KEY (id)",
    ],
    [
      "CodexOAuthSetupManifest_pkey",
      "CodexOAuthSetupManifest",
      "PRIMARY KEY (id)",
    ],
    [
      "CodexOAuthSetupPayloadClaim_pkey",
      "CodexOAuthSetupPayloadClaim",
      "PRIMARY KEY (id)",
    ],
    [
      "CodexOAuthSetupRecoveryRequest_pkey",
      "CodexOAuthSetupRecoveryRequest",
      "PRIMARY KEY (id)",
    ],
    [
      "CodexOAuthWritebackIntent_pkey",
      "CodexOAuthWritebackIntent",
      "PRIMARY KEY (id)",
    ],
  ].map(([name, table, definition]) =>
    Object.freeze({ name, table, definition, validated: true }),
  ),
);

const functionBody = (name, bodySha256) => Object.freeze({ name, bodySha256 });

// SHA-256 of pg_proc.prosrc after CRLF/CR -> LF normalization and trimming
// outer whitespace. Metadata is verified separately; these digests bind the
// complete stored PL/pgSQL bodies rather than one easily preserved token.
export const codexRotatingFunctionBodyDigests = Object.freeze([
  functionBody(
    "codex_oauth_authorize_provider_identity_repair",
    "90474a7b622a55f6967d9947451bcf8b563f6f0c89ef7dbe09bd58e0f61f20f3",
  ),
  functionBody(
    "codex_oauth_authorize_runtime_completion",
    "753dd33a96776039c03a12ad83eddeb9ff5041c5f1aadd62fa6170806caeb694",
  ),
  functionBody(
    "codex_oauth_authorize_runtime_confirmation",
    "7282244f4ae3649cb8e97668efa351e8b4c8c9e2f5b9ed52badfd215fa138d11",
  ),
  functionBody(
    "codex_oauth_authorize_setup_confirmation",
    "26eb2db9835230178a23f36c6d44ca58a0832834293b2d43c6d10a8370bf3a7d",
  ),
  functionBody(
    "codex_oauth_child_identity_fence_guard",
    "29210f62bd56d1592a30ad0a3672c93d3b9b459d89e55636418a9294c0198088",
  ),
  functionBody(
    "codex_oauth_consume_database_authority",
    "f78dcb97afb2d078cfee39ecaf7cfd2de9ad7d2beac758d7eb27388bc5ce075a",
  ),
  functionBody(
    "codex_oauth_database_authority_challenge",
    "478770fa321c3f018db0bc96b571b9b82f0bd771094bde192764923b5f982e10",
  ),
  functionBody(
    "codex_oauth_database_authority_receipt_guard",
    "f2eb97bd2559fc2434765b24e7358ba21717674ca020d81808bf1661dee5892d",
  ),
  functionBody(
    "codex_oauth_provider_identity_guard",
    "a9f070ee7f332c150b7c33ccb5d5e1fc1a2ecf67ec35cd0ad5343b494718e6e8",
  ),
  functionBody(
    "codex_oauth_provider_mutation_transition_guard",
    "0c735bbe8f8748d5efa6a001b416bc268e92ad7cc466d23cb21b98d0b0750d06",
  ),
  functionBody(
    "codex_oauth_repair_quarantined_child",
    "d07c4ff352fea8060d67294f4deb2ba2a691c60bac6d3acfc8f1106af2716426",
  ),
  functionBody(
    "codex_oauth_repair_quarantined_provider",
    "8b734e58f5d6cbc79f25bbeac77fc0f9347a2d5c27a3d9018c49db14226986af",
  ),
  functionBody(
    "codex_oauth_repository_identity_guard",
    "050ebe504e6051cf2675278d8f7c48eae3d36bad407da2f3a7e148934807436a",
  ),
  functionBody(
    "codex_oauth_runtime_writeback_evidence_guard",
    "1cbb07bb96c15f56086f9d10fb54039e0c33a117b586b9cbe446f7c78302f096",
  ),
  functionBody(
    "codex_oauth_secret_namespace_tombstone_guard",
    "f52841303c4626a6270c1a897ffcf46d2e17c8f785a8bdd1dad6321f9a26d85f",
  ),
  functionBody(
    "codex_oauth_setup_attempt_evidence_guard",
    "a7bab78dcb7db3c14b279bf2948c7ae5661e5d037ba414736042dc08c469c7da",
  ),
  functionBody(
    "codex_oauth_setup_claim_evidence_guard",
    "fc0c3ad61393c44d5977a839e7f7166e9d870ee367bd8a895a87de436f10eb9d",
  ),
  functionBody(
    "codex_oauth_setup_manifest_evidence_guard",
    "ddb494ed1c7559eba04cb2e64e4453972df9b7c5024f05537d30e78c4c82d2e4",
  ),
  functionBody(
    "codex_oauth_setup_recovery_evidence_guard",
    "3a8fc166c2bf331161e52f7cf24efaed212ef276282b294df98f16e3c53fe4aa",
  ),
  functionBody(
    "codex_oauth_sign_database_authority",
    "2ece5dafc439c426f32d929d9580fe9fbb7cd65a24ac8733f11a1cf64c3b018f",
  ),
]);

export const codexRotatingFunctions = Object.freeze(
  codexRotatingFunctionBodyDigests.map(({ name }) => name),
);

export const codexRotatingTriggers = Object.freeze([
  "CodexOAuthDatabaseAuthorityReceipt_one_shot_guard",
  "CodexOAuthLease_identity_fence_guard",
  "CodexOAuthProviderInstance_identity_guard",
  "CodexOAuthProviderInstance_mutation_transition_guard",
  "CodexOAuthSetupManifest_identity_fence_guard",
  "CodexOAuthSetupManifest_evidence_guard",
  "CodexOAuthSecretNamespace_tombstone_guard",
  "CodexOAuthSetupPayloadClaim_evidence_guard",
  "CodexOAuthSetupDispatchAttempt_evidence_guard",
  "CodexOAuthSetupRecoveryRequest_evidence_guard",
  "CodexOAuthWritebackIntent_identity_fence_guard",
  "CodexOAuthWritebackIntent_runtime_evidence_guard",
  "RepositoryConnection_codex_oauth_identity_guard",
]);

export const codexRotatingPublicExecuteDeniedFunctions = codexRotatingFunctions;

export function catalogColumnKey(column) {
  return `${column.table}.${column.name}`;
}
