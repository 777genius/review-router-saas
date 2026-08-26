# Hosted Workspace Account Pool Plan

## Goal and Invariants

Provide an opt-in pool of workspace-owned Codex subscription accounts while
keeping checkout, tools, and the agent loop in GitHub Actions.

🔒 Invariants:

- legacy repository-owned mode is the default and is behaviorally unchanged;
- a repository cannot use the hosted pool without explicit workspace opt-in and
  repository binding;
- `auth.json`, refresh tokens, and access tokens never leave SaaS;
- SaaS transiently sees relay prompts, tool outputs, and responses but never
  persists their bodies;
- one invocation stays on one account, except for one pre-response classified
  auth/quota fallback;
- credential mutation is fenced and generation-CAS protected; inference is not
  account-mutex protected;
- no `executionSlotsPerAccount` control exists;
- multi-replica production never uses `FileBackend` workers or local session and
  lease stores.

## Top Three Architecture Options

1. **SaaS credential custodian + invocation-scoped relay** - selected.
   🎯 9/10 🛡️ 8/10 🧠 8/10. Approx. 3,500-6,500 changed LOC.
   Keeps sensitive credentials out of Actions and preserves customer-side tools,
   while requiring strong streaming, KMS, and transient-data controls.

2. **Repository-owned rotating secret per repository** - keep as legacy default.
   🎯 7/10 🛡️ 9/10 🧠 6/10. Approx. 800-1,800 changed LOC for incremental
   hardening. Lowest SaaS custody risk, but it does not provide a workspace pool
   and distributes account lifecycle across repositories.

3. **Run the complete agent and checkout in SaaS workers** - rejected.
   🎯 4/10 🛡️ 4/10 🧠 10/10. Approx. 8,000-18,000 changed LOC. Centralizes
   scheduling, but expands code custody, sandboxing, SCM credentials, compute,
   and incident blast radius far beyond this feature.

## Responsibility Map

```text
GitHub Action
  checkout + local tools + Codex agent loop
  -> bounded run grant + streamed Responses/tool-result frames

SaaS relay
  validates grant + binds repository/run/account
  -> account router -> session validation/lazy refresh -> upstream Responses

Shared persistence
  encrypted session envelope + generation
  refresh/writeback lease + mutation fence
  safe invocation metadata only

KMS/keyring
  envelope key wrap/unwrap + rotation + audited restore rewrap
```

Keep interfaces narrow:

- `HostedPoolBindingRepositoryPort`: explicit workspace/repository/account policy;
- `InvocationGrantPort`: mint, validate, consume budget, revoke;
- `ResponsesRelayPort`: streaming only, with byte/time/backpressure ceilings;
- existing `SessionStorePort`: encrypted session envelope and generation CAS;
- existing `LeaseStorePort`: refresh/writeback lease only;
- `CredentialKeyringPort`: wrap/unwrap/rewrap by key ID and database incarnation;
- `CodexCliSessionDriver`: lazy refresh plus existing validate/classify behavior.

The high-level use case depends on these ports. Provider, Postgres, KMS, and HTTP
streaming adapters remain replaceable and independently testable.

## Account Selection and Concurrency

At grant creation, select an enabled account authorized by the explicit repository
binding, then persist the sticky binding `(invocationId, accountId)`. Do not change
it for latency, load, or generic upstream errors.

The only permitted backup transition is:

```text
no successful upstream response yet
+ classified auth_required/auth_invalid/quota_limited
+ backup not previously attempted
-> atomically bind one eligible backup account and retry once
```

Any response headers/body/event accepted as a successful upstream response closes
the fallback window. Transport errors, timeouts, 5xx, malformed output, tool
errors, and post-response quota errors do not trigger account switching.

Multiple invocations may use the same account concurrently. Acquire an
account-scoped mutation fence only when lazy refresh is needed. Re-read the
generation after acquiring it, refresh once, and commit with expected-generation
CAS. A CAS loser discards its refreshed artifact and re-reads. Never hold this
fence during an upstream response stream or Action tool execution.

## Credential Storage and Restore Safety

Persist an encrypted session envelope, never plaintext credential columns:

```text
ciphertext, nonce/tag, wrappedDataKey, keyId
tenantId, accountId, generation, databaseIncarnation
status, createdAt, rotatedAt, safe credential fingerprint
```

AEAD AAD is the canonical encoding of tenant, account, generation, schema
version, and database incarnation. The active database incarnation is anchored
outside the restored database through the deployment/KMS control plane.

After any database restore:

1. start hosted-pool issuance and relay in deny mode;
2. create/verify a new active database incarnation outside the restored snapshot;
3. mark restored credential rows `restore_quarantined`;
4. inspect tenant/account/generation inventory without decrypting into logs;
5. perform an explicit, audited KMS-backed decrypt-and-rewrap into the new
   incarnation, preserving or monotonically advancing generation;
6. re-enable only verified bindings. Uncertain rows require reconnect.

Backups, exports, traces, support tools, and migration logs must never expose
plaintext envelopes or relay bodies.

## Threat Model Additions

| Threat                                        | Required control                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen Action grant                           | Short expiry, exact repo/run/attempt/account audience, bounded calls/bytes/tokens, revocation, replay-safe counters                                               |
| Cross-tenant account selection                | Tenant and repository binding checked at issuance and every relay request; database constraints include tenant identity                                           |
| Credential disclosure from SaaS               | Envelope encryption, KMS audit, least-privilege decrypt role, no plaintext logs/traces/errors, bounded process lifetime and overwriteable buffers where practical |
| Prompt/tool output retained by infrastructure | Disable body capture/APM, stream without queues or retries that persist bodies, bounded redacted metadata only                                                    |
| Refresh race                                  | Account mutation fence, generation CAS, idempotent writeback; no full-run lock                                                                                    |
| Pool hopping hides failures                   | Sticky binding; maximum one backup only for classified auth/quota before first success                                                                            |
| Stale backup restore reactivates credentials  | External database-incarnation anchor, restore quarantine, audited rewrap/reconnect                                                                                |
| Unstable upstream delegation contract         | Compliance gate, pinned compatibility probes, account-type allowlist, global kill switch                                                                          |
| Malicious workflow/tool floods relay          | Trusted/private repos first, protected workflow policy, per-grant byte/request/token/time limits and backpressure                                                 |

### Comment-token crash boundary

The custody protocol deliberately has no local plaintext or token WAL. After a
GitHub POST can have taken effect, the database first persists
`dispatching`/`outcome_unknown` with `unsafeUntil`. If a bearer is parsed but
the process crashes while both durable encrypted staging and authenticated
DELETE proof are unavailable, no token is returned and no second POST is
allowed. The account and runtime closure remain fail-closed until the
server-checked conservative provider lifetime has elapsed. Recovery then
records server-derived expiry evidence, clears encrypted secret columns, and
terminalizes the row as `expired`; it never describes expiry as DELETE proof.
This bounded availability loss is the accepted residual risk in preference to
creating another durable bearer-secret store.

## Implementation and Migration

The exact environment contract, public Action SHA sequencing, and kill-switch
procedure are defined in
[Hosted Codex Pool Operations](../operations/01-deployment-model.md#hosted-codex-pool-operations).

1. **Schema and ports, feature off**
   - add accounts, explicit repository bindings, encrypted generations, invocation
     bindings/grants, refresh leases, and safe audit metadata;
   - add Postgres `SessionStorePort`/`LeaseStorePort` adapters and
     `CredentialKeyringPort`; do not reuse `FileBackend` production adapters.
2. **Custody and refresh, no customer traffic**
   - implement account connect/reconnect, envelope encryption, lazy
     `CodexCliSessionDriver` refresh, validation/classification, mutation fence,
     generation CAS, rotation, deletion, and restore quarantine drills.
3. **Relay and new Action contract**
   - issue bounded multi-use grants via OIDC-authenticated Action sessions;
   - stream request/tool-result/response frames with limits and body-free
     telemetry; implement sticky selection and the one-backup rule.
4. **Old/new Action rollout**
   - old Actions continue legacy mode and cannot request hosted grants;
   - new Action advertises a versioned hosted-pool capability and defaults to
     legacy unless the server returns an explicit bound provider mode;
   - deploy server readers first, then new Action, then enable writers and relay
     for internal allowlisted repositories.
5. **Progressive availability**
   - disposable private E2E repository, internal trusted private repositories,
     small workspace allowlist, then wider opt-in only after acceptance and
     compliance approval. Public/fork/untrusted repositories remain denied until
     separately approved.

No migration copies legacy GitHub secrets into SaaS. A repository enters hosted
mode only after a new account connection, explicit binding, and successful
health check. Switching modes is an audited configuration generation change.

## Rollback

- Global kill switch stops new hosted grants and relay calls without affecting
  legacy Actions.
- Repository/workspace/account flags revoke grants and freeze new hosted work.
- In-flight streams terminate with a safe retryable classification; they never
  switch silently to legacy credentials.
- Roll back server code only while the additive schema remains. Do not drop
  encrypted generations, grants, or audit rows during emergency rollback.
- To return a repository to legacy mode, require an explicit admin action and a
  separately healthy repository-owned credential; never export the hosted
  credential to GitHub.
- Upstream contract/compliance failure disables hosted mode globally and keeps
  encrypted accounts quarantined or reconnect-only according to incident policy.

## Acceptance Matrix

| Area                | Required evidence before enablement                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Opt-in isolation    | Unbound repositories and old Actions remain legacy; cross-tenant/repo grant attempts fail closed                                                |
| Credential boundary | Network/log/artifact scans prove no `auth.json`, refresh token, or access token reaches Action or observability systems                         |
| Transient privacy   | Prompts/tool outputs/responses complete through streaming while DB, queue, logs, traces, errors, and backups contain no bodies                  |
| Grant security      | Expiry, replay, wrong run/attempt/audience/account, revoked grant, and budget exhaustion tests fail closed; valid grant supports multiple turns |
| Concurrency         | Parallel inference on one account succeeds; only refresh/writeback serializes; generation CAS rejects stale writers                             |
| Fallback            | Auth and quota failures before first response use at most one backup; all other and post-response failures stay sticky                          |
| Restore             | Disposable backup restore starts quarantined; wrong incarnation cannot decrypt/serve; audited rewrap or reconnect is required                   |
| Multi-replica       | Two or more SaaS replicas share Postgres stores/leases correctly; no local/FileBackend correctness state exists                                 |
| Compatibility       | Old and new Action matrices pass, including hosted-disabled server, kill switch, rolling deploy, and downgrade                                  |
| Repository trust    | Only explicitly bound trusted private disposable repositories pass E2E; fork/public/untrusted cases fail closed                                 |
| Compliance          | Named owner records approval for supported account types and upstream contract; kill-switch drill succeeds                                      |
| Operations          | Key rotation, account revoke/delete, incident disable, quotas/backpressure, and body-free support diagnostics are exercised                     |

All agent-command, provisioning, runtime, assignment, and smoke E2E must use a
new disposable test repository or an explicitly designated existing test
repository. Never validate this mode on a real customer/user project.
