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

1. Issue is serialized, reconciles every unfinished lease, and only then mints
   the next lease.
2. The database chooses `issued_at` and `expires_at`.
3. Consume requires exact SHA/run/attempt/operation/database/password hash,
   nonce hash, receipt, login identity, and exactly one connected backend.
4. Consume, DDL, exact catalog verification, and finalize share one explicit
   transaction. Consume changes the login to `NOLOGIN` before granting `SET`
   membership in the fixed owner; a deferred guard rejects autocommit consume.
5. Migration DDL and catalog verification run in the same authenticated
   connection after `SET ROLE`.
6. Finalize revokes owner membership and all credential-schema/function ACLs
   before migration commit and records the terminal state. If the authenticated
   backend is still present, the exact inert `NOLOGIN` role remains only until
   a later reconciliation can safely drop it.
7. Reconcile durably terminalizes every unfinished authority edge; it cannot
   extend or reissue a lease. Physical deletion is deferred, without rolling
   back terminalization or blocking later issuance, while a backend remains.
8. Credential URLs and raw PostgreSQL output never cross the sanitized
   diagnostic boundary.

## Bootstrap transition

Migration 000015 is the one-time trust transition. The fixed
`reviewrouter_bootstrap_administrator` is a `NOSUPERUSER NOCREATEDB CREATEROLE`
provider capability with `pg_signal_backend`. A direct P login with
`createrole_self_grant=''` creates and drops a random disposable role in one
transaction to discover the opaque provider root. The contract pins the server
`system_identifier`, root OID/name, and P OID/name. B/O/M must have exact
`ADMIN TRUE, INHERIT FALSE, SET FALSE` implicit edges from that same root;
O-to-M is the only P-granted durable edge. Provisioning never hardcodes the
root, re-grants a provider edge, or adopts a catalog-present foreign root.
Existing partial, duplicate, foreign-root, or option-drifted roles fail closed.
The two migration-only O/M-to-B `SET TRUE` edges are P-granted with
`ADMIN FALSE`; only O-to-B is temporarily `INHERIT TRUE`, which lets PostgreSQL
`REASSIGN OWNED` transfer the database without granting `CREATEDB`. M-to-B is
non-inheriting, and B receives no delegation authority.
The owner receives read-only access to the non-secret provider-root pin so the
post-quiescence catalog gate can attest the exact provider identity.
The capability is
distinct from the restricted provider-decision login. It provisions an exact,
body-hash attested one-shot quiescence helper. The bootstrap database owner is also
`NOCREATEDB`; database ownership is provisioned separately. That owner grants database `CREATE`
to that fixed identity only around helper creation and revokes it before the
migration; terminal gates prove that neither provider nor bootstrap retains a
database `CREATE` path. The migration rejects any other B session, proves B owns
no unexpected shared or database-local object, transfers ownership with
`REASSIGN OWNED`, and removes only the two P-granted bootstrap `SET` edges with
`GRANTED BY P RESTRICT`, and quiesces B. After the migration connection exits,
P re-probes the pinned root, proves B has no sessions or ownership dependencies,
removes the exact helper with `RESTRICT`, invokes the M-owned SECURITY DEFINER
marker through a direct attested P session, records terminal deletion, and runs
`DROP ROLE B` without `CASCADE`. The
`bootstrap-upgrade` workflow operation exists only for this transition. Fresh
install performs the same transition at the end of the checked-in chain.

## Failure semantics

- failure before issue: no database state;
- failure after issue but before consume: expiring login without owner
  membership;
- failure after consume: the same transaction rolls back the owner edge;
- failure after finalize: no owner edge and a terminal receipt;
- runner loss: the protected workflow's unconditional reconcile removes every
  unfinished edge on the next authorized connection;
- bootstrap provisioning failure: unconditional convergence terminates its
  sessions, removes the helper and authority edges, leaves the login disabled,
  and preserves only the non-inheriting/non-settable administrator recovery
  edge required to retry. An ambiguous successful retry recognizes the exact
  cleanup-pending state and completes terminal deletion without re-enabling B.
- connected terminal migration backend: `NOLOGIN`, password expiry, owner-edge
  removal, terminal lease state, and credential ACL removal commit immediately;
  exact topology admits only that inert role and deletes it after disconnect.

Operational commands and secret names are documented in
`docs/operations/private-pg17-release-rollout.md`.
