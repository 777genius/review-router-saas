# Account Gateway: Normative Implementation Contract

Date: 2026-10-03. DOC PLAN corrections prepared for review; runtime qualification pending.
This is the sole normative implementation authority. [Vision 50](./50-reusable-account-gateway-and-personal-pool.md), [sequence
51](./51-account-gateway-modular-implementation-plan.md), [evidence and dispositions 52](./52-account-gateway-first-slice-contract.md) and
[ADR-030](../decisions/030-reusable-account-gateway-and-ownership.md) link here; their historical prose cannot override this contract.
Every implementation packet includes these exact bytes/digest, its supplied and observed source identities separately, owned paths, dependencies
and nearest observable tests. MUST denotes a required gate, not an implemented capability.
Writers: explicit `gpt-6.1-sol/high/default`; independent exact-source review: `gpt-6.1-sol/xhigh/default`. NO FAST. Target coherent component
PRs around 2000 changed LOC.

## 1. Product and authority

One separately deployed reusable service unit contains a narrow TS facade/kernel and one pinned private Sub2API engine. Our product UI remains
mandatory; no per-organization engine/admin instance.
RR owns users, live membership/roles, credential owner/use relations, repository/model policy, OIDC/run admission and GitHub App publication.
Kernel SQL owns durable execution claims/effects, account-global occupancy, epochs and cleanup. Sub2API alone owns provider transport/auth and
qualified engine refresh.
A separate reusable TS SDK provides safe versioned contracts, server-only HTTP and optional static Get Modular composition outside neutral Core.
Other languages use HTTP. Foundation/Docs Protocol are dev tooling, not policy/runtime dependencies.
Use cohesive consumer-owned management/execution capabilities and existing composition; no generic interfaces, DI framework, scheduler, plugins,
outbox, refresh-sync authority or renewal subsystem.
Owner is exactly one stable User or Workspace under existing XOR constraints; execution workspace is a distinct use. User IDs/personal scope
cannot be inferred from login/slugs. Canonical personal-to-multi-org sharing is H follow-up, with full vision retained in 50; no sharing
implementation in A–D.
Own MiMo/OpenRouter BYOK requires ordinary workspace-admin authority, independent of operator shared-pool grants. Paid tier never creates a
grant. Explicit standalone Action BYOK remains supported under its existing policy, never a gateway fallback.
Codex through Sub2API is mandatory: MiMo API-key native Responses at D, protected Codex OAuth at F. OpenRouter E remains a user goal. Claude/new
protocols/auth kinds require their own qualification.

## 2. Private HTTP and persisted identity

Consumer identity comes from server-configured role-specific bearer credentials mapped to opaque consumer/role, never caller IDs. Bind control/execution/cleanup/native-callback roles
separately; rotation closes retired authority. CI grants cannot administer accounts. Fixed server origins, no redirects/caller callback
URLs/admin routing headers.
Native bootstrap is opt-in, one dedicated fixed private origin, admin off public interfaces. Reuse existing Go constructors/Wire graph, a
separate bounded private listener and sanitized middleware; no stock admin/scheduler fallback. Managed rows are excluded from ordinary
scheduling, probes, mutations/export and shared groups. Native ordinary Concurrency must be proved inert on this path.
Reuse SDK v1 route/schema authority; additive changes derive types/validators there, never independent product DTO copies. Snapshot accepted
primitive consumer/intent/proof fields before any await. Facade owns bounded heartbeat/reconcile/cleanup polling under existing kernel leases;
no inference replay or extra scheduler. Lock/lease loss preserves unknown facts and exact-owner cleanup.

| Route                                                    | Required semantics                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/profiles`                                       | Safe server-owned protocol/model/auth catalog; no origin/native IDs                                                                     |
| `POST /v1/accounts`                                      | Stable operation, opaque owner, profile/name, write-only server credential; staging                                                     |
| `GET /v1/accounts` and `GET /v1/accounts/:accountRef`    | Control role; bounded consumer/owner-filtered safe metadata only                                                                        |
| `PATCH /v1/accounts/:accountRef`                         | Expected metadata revision, rename only                                                                                                 |
| `POST /v1/accounts/:accountRef/reconnect` and `/disable` | Stable operation/revision; staged promotion or logical deny, safe status                                                                |
| `GET /v1/operations/:operationRef`                       | Bounded pending/applied/rejected/unknown union; no intent body/secret/capability                                                        |
| `POST /v1/executions`                                    | Opaque invocation/attempt, approved account subset, policy subject/revision, independent binding revision, profile/full limits/deadline |
| `POST /v1/executions/:executionRef/requests`             | Stable request ID, trusted full saved envelope and native payload; bounded SSE                                                          |
| `GET /v1/executions/:executionRef/requests/:requestRef`  | Safe effect readback, never replay/resume/body                                                                                          |
| `POST /v1/executions/:executionRef/close`                | Idempotent deny and scoped cleanup; owner may explicitly close a run                                                                    |
| `POST /v1/policy-fences`                                 | Stable operation/subject, monotonic authorization policy revision; applied only after durable ACK                                       |

`operationRef = operationId`; `requestRef = requestId`. Same consumer/ID+intent reads the original result; changed intent is conflict. 202 is
pending, not applied. 404 is non-disclosing absence, never proof of no effect. Safe errors contain code/trace/ref/effect/classified hint, no
vendor bodies, credentials, prompt/output or secret fingerprints.
Preparation and operation readback return the same persisted selected `accountRef` + `authorizationEpoch` with execution/deadline/state, not a
descriptor or permission. RR retains the full original preparation intent and constructs admission from that tuple; no later GET-inferred epoch
or singleton-set workaround.
Claim matches saved consumer/execution/issuer, invocation/opaque attempt, selected account/auth epoch, subject, independent policy/binding revisions,
profile, all five limits (requests/concurrency/requestBytes/outputBytes/tokens) and exact expiry instant; finer expiry truncation cannot extend authority.
Dedicated kernel PostgreSQL 17.10/numbered SQL/pg adapter remains the selected storage; no shared RR writes. Unique consumer/account,
consumer/operation, invocation/attempt and execution/request identities; atomic claim/fence/promotion/cleanup transactions.
Persist private route mapping from physical UUID to exact numeric native ID, canonical birth UUID, CreatedAt precision, profile/baseURL/model.
No JS Date precision loss, ID-only/name/latest-row lookup, missing/ambiguous candidate or restored stale descriptor. Conflicts quarantine.
Generation means immutable native physical birth UUID, replaced on reconnect/promotion. Internal OAuth refresh credential version is
engine-owned and separate. `authorizationEpoch` is owner authority, not either counter. Reconnect/global disable increments epoch and stops all
account uses; rename changes metadata only.
F MUST define and test actual upstream OAuth identity, duplicate enrollment/single-writer handling and native fenced refresh on the same
physical row/account without revoking a valid invocation. API-key-only candidate is not OAuth capable; token DeepEqual cannot substitute for
this future identity contract.

## 3. One durable admit and replay protection

Order is mandatory:

1. TS validates authenticated ingress, live saved full envelope, profile/model/limits and decoded payload before forwarding. TS MUST NOT
   preclaim. It opens one no-retry authenticated native request.
2. Go reserves a bounded private registry entry before one bounded authenticated admit CALLBACK to the fixed TS origin. Reservation key binds
   consumer/execution/request/generation/incarnation/nonce; duplicate reservation denies. Saturation rejects before claim and never evicts
   unresolved evidence.
3. Callback resolves the protected mapping and atomically validates current kernel permission/epoch/fence/deadline/full envelope, then performs
   the sole SQL claim under its exact current worker lease/registered protected incarnation. FIRST claim alone returns exact private
   descriptor/dispatch proof, bound to origin/incarnation/generation/request nonce. Duplicate native HTTP or callback for the same
   consumer/execution/request returns status, no second permit.
4. Go checks exact permit binding, current lease/proof expiry, approved deadline and cancellation latch, performs locked fresh-row validation and additional per-call entered CAS, then enters
   upstream at most once. No SDK/facade/engine inference retry or independently selected account. A future qualified backup permits at most one
   atomic freshly authorized account switch before first success, only with positively classified safe auth/quota non-effect; ambiguity, timeout
   or partial output never permits it. Initial backup is disabled.
5. Go settlement authenticates exact identity/proof to TS; only kernel SQL writes effect/occupancy. HMAC authenticates a proof; Redis markers
   and per-call CAS are additional guards, never authoritative replay ledgers.

Lost/delayed admit ACK seals the reserved entry through its cancellation latch; it MUST NOT enter upstream even if a late permit arrives.
Cleanup recovers the original durable binding/proof under cleanup authority; never obtains another dispatch permission or reclaims.
Restart/restore cannot rearm spent claims.
Required B receipt: actual dual POST and duplicate callback, TS loss, Go restart and lost/delayed admit ACK against migrated SQL+controlled
upstream; at most one upstream entry, and zero entry for a sealed lost-ACK reservation.

Before entry, TS and Go enforce approved bytes/profile/model and decoded critical names/types: reject duplicate decoded names and case/Unicode
aliases (canonical escaped names remain supported) in envelope/descriptor/payload including `max_output_tokens`; require server-qualified
endpoint/catalog, `store:false`, no `previous_response_id`, `stream:true`, `service_tier:"default"`. Omitted output cap gets approved cap;
integer 1..qualified provider upper bound is clamped to approved cap; invalid caps deny. Construct upstream auth/content headers afresh.
Native's old 4/8 MiB constants do not prove approved byte enforcement.
Private qualification requires 2xx status and valid UTF-8 before conversion/delivery, rejects conflicting tool identities within a chunk,
ambiguous `status`/`type`/`response`, incomplete/truncated output, invalid finish reasons and sparse tool
indices. SSE must use complete bounded events/data-line joins; full write/flush and qualified successful terminal delivery are required, never
upstream EOF alone. Preserve ordinary compatibility and unrelated tool/user bytes; historical conversion is never fallback. W5 fixes alone do
not qualify caps/profile.

## 4. Effects, allowances and closure

Normal effects: `not_dispatched -> dispatch_started -> response_started -> completed`; possible dispatch/partial output/terminal delivery
failure becomes `effect_unknown` and fences the original invocation/attempt across new request/execution IDs.
Additive future kernel/SDK patch MUST implement `dispatch_started -> rejected_before_dispatch` before B dispatch gate. Only positively attested
native settlement for the exact trusted identity+proof with `entered=false` permits it. This document changes no enum/schema/code. Generic HTTP
4xx/5xx/404, missing record, lost response or unknown upstream response never proves non-entry.
Proved pre-entry rejection does not fence the invocation; permanently spent request/token allowances stay spent. Occupied concurrency closes
independently by exact closure proof. Lost rejection settlement preserves unknown fencing/occupancy until reconciled, without inference replay.
`limits.tokens` for MiMo means output+reasoning cap per request, not execution-total input/output billing. Conservative ceiling is
requests×tokens; input separately bounded by bytes/context. No refund/tokenizer ledger. Each durable claim spends one request slot/cap; missing
usage never recycles it.
Existing maxConcurrent is account-global across executions and old generations/fenced/closed runs, plus narrower approved execution limits. No
full-agent-run mutex, duplicate native limiter or per-binding multiplication. Unknown/expiry/revoke/credential erase never frees occupancy.
Go registry owns cancel/context, forwarding-return signal, body-close result, latch, proof and durable-ACK state; retain closed unacknowledged
entries within enforced bounds. States reserved/admitted/entered/closed are distinct from effect outcome.
Local closure requires owned Context Done, forwarding return AND successful response-body Close (or positively proven no transport/body entry).
Close error/blocked downstream write is not closure. Deadline cancels in Go; private writes/reads are bounded and cancellation interrupts
blocked writes.
Revoke/close commits kernel fence first; leased cleanup sends authenticated exact-binding cancel and bounded read-only wait under
`/private/native/v1/transports`. Lost settle/close ACK retains occupancy; fresh cleanup may read the retained receipt and acknowledge it with
its current lease. Wrong scope/proof/incarnation denies.
TS uses bounded Node HTTP(S), `agent:false`, abort and socket/body observation. TS outbound closure proves only that hop; TS death/socket drop
cannot certify Go provider closure. Erasing credentials, timeout or new Go boot also cannot.
Use B3's minimal protected single-host inherited-lock launcher: fixed-inode process-lifetime Linux flock inherited by engine with close-on-exec
cleared, retained until process exit; never unlink/replace the lock inode; no daemonization/unlock/descriptor release. Protected
fsynced/atomically replaced metadata records origin, host boot/process birth and incarnation before readiness. Lock conflicts deny startup; no
rolling instances.
Retirement proof requires exact child exit or lock reacquisition after launcher loss, bound to persisted old incarnation and supervisor-only
authority. Fresh cleanup verifies proof per occupied binding; absent proof retains occupancy/quarantine. Process death proves local teardown,
never provider nonbilling/no effect.
Actual Linux qualification MUST cover inherited FD/lock behavior, launcher+TS+Go loss, surviving old child blocking new start, restart/readback
and wrong-incarnation proof. This is a required new mechanism, not an available feature.
Nearest effect/closure tests: postclaim `store:true` exact entered=false vs lost settlement; held stream+revoke+TS kill; Close/write failure;
lease recovery; verified old-process retirement; unknown/spent facts remain after exact occupancy closure.

## 5. Product binding policy and mirrors

For binding-use grants `policySubject` is opaque `WorkspaceAccountBinding.id`. Authorization `policyRevision` and `bindingRevision` remain
independently persisted/validated even when first implementation advances both together; never reconstruct one from the other.
Detach/explicit use revoke atomically increments both revisions and persists a bounded pending-fence intent on that binding with stable
operation ID. Local denial is immediate; applied remote revocation awaits durable gateway fence ACK. Crash recovery reads the same intent; no
generic outbox. Concurrent intent replacement cannot forget an unacknowledged required revision.
Workspace/member role loss/removal fences affected binding uses under existing explicit RR membership policy. Unrelated Y is not denied by X's
detach. Rejoin does not restore revoked uses. Account reconnect/global disable separately advances auth epoch and denies every use.
Repository/model settings changes apply to the next admitted run; existing runs retain pinned configuration. Explicit revoke/run-close is the
supported way to stop a pinned run. Test settings mutation alongside X/Y fence race, including delayed ACK and new-ID bypass denial.
System-owned RR admission resolves current server repository config/binding and live original authority; it MUST NOT fabricate a user actor to
call C1's interactive selection. Registration binds actual repo/run/attempt/head and persists approved tuple.
RR account mirror refreshes after mutation/readback and on authorized Accounts GET, with safe metadata revision CAS; older snapshot cannot
overwrite newer state. Mirror is display/cache only and never grants authority; live gateway/kernel checks remain required.
Deletion sequence: deny/revoke affected uses + durable remote ACK -> exact transport cleanup and credential erase -> inert tombstone ->
owner/workspace deletion. Return explicit delete-pending/refusal until satisfied, not raw FK error; retain scoped audit/effect references
without broad data deletion.

## 6. Relay wait, CI trust and UI

Only RR relay owns bounded wait for positively classified LOCAL `admission_limited` + `not_dispatched`. New wire requestId stays within the SAME
approved invocation/attempt while no fence/deadline violation, provider entry or partial output exists. Read current authority before each new
admission.
No general CLI/SDK inference retry, no upstream-429 inference, no wait/re-ID bypass of unknown fence. Once configured wait budget/deadline is
consumed, return safe observable busy/not-dispatched with reason/effect in Action summary/advisory; never fabricate success. Test two
invocations/cap1 completing once each, budget exhaustion and partial stream denial.
OIDC authenticates repo/workflow/event/run identity, not job-code trust. C2/D MUST inspect and preserve actual RR fork/event authorization,
permissions and approved head/run/attempt binding; no blanket fork exclusion or privileged pull_request_target checkout of untrusted head.
Server owns provider/model/account/limits/deadline and closes grant at job end/abandonment. Grant can be accessed/abused by code inside its
authorized job; provider sees submitted source. Tools env scrub is defense in depth, not full grant secrecy. Prompt injection/tools/publication
can exfiltrate content; UI/customer copy states these limits without adding approval flow.
Master/API/OAuth/refresh/admin credentials MUST be absent from CI env/logs/artifacts and safe APIs. Disposable C2/D source-classification tests
cover actual allowed/denied fork/events and attempt/head mismatch, tool env scrub, grant scope abuse bound and denial after close/deadline.
One run capability has approved server deadline distinct from OIDC mint expiry; no caller extension. Test valid long run after OIDC mint expiry,
then denied postdeadline/revoke. Existing RR finality/head/publication idempotency remains mandatory, App bot authors every advisory/inline
comment.
Use current App-first client-triggered T0 schema v2: `.github/workflows/reviewrouter-codex.yml`, immutable
`reviewrouter-t0-reusable.yml`, repository-scoped `provider_instance_id` and OIDC `id-token: write`. New gateway auth mode
injects no upstream credential. No legacy direct workflow or review publication through `github.token`; coordinate generated workflow/control plane.
Use our Accounts connect/rename/reconnect/disable UI and Models/repository batch controls. Server authorization/first paint; shared Radix
primitives, React Query only for useful safe cached interactions. Credentials use one-off server ingress, never query/mutation cache/local
storage/readback.
Persist binding/profile in versioned configuration and primary representation with workspace FKs; override -> workspace default -> safe default.
Per-target expectedVersion CAS/live authorization and stable operation/readback yield truthful partial batch results and preserved selection
after refetch; no upstream-key copies to repo secrets.

## 7. Custody and account lifecycle

Managed native BYOK rows MUST use AEAD envelopes with server-only key outside DB/backup and exact consumer/owner/account/generation/purpose AAD.
Decode only at native credential boundary. No plaintext JSONB/Redis/history/debug/export paths. Rotation/readback mismatches quarantine.
Protected transient create intent remains encrypted, short TTL, bounded, stable-operation scoped with readback/erase after one attempt or
expiry; server HMAC secret is outside DB/backup. Memory-only proposal is not accepted absent actual equivalent crash/reconciliation/custody
guarantees. Do not promise immutable-string zeroization.
Journal exact owned candidate/generation before sole native create; lost ACK uses generation readback, never second create. Zero/multiple
candidates quarantine. Staging is nonexecutable; reconnect promotes mapping+epoch atomically only after controlled credential/profile proof.
No implicit paid validation probe. Non-inference credential check is allowed only when that provider path is qualified; first actual canary is
explicit. HTTP401 alone cannot prove NoEffect. Controlled fixture proof then first paid canary qualify the real profile.
Real-user release requires actual dump/backup without plaintext and restore into new issuer epoch with quarantine, key rotation/readback/erase
tests. Isolated canary is not production custody acceptance. F extends the envelope/one-writer proof to every OAuth
refresh/cache/history/export/restore path, including both Redis projections; BYOK is not free equivalence.
Restored grants/claims never revive; explicit fresh issuer/admission epoch and exact mapping quarantine before new work. Normal restart and
backup restore are separate tests. Cleanup leases are bounded/current; recovery never resumes inference.

## 8. Qualification, retention and delivery

Foundation source/installed-artifact receipts and current readiness live only in [evidence 52](./52-account-gateway-first-slice-contract.md).
Accepted foundation evidence never implies dispatch, facade, provider, daemon, deploy, retirement or product qualification.
Gate B requires accepted W5+B2 and additive rejected-before-dispatch kernel/SDK support, actual Go bootstrap/admit/closure/launcher and
management reconciliation proofs. C2 supplies authorized server adapter/config/OIDC relay; C3 UI runs in parallel.
D-min precedes full UI: actual Codex tools + final parsed review + exact-approved-head App publication through the same authoritative
connection/binding/admission use cases using disposable fixtures. Missing final answer fails even if workflow green. D-final additionally needs
full UI batch, enforced measured limits/memory/cleanup and long OIDC.
S after D is explicit operator pool: dedicated operator workspace owns canonical account under XOR; special operator-grant creates consuming
workspace use, account-global capacity with workspace attribution and binding fence. Granted succeeds, paid/ungranted denies, revoke fences X
while Y remains. Own BYOK has no S dependency; H personal sharing is separate.
E OpenRouter and F protected Codex OAuth each need actual profile-specific tools/final/publication; G requires D+E+F and exact release gates. No
credential/history/grant migration or coexistence/automatic legacy fallback. Close old admission/refresh/grants and classify in-flight effects
before old retirement; prove no competing refresh writer. Failure suspends new dispatch without reviving legacy authority.
Before D-final record and enforce measured numeric ingress/output/buffer/header/registry/request/concurrency/cgroup caps,
per-request/stream-idle/run deadlines, wait budget and cleanup SLO. Observe Node+Go+PG/Redis repeated-burst/retained-heap/cleanup; no invented
qualified numbers or forced-GC repainting historical RSS failure.
At D derive concrete executable-metadata TTL, operation/receipt retention and tombstone horizon from those numeric deadlines, pending effects,
closure/readback/recovery and restore-epoch policy. GC never removes unresolved unknown-effect/occupancy/fence/cleanup or replay tombstone
before ALL run deadlines + pending effects + exact closure + restore epochs are accounted. Bound growth via admission saturation, not evidence
eviction; test expired safe records vs unresolved/restore-reachable records.
Reuse only existing disposable test repos/identities, fresh App/permissions inspection; no real-project agent/paid probes. Main pins accepted
SDK/kernel/native/service candidates and verifies exact-SHA review+CI+assembled receipts, never a fabricated run head. ~2000 LOC cohesive
component PRs, observable/security tests nearest responsible boundary; no implementation-mirror/mock-only/source-string new tests.
Historical hashes/receipts remain NONNORMATIVE in 52. Every acceptance receipt identifies exact candidate/image, scenario/identity,
command/result and retained evidence. No product scenario becomes PASS from documentation. Licensing/version/toolchain requalification and
production release remain independent gates under the release runbook.
