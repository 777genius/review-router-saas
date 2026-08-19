# ADR: Private PostgreSQL 17 Release Authority

- Status: Accepted
- Date: 2026-08-12
- Scope: hosted ReviewRouter PostgreSQL 17 private-network release rollout

## Context

The cutover freezes the current writer generation, copies and migrates a target,
switches service connections, and enables the target generation. Workflow
artifacts and process exits are insufficient authority: either may be stale,
replayed, incomplete, or unavailable after a network failure. The release must
survive an outcome-unknown activation without allowing dual writers.

## Decision

### Dedicated Release Authority database

Release state lives in a dedicated PostgreSQL database. It is neither
application database and is never included in their backup/restore, copy,
clone, promotion, or rollback. Application migration tooling must not migrate
it. It is the durable source of truth for rollout identity, transitions,
activation authorization, source ineligibility, runner intents/identities,
cleanup observations, and reconciliation. Workflow artifacts only transport
evidence.

### Separate control and witness identities

- `reviewrouter-release-control` uses
  `REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_DATABASE_URL` and
  `REVIEW_ROUTER_RELEASE_CONTROL_TOKEN_SHA256` for transitions and runner
  coordination. The same process uses the distinct
  `REVIEW_ROUTER_RELEASE_AUTHORITY_PROVIDER_DATABASE_URL` and
  `REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN_SHA256` only for provider decisions,
  plus the target-local installer connection for permit installation.
- `reviewrouter-release-witness` uses
  `REVIEW_ROUTER_RELEASE_AUTHORITY_WITNESS_DATABASE_URL` and
  `REVIEW_ROUTER_RELEASE_WITNESS_TOKEN_SHA256`. It independently serves
  cleanup observations.

Their database roles have routine-only grants and no direct table access.
The HTTP boundary has exactly three distinct bearer credentials: release
control, provider authority, and release witness. Their canonical stored hashes
are `REVIEW_ROUTER_RELEASE_CONTROL_TOKEN_SHA256`,
`REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN_SHA256`, and
`REVIEW_ROUTER_RELEASE_WITNESS_TOKEN_SHA256`. Tokens, logins, services, and
control/witness URLs are distinct; runner-ledger and runner-witness names are
adapter-local inputs, not additional deployment variables or credentials.

### Solo-owner deployment approval

Protected production environments require an explicit reviewer and protected
branch policy. Independent approval is recommended when an independent operator
exists, but it is not treated as a security claim in a repository with one
owner. Such a repository may allow the dispatching owner to approve the
deployment by explicitly selecting `solo_owner`. The `independent` mode requires
GitHub's prevent-self-review policy. The selected mode and observed boolean
policy are written into durable rollout evidence; missing or malformed policy
facts fail closed. Exact protected-main identity, successful release gates,
immutable artifacts, scoped credentials, durable database authority, and
reconciliation remain mandatory and are the enforceable trust boundaries.

### Target-local one-shot permit

Before cutover, the target is provisioned with the
`reviewrouter_activation` schema, permit/receipt tables, functions, and
isolated release-migration, permit-installer, and receipt-guard roles. The
cutover runner cannot create or alter this boundary.

After durable authorization of the exact rollout tuple, the control server uses
the server-only `REVIEW_ROUTER_ACTIVATION_PERMIT_INSTALLER_DATABASE_URL` to
install the permit. The runner receives neither this URL nor permit/guard
material. Exact replay is idempotent; a conflicting tuple is rejected.

Activation locks and validates the permit against rollout ID, source/target
system identifiers, PostgreSQL major, expected commit, migration checksum,
target deploy IDs, epoch, nonce, and current target catalog facts. One
transaction grants canonical runtime privileges, crosses the first-write
boundary, writes an immutable receipt, and consumes the permit. A byte-identical
activation request replay is implemented as an idempotent read of that same
matching receipt; any conflicting replay or torn consumption fails closed.

### Provider authority and compensation

Render mutations require a fresh control-service decision and fail closed on
unavailable, malformed, unauthorized, or denied authority. Target staging is
allowed only before activation, source resume only after durable compensation,
and target resume only after durable activation.

A definite pre-activation failure compensates only after durable state and
database/provider observations. Once activation is authorized, source is
permanently ineligible. An ambiguous activation becomes
`activation_uncertain`: do not compensate, resume either side, rerun
activation, or start another rollout until authority state and target receipt
are reconciled.

Source freeze is a sequential external effect. Each required running-to-
suspended transition has an immutable authority intent before the provider
call and an immutable completion before the next service is attempted. An
unpaired intent is unknown and blocks compensation. Compensation derives its
resume set solely from paired observations. The database transition to
compensation requires at least one such pair and safe runner-effect state; an
authority-backed complete inventory with no mutations and no runner intents is
handled as a no-op.

### Prohibitions

- Never test this flow against a real user repository/project. Rehearsal, CI,
  and live E2E use only new disposable test repositories/projects and databases.
- Never mutate secrets directly with `gh secret set`, provider APIs/dashboards,
  SQL, or ad hoc scripts. Use the approved secret-manager/environment path.
- Never copy the authority DB, collapse control/witness identities, expose
  server-only URLs to Actions, or bypass the protected workflow.
- Never interpret a failed, canceled, or timed-out workflow as proof that
  activation did not occur.

## Consequences

This adds a database, two services, protected environments, and reconciliation
work. In return, a workflow cannot mint a permit, cleanup has an independent
witness, provider effects follow durable state, replay is safe, and ambiguous
results cannot silently create dual writers.

The normative procedure is
[`private-pg17-release-rollout.md`](../operations/private-pg17-release-rollout.md).
