/**
 * Canonical PostgreSQL projection of the live V70-V72 application catalog.
 * Keep this in the Postgres adapter layer: the domain receives only its digest.
 */
export const fencedLiveV70V72CatalogDigestSql = `
WITH selected_relations AS (
  SELECT c.oid, n.nspname, c.relname, c.relkind, c.relowner, c.relacl
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN
    ('RuntimeGenerationWitnessProof','RuntimeCanaryChallenge','RuntimeCanaryChallengeProof')
), facts AS (
  SELECT jsonb_build_object(
    'columns',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'relation',r.relname,'position',a.attnum,'name',a.attname,
      'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
      'nullable',NOT a.attnotnull,
      'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid))
      ORDER BY r.relname COLLATE "C",a.attnum)
      FROM selected_relations r JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
      WHERE a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
    'constraints',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'relation',r.relname,'name',c.conname,'type',c.contype,
      'definition',pg_catalog.pg_get_constraintdef(c.oid,true))
      ORDER BY r.relname COLLATE "C",c.conname COLLATE "C")
      FROM selected_relations r JOIN pg_catalog.pg_constraint c ON c.conrelid=r.oid),'[]'::jsonb),
    'indexes',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'relation',r.relname,'name',i.relname,'valid',x.indisvalid,
      'unique',x.indisunique,'primary',x.indisprimary,
      'definition',pg_catalog.pg_get_indexdef(i.oid))
      ORDER BY r.relname COLLATE "C",i.relname COLLATE "C")
      FROM selected_relations r JOIN pg_catalog.pg_index x ON x.indrelid=r.oid
      JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid),'[]'::jsonb),
    'relations',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'name',relname,'kind',relkind,'owner',pg_catalog.pg_get_userbyid(relowner),
      'acl',coalesce((SELECT jsonb_agg(v::text ORDER BY v::text COLLATE "C")
        FROM unnest(relacl) v),'[]'::jsonb)) ORDER BY relname COLLATE "C")
      FROM selected_relations),'[]'::jsonb),
    'functions',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'identity',p.oid::regprocedure::text,'owner',pg_catalog.pg_get_userbyid(p.proowner),
      'securityDefiner',p.prosecdef,'searchPath',coalesce(to_jsonb(p.proconfig),'null'::jsonb),
      'definition',pg_catalog.pg_get_functiondef(p.oid),
      'acl',coalesce((SELECT jsonb_agg(v::text ORDER BY v::text COLLATE "C")
        FROM unnest(p.proacl) v),'[]'::jsonb)) ORDER BY p.oid::regprocedure::text COLLATE "C")
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN (
        'reviewrouter_record_runtime_generation_witness_proof',
        'reviewrouter_read_runtime_generation_witness_proofs',
        'reviewrouter_runtime_generation_write_read_canary',
        'reviewrouter_request_runtime_canary_challenge',
        'reviewrouter_answer_runtime_canary_challenge',
        'reviewrouter_read_runtime_canary_challenge_proofs')),'[]'::jsonb),
    'defaultAcl',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'owner',pg_catalog.pg_get_userbyid(d.defaclrole),'namespace',n.nspname,
      'kind',d.defaclobjtype,'acl',(SELECT jsonb_agg(v::text ORDER BY v::text COLLATE "C")
        FROM unnest(d.defaclacl) v)) ORDER BY pg_catalog.pg_get_userbyid(d.defaclrole) COLLATE "C",d.defaclobjtype)
      FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
      WHERE n.nspname='public'),'[]'::jsonb),
    'history',CASE WHEN reviewrouter_activation.read_activation_migration_manifest_identity()
      = 'sha256:553576dcf644278cdc464d3465e34e0814862cd44c76784d89bb61c65f04b303'
      THEN jsonb_build_array(
        jsonb_build_object('name','000070_runtime_generation_witness_proof',
          'checksum','cb9c42171f9bd924d21093852a1053cb947100acef1321ec8cf62e8fd5928c6f',
          'finished',true,'rolledBack',false),
        jsonb_build_object('name','000071_transactional_service_transition',
          'checksum','36ecd5c6b880bd9cd4ad76a20fdd9e4ceafcc3e524e924eb3c7b0c78116da093',
          'finished',true,'rolledBack',false),
        jsonb_build_object('name','000072_runtime_canary_challenge',
          'checksum','48ac05b9da6031456de6b7bab2bc9ee46dc3b7bc5cb7ef45c7a5db1ee3956b68',
          'finished',true,'rolledBack',false))
      ELSE '[]'::jsonb END,
    'unresolvedHistory',false,
    'legacyAuthoritySchemaPresent',to_regnamespace('release_authority') IS NOT NULL
  ) AS value
)
SELECT 'sha256:'||encode(pg_catalog.sha256(convert_to(value::text,'UTF8')),'hex')
FROM facts`;

export const liveV70V72CatalogDigestSha256 =
  "sha256:05820ed393b7364c468b62cb19e5cd4c8aaa729021155a18162f1a4b2012a44d";
