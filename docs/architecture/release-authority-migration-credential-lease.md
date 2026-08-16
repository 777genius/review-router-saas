# Release authority migration credential lease

## Decision

Production authority migrations use a database-enforced, one-connection lease.
The long-lived GitHub environment secret authenticates only
`reviewrouter_migration_issuer`; it is not an authority owner credential.

The bounded context is split into:

- domain contract: exact lease identity and `issued -> consumed -> finalized`
  or `reconciled` lifecycle;
- application adapters: issue/reconcile and migration execution scripts;
- PostgreSQL adapter: `reviewrouter_migration_credential` schema and its
  SECURITY DEFINER routines;
- transport adapter: protected GitHub workflow with exact-main evidence gates.

## Roles

- `reviewrouter_authority_owner`: fixed `NOLOGIN` owner of the authority schema.
- `reviewrouter_migration_broker`: fixed `NOLOGIN` broker with no database
  CREATE privilege after bootstrap. It alone can administer lease logins and
  the owner membership edge.
- `reviewrouter_migration_issuer`: restricted login that can invoke only
  `issue` and `reconcile`.
- `rr_migration_<identity>`: generated login, connection limit one, ten-minute
  expiry, no elevated attributes, and no owner membership before consume.

## Invariants

1. Issue is serialized and rejects a second unexpired lease.
2. The database chooses `issued_at` and `expires_at`.
3. Consume requires exact SHA/run/attempt/operation/database/password hash,
   nonce hash, receipt, login identity, and exactly one connected backend.
4. Consume commits before DDL, changes the login to `NOLOGIN`, and only then
   grants `SET` membership in the fixed owner.
5. Migration DDL and catalog verification run in the same authenticated
   connection after `SET ROLE`.
6. Finalize revokes owner membership before migration commit and records the
   terminal state. A failed process leaves a non-login principal.
7. Reconcile can only remove expired authority; it cannot extend or reissue a
   lease.
8. Credential URLs and raw PostgreSQL output never cross the sanitized
   diagnostic boundary.

## Bootstrap transition

Migration 000015 is the one-time trust transition. A direct existing owner
creates the fixed roles, transfers authority ownership, installs broker
functions, and sets its own password to NULL in the same transaction. The
`bootstrap-upgrade` workflow operation exists only for this transition. Fresh
install performs the same transition at the end of the checked-in chain.

## Failure semantics

- failure before issue: no database state;
- failure after issue but before consume: expiring login without owner
  membership;
- failure after consume: `NOLOGIN` principal with a removable owner edge;
- failure after finalize: no owner edge and a terminal receipt;
- runner loss: the protected workflow's unconditional reconcile removes an
  expired edge on the next authorized connection.

Operational commands and secret names are documented in
`docs/operations/private-pg17-release-rollout.md`.
