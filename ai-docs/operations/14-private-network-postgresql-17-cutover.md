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
than one. Dispatch must use `--ref main`: environment branch policy evaluates
the workflow ref, not `inputs.expected_sha`. Every privileged environment must
require at least one reviewer, prevent self-review, and allow protected branches
only. Before checkout, an inline read-only bootstrap proves the workflow ref,
dispatch SHA, current protected `main`, `expected_sha`, release run/artifact
coordinates, and every environment policy agree. It emits the only SHA later
checkouts may use, all with persisted credentials disabled. If bootstrap or
protected preflight fails or is skipped, downstream and always-reconcile jobs
cannot start or receive secrets. Preflight then reads and hashes the observed
GitHub policy into durable evidence; a variable claiming the policy is not proof.
Every dispatch also supplies the immutable release workflow run ID and hosted
runtime identity artifact ID. Before rollout claim or any provider/database
mutation, preflight downloads that exact artifact, verifies its GitHub artifact
attestation was issued by this repository's protected release workflow on
`refs/heads/main`, and requires the release run, artifact metadata, identity
repository, identity commit, OCI digest, and immutable image URL all to bind the
exact `expected_sha`. A stale digest variable is not an input and cannot select
the deployed image. Missing, expired, foreign, stale, or contradictory release
evidence fails closed. The verified binding is carried through every phase and
included in the final trusted rollout evidence.
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

The dedicated authority's canonical migration chain is, in order:
`000001_release_authority`, `000002_external_effect_protocol`,
`000002_transactional_service_transition`, `000003_partial_source_freeze`,
`000004_selective_source_recovery`, `000005_late_runner_effects`,
`000006_runner_provider_creation_boundary`,
`000007_compensation_effect_fence`, `000008_trigger_helper_acl`,
`000009_authority_history_and_forward_repairs`, and
`000010_recovery_effect_permits`. The final five migrations bind provider
creation time, recheck late effects at every compensation boundary, remove the
remaining public trigger-helper grant, establish an immutable migration
history, and fence every recovery effect with a single-use permit.
The disposable PG16 to PG17 rehearsal and dedicated authority contract must
execute this complete inventory before a release is eligible for production.

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
- `RENDER_TARGET_SWITCH_API_KEY`: key-scoped target environment mutation and
  immutable deploy creation/polling only.

Adapters accept additive documented fields while requiring their security
subset. Every inventory has explicit page/item ceilings, cursor syntax and
cycle checks; an incomplete inventory fails closed. Every HTTP request has an
abort deadline. Only safe reads have bounded automatic retries.

Every Render write consumes a durable, single-use provider-mutation permit
bound to rollout, operation, exact resource, expected state fingerprint,
authority epoch and expiry. The adapter re-observes that fingerprint, validates
the consumed execution receipt immediately before one HTTP write, and records
the exact postcondition. Environment changes use one bulk
`PUT /services/{serviceId}/env-vars` replacement per permit. Lost write
responses are observed and reconciled; they are never blindly replayed.

Render does not document ETags or conditional writes. This protocol is
authority-serialized compare-and-swap with pre/post state witnesses, not
provider-native CAS. It serializes ReviewRouter actors, but cannot fence a
simultaneous Render console or independently credentialed API writer in the
small interval between the final observation and the provider write. Any drift,
unproven postcondition, deadline, or response loss closes the operation and
requires durable reconciliation/forward repair. No environment value, URL,
token, or provider response body is included in errors or outcomes.

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

1. inspect every source writer sequentially, durably prepare an authority
   mutation intent before each required suspend call, re-observe it suspended,
   persist an immutable completion observation, and finally persist the
   complete inspected inventory;
2. install an attested source-local fence ledger, snapshot the exact CONNECT
   ACL, revoke CONNECT from PUBLIC and every catalog role except the isolated
   fence authority, commit that database-level fence, and only then terminate
   all other sessions;
3. evaluate the complete effective-principal inventory against the reviewed
   phase policy, deny reconnect for every approved runtime credential, and use
   bounded zero-session samples only as supporting evidence.

`writersSuspended` is never synthesized. If freeze stops part-way, the durable
intent/completion observations—not the adapter process—name the exact mutated
subset. An unresolved intent is an unknown provider effect and denies
compensation.

Render environment-key discovery is only a provider hint; it is not proof that
all database-capable processes were found. The complete PostgreSQL principal
inventory and committed database fence are the security boundary for unlisted
or external writers.

A definite failure before activation enters compensation only after the database gate
proves that subset and runner external effects are safe; source ACL/environment
is restored and exactly that subset is resumed and re-observed. Zero runner
intents are safe only with partial/complete mutation evidence. A completed
freeze receipt proving no source mutation is a no-op; absent evidence is
unknown and remains denied. An accepted or uncertain activation permanently bans
PG16 promotion and allows only PG17 forward repair/PITR.

Equivalence is restricted to `REVIEW_ROUTER_APPLICATION_SCHEMAS_JSON`, streams
each table/materialized view through a hash with an 8 MiB process ceiling, and
also binds sequence `last_value`/`is_called`/owner/dependency, columns/defaults,
constraints/indexes/triggers, policies and RLS, functions/views/schemas,
ACL/default privileges/ownership, and migration history. Activation rejects an
unclassified application schema, any unlisted login or SET ROLE path,
privileged/bypass-RLS role, unapproved owner, or unsafe PUBLIC/table/column/
sequence/routine privilege. The same provider-neutral inventory and exact
policy matrix are attested at source freeze, both sides of equivalence,
activation, production-writer capture, and compensation. Canonical grants, catalog-fact hash,
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
`safeForCompensation`. That value is true when durable intent evidence proves
every existing intent `cleaned` or `abandoned`; zero intents are accepted only
when authority-owned freeze evidence proves a source mutation. Pending discovery, a
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
four Render credentials, root-owned App key secret file, immutable runner
service provenance, authenticated backup/export witness, and the durable ledger
API backed by the installed PostgreSQL schema. Until each is independently
observed, this implementation is not dispatchable and production remains
NO-GO.
