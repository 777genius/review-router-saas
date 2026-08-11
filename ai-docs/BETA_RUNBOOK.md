# Beta Runbook (superseded)

This former local/private-beta checklist is retained only as a compatibility
landing page. It is not an operational runbook and must not be used to install,
seed, reseed, recover, release, or deploy ReviewRouter.

Use these current sources of truth instead:

- [Operations runbooks](./operations/02-runbooks.md) for dashboard-issued Codex
  setup, unknown-outcome recovery, forced reseed, account-switch recovery, and
  database restore/writer-promotion recovery.
- [Environment and release management](./operations/07-environments-and-release-management.md)
  for release, exact Action identity, and deployment gates.
- [Render hosted deployment](../deploy/render.md) for the two supported hosted
  configuration paths and readiness/convergence checks.
- [Beta readiness](./product/06-beta-readiness.md) for product validation that
  does not mutate provider credentials.

## Codex setup and recovery contract

Never write a stable or versioned Codex GitHub Actions secret directly. Never
construct an installer command from a mutable URL, branch, tag, or curl-pipe
example in an old document. Open the repository's provider setup in the
dashboard and copy the command issued for that exact repository and provider.
The issued command binds a short-lived setup manifest to one immutable
installer URL, release version, SHA-256, exact Action commit, repository,
provider, mutation epoch, and never-reused versioned namespace. Any missing or
mismatched binding fails closed before provider credentials are read or a
GitHub secret mutation is authorized.

Do not improvise recovery after a dropped response, expired setup, external
drift, account switch, database restore, or writer promotion. Stop all prior
installers and runtime writers, then use the dashboard's acknowledged
**Recover and issue forced reseed** operation. That operation creates a new
recovery request and mutation epoch, tombstones ambiguous or old namespaces,
and issues a fresh dashboard command. A normal setup or direct secret write
cannot stand in for this recovery authority. Follow the exact replay,
unknown-outcome, account-switch, and witness-transition rules in
[Operations runbooks](./operations/02-runbooks.md).

The immutable installer descriptor used by hosted services is a release
artifact, not an operator-authored tuple. Verify the descriptor file against
the separately published descriptor SHA-256, require its `actionRef` to match
the exact rotating Action SHA, and propagate its URL/version/installer-SHA tuple
as one unit. See [Render hosted deployment](../deploy/render.md).
