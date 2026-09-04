/**
 * Canonical PostgreSQL projection of the live V70-V89 application catalog.
 * Keep this in the Postgres adapter layer: the domain receives only its digest.
 */
import { canonicalReleaseMigrationArtifact } from "../domain/release-migration-transition.ts";

const phaseVaryingApplicationAclPrincipals = Object.freeze([
  "reviewrouter_api",
  "reviewrouter_web",
  "reviewrouter_worker",
]);
const phaseVaryingApplicationAclPrincipalSql =
  phaseVaryingApplicationAclPrincipals
    .map((principal) => `'${principal}'`)
    .join(",");
const phaseVaryingApplicationInsertUpdateRelations = Object.freeze([
  "CodexOAuthWritebackIntent",
  "GitHubInstallation",
  "HostedCodexCommentRefreshCapability",
  "HostedCodexCommentRefreshUse",
  "HostedCodexInvocationGrant",
  "HostedCodexPool",
  "HostedCodexRepositoryBinding",
]);
const phaseVaryingApplicationInsertUpdateRelationSql =
  phaseVaryingApplicationInsertUpdateRelations
    .map((relation) => `'${relation}'`)
    .join(",");
const phaseVaryingApplicationDeleteRelationSql =
  phaseVaryingApplicationInsertUpdateRelations
    .filter((relation) => relation !== "CodexOAuthWritebackIntent")
    .map((relation) => `'${relation}'`)
    .join(",");
const phaseVaryingCodexOAuthInsertRelations = Object.freeze([
  "CodexOAuthProviderInstance",
  "CodexOAuthSecretNamespace",
  "CodexOAuthSetupDispatchAttempt",
  "CodexOAuthSetupPayloadClaim",
]);
const phaseVaryingCodexOAuthInsertRelationSql =
  phaseVaryingCodexOAuthInsertRelations
    .map((relation) => `'${relation}'`)
    .join(",");
const phaseVaryingCodexOAuthUpdateRelations = Object.freeze([
  "CodexOAuthSecretNamespace",
  "CodexOAuthSetupDispatchAttempt",
  "CodexOAuthSetupPayloadClaim",
]);
const phaseVaryingCodexOAuthUpdateRelationSql =
  phaseVaryingCodexOAuthUpdateRelations
    .map((relation) => `'${relation}'`)
    .join(",");
const phaseVaryingCodexOAuthProviderUpdateColumns = Object.freeze([
  "activeAccountIdentityHash",
  "activeLeaseExpiresAt",
  "activeLeaseId",
  "activeSecretNamespaceEpoch",
  "activeSecretNamespaceId",
  "activeSecretNamespaceName",
  "latestGeneration",
  "latestGenerationHash",
  "mutationEpoch",
  "mutationOwner",
  "mutationOwnerId",
  "updatedAt",
  "state",
]);
const phaseVaryingCodexOAuthProviderUpdateColumnSql =
  phaseVaryingCodexOAuthProviderUpdateColumns
    .map((column) => `'${column}'`)
    .join(",");

// Only these reviewed ACL tuples vary between preactivation and activated.
// Every other write bit is phase-stable and therefore remains digest-visible.
const phaseVaryingRelationPrivilegePatternSql = `CASE
              WHEN split_part(v::text,'/',2)='reviewrouter_release_schema_owner'
                AND split_part(v::text,'=',1) IN (${phaseVaryingApplicationAclPrincipalSql})
                AND relname IN (${phaseVaryingApplicationDeleteRelationSql})
              THEN '[awd]'
              WHEN split_part(v::text,'/',2)='reviewrouter_release_schema_owner'
                AND split_part(v::text,'=',1) IN (${phaseVaryingApplicationAclPrincipalSql})
                AND relname IN (${phaseVaryingApplicationInsertUpdateRelationSql})
              THEN '[aw]'
              WHEN split_part(v::text,'/',2)='reviewrouter_release_schema_owner'
                AND split_part(v::text,'=',1) IN (${phaseVaryingApplicationAclPrincipalSql})
                AND relname IN (${phaseVaryingCodexOAuthUpdateRelationSql})
              THEN '[aw]'
              WHEN split_part(v::text,'/',2)='reviewrouter_release_schema_owner'
                AND split_part(v::text,'=',1) IN (${phaseVaryingApplicationAclPrincipalSql})
                AND relname IN (${phaseVaryingCodexOAuthInsertRelationSql})
              THEN '[a]'
              WHEN split_part(v::text,'/',2)='reviewrouter_release_schema_owner'
                AND split_part(v::text,'=',1)='reviewrouter_comment_token_custody'
                AND relname='HostedCodexCommentRefreshUse'
              THEN '[a]'
              ELSE NULL
            END`;

export const liveV70V89CatalogProjectionRelations = Object.freeze([
  "CodexOAuthWritebackIntent",
  "CodexOAuthSecretNamespace",
  "CodexOAuthProviderInstance",
  "RepositoryConnection",
  "CodexOAuthSetupDispatchAttempt",
  "CodexOAuthSetupPayloadClaim",
  "CodexOAuthDatabaseAuthorityReceipt",
  "CodexOAuthWorkflowCompatibility",
  "RuntimeGenerationWitnessProof",
  "RuntimeCanaryChallenge",
  "RuntimeCanaryChallengeProof",
  "HostedCodexCommentTokenMint",
  "HostedCodexCommentTokenRevocationProof",
  "HostedCodexRuntimeClosure",
  "HostedCodexCommentRefreshUse",
  "HostedCodexRuntimeGate",
  "HostedCodexRepositoryBinding",
  "HostedCodexPool",
  "GitHubInstallation",
  "HostedCodexInvocationGrant",
  "HostedCodexCommentRefreshCapability",
]);

export const liveV70V89CatalogProjectionRoutines = Object.freeze([
  "reviewrouter_record_runtime_generation_witness_proof",
  "reviewrouter_read_runtime_generation_witness_proofs",
  "reviewrouter_runtime_generation_write_read_canary",
  "reviewrouter_request_runtime_canary_challenge",
  "reviewrouter_answer_runtime_canary_challenge",
  "reviewrouter_read_runtime_canary_challenge_proofs",
  "codex_oauth_v4_v5_reattestation_transition",
  "codex_oauth_reattest_active_namespace_v4_to_v5",
  "codex_oauth_secret_namespace_tombstone_guard",
  "codex_oauth_consume_database_authority",
  "codex_oauth_database_authority_receipt_guard",
  "codex_oauth_workflow_compatibility_guard",
  "hosted_codex_comment_refresh_use_mint_guard",
  "hosted_codex_comment_token_mint_guard",
  "hosted_codex_comment_token_prepare_authority_complete",
  "hosted_codex_lock_comment_token_runtime_gate",
  "hosted_codex_comment_token_authority_snapshot",
  "hosted_codex_lock_comment_token_mint",
  "hosted_codex_mutate_comment_token_mint",
  "hosted_codex_mutate_comment_token_mint_v83",
  "hosted_codex_mutate_comment_token_mint_v85",
  "hosted_codex_claim_comment_token_delivery",
  "hosted_codex_finalize_comment_token_revocation",
  "hosted_codex_runtime_closure_guard",
  "hosted_codex_runtime_gate_guard",
  "hosted_codex_runtime_gate_activation_barrier",
  "hosted_codex_comment_token_authority_revoke_enqueue",
]);

const selectedRelationsSql = liveV70V89CatalogProjectionRelations
  .map((relation) => `'${relation}'`)
  .join(",");
const selectedRoutinesSql = liveV70V89CatalogProjectionRoutines
  .map((routine) => `'${routine}'`)
  .join(",");

export const fencedLiveV70V73CatalogDigestSql = `
WITH selected_relations AS (
  SELECT c.oid, n.oid AS namespace_oid, n.nspname, c.relname, c.relkind,
    c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity,
    c.relreplident, c.relpersistence, c.relam, c.reltablespace, c.reloptions
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN
    (${selectedRelationsSql})
), facts AS (
  SELECT jsonb_build_object(
    'columns',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'relation',r.relname,'position',a.attnum,'name',a.attname,
      'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
      'nullable',NOT a.attnotnull,
      'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
      'acl',coalesce((SELECT jsonb_agg(
        normalized_acl.entry ORDER BY normalized_acl.entry COLLATE "C")
        FROM (
          SELECT CASE
            WHEN split_part(v::text,'/',2)='reviewrouter_release_schema_owner'
              AND split_part(v::text,'=',1) IN (${phaseVaryingApplicationAclPrincipalSql})
              AND r.relname='CodexOAuthProviderInstance'
              AND a.attname IN (${phaseVaryingCodexOAuthProviderUpdateColumnSql})
            THEN split_part(v::text,'=',1)||'='||pg_catalog.regexp_replace(
              split_part(split_part(v::text,'/',1),'=',2),'[w]','','g'
            )||'/'||split_part(v::text,'/',2)
            WHEN split_part(v::text,'/',2)='reviewrouter_release_schema_owner'
              AND split_part(v::text,'=',1)='reviewrouter_comment_token_custody'
              AND r.relname='HostedCodexCommentRefreshCapability'
              AND a.attname IN ('useCount','lastUsedAt','revision','updatedAt')
            THEN split_part(v::text,'=',1)||'='||pg_catalog.regexp_replace(
              split_part(split_part(v::text,'/',1),'=',2),'[w]','','g'
            )||'/'||split_part(v::text,'/',2)
            ELSE v::text
          END AS entry
          FROM unnest(a.attacl) v
        ) normalized_acl
        WHERE split_part(split_part(normalized_acl.entry,'/',1),'=',2)<>''
      ),'[]'::jsonb),
      'collation',CASE WHEN a.attcollation=0 THEN NULL
        ELSE a.attcollation::regcollation::text END,
      'identity',a.attidentity,'generated',a.attgenerated,
      'storage',a.attstorage,'compression',a.attcompression,
      'statisticsTarget',a.attstattarget,'options',a.attoptions,
      'fdwOptions',a.attfdwoptions)
      ORDER BY r.relname COLLATE "C",a.attnum)
      FROM selected_relations r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
      WHERE a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
    'constraints',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'relation',r.relname,'name',c.conname,'type',c.contype,
      'definition',pg_catalog.pg_get_constraintdef(c.oid,true),
      'validated',c.convalidated,'deferrable',c.condeferrable,
      'deferred',c.condeferred,'noInherit',c.connoinherit)
      ORDER BY r.relname COLLATE "C",c.conname COLLATE "C")
      FROM selected_relations r JOIN pg_catalog.pg_constraint c ON c.conrelid=r.oid),'[]'::jsonb),
    'indexes',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'relation',r.relname,'name',i.relname,'valid',x.indisvalid,
      'ready',x.indisready,'live',x.indislive,'unique',x.indisunique,
      'primary',x.indisprimary,'replicaIdentity',x.indisreplident,
      'clustered',x.indisclustered,'immediate',x.indimmediate,
      'exclusion',x.indisexclusion,'nullsNotDistinct',x.indnullsnotdistinct,
      'definition',pg_catalog.pg_get_indexdef(i.oid))
      ORDER BY r.relname COLLATE "C",i.relname COLLATE "C")
      FROM selected_relations r JOIN pg_catalog.pg_index x ON x.indrelid=r.oid
      JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid),'[]'::jsonb),
    'relations',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'name',relname,'kind',relkind,'owner',pg_catalog.pg_get_userbyid(relowner),
      'rowSecurity',relrowsecurity,'forceRowSecurity',relforcerowsecurity,
      'replicaIdentity',relreplident,'persistence',relpersistence,
      'accessMethod',CASE WHEN relam=0 THEN NULL ELSE
        (SELECT amname FROM pg_catalog.pg_am WHERE oid=relam) END,
      'tablespace',CASE WHEN reltablespace=0 THEN NULL ELSE
        (SELECT spcname FROM pg_catalog.pg_tablespace WHERE oid=reltablespace) END,
      'options',reloptions,
      'acl',coalesce((SELECT jsonb_agg(
        normalized_acl.entry ORDER BY normalized_acl.entry COLLATE "C")
        FROM (
          SELECT CASE
            WHEN (${phaseVaryingRelationPrivilegePatternSql}) IS NOT NULL
            THEN split_part(v::text,'=',1)||'='||pg_catalog.regexp_replace(
              split_part(split_part(v::text,'/',1),'=',2),
              (${phaseVaryingRelationPrivilegePatternSql}),'','g'
            )||'/'||split_part(v::text,'/',2)
            ELSE v::text
          END AS entry
          FROM unnest(relacl) v
        ) normalized_acl
        WHERE split_part(split_part(normalized_acl.entry,'/',1),'=',2)<>''
      ),'[]'::jsonb)) ORDER BY relname COLLATE "C")
      FROM selected_relations),'[]'::jsonb),
    'schemas',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'name',n.nspname,'owner',pg_catalog.pg_get_userbyid(n.nspowner),
      'acl',coalesce((SELECT jsonb_agg(v::text ORDER BY v::text COLLATE "C")
        FROM unnest(n.nspacl) v),'[]'::jsonb)) ORDER BY n.nspname COLLATE "C")
      FROM pg_catalog.pg_namespace n WHERE n.nspname='public'),'[]'::jsonb),
    'policies',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'relation',r.relname,'name',p.polname,'permissive',p.polpermissive,
      'command',p.polcmd,'roles',p.polroles,'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),
      'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))
      ORDER BY r.relname COLLATE "C",p.polname COLLATE "C")
      FROM selected_relations r JOIN pg_catalog.pg_policy p ON p.polrelid=r.oid),'[]'::jsonb),
    'triggers',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'relation',r.relname,'name',t.tgname,'enabled',t.tgenabled,
      'definition',pg_catalog.pg_get_triggerdef(t.oid,true))
      ORDER BY r.relname COLLATE "C",t.tgname COLLATE "C")
      FROM selected_relations r JOIN pg_catalog.pg_trigger t ON t.tgrelid=r.oid
      WHERE NOT t.tgisinternal),'[]'::jsonb),
    'rules',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'relation',r.relname,'name',rw.rulename,'enabled',rw.ev_enabled,
      'definition',pg_catalog.pg_get_ruledef(rw.oid,true))
      ORDER BY r.relname COLLATE "C",rw.rulename COLLATE "C")
      FROM selected_relations r JOIN pg_catalog.pg_rewrite rw ON rw.ev_class=r.oid
      WHERE rw.rulename<>'_RETURN'),'[]'::jsonb),
    'inheritance',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'child',child.relname,'parentSchema',parent_namespace.nspname,
      'parent',parent.relname,'sequence',inherit.inhseqno,'detachPending',inherit.inhdetachpending)
      ORDER BY child.relname COLLATE "C",inherit.inhseqno)
      FROM selected_relations child JOIN pg_catalog.pg_inherits inherit ON inherit.inhrelid=child.oid
      JOIN pg_catalog.pg_class parent ON parent.oid=inherit.inhparent
      JOIN pg_catalog.pg_namespace parent_namespace ON parent_namespace.oid=parent.relnamespace),'[]'::jsonb),
    'enums',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'name',t.typname,'owner',pg_catalog.pg_get_userbyid(t.typowner),
      'acl',coalesce((SELECT jsonb_agg(v::text ORDER BY v::text COLLATE "C")
        FROM unnest(t.typacl) v),'[]'::jsonb),
      'labels',(SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
        FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid))
      ORDER BY t.typname COLLATE "C")
      FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='public' AND t.typname IN (
        'HostedCodexCommentTokenMintPurpose','HostedCodexCommentTokenMintState',
        'HostedCodexRuntimeClosureState')),'[]'::jsonb),
    'functions',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'identity',p.oid::regprocedure::text,'owner',pg_catalog.pg_get_userbyid(p.proowner),
      'securityDefiner',p.prosecdef,'searchPath',coalesce(to_jsonb(p.proconfig),'null'::jsonb),
      'definition',pg_catalog.pg_get_functiondef(p.oid),
      'acl',coalesce((SELECT jsonb_agg(v::text ORDER BY v::text COLLATE "C")
        FROM unnest(p.proacl) v),'[]'::jsonb)) ORDER BY p.oid::regprocedure::text COLLATE "C")
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN (${selectedRoutinesSql})),'[]'::jsonb),
    'defaultAcl',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'owner',pg_catalog.pg_get_userbyid(d.defaclrole),'namespace',n.nspname,
      'kind',d.defaclobjtype,'acl',(SELECT jsonb_agg(v::text ORDER BY v::text COLLATE "C")
        FROM unnest(d.defaclacl) v)) ORDER BY pg_catalog.pg_get_userbyid(d.defaclrole) COLLATE "C",d.defaclobjtype)
      FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
      WHERE n.nspname='public'),'[]'::jsonb),
    'history',CASE WHEN reviewrouter_activation.read_activation_migration_manifest_identity()
      = '${canonicalReleaseMigrationArtifact.postManifestIdentity}'
      THEN jsonb_build_array(
        jsonb_build_object('name','000070_runtime_generation_witness_proof',
          'checksum','cb9c42171f9bd924d21093852a1053cb947100acef1321ec8cf62e8fd5928c6f',
          'finished',true,'rolledBack',false),
        jsonb_build_object('name','000071_transactional_service_transition',
          'checksum','36ecd5c6b880bd9cd4ad76a20fdd9e4ceafcc3e524e924eb3c7b0c78116da093',
          'finished',true,'rolledBack',false),
        jsonb_build_object('name','000072_retire_superseded_codex_setup_claims',
          'checksum','a0105a5498bacf23ec59687f6b43c70cecc075665231c37d970edcf8c0855fb3',
          'finished',true,'rolledBack',false),
        jsonb_build_object('name','000072_runtime_canary_challenge',
          'checksum','48ac05b9da6031456de6b7bab2bc9ee46dc3b7bc5cb7ef45c7a5db1ee3956b68',
          'finished',true,'rolledBack',false),
        jsonb_build_object('name','000073_codex_oauth_active_namespace_refresh',
          'checksum','3e5b6606f22c8bec6f75f52f48b693806d597fa283155f6e033844c4f6be4de6',
          'finished',true,'rolledBack',false),
        jsonb_build_object('name','000087_codex_oauth_v4_v5_workflow_reattestation',
          'checksum','af5fccfd987312b85d48cd38b7f528780f52e82daab47c34829581e50193b090',
          'finished',true,'rolledBack',false),
        jsonb_build_object('name','000088_codex_oauth_reattestation_mutation_owner_fence',
          'checksum','18a1e48953d1360d3661ea6753b7aa350fc7e28caeaeb65d42c9ac42569f1cf0',
          'finished',true,'rolledBack',false),
        jsonb_build_object('name','000089_codex_oauth_v4_v5_staged_compatibility',
          'checksum','bd35157bc11c84dd181ba7f2edf589503d75cb359c12e9a93bf4a884f94c9db7',
          'finished',true,'rolledBack',false))
      ELSE '[]'::jsonb END,
    'unresolvedHistory',false,
    'legacyAuthoritySchemaPresent',EXISTS (
      SELECT 1 FROM pg_catalog.pg_class authority_root
      JOIN pg_catalog.pg_namespace authority_namespace
        ON authority_namespace.oid=authority_root.relnamespace
      WHERE authority_namespace.nspname='release_authority'
        AND authority_root.relname='rollout'
        AND authority_root.relkind IN ('r','p'))
  ) AS value
)
SELECT 'sha256:'||encode(pg_catalog.sha256(convert_to(value::text,'UTF8')),'hex')
FROM facts`;

export const liveV70V73CatalogDigestSha256 =
  canonicalReleaseMigrationArtifact.postCatalogDigest;

// Compatibility aliases for existing external consumers through the V89 rollout.
export const fencedLiveV70V72CatalogDigestSql =
  fencedLiveV70V73CatalogDigestSql;
export const fencedLiveV70V87CatalogDigestSql =
  fencedLiveV70V73CatalogDigestSql;
export const fencedLiveV70V88CatalogDigestSql =
  fencedLiveV70V73CatalogDigestSql;
export const fencedLiveV70V89CatalogDigestSql =
  fencedLiveV70V73CatalogDigestSql;
