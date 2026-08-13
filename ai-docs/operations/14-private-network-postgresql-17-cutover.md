# Private-network PostgreSQL 17 cutover

This is a fail-closed implementation contract, not production approval. The
independent audit of `616426a` remains PR and production **NO-GO** until this
branch is reviewed, the external controls below exist, a disposable rehearsal
passes, and a separate change-management decision authorizes a real cutover.
Git flow and release sequencing remain governed by
[07-environments-and-release-management.md](./07-environments-and-release-management.md).

## Required organization control plane

The workflow may exist only in the organization-owned repository named by
`REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY`. Personal repositories fail. Configure
one positive `REVIEW_ROUTER_RUNNER_GROUP_ID` and its matching group name. The
group must:

- have `visibility=selected`, exactly the private control repository, and no
  public repositories;
- have workflow restriction enabled with exactly
  `<org>/<control-repo>/.github/workflows/private-network-pg17-rollout.yml@refs/heads/main`;
- be dedicated to this rollout. Each queued job requires the exact group and a
  rollout/run-bound unique label; the JIT response and post-registration
  re-read retain the returned positive runner ID, group ID, and exact labels.

The protected `main` workflow is dispatch-only and rejects run attempts other
than one. `production-release-preflight` must require at least one reviewer,
prevent self-review, and allow protected branches only. Preflight reads and
hashes the observed GitHub policy; a variable claiming the policy is not proof.
The `workflow_job` controller observes the numeric queued job ID, exact name,
run/attempt, SHA, actor, workflow path/ref, event, organization, and repository
before it creates a JIT runner.

The GitHub App installation must be limited to the single control repository.
Its token request is scoped to that exact repository and exactly
`organization_self_hosted_runners:write`, `actions:read`, and `metadata:read`;
repository-level `administration` is not requested for this organization JIT
runner flow. The runner group ID is configuration, never a default. Store the
App private key as a root-owned `0600` secret file under `/run/secrets`; the
environment variable form is rejected. The credential process unlinks the
file, mints the installation token and JIT configuration, deletes credential
environment entries, then uses `execve` to replace its address space with the
unprivileged launcher. The launcher runs only `Runner.Listener run --jitconfig`
in a unique work root. Its no-job timer is cancelled at assignment; the
workflow timeout remains the job runtime ceiling. Cleanup terminates the
listener process group, removes and enumerates the complete work root, and
emits its nonsecret receipt only after absence is proven.

The base image is digest pinned. The Actions runner version and SHA-256 are
mandatory Docker build arguments and are checked before extraction. The
dedicated Render runner service must have auto-deploy off and no active deploy.
Its latest live deploy must match the configured attested image SHA. The image
uses the repository pnpm lockfile/frozen install and a dated Debian snapshot.
Render one-off creation sends only `startCommand` and optional compute
`planId`; a deploy ID is never a plan ID.

## External authenticated ledger contract

`REVIEW_ROUTER_RUNNER_LEDGER_URL` is mandatory. Its bearer credentials are
scoped by protected environment and visible only to the exact step using them.
The service implements the endpoints consumed by
`AuthenticatedRunnerLedgerAdapter` over SaaS migration
`000069_release_rollout_ledger`:

- atomically claim a never-used rollout ID bound to commit, run, attempt, and
  both system identifiers;
- CAS every hash-chained observation receipt;
- persist a provisioning intent/idempotency identity before Render creation,
  bind the returned provider job afterward, and retain a discoverable
  reconciliation record if that binding write fails;
- grant the provider POST permit once only. Replays may discover, bind, clean,
  or abandon the durable intent, but never repeat the provider POST. Once the
  rollout enters compensation, both new intent preparation and dispatch permit
  acquisition are forbidden;
- store launcher cleanup observation and provider terminal state, list open
  jobs, and make cleanup/reconciliation idempotent;
- permanently set `source_permanently_ineligible` on activation or activation
  uncertainty; every promotion path must consult that ledger;
- on reconciliation, return either proven pre-activation compensation (source
  ACL/environment restored and source services resumed) or a PG17-only
  activated/uncertain state. It must never report PG16 eligible at or after the
  boundary.

The API registers the exact authenticated `/v1` contract only after the main
database is migrated and two distinct SHA-256 credential hashes are set:
`REVIEW_ROUTER_RUNNER_LEDGER_TOKEN_SHA256` for controller/runner calls and
`REVIEW_ROUTER_RUNNER_WITNESS_TOKEN_SHA256` for independent provider-witness
ingestion. Routes cover rollout claim/CAS, activation fence/finalize/state,
uncertainty and reconciliation, plus runner intent/job/current, registration,
identity, terminal, cleanup observation and cleanup witness. The fence
atomically changes authority to target/uncertain before its nonce/version can
enter target SQL. Each successful CAS must atomically update
`release_rollout_ledger` and append the step/provider/hash-chain binding to
`release_rollout_receipt_ledger`; an update without that append is a failure.

Missing, unavailable, stale, duplicate, or contradictory ledger responses stop
the rollout. Do not bypass this dependency with artifacts, labels, or in-memory
state.

The dedicated authority is installed in order from
`000001_release_authority`, `000002_external_effect_protocol`, and
`000002_transactional_service_transition`. The disposable PG16 to PG17
rehearsal and the dedicated authority contract must both execute that complete
inventory before a release is eligible for production.

The hosted runner controller receives the plaintext witness credential as
`REVIEW_ROUTER_RUNNER_WITNESS_TOKEN`; the runner container never receives it.
The controller reads the terminal job's bounded Render log window, accepts one
exact cleanup JSON record, hashes that provider record, and submits its erased
and remaining path enumeration through the witness-only route. Configure
`REVIEW_ROUTER_RUNNER_IMAGE_ATTESTATION_JSON` with the final image subject
digest, reviewed source commit, attestation statement SHA-256, and builder ID.
The subject and source must exactly match the immutable Render image and
rollout commit before a job can be created.

## Split Render permissions and API facts

Use four independent credentials:

- `RENDER_RUNNER_CONTROL_API_KEY`: one-off runner creation and terminal polling;
- `RENDER_PROVENANCE_READ_API_KEY`: read-only service/deploy/recovery/env facts;
- `RENDER_SERVICE_SUSPENSION_API_KEY`: source/target suspend and resume only.
- `RENDER_TARGET_SWITCH_API_KEY`: complete target environment replacement and
  immutable deploy creation/polling only.

Adapters accept additive documented fields while requiring their security
subset. Service/deploy/job/env list cursor wrappers, suspend/resume HTTP 202,
and full environment replacement follow Render OpenAPI. Full replacement first
reads every page, preserves every key, writes the complete set, re-reads every
page, and compares complete key/value digests without logging values.

There is no backups-by-ID call. Render contributes only
`GET /postgres/{id}/recovery`. A separately authenticated export witness binds
the Render resource ID, internal hostname, database, PostgreSQL system ID,
LSN/time, recovery window, witness hash, and dump hash. The locally created dump
must equal that witness. Git-backed deploys bind `commit.id` and have no image;
image-backed deploys bind `image.sha` and have no commit. Ambiguous or mutable
provenance fails.

## Database and secret boundary

### Legacy rotating-OAuth ambiguity

The source may legitimately contain expired-by-time `preleased`/`finalized`
leases and `fetched` setup manifests. Do not manually rewrite or delete these
rows before the copy. Source quiescence records two identical, ordered ID
inventories and their digest. After migrations establish the target recovery
epoch and `versioned-namespace-cutover:<provider>` fence, the release migration
reconciles only rows from that stable inventory:

- leases must be expired by time, older than the provider epoch, recovery-owned,
  and have no `pending` or `remote_outcome_unknown` intent;
- fetched manifests require the exact forced-recovery acknowledgement. They are
  retained as `recovered` evidence with the inventory digest;
- terminal intent rows remain immutable. Any unknown intent status fails closed;
- the post-reconciliation raw counts for `preleased`/`finalized`, `fetched`, and
  `pending` must all be zero. The final verifier does not weaken this gate.

If either stable sample differs, a row is current-epoch or unexpired, or a live
ambiguous intent exists, stop the rollout. Do not bypass the guard with direct
SQL cleanup.

All database tools run on the exact private runner step, after checkout and
dependency installation. Database URLs and passwords are never placed in argv,
artifacts, logs, workspace metadata, image metadata, or broad inherited
environments. PostgreSQL URLs are decomposed to nonsecret host/port/user/db
arguments. Each command gets a fresh non-workspace `0600` passfile and a small
allowlisted environment; errors expose only a step/command code.

The source sequence is mandatory:

1. suspend every source writer and re-observe every service suspended;
2. revoke `CONNECT` from PUBLIC and runtime roles and commit it;
3. terminate existing sessions;
4. observe at least three bounded zero-session samples;
5. prove every exact runtime credential connects to the expected source system
   before revocation, then require the exact database CONNECT
   permission-denied class from that same credential/system.

`writersSuspended` is never synthesized. A definite failure before activation
enters compensation: source ACL/environment is restored and source writers are
resumed and re-observed. An accepted or uncertain activation permanently bans
PG16 promotion and allows only PG17 forward repair/PITR.

Equivalence is restricted to `REVIEW_ROUTER_APPLICATION_SCHEMAS_JSON`, streams
each table/materialized view through a hash with an 8 MiB process ceiling, and
also binds sequence `last_value`/`is_called`/owner/dependency, columns/defaults,
constraints/indexes/triggers, policies and RLS, functions/views/schemas,
ACL/default privileges/ownership, and migration history. Activation rejects an
unclassified application schema, privileged/bypass-RLS runtime roles, runtime
ownership, or unsafe PUBLIC privileges. Canonical grants, catalog-fact hash,
and immutable first-write receipt share one transaction. Duplicate activation,
including an identical replay, is rejected.

## Workflow completion

There are two independent runner leases: copy/role bootstrap and cutover. The
second cannot queue until the first provider job and launcher cleanup witness
are terminal. After activation, the second runner is also cleanup-proven. Only
then may the hosted finalizer use the service-suspension credential to resume
the exact target services, observe their live deploys, execute the unique
authenticated no-store POST write/read canary, and assemble/verify trusted
evidence. The evidence binds the
protected-environment receipt, rollout/SHA/run/job/attempt/deploy identities,
both generations, external backup witness, receipt chain, activation boundary,
both runner lifecycles, resumed deploys, and live canary.

Before provider freeze, the hosted preflight composition root durably claims
the rollout, recomputes the observed protected-environment artifact digest,
and records both claim and protected-policy receipts through application use
cases. Later private-runner scripts resume that artifact-backed aggregate; they
cannot recreate or claim a parallel rollout history.

The always-running reconciliation job cleans every persisted orphan. The
completed-run controller redrives durable discovery and cleanup with bounded
exponential backoff until it emits `clean` or an explicit `blocked` result; it
does not redrive provider creation. Every reconciliation artifact includes
`safeForCompensation`. That value is true only when nonempty durable intent
evidence proves every intent `cleaned` or `abandoned`. Pending discovery, a
timeout, duplicate provider jobs, unknown/legacy state, partial cleanup, or
missing evidence leaves it false. The compensation application gate re-reads
those durable facts immediately before beginning or replaying compensation and
keeps the source frozen on every unsafe result. An unknown activation result is
never treated as pre-activation.

## Disposable rehearsal and current blockers

Rehearsal may use only pinned disposable PostgreSQL 16.13 and 17 images. It must
exercise the production domain/application use cases, canonical SQL generators,
role bootstrap, migration, activation, and evidence verifier while substituting
only provider and connection ports. It must prove reconnect denial, definite
pre-activation compensation, post/uncertain-activation PG16 ban, effective role
and ACL/RLS matrix, argv/environment/proc redaction canaries, two runner cleanup
lifecycles, and no remaining Docker resources.

External prerequisites are intentionally blockers, not defaults: dedicated
control repository, exact restricted runner group, protected environments,
three Render credentials, root-owned App key secret file, immutable runner
service provenance, authenticated backup/export witness, and the durable ledger
API backed by the installed PostgreSQL schema. Until each is independently
observed, this implementation is not dispatchable and production remains
NO-GO.
