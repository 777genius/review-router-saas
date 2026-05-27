# Codex OAuth GitHub-Hosted Refresh Plan

## Status

Proposed production-grade architecture.

Last reviewed: 2026-05-24.

This document replaces the earlier "static `CODEX_AUTH_JSON` on
GitHub-hosted runners" mental model for Codex subscription authentication.
It does not remove the existing v1 behavior yet. It defines the target design
for a no-VPS, no-plaintext-SaaS, auto-refreshing Codex OAuth mode.

## Spike Results

### 2026-05-24 Local Custom Provider Spike

Environment:

- Codex CLI `0.125.0`
- fresh temp `CODEX_HOME` with no `auth.json`
- local mock Responses provider on `127.0.0.1`
- static `model_catalog_json` from the pinned Codex source checkout
- runtime flags: `--ephemeral`, `--ignore-user-config`, `--ignore-rules`,
  `--sandbox read-only`, `approval_policy="never"`

Results:

- ✅ simple assistant response through custom provider worked
- ✅ tool-call loop through custom provider worked with real `exec_command pwd`
- ✅ custom provider received no `Authorization` header
- ✅ static `model_catalog_json` avoided `/models`
- ✅ runtime `CODEX_HOME` created only `installation_id` and system skill marker
- ✅ hardened flags removed remote plugin warmup and removed `web_search`
- ⚠️ default features tried a best-effort
  `GET https://chatgpt.com/backend-api/plugins/featured` and logged 401
- ⚠️ request payload still contains built-in review tools
  (`exec_command`, `write_stdin`, `apply_patch`, `view_image`, multi-agent
  tools). This is expected for review, but the proxy and workflow must enforce
  tool and sandbox policy.
- ⚠️ trivial request body was about 55 KB because Codex injects system context
  and tool schemas. Proxy limits must account for this.

Hardened invocation additions proven by spike:

```bash
--disable plugins \
--disable apps \
--disable tool_suggest \
-c 'web_search="disabled"' \
-c 'check_for_update_on_startup=false'
```

Recommended extra containment:

```bash
-c 'chatgpt_base_url="http://127.0.0.1:<proxy-port>/<nonce>/backend-api"'
```

This makes accidental ChatGPT backend calls hit the local proxy/sink instead
of the public ChatGPT host. The proxy should deny every non-allowlisted path.

## Executive Summary

ReviewRouter should support Codex ChatGPT subscription authentication on
GitHub-hosted runners without requiring a self-hosted runner, VPS, or repeated
manual reseeding.

The recommended production design is:

```text
local installer creates a dedicated per-repo Codex session
-> installer writes auth.json directly to a repo-scoped GitHub Actions secret
-> GitHub-hosted workflow restores the secret only inside a trusted proxy step
-> ReviewRouter OAuth proxy owns the refresh token in memory
-> codex exec talks to a localhost custom provider and never sees auth.json
-> proxy refreshes when stale or after 401
-> proxy encrypts the refreshed auth.json with GitHub's Actions public key
-> ReviewRouter SaaS writes only encrypted_value + key_id to GitHub
```

The ReviewRouter SaaS must never receive plaintext Codex OAuth credentials.
It only coordinates leases, validates GitHub OIDC identity, writes already
encrypted GitHub secret values through the GitHub App, and records safe status.

This is more complex than the official persistent-runner path, but it matches
the desired user experience:

- no VPS
- no self-hosted runner requirement
- no API key requirement
- no plaintext Codex OAuth custody in ReviewRouter SaaS
- automatic refresh on GitHub-hosted ephemeral runners

## Decision

Implement the no-VPS production path as:

```text
GitHub-hosted runner
+ repo-scoped dedicated Codex OAuth auth.json
+ ReviewRouter OAuth proxy
+ GitHub Actions encrypted secret writeback
+ ReviewRouter GitHub App Secrets: write permission
+ server-side single-writer lease
```

Decision score:

```text
🎯 8.6 / 10   🛡️ 9 / 10   🧠 9.8 / 10
Approx changes: MVP 16600-37500 LOC, production-grade 48650-105900 LOC.
```

Confidence is not 10/10 because OpenAI's official Codex OAuth CI/CD guidance
recommends persistent trusted runners as the simplest fully automated setup.
The proxy design is source-compatible with Codex custom providers and follows
the security pattern used by `openai/codex-action`, but we must prove it in a
real disposable private repository before enabling it broadly.

## Production Readiness Gates

This design must not ship broadly just because the document looks complete.
Release is allowed only after these gates pass in order:

1. **Codex CLI contract gate**
   - pinned Codex CLI version is fixed by exact version and package integrity
   - local custom provider receives no Authorization header
   - static `model_catalog_json` suppresses `/models`
   - plugin/app/tool-suggest warmups are disabled or routed to local deny sink
   - hosted `web_search` is absent
   - tool-call loop works for the real ReviewRouter review workload
   - no new remote Codex/ChatGPT endpoints appear outside the proxy allowlist

2. **OAuth upstream gate**
   - proxy can call the real ChatGPT Codex upstream with managed ChatGPT auth
   - required headers are proven for Plus/Pro/Business where supported
   - 401 classifications are observable without logging tokens
   - refresh code path is either reused from Codex or source-equivalent and
     covered by tests

3. **Upstream contract and policy gate**
   - OpenAI's current Codex account-auth CI guidance still permits the managed
     `auth.json` automation shape this design depends on
   - ReviewRouter is not relying on a user-visible promise that contradicts
     OpenAI docs, terms, or product policy
   - ChatGPT Codex backend path/header behavior is treated as a pinned,
     monitored compatibility contract, not a stable public API
   - a global kill switch exists for upstream auth-shape changes, unexpected
     401/403 waves, or account-policy rejection

4. **Encrypted writeback gate**
   - runner encrypts refreshed `auth.json` with the GitHub Actions public key
   - ReviewRouter SaaS receives only `encrypted_value`, `key_id`, safe hashes,
     and lease metadata
   - GitHub secret update works through the ReviewRouter GitHub App
   - the next GitHub-hosted run uses the refreshed value without local reseed

5. **Failure semantics gate**
   - cancellation before refresh is safe
   - cancellation after refresh enters `unknown_auth_state`
   - permanent refresh failure enters `needs_reconnect`
   - manual reseed during active lease cannot be overwritten by stale writeback
   - public repo, fork PR, Dependabot, and untrusted workflow events fail closed

6. **Security evidence gate**
   - malicious prompt suite cannot read auth from file, env, procfs, logs, or
     artifacts
   - Codex runtime cannot mutate repository files in review mode
   - no workflow step exposes a GitHub token with `Secrets: write`
   - no raw prompt, diff, auth JSON, JWT, provider body, or model output is
     stored in SaaS telemetry

7. **Operational drift gate**

- generated workflow has no `environment:` on the secret-backed review job
- maintenance refresh is either disabled or proven best-effort with dashboard
  stale-session detection
- quota/rate-limit behavior maps to `quota_limited` or retryable states, not
  reconnect loops
- Codex account/workspace lifecycle and provider-mode replacement rules are
  proven for Plus/Pro/Business/Enterprise paths
- GitHub secret materialization preserves canonical auth bytes from local
  setup -> GitHub secret -> workflow env/input -> proxy stdin without newline,
  encoding, or masking surprises
- installer zero-plaintext and setup PR idempotency tests pass
- compatibility registry can disable unsafe installer/proxy/Codex/workflow
  version combinations before they run with secrets

8. **Product feature interaction gate**

- review, interaction, conflict review, reusable workflow, memory, and
  required-check paths have explicit allow/deny behavior for this provider
  mode
- no existing workflow path can keep using legacy `CODEX_AUTH_JSON` semantics
  while dashboard labels it as auto-refreshing
- jobs with PR/issue write permission do not receive the auto-refresh OAuth
  secret unless a separate two-job or SaaS-sanitized design is implemented
- memory endpoints and ledger material cannot receive auth, raw diff, raw
  prompt, raw model output, proxy URL, nonce, HMAC material, or helper tokens

9. **Action lifecycle and package execution gate**

- no marketplace/composite/JavaScript action with `pre`, `post`, or hidden
  lifecycle behavior runs after the OAuth secret is materialized unless it is
  ReviewRouter-owned, pinned, audited, and tested for no secret persistence
- `$GITHUB_STATE` and action post-state files cannot receive auth, proxy,
  HMAC, helper-token, writeback, OIDC, or raw review material
- package installation lifecycle scripts cannot run after secret restore
- cleanup is implemented for hygiene, but deletion/traps/post-steps are not
  treated as the security boundary

10. **Control-plane key management gate**

- GitHub App private keys, action-session signing keys, setup/writeback token
  signing keys, HMAC fingerprint keys, and encryption-at-rest keys have
  explicit owners, rotation procedures, `kid`/version tracking, and incident
  response
- KMS or signing-key unavailability fails before OAuth secret restore
- GitHub App private key compromise pauses writeback and helper-token minting
  globally until key rotation and audit complete
- database constraints enforce single active leases, writeback idempotency,
  generation monotonicity, and tenant/repository isolation

11. **Review input and output backpressure gate**

- PR file lists, diffs, checkout scope, tool stdout/stderr, and model context
  have explicit byte/file/token limits before Codex starts
- large, binary, generated, vendored, renamed, deleted, symlink, submodule,
  and LFS-pointer changes have deterministic review behavior
- GitHub API/file-list truncation or local diff truncation is surfaced as a
  safe review scope limitation, not hidden as a complete review
- process output caps prevent shell/tool/model output from becoming a log,
  artifact, memory, or SaaS ingestion DoS

12. **Customer code and secret redaction gate**

- dashboard/setup copy makes clear that review content is sent from the
  customer runner to the customer's Codex/OpenAI account, even though
  ReviewRouter SaaS does not receive raw diffs
- review packets are scanned for token-looking material before any model
  request
- detected secrets are redacted from model input, logs, artifacts, comments,
  memory, and SaaS telemetry
- the user still gets actionable safe findings for suspected secret leaks
  without the leaked value being repeated

13. **Result freshness and PR posting idempotency gate**

- every sanitized review artifact is bound to repository id, PR number,
  base SHA, head SHA, event type, run id, run attempt, workflow SHA, and
  artifact hash
- the comment job re-fetches the current PR head before posting and refuses
  to post inline findings for stale artifacts
- repeated workflow re-runs update or skip existing ReviewRouter comments
  instead of duplicating them
- merge-queue runs report final policy but do not post PR comments unless a
  safe PR mapping is explicitly proven
- GitHub API line-placement failures, secondary rate limits, and abuse
  throttles degrade to a bounded safe summary or skipped comment, not to
  retries that spam a PR

14. **Local credential-source and dedicated-session gate**

- installer has an explicit credential source resolver instead of searching
  arbitrary Codex account files, keychains, browser profiles, or app state
- v1 default source is a freshly created dedicated
  `$HOME/.reviewrouter/codex/<repo-id>/auth.json` with
  `cli_auth_credentials_store = "file"`
- global `~/.codex/auth.json` import is disabled by default and, if ever
  enabled as an advanced path, must copy into the dedicated `CODEX_HOME`
  after explicit local confirmation and smoke validation
- keyring/auto credential storage, Codex app/IDE stores, browser cookies,
  and account/app-server files are never scraped or treated as canonical
  secrets
- local setup records safe dedicated-session metadata so reruns can detect
  account replacement, stale local source, or deleted local session without
  sending plaintext to SaaS

15. **Existing-code migration and compatibility gate**

- no-VPS auto-refresh has a distinct provider auth mode, setup kind,
  workflow schema version, action runtime mode, secret name, and dashboard
  label from legacy static `CODEX_AUTH_JSON`
- existing `codex_subscription_oauth` repositories are migrated explicitly;
  dashboard copy must not relabel a static secret as auto-refreshing
- provider catalog, provider setup, workflow provisioning, action control
  plane, repo health, support diagnostics, dashboard copy, and Prisma
  migrations have a checked integration map before implementation starts
- `scripts/seed-codex-auth.sh` remains the legacy static seeding path unless
  a new pinned installer route is created and tested separately
- organization-wide legacy secret scopes are not inherited by rotating v1
  because refresh writeback needs a single repository/provider owner

16. **Installer and release root-of-trust gate**

- the production rotating installer is not served from mutable `main`,
  unversioned `/install/codex`, or a floating npm dist-tag
- dashboard-generated setup commands name an immutable installer version,
  expected digest, and release channel; internal spike shortcuts are clearly
  separated from production user copy
- installer digest verification is treated as network/CDN tamper protection,
  not as protection from a compromised ReviewRouter release/control plane
- high-security users have a documented independent verification path using
  GitHub release assets, immutable release/attestation metadata where
  available, or an offline signing key
- compatibility registry can emergency-block installer, proxy, action,
  Codex CLI, or release-manifest versions before any command reads
  `auth.json`
- release compromise runbook distinguishes installer compromise, proxy
  compromise, Codex CLI upstream compromise, dashboard command compromise,
  and npm/GitHub package registry compromise

17. **Proxy capability separation gate**

- the localhost listener visible to Codex is data-plane only and exposes no
  refresh, writeback, public-key, lease, status, debug, shutdown, admin, or
  health endpoints
- OAuth tokens, writeback session tokens, helper tokens, HMAC material,
  lease identifiers, and public-key fetch capability stay in proxy memory or
  inherited private file descriptors, never in the model-provider HTTP API
- the nonce-prefixed proxy URL is treated as visible to malicious prompts and
  shell tools; it is not a credential and no security claim depends on it
  staying hidden
- direct allowlisted `/v1/responses` calls can at worst spend the configured
  per-run quota budget and cannot trigger refresh/writeback/control actions
  independently
- the proxy rejects unsupported Responses body fields that enable hosted
  tools, file APIs, remote MCP, image/audio/realtime features, or model
  overrides outside the pinned ReviewRouter review contract

18. **Action runtime protocol and static-fallback gate**

- rotating OAuth is unavailable to `protocolVersion: 1`, legacy static
  runtime config, and action refs that do not advertise the rotating
  capability
- the secret-backed job performs a no-secret compatibility handshake before
  `REVIEWROUTER_CODEX_AUTH_JSON` is materialized
- runtime config response, action session claims, workflow schema marker,
  action/proxy version, provider auth mode, secret name, and feature-scope
  capabilities are validated as one tuple
- `REVIEWROUTER_STATIC_CONFIG_FALLBACK=true` is forbidden for rotating OAuth
  because static env fallback cannot safely carry leases, generations,
  feature denies, or compatibility registry decisions
- old actions must fail with safe setup/runtime errors such as
  `rotating_protocol_unsupported`, never fall back to legacy
  `CODEX_AUTH_JSON` semantics or run without refresh/writeback

19. **Release channel, mixed-fleet, and rollback gate**

- first production rotating OAuth setup PRs use exact action/proxy/installer
  versions or full SHAs, not the moving `v1` channel
- moving `v1` can become the default for rotating OAuth only after canary and
  exact-pin cohorts pass soak criteria and rollback drills
- compatibility registry, release tags, workflow schema, and action protocol
  are treated as separate gates; moving a tag alone cannot enable or disable
  secret restore
- emergency rollback disables new secret materialization before proxy start
  and leaves `REVIEWROUTER_CODEX_AUTH_JSON` and `CODEX_AUTH_JSON` intact
- mixed fleets are supported explicitly: legacy static, rotating exact-pin,
  rotating canary, rotating blocked, and rotating v1 customers can coexist
  without hidden migrations

20. **Checkout and workspace containment gate**

- trusted control files, proxy/auth material, OIDC/session material, and
  sanitized artifacts live outside the PR checkout workspace
- Codex reviews a sanitized read-only snapshot of the PR content, not a
  credential-bearing `.git` checkout or workspace that may be archived
- checkout uses explicit no-credential, no-submodule, no-LFS, no-cache, and
  no-repo-script settings for the first production mode
- `.git`, hooks, credential helpers, tokenized remotes, local git config,
  submodule metadata, LFS smudge state, caches, and generated temp paths are
  not available to Codex tools
- artifact and cache allowlists cannot include checkout root, control root,
  proxy temp dirs, Codex runtime home, or broad workspace globs

21. **GitHub App permission and secret wire-contract gate**

- the current ReviewRouter GitHub App profile is treated as secrets
  metadata read-only until the registered App, readiness checks, UI copy,
  and existing installations are upgraded to `Secrets: write`
- rotating OAuth cannot acquire a lease or restore
  `REVIEWROUTER_CODEX_AUTH_JSON` until the target installation has accepted
  the permission update and selected-repository membership is reverified
- repository public-key fetch and secret writeback use explicit GitHub API
  versions, exact owner/repo/secret name, response-shape validation, and
  safe handling of 403/404/rate-limit responses
- GitHub App installation tokens are treated as opaque variable-length
  bearer tokens; no code may assume fixed token length, prefix, or old
  format when parsing, masking, logging, or validating helper tokens
- runner-side encryption validates canonical plaintext byte budget,
  `encrypted_value` base64 shape/size budget, `key_id`, repository id,
  installation id, and secret name before SaaS writeback
- SaaS writeback accepts only ciphertext plus safe metadata and never
  receives plaintext auth, raw helper tokens, or raw installation tokens

22. **Account-session isolation and multi-repo rollout gate**

- production rollout does not assume that multiple dedicated per-repo Codex
  logins under the same ChatGPT account create independent refresh streams
  until Spike E proves it against real disposable repositories
- before isolation is proven, more than one active rotating provider with
  the same safe account/workspace fingerprint is either account-serialized
  or blocked by policy; it must not race independent refresh writebacks
- setup completion records only non-reversible account/workspace
  fingerprints, provider instance id, repository id, and isolation policy
  state; it never stores raw account ids, emails, workspace names, or token
  claims
- server lease keys can include an account-session-group dimension when the
  account isolation status is unknown, serialized, or known-interfering
- dashboard and support diagnostics show safe states such as
  `account_isolation_unknown`, `account_serialized`, or
  `multi_repo_account_blocked`, not raw account identity
- org-level static `CODEX_AUTH_JSON` secrets are never migrated into
  rotating multi-repo mode because one secret cannot safely represent
  multiple refresh streams

23. **Codex CLI binary contract and upgrade gate**

- the rotating mode does not run on a Codex CLI version just because it is
  the npm `latest`; every supported version has an allowlisted binary
  contract, package integrity record, help/config snapshot, and network
  behavior fixture
- current local/project reality is Codex CLI `0.125.0`, while `npm view
@openai/codex` on 2026-05-24 reports `latest` as `0.133.0`; this is an
  upgrade signal, not automatic permission to bump production
- workflow install uses exact version plus integrity/lock evidence; no
  floating `latest`, alpha/beta/native dist-tag, or platform-specific
  dist-tag can enter secret-backed runs
- required `codex exec` flags, `-c` config keys, custom provider fields,
  model catalog shape, JSONL event schema, sandbox behavior, and remote
  endpoint set are captured as a versioned compatibility fixture
- if a CLI version adds new network calls, changes config semantics,
  ignores path-prefix base URLs, sends Authorization to the local provider,
  changes tool-call JSONL, or stops honoring hardening flags, compatibility
  registry blocks the version before secret restore
- Codex CLI package install and any native/platform package resolution
  happen before OAuth secret materialization and are verified without
  executing repo-controlled lifecycle scripts

24. **Sensitive route privacy and telemetry sink gate**

- every route that can receive setup completion, OIDC exchange, lease
  acquire, runtime preflight, public-key helper, writeback, provider health,
  compatibility preflight, support export, or sanitized artifact ingestion is
  registered in a central sensitive-route registry before implementation
- framework, route handlers, validation errors, gateway logs, APM, tracing,
  metrics, error reporting, and support exports use allowlist-only metadata
  for those routes and cannot capture request or response bodies
- negative tests inject sentinel values into plaintext-looking fields,
  ciphertext, OIDC JWTs, setup/writeback tokens, HMAC material, nonce/proxy
  URLs, raw prompts, raw diffs, and raw model output, then prove the values
  are absent from logs, spans, metrics, error events, support exports, DB
  rows, artifacts, and job summaries
- route schemas reject unexpected body fields and plaintext-looking aliases
  before business logic, and validation errors never echo offending values
- access logs record only method, route id, status, request id, body-size
  bucket, duration bucket, and safe reason; they never record raw URLs with
  query strings, headers, cookies, bearer tokens, or body snippets
- any logging, telemetry, APM, error-reporting, hosting, or middleware
  change revalidates the telemetry sink harness in staging before it can be
  used by secret-backed routes

25. **GitHub OIDC claim-contract and original-event trust gate**

- rotating OAuth uses a stricter OIDC claim schema than legacy action
  protocol v1 and records a safe original-event trust snapshot before secret
  materialization
- lease/writeback requires `repository_id`, `repository_owner_id` when
  present, `repository_visibility`, `workflow_ref`, `workflow_sha`,
  `job_workflow_ref` and `job_workflow_sha` for reusable workflows,
  `run_id`, `run_attempt`, `event_name`, `actor`, `actor_id` when present,
  `runner_environment`, and `jti` replay protection
- optional claims are handled as versioned capability bits: missing claims
  may block rotating OAuth or fall back to a clearly documented safer check,
  but they never silently widen trust
- maintainer/admin re-runs, `workflow_dispatch`, merge queue, scheduled
  runs, and reusable workflow callers bind to the original event/ref trust
  snapshot and cannot upgrade an originally untrusted fork, Dependabot,
  public, actor-blocked, or unresolved-ref event into secret-backed mode
- if GitHub changes claim shape, claim availability, `sub` templates,
  reusable workflow claim behavior, or runner environment values, the
  compatibility registry blocks rotating OAuth before secret restore
- raw OIDC JWTs and raw claims are never persisted; only allowlisted,
  normalized safe claim fields and hash prefixes are stored for audit,
  support, dedupe, replay protection, and incident response

26. **Local setup pairing, anti-confusion, and completion-state gate**

- rotating OAuth setup uses a dedicated setup session protocol, not the
  legacy static `/install/codex` redirect, raw `main` seed script, or generic
  provider-secret confirmation form
- the dashboard command, installer manifest, setup session, GitHub App
  installation, repository id, provider instance id, secret name, release
  channel, installer digest, and workflow schema version are bound into one
  signed setup intent before any local auth file is read
- the installer prints the resolved target and requires local confirmation
  when the shell is interactive; in non-interactive mode it requires an
  exact dashboard-issued setup intent and refuses inferred repo/org targets
- setup completion is single-use and idempotent by setup intent id, local
  generation hash, GitHub secret metadata, and provider instance; it cannot
  mark a different repo/provider configured
- setup state distinguishes `created`, `download_verified`,
  `auth_validated_locally`, `secret_write_started`, `secret_write_confirmed`,
  `completion_recorded`, `seeded_unconfirmed`, `expired`, `cancelled`, and
  `replayed`
- setup session tokens, dashboard command URLs, pairing codes, QR codes, and
  local callback ports never grant access to plaintext auth, GitHub secret
  values, writeback, lease acquisition, repo code, or support exports

27. **Persistence model, state machine, and migration invariant gate**

- rotating OAuth introduces additive Prisma tables with explicit ownership,
  unique constraints, foreign keys, CAS update predicates, and state
  transition rules; it does not overload legacy `ProviderSetupState`
- every setup, lease, writeback, generation, compatibility decision, account
  session group, and health event has exactly one canonical writer and a
  documented reconciliation path
- latest confirmed generation can advance only inside a transaction that
  validates provider instance, setup/writeback intent, lease ownership,
  previous generation, GitHub secret metadata, and idempotency key
- migrations are additive and reversible without deleting or rewriting
  legacy static rows; rollback disables rotating mode through auth mode,
  workflow schema, and compatibility registry, not through destructive data
  edits
- support/dashboard reads use safe projection views and cannot join back to
  plaintext, ciphertext bodies, raw claims, raw logs, or token-like material
- backfills are metadata-only, bounded, resumable, and never infer trust from
  `CODEX_AUTH_JSON`, GitHub `updated_at`, raw repository names, or old health
  reports alone

28. **Workflow provenance, template digest, and runtime attestation gate**

- every rotating OAuth workflow generated by ReviewRouter carries a
  ReviewRouter-owned schema marker, template digest, action/proxy/Codex
  versions, release channel, feature-scope, secret name, expected workflow
  path, setup intent id, and setup generation marker
- secret restore is allowed only after a no-secret runtime preflight compares
  OIDC `workflow_ref`/`workflow_sha`, `job_workflow_ref`/`job_workflow_sha`
  where applicable, recorded provisioning template digest, provider auth
  mode, action ref/SHA, workflow schema, secret name, runtime protocol, and
  compatibility decision as one attested tuple
- PR-controlled changes to `.github/workflows/**`, setup branch drift,
  manual workflow edits, YAML syntax changes, or missing markers map to
  `workflow_schema_mismatch` or `workflow_drift_detected`, never to static
  fallback or best-effort legacy execution
- a merged setup PR is not treated as configured until a trusted run from
  the expected default ref proves the schema marker, template digest, and
  runtime attestation tuple
- reusable workflow callers pin or advertise the exact trusted
  `job_workflow_ref`/`job_workflow_sha` according to release-channel policy;
  moving tags are allowed only when the compatibility registry explicitly
  accepts that channel
- workflow template merge uses structured YAML AST or a bounded patcher with
  conflict diagnostics; broad string replacement cannot silently rewrite
  user workflow content

29. **OIDC v2 capability, subject-template, and protocol-separation gate**

- rotating OAuth uses a distinct OIDC validator and action-session type from
  legacy protocol v1; it cannot call the existing protocol v1 workflow-ref
  allowlist and then add secret restore as an afterthought
- mandatory claim availability is verified in a no-secret diagnostic run for
  direct and reusable workflows before any repository can enable rotating
  OAuth; missing `repository_visibility`, `workflow_sha`,
  `runner_environment`, `jti`, or applicable `job_workflow_sha` blocks the
  provider as `oidc_claim_contract_unsupported`
- GitHub OIDC subject templates that include `repository_id` and
  `job_workflow_ref` are treated as hardening and diagnostics; v1 does not
  require customers to mutate org OIDC templates, but it must never accept a
  repository-name-only or default-audience trust contract
- moving `main`/`v1` reusable refs accepted by legacy protocol v1 are not
  automatically trusted for secret restore; rotating OAuth requires the
  resolved SHA to pass release-channel compatibility policy
- OIDC verification has explicit JWKS/key-rotation, outage, `kid`, clock
  skew, audience-array, replay, issuer, and claim-shape failure states that
  fail before secret restore and do not trigger Codex reconnect guidance
- no route, session token, health report, or support view can mix protocol v1
  metadata-only action sessions with protocol v2 secret-bearing sessions

30. **GitHub public-key provenance, sealed-box envelope, and writeback proof gate**

- plaintext `auth.json` never leaves the runner during setup or refresh;
  ReviewRouter SaaS must not supply the encryption public key, receive
  plaintext, receive decrypted bytes, or receive a reversible envelope
- the runner obtains the GitHub Actions repository public key from GitHub
  using a one-shot helper capability or direct local `gh` setup path, binds
  `key_id`, public-key hash, owner, repo, repository id, installation id,
  secret name, API version, and response shape before encryption, and rejects
  SaaS-provided or mismatched keys
- encryption uses the documented GitHub Actions secret sealed-box contract;
  ciphertext is base64, size-bounded, hash-bound, and tied to the same
  public-key response that produced `key_id`
- SaaS writeback accepts only `encrypted_value`, `key_id`, ciphertext hash,
  public-key hash, generation hashes, lease id, idempotency key, and safe
  GitHub metadata; any plaintext-looking field is rejected before business
  logic and before telemetry
- latest confirmed generation advances only after durable writeback intent,
  GitHub PUT `201`/`204` proof, repository/secret metadata binding, and a DB
  transaction; GitHub `updated_at`, secret existence, or dashboard manual
  confirmation can never confirm rotating auth
- stale public keys, key substitution attempts, lost PUT responses,
  duplicate idempotency keys, ciphertext/key mismatch, manual secret edits,
  and App permission changes all map to explicit safe states before another
  refresh can start

31. **GitHub App permission epoch, installation approval, and token-scope gate**

- desired App permission profile, accepted installation permissions,
  selected-repository membership, and minted installation-token scope are
  four separate facts with separate versions; changing the App manifest is
  not proof that a repository can write back an Actions secret
- rotating OAuth can acquire a lease only when the provider is bound to the
  expected App id, installation id, account id, repository id,
  permission profile, required permission hash, accepted permission hash,
  selected-repository hash, token permission hash, and token repository
  scope for the same permission epoch
- `setup_on_update`, installation callbacks, webhooks, dashboard sync, and
  manual refresh buttons are notification/sync inputs only; they cannot
  activate rotating OAuth until a lease preflight verifies an explicitly
  scoped installation token for the target repository
- existing installations that still have `Secrets: read` remain legacy
  static or `permission_required`; ReviewRouter must not fall back to a PAT,
  workflow `GITHUB_TOKEN`, or workflow-held token with `Secrets: write`
- helper/writeback installation tokens are minted server-side with explicit
  `repository_ids` and explicit `permissions`; token responses are validated
  and tokens are treated as opaque bearer values with no prefix/length
  assumptions
- permission removal, selected-repository removal, App suspension,
  uninstall, org policy block, owner transfer, token-scope mismatch, or App
  id mismatch immediately increments the permission epoch and blocks new
  leases before secret restore
- if a separate high-trust writeback App is introduced later, provider state
  must bind to that App id and installation id explicitly; standard and
  high-trust installations cannot be mixed for one rotating provider

32. **GitHub webhook inbox, ordering, and reconciliation gate**

- signed webhooks are early signals, not the canonical source of truth for
  secret restore; every lease preflight still revalidates installation,
  repository visibility, selected-repository membership, and permission
  epoch through GitHub API before `REVIEWROUTER_CODEX_AUTH_JSON` is exposed
- webhook HTTP handling verifies `X-Hub-Signature-256` against the raw body,
  records a safe inbox row with delivery id, event/action, installation id,
  repository id when present, payload hash, normalized event hash, and
  status, then returns a 2xx response quickly without doing slow GitHub API
  reconciliation inline
- webhook processing is idempotent by `X-GitHub-Delivery`; duplicate
  delivery with the same payload hash is a no-op, while duplicate delivery
  with a different payload hash is suspicious and cannot mutate provider
  state
- GitHub may deliver webhooks late, throttled, or out of order; destructive
  states such as App uninstall, selected-repo removal, permission removal,
  public visibility, and repository transfer may suspend immediately, but
  any transition back to `active` requires fresh GitHub API reconciliation
- stale `created`, `unsuspended`, repository-added, or permission-accepted
  events cannot override a newer local suspension, permission epoch, or repo
  transfer marker unless their projection version and source-of-truth check
  prove they are current
- webhook worker failure, dead-letter, replay, malformed payload, signature
  failure, payload-size anomaly, or delivery backlog maps to `sync_stale` or
  `policy_blocked` style diagnostics, not Codex reconnect guidance
- raw webhook payloads are not stored by default; support views expose only
  safe normalized metadata, payload hashes, delivery ids, status, retry
  counts, and reconciliation timestamps

33. **GitHub Actions debug, summary, log-archive, and artifact-retention gate**

- rotating OAuth must treat GitHub Actions logs, runner diagnostic logs, job
  summaries, annotations, environment files, step outputs, artifacts, cache,
  and downloaded artifacts as separate persistence channels, not as one
  generic "logs" bucket
- the secret-backed job blocks or degrades before secret restore when
  `ACTIONS_STEP_DEBUG`, `ACTIONS_RUNNER_DEBUG`, `runner.debug`, shell xtrace,
  or ReviewRouter debug modes are enabled, unless an internal canary mode
  has proven the exact workflow/action version with sentinel secrets
- masking is defense-in-depth only: all token values and token substrings are
  registered before any untrusted output, but correctness cannot depend on
  GitHub automatically redacting structured `auth.json`, debug logs, job
  summaries, artifacts, or annotations
- generated workflows use safe wrapper helpers for warnings/errors/summaries
  and never let raw model output, upstream error bodies, shell stdout/stderr,
  prompt text, diff text, or tool output write workflow commands,
  annotations, `$GITHUB_OUTPUT`, `$GITHUB_ENV`, `$GITHUB_STATE`, or
  `$GITHUB_STEP_SUMMARY`
- sanitized artifacts are uploaded with fixed names, explicit allowlisted
  files, explicit minimal `retention-days`, digest/hash validation, and no
  workspace-wide globs; comment jobs download only the expected artifact by
  name and verify the ReviewRouter schema before posting
- workflow log/archive retention is treated as customer-controlled and may
  be 90-400 days depending on repository/org policy; no plaintext auth or
  token-like sentinel may appear even if long retention, debug rerun, or log
  archive download is enabled
- tests must fetch workflow logs, runner diagnostic logs when enabled,
  summaries, annotations, artifact manifests, and downloaded artifact
  contents from disposable runs and prove sentinel values are absent

34. **Reusable workflow caller/callee secret contract gate**

- rotating OAuth reusable workflows must use explicit `workflow_call`
  secrets and explicit caller `jobs.<job_id>.secrets` mapping. `secrets:
inherit` is forbidden for secret-backed Codex OAuth because it can pass
  unrelated repository, organization, or environment secrets into the called
  workflow
- the caller job must declare minimal `permissions` for the reusable call.
  The called workflow can only maintain or reduce `GITHUB_TOKEN`
  permissions, so missing caller permissions must fail during setup/preflight
  rather than being "fixed" by the reusable workflow
- the called reusable workflow must not define `environment:` in the
  secret-backed job; environment secrets can shadow caller-provided secrets
  and have different approval/materialization timing
- OIDC v2 must bind both caller identity (`workflow_ref`, `workflow_sha`,
  repo id, event/ref/run) and called workflow identity (`job_workflow_ref`,
  `job_workflow_sha` where available). A trusted caller path cannot call an
  untrusted reusable workflow ref and still restore secrets
- reusable workflow refs are exact-SHA in strict/enterprise mode and exact
  release tags or allowlisted moving channels only after compatibility
  resolution records the resolved SHA; branch refs such as `main` are not
  production secret-restore evidence
- reusable workflow nesting is disabled for rotating OAuth v1 unless every
  hop has explicit secret mapping, permission narrowing, and OIDC
  `job_workflow_ref` evidence; workflow outputs cannot carry review
  payloads or secret-adjacent material back to the caller
- reusable workflow access-policy failures, missing caller permissions,
  `secrets: inherit`, missing required `workflow_call` secret declarations,
  or missing called-workflow OIDC claims map to setup/runtime policy
  blockers before auth restore, not Codex reconnect guidance

35. **Encrypted writeback payload custody, replay, and rollback gate**

- GitHub `encrypted_value` is not plaintext, but it is still credential
  update material: anyone who can write it through the ReviewRouter GitHub
  App can replace the repository secret with that ciphertext
- raw `encrypted_value` is discarded after successful GitHub PUT and DB
  confirmation; it may be retained only in an encrypted short-TTL retry queue
  for unresolved writeback ambiguity, never in support exports, logs,
  analytics, traces, long-lived tables, or dashboard payloads
- the retry queue is bound to provider instance id, repository id,
  installation id, secret name, lease id, run id, run attempt, previous
  generation, new generation hash, ciphertext hash, `key_id`, public-key
  hash, permission epoch, and workflow schema version
- a duplicate idempotency key can retry only the exact same ciphertext hash,
  generation hash, public-key hash, `key_id`, lease, run, attempt, repo,
  installation, secret name, and permission epoch; any mismatch is a
  security invariant failure
- stale ciphertext cannot be replayed after a newer confirmed generation,
  external secret drift, local reseed, provider deletion, permission loss,
  repository transfer, public visibility change, or lease expiry
- encrypted retry payloads are envelope-encrypted with KMS key id, have
  explicit `retention_until`, and are purged on expiry, incident response,
  provider deletion, permission epoch change, or reconciliation resolution
- support/admin tooling can show only hash prefixes, byte buckets, key ids,
  state, TTL, and safe reason codes; it cannot read, copy, replay, export,
  or manually submit raw ciphertext bodies

36. **GitHub runner implicit credential and child-process environment gate**

- `id-token: write` is a job-level capability: GitHub exposes OIDC request
  URL/token material to the runner, and any trusted action code in that job
  can request an OIDC JWT for the configured audience
- `GITHUB_TOKEN` is also job-scoped and available through workflow contexts;
  step ordering is not a production boundary for keeping it away from a
  model-driven subprocess
- Codex runtime and any repo/model-controlled subprocess must be launched
  with an explicit allowlisted environment, not inherited `process.env` or
  the default shell environment
- the denylist must include `GITHUB_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_URL`,
  `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_RUNTIME_TOKEN`, artifact/cache
  service tokens and URLs, `GITHUB_ENV`, `GITHUB_OUTPUT`, `GITHUB_STATE`,
  `GITHUB_STEP_SUMMARY`, `GITHUB_PATH`, `INPUT_*`, package registry tokens,
  helper tokens, writeback/session tokens, proxy admin material, HMAC
  material, and raw auth variables
- the allowlist should be minimal and deterministic: fixed `PATH`, locale,
  temp/home paths, `CODEX_HOME`, the nonce-prefixed data-plane proxy URL,
  and bounded ReviewRouter safe config only
- after OIDC exchange and before Codex starts, the action must clear or
  shadow credential-bearing environment variables for all child processes
  and must not run third-party actions, package scripts, repo scripts, or
  model-influenced shell commands in the same credential-bearing process
- disposable runner tests must launch a malicious env-dumping review and
  prove token variable names, file-command paths, and request URLs are absent
  from Codex env, args, files, artifacts, logs, summaries, and proxy env

37. **Workflow provisioning state taxonomy and repair gate**

- workflow/setup states are first-class provider states, not generic
  `suspended`, `needs_reconnect`, or `policy_blocked` fallbacks
- `setup_pr_open`, `workflow_pending_verification`,
  `workflow_drift_detected`, `workflow_schema_mismatch`,
  `workflow_attestation_incomplete`, `rotating_protocol_unsupported`, and
  `control_plane_version_unsupported` all block secret restore before auth
  materialization and must not ask the user to reconnect Codex
- each workflow state has one repair path: merge setup PR, run trusted
  default-ref attestation, open repair PR, upgrade action/proxy/workflow
  schema, or wait for compatible control plane
- dashboard, repo health, final policy check, support export, and audit
  events must preserve the exact workflow state and safe blocker reason
- state transitions from workflow repair states to `active` require a fresh
  no-secret runtime attestation from a trusted default ref; setup PR status,
  YAML comments, GitHub `updated_at`, or support/admin confirmation are not
  enough
- rollback PRs move rotating providers to an inert workflow-disabled state
  without deleting `REVIEWROUTER_CODEX_AUTH_JSON`, corrupting legacy
  `CODEX_AUTH_JSON`, or marking Codex auth invalid

38. **One-shot secret restore grant and preflight-to-bootstrap TOCTOU gate**

- no-secret preflight must return a short-lived one-shot restore grant, not
  a broad `allow_secret_restore` boolean that can be replayed by later steps
- the grant is bound to repository id, installation id, provider instance,
  secret name, workflow schema, action/proxy versions, workflow ref/SHA,
  reusable workflow ref/SHA where applicable, event, run id, run attempt,
  runner environment, permission epoch, compatibility decision id, and
  feature scope
- the bootstrap step that receives `REVIEWROUTER_CODEX_AUTH_JSON` must call
  lease acquire with that grant before parsing or proxying auth bytes; grant
  mismatch, expiry, reuse, or missing lease binding fails closed before
  refresh
- the grant TTL is short, single-use, and narrower than the lease TTL; it is
  invalidated by permission epoch change, provider state change, workflow
  repair state, emergency compatibility block, repository visibility change,
  App uninstall/removal, selected-repository removal, or account/provider
  policy change
- generated workflow must not store the grant in job outputs, summaries,
  artifacts, cache, `$GITHUB_ENV`, `$GITHUB_OUTPUT`, `$GITHUB_STATE`, or
  model-visible env; the grant can exist only in trusted action memory or a
  private temp file under the trusted control root
- a manually edited workflow can still cause GitHub to materialize a secret
  by referencing it, so the pinned bootstrap action must detect missing or
  invalid grant, avoid logging auth, zeroize temp material, and report
  `secret_restore_grant_invalid` or `workflow_schema_mismatch`

39. **Linux process, procfs, and sibling-process isolation gate**

- "no tokens in env" is not sufficient: Codex/tool subprocesses run on the
  same GitHub-hosted runner and may try `ps`, `/proc/*/environ`,
  `/proc/*/cmdline`, `/proc/*/fd`, `/proc/net/*`, `lsof`, core dumps, temp
  dirs, or inherited file descriptors
- before OAuth secret restore, the runtime must prove the selected runner
  image, action wrapper, proxy launcher, and Codex invocation prevent
  model-controlled subprocesses from reading proxy env, args, private FDs,
  control-root files, auth bootstrap material, helper tokens, HMAC material,
  writeback tokens, OIDC request env, and server-info files
- proxy and bootstrap launchers must use explicit env allowlists, `FD_CLOEXEC`
  or equivalent close-on-exec discipline, private `0700` control dirs,
  `0600` files, restrictive `umask`, no sensitive argv, no shell history,
  no core dumps, and Linux non-dumpable/ptrace hardening where available
- if GitHub runner image, kernel, container mode, or Codex CLI sandbox makes
  this boundary unverifiable, rotating no-VPS mode maps to
  `process_isolation_unsupported` before secret restore; do not proceed with
  a best-effort warning
- tests must run malicious same-user probes for process list, procfs env,
  cmdline, FDs, temp dirs, socket discovery, core dump attempts, and direct
  localhost calls on every supported runner image and pinned Codex CLI tuple

40. **SaaS writeback authority and installation-token minting boundary gate**

- ReviewRouter SaaS never stores plaintext Codex auth, but it does hold
  GitHub App private-key authority that can mint installation tokens and
  write repository Actions secrets; this is a separate high-blast-radius
  trust boundary
- installation-token minting must be a typed internal capability, not a
  generic GitHub client helper: each mint request names purpose
  `public_key_read` or `secret_writeback`, repository id, installation id,
  permission epoch, exact `repository_ids`, exact `permissions`, lease or
  writeback intent id, caller service, and operation TTL
- token issuer rejects omitted `repository_ids` or omitted `permissions`
  because GitHub would otherwise grant all installation repositories or all
  granted App permissions for that token
- only the writeback service can request `Secrets: write` installation
  tokens, only after durable writeback intent and active lease proof; public
  API routes, support tools, web dashboard actions, background sync workers,
  and webhook projectors cannot mint write tokens
- token values are never stored, logged, exported, sent to support, or
  returned to workflow steps; audit stores only safe HMAC token fingerprint,
  permission hash, repo scope hash, request purpose, TTL, issuer key id,
  caller id, and GitHub response status class
- GitHub App private-key access is isolated behind KMS/HSM or an equivalent
  signer service with key id, rotation window, emergency pause, and
  least-privilege deployment access; a compromised web/API worker must not
  automatically have private-key bytes
- any token issuer policy drift, overbroad token response, signer outage,
  key compromise suspicion, or unapproved caller maps to
  `writeback_authority_paused` before helper-token minting or secret
  writeback

41. **GitHub SDK token-cache and scope-isolation gate**

- the repo already uses `@octokit/app`, `app.getInstallationOctokit(...)`,
  and direct `POST /app/installations/{installation_id}/access_tokens`
  paths; rotating OAuth cannot inherit generic Octokit installation clients
  from dashboard, setup, repo-health, worker, or comment-posting code
- `@octokit/auth-app` caches installation tokens by default, and its factory
  path can share internal auth state; a cache key that misses purpose,
  repository id, permissions, permission epoch, API base URL, or issuer key
  can silently return a broader token to a narrower operation
- rotating helper/writeback tokens must either bypass SDK token caching or
  use an issuer-private cache keyed by App id, installation id, normalized
  repository ids, exact permission hash, purpose, permission epoch, issuer
  key id, GitHub API version/base URL, and compatibility tuple
- `secret_writeback` should default to no reusable cache; if production load
  later requires caching, it needs a separate risk review, short TTL safety
  margin, token fingerprint audit, and cache-poisoning tests before rollout
- cached tokens are revalidated against the original requested scope before
  use; cache hit with broader, narrower, missing, expired, wrong-purpose, or
  wrong-epoch scope maps to `writeback_authority_paused` before refresh
- tests must monkeypatch Octokit/app auth cache behavior, force broad-token
  and cross-purpose cache hits, and prove rotating paths never call generic
  `getInstallationOctokit(...)` helpers

42. **Customer account authorization, workspace-policy, and quota-ownership gate**

- Codex ChatGPT auth in CI is an advanced account-auth pattern, not a normal
  API-key automation path; setup must make the customer explicitly approve
  using their ChatGPT/Codex account session for repository review automation
- before writing `REVIEWROUTER_CODEX_AUTH_JSON`, local setup must show and
  record a consent/policy version covering: GitHub-hosted runner execution,
  repository content sent to Codex under the connected ChatGPT account or
  workspace, subscription quota usage, workspace retention/RBAC/residency
  policy, optional maintenance refresh, and the no-plaintext-SaaS boundary
- consent records store only safe metadata: workspace id, repository id,
  provider instance id, setup actor GitHub id, account/workspace fingerprint
  hash, consent version, feature scope, auth mode, setup channel, timestamp,
  and policy document hash; they never store raw OpenAI account ids, emails,
  token claims, browser session ids, or auth bytes
- support/admin/dashboard cannot create, backdate, or force consent; missing
  or stale consent blocks setup/refresh as `account_authorization_required`
  until an authorized repository/workspace actor reruns local setup
- consent is invalidated by account replacement, workspace mismatch, public
  repo transition, feature-scope expansion beyond review-only, maintenance
  refresh enablement if not previously acknowledged, provider-mode switch,
  material retention/logging policy change, or enterprise policy revocation
- offboarding is explicit: if the setup user's ChatGPT account is disabled or
  leaves the customer's organization, recovery is an approved account
  replacement, not silent reuse of the old secret or a ReviewRouter-owned
  account

If any gate fails, keep the feature behind the internal flag and fall back to
the official self-hosted persistent `CODEX_HOME` path for users who need
automatic refresh immediately.

### Compatibility Registry and Auto-Disable

ReviewRouter needs a server-side compatibility registry for the moving parts:

```text
installer version
workflow schema version
ReviewRouter action/proxy version
Codex CLI version
Codex CLI package integrity / binary contract fixture
Codex auth.json schema version
custom provider config shape
Codex JSONL event schema and network egress fixture
OpenAI/Codex upstream auth shape
GitHub Actions runner image family
GitHub REST API version/header
GitHub API behavior needed for public key/writeback
ReviewRouter feature-scope compatibility for review/interaction/conflict/memory
```

Registry states:

```text
allowed
internal_only
deprecated
blocked
emergency_blocked
```

Auto-disable triggers:

- unexpected upstream 401/403 wave for a previously healthy version
- Codex CLI starts calling unapproved endpoints or requiring `/models`
- Codex CLI stops honoring custom provider `base_url` path prefix
- refresh response shape changes or refresh ambiguity spikes
- Codex auth cache schema changes, moves token fields, or introduces new
  token-bearing fields
- GitHub public-key/writeback behavior changes
- GitHub runner image changes break sandbox/process hardening
- environment-secret shadowing is detected in generated workflow
- sanitizer/logging sentinel appears in any telemetry sink
- quota-limited rate crosses a configured provider/org threshold
- an interaction, conflict-review, memory, or reusable-workflow path attempts to
  consume the rotating OAuth secret without the matching schema version
- a generated workflow introduces a third-party action, action post step,
  `$GITHUB_STATE` write, or package lifecycle script after secret restore
- GitHub App private key, action-session signing key, HMAC key, KMS key, or
  setup/writeback token signer is rotated or suspected compromised without a
  compatible active-key policy
- PR diff/list truncation, tool-output backpressure, or large-file handling
  exceeds configured safety limits
- pre-model secret redaction detects a high-confidence secret and the workflow
  cannot produce a safe redacted review packet
- redaction budget is exceeded, an unparseable file looks secret-bearing, or a
  new supported secret pattern cannot be classified by the pinned scanner

Behavior:

- `blocked` prevents new setup and workflow generation
- `emergency_blocked` prevents secret restore before proxy start
- existing GitHub secrets are not deleted automatically
- dashboard explains whether the user should wait, rerun setup, approve
  permissions, or switch to self-hosted persistent mode
- compatibility registry changes are audited as safe metadata and require
  release-owner approval for production broadening

### Release Channels and Mixed-Fleet Rollout

Local release documentation says production setup PRs normally use moving
major channel `@v1`, while exact `v1.0.x` tags are immutable conservative pins.
That is acceptable for the current action model, but rotating OAuth changes the
blast radius because the workflow handles a refreshable customer auth secret.

Rotating OAuth release references need stricter staging.

Rollout options:

1. **Exact-pin first, then promote to moving `v1` after soak**

   ```text
   🎯 9 / 10   🛡️ 9 / 10   🧠 6 / 10
   Approx changes: 300-800 LOC.
   ```

   New rotating setup PRs pin exact action/proxy/installer versions or full
   SHAs during beta and early GA. The compatibility registry decides which
   exact versions may restore secrets. `v1` becomes the rotating default only
   after canary metrics and rollback drills pass. Recommended.

2. **Use moving `v1` immediately, rely on compatibility registry**

   ```text
   🎯 7 / 10   🛡️ 6 / 10   🧠 4 / 10
   Approx changes: 150-400 LOC.
   ```

   Easier UX and matches current release docs, but a bad `v1` move affects every
   new secret-backed run that references `@v1`. The compatibility registry can
   block secret restore, but the workflow still pulls the bad action before it
   can ask SaaS.

3. **Never use moving channels for rotating OAuth**

   ```text
   🎯 8 / 10   🛡️ 9 / 10   🧠 7 / 10
   Approx changes: 600-1400 LOC.
   ```

   Strongest operational isolation, but customers need setup PR churn for every
   runtime upgrade. Good for enterprise strict mode, too heavy as the only
   default.

Recommendation:

Use option 1. Exact-pin first protects the first secret-backed release, while a
later `v1` default keeps normal UX after the runtime proves stable.

Fleet cohorts:

| Cohort             | Action ref             | Secret                         | Runtime protocol | Behavior                                     |
| ------------------ | ---------------------- | ------------------------------ | ---------------- | -------------------------------------------- |
| legacy static      | `@v1` or exact old tag | `CODEX_AUTH_JSON`              | v1               | manual refresh, no writeback                 |
| rotating internal  | exact tag/full SHA     | `REVIEWROUTER_CODEX_AUTH_JSON` | v2               | internal only, disposable repos              |
| rotating canary    | exact tag/full SHA     | `REVIEWROUTER_CODEX_AUTH_JSON` | v2               | selected customer repos, strict telemetry    |
| rotating GA exact  | exact tag/full SHA     | `REVIEWROUTER_CODEX_AUTH_JSON` | v2               | default for new setup before `v1` broadening |
| rotating GA moving | `@v1`                  | `REVIEWROUTER_CODEX_AUTH_JSON` | v2               | only after soak and rollback proof           |
| blocked/suspended  | any                    | secret unused                  | none             | no secret restore                            |

Rules:

- `v1` moving tag is not a capability by itself; registry state must still be
  `allowed` for the exact resolved action SHA, workflow schema, proxy version,
  Codex CLI version, and provider auth mode
- the generated workflow records both configured ref and resolved exact SHA
  when available
- compatibility preflight must send configured action ref, resolved action SHA,
  workflow ref/SHA, workflow schema, protocol version, and release channel
- a moving `v1` rollback must not change exact-pinned rotating repositories;
  they remain governed by compatibility registry entries for their exact
  versions
- emergency blocking a bad exact version stops secret restore for that version
  even if a workflow still references it
- if SaaS is rolled back but customer workflows are newer, preflight returns
  `control_plane_version_unsupported` before secret restore
- if customer workflow is older but SaaS is newer, SaaS returns
  `rotating_protocol_unsupported` or legacy static config according to selected
  auth mode
- installer must not "upgrade" an exact-pinned rotating repo to `@v1` without
  explicit user/admin consent or a configured stable-channel policy
- rollback PR disables rotating mode by changing provider auth mode/workflow
  schema, not by deleting secrets
- old exact versions must have a deprecation window and dashboard copy before
  they are blocked, unless an incident requires emergency block

Release-stage promotion criteria:

```text
internal_only -> canary:
  all required spikes pass with fake/disposable credentials
  no plaintext sentinel appears in logs/support paths
  installer and proxy artifacts verified

canary -> GA exact:
  minimum successful private repo runs across multiple orgs
  no unknown_auth_state above threshold
  no external_secret_drift false positives above threshold
  no comment idempotency/freshness incidents
  rollback drill completed without deleting secrets

GA exact -> GA moving v1:
  at least one fixed exact release after canary
  compatibility registry can block exact SHA before secret restore
  moving v1 rollback drill completed
  setup PR generator can keep exact pin for strict customers
```

Rollback matrix:

| Situation                                         | First action                                                                               | User action required                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| bad SaaS deploy, action ok                        | rollback SaaS deploy or disable feature flag                                               | none unless auth state changed           |
| bad action/proxy exact version before auth read   | block exact version in compatibility registry                                              | rerun after fixed release                |
| bad action/proxy after auth read possible         | emergency-block, mark affected providers `needs_reconnect` if plaintext exposure plausible | rerun setup with fresh dedicated login   |
| bad `v1` move                                     | emergency move `v1` or publish fixed release, plus registry block for bad exact SHA        | exact-pinned repos unaffected            |
| OpenAI upstream contract drift                    | emergency-block matching upstream compatibility entry                                      | wait or switch provider/self-hosted path |
| GitHub API/writeback drift                        | block writeback-capable versions before refresh                                            | rerun after fixed release                |
| accidental rotating rollout to legacy static repo | block workflow schema/auth mode tuple and report setup mismatch                            | setup PR repair                          |

Dashboard should show both product mode and release cohort:

```text
Codex subscription - static manual refresh
Codex subscription - auto-refresh canary exact v1.0.x
Codex subscription - auto-refresh stable exact v1.0.x
Codex subscription - auto-refresh stable v1
Codex subscription - auto-refresh blocked by version policy
```

## Goals

- Let users configure Codex subscription auth once from their local machine.
- Run reviews on GitHub-hosted runners, usually `ubuntu-latest`.
- Avoid requiring a user's computer, laptop, or VPS to stay online.
- Keep plaintext `auth.json`, refresh tokens, access tokens, and id tokens out
  of ReviewRouter SaaS.
- Avoid giving workflow code a long-lived token that can write GitHub secrets.
- Prevent concurrent jobs from invalidating each other's refresh token state.
- Detect when auth is unrecoverable and ask for reconnect clearly.
- Keep the old static secret mode working during migration.
- Give support enough safe metadata to debug without asking users to paste
  secrets or model output.

## Non-Goals

- Do not implement OpenAI Platform API-key mode here. API keys are already a
  separate provider path and the user explicitly prefers subscription auth.
- Do not store Codex OAuth plaintext in ReviewRouter databases, logs, queues,
  traces, caches, or object storage.
- Do not depend on a self-hosted runner for the default flow.
- Do not make public repositories run secret-backed Codex OAuth reviews.
- Do not use `pull_request_target` to access secrets for untrusted PR code.
- Do not use `workflow_run` as a privilege trampoline for untrusted PR code.
- Do not rely on a GitHub PAT with `Secrets: write` in customer workflows.
- Do not support org-wide shared rotating Codex OAuth secrets.
- Do not let arbitrary repo-controlled Codex config, rules, or plugins execute
  in the secret-backed job.
- Do not make ReviewRouter SaaS a plaintext token broker, even temporarily.
- Do not build a generic OAuth client against OpenAI token endpoints. Codex
  already owns the managed ChatGPT refresh behavior, and external direct OAuth
  semantics are not guaranteed as a public integration contract.

## External Facts

These facts are part of the plan's assumptions and should be revalidated before
implementation starts.

### OpenAI Codex Auth Facts

Source: [OpenAI Codex authentication](https://developers.openai.com/codex/auth)

- Codex supports ChatGPT sign-in and API-key sign-in.
- ChatGPT sign-in uses subscription access and follows the user's ChatGPT
  workspace permissions, RBAC, and enterprise retention/residency settings.
- Codex caches login details in `~/.codex/auth.json` or OS credential storage.
- For ChatGPT sessions, Codex refreshes tokens automatically during use before
  they expire.
- `cli_auth_credentials_store = "file"` stores credentials in
  `$CODEX_HOME/auth.json`.
- `codex login --device-auth` exists for headless flows, but server-side device
  code support must be enabled by the user or workspace admin.
- `CODEX_ACCESS_TOKEN` / `codex login --with-access-token` is not a universal
  Plus/Pro replacement for ChatGPT OAuth refresh. It is mainly useful where a
  valid Codex access token is already provided.
- ChatGPT Enterprise admins can allow Codex access tokens for trusted
  non-interactive local workflows. That is a separate provider path from
  Plus/Pro OAuth `auth.json` refresh.
- `auth.json` must be treated like a password.
- Device-code login is the preferred headless path when enabled in ChatGPT or
  workspace settings; if device code is not enabled, Codex falls back to normal
  browser login.
- If OS credential storage is used instead of file storage, copying an
  `auth.json` cache may not apply. ReviewRouter must create file-backed
  credentials in its own dedicated `CODEX_HOME` rather than scraping keychains.
- Codex can use `CODEX_CA_CERTIFICATE` or `SSL_CERT_FILE` for login and normal
  HTTPS requests in corporate TLS environments.

Plan implication: a ReviewRouter OAuth provider is tied not only to a GitHub
repository but also to a customer's ChatGPT account/workspace policy. If that
account loses entitlement, changes workspace, is revoked, or no longer matches
managed configuration, ReviewRouter should show account lifecycle guidance
instead of treating every failure as a generic refresh bug.

### OpenAI Codex CI/CD Facts

Source: [OpenAI Codex CI/CD auth](https://developers.openai.com/codex/auth/ci-cd-auth)

- OpenAI recommends API keys for most automation.
- The advanced account-auth pattern is:
  1. create `auth.json` once with `codex login`
  2. put the file on a trusted runner
  3. run Codex normally
  4. let Codex refresh the session
  5. persist the updated `auth.json` for the next run
- Self-hosted runner with persistent `CODEX_HOME` is the simplest fully
  automated setup.
- Ephemeral runners need restore -> run Codex -> persist updated file.
- Use one `auth.json` per runner or serialized workflow stream.
- Do not share the same file across concurrent jobs or multiple machines.
- Reseed if refresh token expired, was revoked, another job rotated it first,
  or old storage was restored.
- Do not use this `auth.json` workflow for public or open-source repositories.

Plan implication: the no-VPS proxy design is an engineering adaptation of
OpenAI's ephemeral-runner restore/run/persist pattern. It must be documented as
ReviewRouter's compatibility layer, not as an official OpenAI-supported proxy
API. If OpenAI ships a stable host-token or CI refresh contract later, this
plan should be re-evaluated before investing further.

### OpenAI Codex App Server Auth Facts

Source: [Codex app-server auth modes](https://developers.openai.com/codex/app-server#authentication-modes)

- `chatgpt` mode means Codex owns OAuth, persists tokens, and refreshes them.
- `chatgptAuthTokens` is experimental and intended for host apps that already
  own the user's ChatGPT auth lifecycle.
- `chatgptAuthTokens` requires the host app to refresh tokens when asked.

Conclusion: `chatgptAuthTokens` is not the first implementation target for
ReviewRouter's GitHub Action reviewer. It is a possible later architecture
spike, not the recommended production path.

### GitHub Actions Secrets Facts

Source: [GitHub REST Actions secrets](https://docs.github.com/en/rest/actions/secrets)
and [GitHub secrets reference](https://docs.github.com/en/actions/reference/security/secrets)
and [GitHub workflow commands](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions)

- GitHub secret values are set by sending `encrypted_value` and `key_id`.
- The value is encrypted with the repository or environment public key.
- The API can update repository, organization, and environment secrets.
- REST calls should send a pinned `X-GitHub-Api-Version` and compatibility
  tests should fail when GitHub changes the documented request/response shape.
- The repository public-key endpoint requires `Secrets` repository permission
  `read` for fine-grained tokens and GitHub App tokens.
- Updating repository secrets requires `Secrets` repository permission `write`.
- Fine-grained tokens and GitHub App installation tokens need appropriate
  secrets permissions.
- GitHub Actions secrets are limited to 48 KB.
- Repository and organization secrets are read when a workflow run is queued.
  Environment secrets are read when the job referencing the environment starts.
- GitHub warns that structured secret values are harder to redact reliably in
  logs. `auth.json` is structured JSON, so ReviewRouter must not rely only on
  GitHub's automatic masking.
- Secret names are case-insensitive, must be unique at their level, and lower
  scopes take precedence over higher scopes.
- Secret metadata APIs expose fields like `name`, `created_at`, `updated_at`,
  and visibility, but not plaintext value, ciphertext value, generation id, or
  compare-and-swap version.
- If the same secret name exists at organization, repository, and environment
  levels, the lower scope takes precedence. Environment secrets override
  repository secrets for jobs that reference that environment.

Plan implication: the runner can encrypt the updated `auth.json` locally using
GitHub's public key, then ReviewRouter SaaS can write only ciphertext to GitHub.
The workflow's default `GITHUB_TOKEN` should not be treated as sufficient for
public-key retrieval unless an implementation spike proves it. Prefer a
short-lived GitHub App token scoped to `Secrets: read` for public-key fetch.
That token must never be exposed to `codex exec`, and it must be minted only
after OIDC and lease validation.

Critical queue-time implication:

```text
run A queued with generation 1
run B queued with generation 1
run A refreshes and writes generation 2
run B starts later but still receives generation 1 from its queued secret context
```

Therefore lease acquisition must compare the restored auth generation hash
against ReviewRouter's last confirmed generation before the proxy is allowed to
refresh. If the queued secret is stale, the run must skip safely and ask for a
fresh rerun instead of attempting refresh with an old token.

Critical metadata implication:

GitHub `updated_at` is a drift signal, not a complete consistency primitive.
It can show that something changed, but it cannot prove which plaintext auth is
currently stored. ReviewRouter therefore needs its own durable writeback intent,
generation hash, idempotency key, ciphertext hash, and lease metadata. When
those records are missing or ambiguous, the safe recovery is local setup, not
guessing from GitHub metadata alone.

Critical environment implication:

A job-level `environment:` can silently switch `REVIEWROUTER_CODEX_AUTH_JSON`
from the repository secret to an environment secret with the same name. The
first production release should block `environment:` on secret-backed Codex jobs
unless a dedicated environment-secret design is implemented and tested.

Critical materialization implication:

GitHub workflow syntax does not allow secrets to be directly referenced in
`if:` conditionals. Presence checks should use derived booleans, not raw secret
values:

```yaml
env:
  REVIEWROUTER_CODEX_AUTH_PRESENT: ${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON != '' && '1' || '0' }}
```

Rules:

- job-level env may contain only presence booleans, never raw auth
- raw `REVIEWROUTER_CODEX_AUTH_JSON` appears only in the proxy bootstrap step
- canonical auth JSON should be compact single-line JSON with deterministic key
  order before storage, which reduces multiline shell and masking edge cases
- proxy bootstrap must feed the secret with `printf '%s'`, not `echo` or
  `printenv`, so no newline is appended or escaped
- the proxy should compute the restored generation hash from exact bytes it
  receives before parsing, then parse the same bytes
- base64 wrapping is not the default v1 format because it increases size
  against GitHub's 48 KB secret limit and creates a second auth-shape contract
- if base64 or another envelope is introduced later, it must use a new
  `auth_shape_version` and separate migration tests
- masking must register the full compact JSON plus individual token substrings
  before any command can print output
- logs must not print "secret present" checks by expanding raw secret
  expressions

This is deliberately boring. The auth state is already structured JSON, and
GitHub warns that structured secrets are harder to redact. ReviewRouter should
therefore reduce formatting variability and add its own redaction tests instead
of relying on GitHub masking alone.

### GitHub Secret Wire Format and Size Budget

Writeback has two different payloads that must be validated separately:

```text
plaintext auth JSON: canonical compact bytes restored by GitHub Actions
encrypted_value: base64 ciphertext produced locally from GitHub's public key
```

Rules:

- v1 accepts only compact canonical JSON plaintext, not base64, gzip, tar,
  multipart, or custom envelopes
- local setup and proxy writeback both measure raw UTF-8 byte length before
  encryption
- set a conservative ReviewRouter raw-auth limit below GitHub's 48 KB secret
  limit; start with 24 KB unless Spike AK proves a larger safe budget
- after LibSodium sealed-box encryption, validate `encrypted_value` as base64
  and enforce a separate API request-size budget before sending it to SaaS
- never log plaintext length together with account identifiers in a way that
  could become a fingerprint of a user's account payload; bucket lengths only
  for telemetry
- `key_id` must come from the same owner/repo public-key response used for
  encryption and must be bound into writeback intent metadata
- if GitHub returns a changed public key between preflight and writeback, retry
  once by refetching the public key and re-encrypting on the runner under the
  same active lease
- if canonical plaintext exceeds the safe budget, stop setup/writeback before
  refresh where possible and surface `auth_secret_too_large`, not reconnect
  loops
- if refresh already happened and the refreshed canonical auth exceeds the
  budget, mark `unknown_auth_state` because the old GitHub secret may no longer
  match upstream refresh state

Do not depend on GitHub accepting a near-limit encrypted payload. The documented
limit is about Actions secrets, but the REST payload also carries encryption
overhead and JSON/base64 expansion. The production contract should stay well
below the limit and prove the exact behavior in Spike AK.

### GitHub Public-Key Provenance and Writeback Proof

Official GitHub secret API facts:

- repository secret values are written through `encrypted_value` and `key_id`
- `encrypted_value` must be encrypted with LibSodium using the repository
  public key returned by GitHub
- create returns `201`; update returns `204`
- metadata APIs do not return plaintext, ciphertext, generation id, or a
  compare-and-set version

Plan implication:

The no-plaintext SaaS boundary is not just "send ciphertext to SaaS". It also
requires proving that the ciphertext was encrypted for GitHub's real repository
public key, not a key supplied by ReviewRouter SaaS or by a compromised setup
response.

Accepted public-key paths:

1. **Local setup path**
   - installer uses the user's local `gh` auth to fetch
     `GET /repos/{owner}/{repo}/actions/secrets/public-key`
   - installer validates owner/repo, repository id from `gh repo view`, API
     host, GitHub API version, key shape, and `key_id`
   - installer encrypts locally and sends only `encrypted_value` + `key_id` to
     GitHub or uses `gh secret set` when the spike proves byte preservation
   - setup completion sends only generation hash, key id, public-key hash, safe
     GitHub secret metadata, and setup intent id to ReviewRouter SaaS

2. **GitHub-hosted refresh path**
   - action performs OIDC v2 preflight before any secret restore
   - SaaS mints a short-lived helper capability scoped only to public-key fetch
     for the exact repository id, owner/repo, installation id, and secret name
   - runner fetches the public key from GitHub, not from ReviewRouter SaaS
   - helper capability expires after one successful public-key fetch or a short
     TTL and is never passed to Codex, the comment job, artifacts, cache, logs,
     or job summaries
   - proxy encrypts the refreshed canonical auth bytes locally, then sends only
     ciphertext and safe metadata to SaaS writeback

Rejected paths:

- SaaS returns a public key for the runner to encrypt against
- runner sends plaintext auth to SaaS for SaaS-side encryption
- workflow uses a PAT or `GITHUB_TOKEN` with `Secrets: write`
- dashboard manual confirmation marks rotating auth configured from secret
  metadata alone
- GitHub `updated_at` is treated as generation proof
- public key retrieved for repository A is accepted for repository B
- `key_id` is accepted without the public-key hash and owner/repo binding

Writeback proof state machine:

```text
writeback_intent_created
-> github_put_started
-> github_put_201_created | github_put_204_updated
-> generation_confirming
-> generation_confirmed
```

Crash and ambiguity handling:

- crash before durable intent: no generation can be confirmed
- crash after durable intent before PUT: retry with same idempotency key is
  safe if ciphertext hash and generation hash match
- crash after PUT before DB commit: state becomes `reconcile_required`
- lost SaaS response after PUT: retry is idempotent only with matching
  ciphertext hash, `key_id`, public-key hash, generation hash, lease id, and
  secret metadata
- GitHub PUT returns unexpected status/body: do not confirm generation
- GitHub public key changes before encryption: refetch and continue
- GitHub public key changes after encryption but before PUT: one same-lease
  re-encrypt retry, then `skipped_retryable` if refresh has not happened or
  `unknown_auth_state` if refresh already rotated upstream state
- GitHub secret metadata changes outside ReviewRouter intent:
  `external_secret_drift`

Current code migration note:

- `scripts/seed-codex-auth.sh` and provider setup copy are legacy static
  seeding paths for `CODEX_AUTH_JSON`
- dashboard verification currently checks only secret metadata and can upsert
  `ProviderSetupState` to `configured`
- rotating OAuth must not reuse that confirmation path; it needs setup intent,
  local generation hash, GitHub key provenance, writeback proof, and first
  trusted workflow attestation before `active`

Top 3 implementation options:

1. Runner-direct GitHub public-key fetch plus SaaS ciphertext-only writeback -
   🎯 9 / 10 🛡️ 9.7 / 10 🧠 8 / 10
   Approx changes: 900-2100 LOC.
   Recommended. This preserves the no-plaintext SaaS boundary and prevents
   ReviewRouter from substituting an encryption key.

2. SaaS fetches GitHub public key and sends it to runner -
   🎯 7 / 10 🛡️ 6.5 / 10 🧠 5 / 10
   Approx changes: 500-1200 LOC.
   Simpler, but a compromised SaaS/control-plane response can substitute a key
   and receive ciphertext that is not actually encrypted for GitHub.

3. SaaS receives plaintext and writes the secret itself -
   🎯 9 / 10 🛡️ 2 / 10 🧠 3 / 10
   Approx changes: 250-700 LOC.
   Functionally easy, but violates the core product requirement and should stay
   out of scope.

### GitHub App Token Facts

Source: [GitHub installation access token docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
and [GitHub App rate limits](https://docs.github.com/developers/apps/rate-limits-for-github-apps)
and [GitHub App private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)

- GitHub App installation access tokens can be narrowed to selected
  repositories and a subset of the App's granted permissions.
- If `permissions` is omitted, the installation token gets all granted App
  permissions, which is too broad for a runner helper token.
- Installation access tokens expire after one hour.
- GitHub App API calls are subject to primary and secondary rate limits.
- GitHub App private keys are used to mint App JWTs, which mint installation
  access tokens. GitHub supports multiple active private keys so keys can be
  rotated without downtime.
- GitHub has started rolling out a stateless installation token format in 2026. Treat installation tokens as opaque bearer tokens: do not validate by
  fixed length, old prefix, internal structure, or stable regex.
- Treat the GitHub App private key as a high-blast-radius production secret:
  compromise can mint installation tokens for every installation and repository
  permission granted to the App.

Plan implication: helper tokens must be minted with explicit repository and
permission subsets. SaaS writeback calls must classify rate-limit failures as
retryable only while the lease remains active.

### GitHub Workflow Runtime Facts

Source: [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[GitHub workflow commands](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions),
[GitHub debug logging](https://docs.github.com/en/actions/how-tos/monitor-workflows/enable-debug-logging),
[GitHub workflow artifacts](https://docs.github.com/actions/using-workflows/storing-workflow-data-as-artifacts),
and [GitHub Actions artifact/log retention](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization)

- `concurrency` can cancel or replace pending runs depending on the group and
  `cancel-in-progress` behavior.
- Only one pending run is kept for a concurrency group by default, and ordering
  should not be treated as a durable serialization guarantee for auth refresh.
- `timeout-minutes` can stop a job before cleanup or writeback steps complete.
- Workflow command parsing can be stopped and resumed with `::stop-commands::`.
- `::add-mask::` prevents future log display of a value, but anything printed
  before masking remains visible.
- A masked value is masked once per job and should be registered before it is
  used in any workflow command. Masking does not make it acceptable to pass
  plaintext auth through outputs, summaries, artifacts, or annotations.
- `$GITHUB_OUTPUT`, `$GITHUB_ENV`, `$GITHUB_STEP_SUMMARY`, annotations, and
  job summaries are separate output channels and must not receive secrets.
- `$GITHUB_STATE` can pass values from an action's main step to its `post`
  action and must be treated as another secret-sensitive channel.
- Job summaries are uploaded after a step completes. Later steps cannot modify
  a previous step's uploaded summary; deleting sensitive summary content may
  require deleting the workflow run.
- Runner diagnostic logging adds runner and worker process log files to the
  downloadable log archive when `ACTIONS_RUNNER_DEBUG=true`. Step debug logging
  increases step-log verbosity when `ACTIONS_STEP_DEBUG=true`.
- GitHub notes that users who can rerun workflows can enable runner diagnostic
  and step debug logging for the rerun. Rotating OAuth must treat debug reruns
  as a distinct leakage scenario, not only as a repository secret/variable.
- GitHub creates a per-job `GITHUB_TOKEN`, exposes it through the `github.token`
  context, and expires it when the job ends or reaches its maximum lifetime.
- The safest way to keep PR comment write permission away from Codex is to run
  Codex in a job without comment write permissions, then post comments in a
  separate downstream job that receives only a sanitized artifact.
- Workflow artifacts have their own retention controls, and `upload-artifact`
  supports `retention-days`. This retention is separate from ReviewRouter SaaS
  retention and must be explicitly bounded for sanitized artifacts.
- GitHub organization/repository policy can retain workflow logs and artifacts
  for long periods, including up to 400 days for private repositories. This
  cannot be the primary safety boundary for auth material.
- `upload-artifact` v4 exposes an artifact digest and `download-artifact`
  validates it on download. ReviewRouter should still bind artifacts to its own
  schema, run metadata, and artifact hash before posting comments.

Plan implication: workflow cancellation and timeout must be treated as normal
failure modes, not exceptional bugs. Masking must happen before any output, and
cleanup/writeback cannot depend only on `if: always()`. Step ordering alone is
not a strong boundary for `GITHUB_TOKEN`; job-level permission separation is.
Sanitized review artifacts should use explicit retention and fixed names, and
job outputs should not be used to transfer review payloads because outputs are
another log/control-plane channel with size limits and secret redaction
semantics outside ReviewRouter's schema control.

Debug and retention implication:

Debug logging and long log retention are normal GitHub features that customers
or rerun actors may enable. The safe design is to block or downgrade before
secret restore when debug is detected, then prove with disposable sentinel runs
that even forced debug logging cannot expose `auth.json`, token substrings,
proxy URLs, helper tokens, HMAC material, raw model output, or upstream bodies.
Do not depend on deleting logs or shortening retention after the fact.

### npm and Package Lifecycle Facts

Source: [npm install docs](https://docs.npmjs.com/cli-documentation/install)
and [npm provenance docs](https://docs.npmjs.com/generating-provenance-statements)

- npm install can run package lifecycle scripts such as `preinstall`,
  `install`, and `postinstall` unless script execution is disabled.
- `ignore-scripts` prevents implicit lifecycle scripts, but direct commands such
  as `npm run test` still run the requested script.
- npm provenance can link a package to where and how it was built, but npm's
  docs explicitly frame it as evidence for audit and trust decisions, not as a
  guarantee that package code is non-malicious.

Plan implication: Codex CLI, proxy, and ReviewRouter runtime dependencies must
be installed or verified before OAuth auth material is restored. If package
installation is unavoidable in a secret-backed job, it must be ReviewRouter
owned, pinned, integrity checked, run with lifecycle-script policy understood,
and completed before the secret enters the job. npm provenance is useful
release evidence, but the runtime still needs version pinning, digest checks,
and an allowlist.

### GitHub Release and Action Supply-Chain Facts

Source: [GitHub Actions secure use reference](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions),
[GitHub immutable releases](https://docs.github.com/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases),
and [GitHub artifact attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)

- GitHub recommends pinning third-party actions to a full-length commit SHA as
  the strongest immutable reference for Actions use.
- GitHub immutable releases lock release tags and release assets after
  publication, and can provide release attestation metadata where supported.
- GitHub artifact attestations can establish where and how an artifact was
  built, and consumers can verify attestations with `gh attestation verify`.
- These mechanisms prove artifact identity and provenance. They do not remove
  the need to trust ReviewRouter's release process, source review, signing-key
  control, and compatibility registry.

Plan implication: rotating OAuth setup must distinguish "verified artifact came
from the expected ReviewRouter release" from "artifact is safe by itself".
Production install commands should avoid mutable branches, mutable tags,
floating dist-tags, and redirect-to-raw-main behavior. The release pipeline
must produce a versioned manifest with digests, optional attestations, and a
compatibility-registry entry before any dashboard can recommend that version.

### GitHub Organization and App Policy Facts

Source: [GitHub Actions organization policies](https://docs.github.com/en/organizations/managing-organization-settings/disabling-or-limiting-github-actions-for-your-organization),
[GitHub workflow syntax permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[GitHub App permission changes](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app),
and [GitHub App installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

- Organization and repository owners can disable GitHub Actions entirely or
  limit which actions and reusable workflows are allowed.
- Allowed-action policies can block third-party actions, GitHub-owned actions,
  or unapproved pinned action references depending on org/enterprise settings.
- Workflow `GITHUB_TOKEN` default permissions are controlled by repository/org
  settings, but explicit job-level `permissions` should still be set.
- GitHub App permission changes on existing installations require approval by
  the account/user or organization owners. An app manager changing permissions
  is not enough for every organization unless they also have the right org
  ownership path.
- Customers may install the GitHub App on selected repositories. A repository
  can be present in SaaS configuration but absent from the selected-repository
  installation access.
- Installation access tokens can be narrowed to selected repositories and
  selected permissions. ReviewRouter must request exact repository ids and
  exact permissions for helper/writeback tokens, then verify the token response
  instead of assuming the App installation grant implies the token is narrow.

Plan implication: setup must include a repository/organization policy preflight
before promising that the no-VPS mode will work. Do not fall back to PATs or
broad App permissions when org policy blocks the generated workflow; surface a
specific `policy_blocked` or `permission_required` state.

### GitHub Schedule Facts

Source: [GitHub events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

- Scheduled workflows run only if the workflow file exists on the default
  branch.
- Scheduled workflows run on the latest commit on the default branch.
- Schedule events can be delayed under high GitHub Actions load, and queued jobs
  may be dropped under sufficiently high load.
- GitHub recommends avoiding the start of the hour for schedules.
- Scheduled workflows can depend on the actor that last modified the schedule;
  deprovisioned/suspended enterprise actors can stop scheduled workflows.

Plan implication: maintenance refresh is a best-effort reliability helper, not
a guarantee that Codex OAuth will stay alive forever. Provider health must
track last successful refresh/review and surface stale sessions before users
hit a PR failure.

### GitHub Required Check Facts

Source: [GitHub required status check troubleshooting](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
and [GitHub status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks)

- Required checks must pass on the latest commit SHA for a PR to merge.
- GitHub treats `success`, `skipped`, and `neutral` as successful check
  conclusions for required checks.
- If a workflow is skipped by path filters, branch filters, or commit-message
  skip directives, associated required checks can remain pending.
- A job skipped by a conditional reports success.
- If a required job depends on failed jobs, use `always()` with `needs` to
  ensure the required check reports a deterministic conclusion.
- Repositories using merge queue need the `merge_group` event for required
  checks to report in the queue.
- Required checks can be pinned to an expected GitHub App/source. Unexpected
  sources can block merging.
- GitHub's branch-protection REST endpoints require `Administration`
  repository permission, read for inspection and write for mutation.

Plan implication: ReviewRouter must not accidentally block merges forever with
pending checks, and it must not accidentally pass a required review when a
policy violation should block. The generated workflow needs an explicit final
policy-check job with stable naming and deterministic conclusions. Dashboard
branch-protection detection is best-effort unless the customer grants
Administration read, and ReviewRouter should not request Administration write
for this OAuth refresh feature.

### GitHub PR Comment Freshness Facts

Source: [GitHub issue comments REST API](https://docs.github.com/en/rest/issues/comments),
[GitHub pull request review comments REST API](https://docs.github.com/en/rest/pulls/comments),
and [GitHub pull request reviews REST API](https://docs.github.com/en/rest/pulls/reviews)

- Pull requests are also issues for timeline comment APIs, so PR summary
  comments can be listed, created, updated, and deleted through issue-comment
  endpoints with the right issue or pull-request permissions.
- Pull request review comments are attached to diff locations and include
  fields such as `commit_id`, `path`, `line`, `side`, and multi-line range
  fields.
- GitHub's review API warns that using a non-latest commit SHA can make review
  comments outdated when a later commit modifies the line.
- Required checks must pass on the latest commit SHA, but PR comments are
  timeline artifacts and can still be posted by an old workflow run unless the
  posting logic checks freshness itself.

Plan implication: the downstream comment job must not treat "the review job
finished" as enough proof to post. It must re-read the current PR head SHA,
validate it against the sanitized artifact, and apply idempotent comment
updates. Otherwise a slow or re-run workflow can publish stale advice on a newer
commit even though GitHub's required-check rules attach the run to the older
SHA.

### GitHub PR File and Diff Limit Facts

Source: [GitHub REST pull request files](https://docs.github.com/en/rest/pulls/pulls)
and [GitHub repository limits](https://docs.github.com/repositories/creating-and-managing-repositories/repository-limits)

- The REST endpoint for pull request files is paginated and documented with a
  maximum of 3000 files.
- GitHub repository/diff views have practical display limits for very large
  diffs, including per-file and total file limits.
- Large diffs, binary files, generated files, vendored directories, and file
  count limits can cause GitHub API/UI views to omit or truncate context.

Plan implication: ReviewRouter must not silently claim a complete review when
GitHub or local diff collection has truncated the file list or diff. The review
input collector needs explicit scope metadata such as total files seen, files
reviewed, files skipped, truncation reason, and safe user-facing copy.

### GitHub Actions Output Limit Facts

Source: [GitHub workflow commands](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions)
and [GitHub debug logging](https://docs.github.com/en/actions/how-tos/monitor-workflows/enabling-debug-logging)

- Job summaries and other command channels have size limits and are separate
  output surfaces from normal logs.
- Debug logging can increase the amount of runner diagnostic data available for
  a workflow run.
- Values printed before masking can remain visible.

Plan implication: ReviewRouter should cap and sanitize stdout/stderr before it
reaches logs, artifacts, summaries, memory endpoints, or SaaS. Debug logging is
not a safe mode for secret-backed jobs and should be detected or warned about
where possible.

### GitHub Secret Scanning Facts

Source: [GitHub push protection](https://docs.github.com/en/code-security/concepts/secret-security/about-push-protection),
[supported secret scanning patterns](https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns),
[secret scanning detection scope](https://docs.github.com/en/code-security/reference/secret-security/secret-scanning-detection-scope),
and [secret scanning push protection REST API](https://docs.github.com/en/rest/secret-scanning/push-protection)

- Push protection can block supported secrets in command-line pushes, GitHub UI
  commits, file uploads, REST API writes, and GitHub MCP interactions for
  public repositories.
- Repository-level push protection requires GitHub Secret Protection and is not
  a universal baseline for every private repository.
- GitHub documents supported generic, AI-detected, and provider-specific
  patterns, but support varies by repository type, product tier, pattern
  category, token age, validity checks, and push-protection capability.
- Push protection intentionally covers only a subset of identifiable patterns
  and can miss secrets when pushes are too large, patterns are unsupported, or
  required pattern pairs are split across files.
- Secret scanning alerts and push-protection pattern configuration can be
  inspected through GitHub APIs for customers that grant the relevant
  permissions, but that is optional metadata, not a security boundary.

Plan implication: ReviewRouter cannot rely on GitHub secret scanning as the
only protection before sending PR input to Codex/OpenAI. The runner must do its
own pre-model redaction pass over the bounded review packet. GitHub secret
scanning can be used as an optional signal to improve findings or dashboard
copy, but raw secret values must still be removed before model input, logs,
artifacts, memory, comments, or SaaS telemetry.

### OpenAI Responses Streaming Facts

Source: [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
and [OpenAI streaming guide](https://platform.openai.com/docs/guides/streaming-responses)

- Responses can stream server-sent events.
- Streaming failures can happen after the upstream request has already been
  accepted and partially produced output.
- Retrying a model request after the request body reached upstream can duplicate
  model work, cost, and tool-call side effects unless an idempotency contract is
  explicitly proven.

Plan implication: the proxy must distinguish auth refresh retry from model
request retry. It may retry after a clean pre-response 401 and successful
refresh, but it must not blindly replay a model request after the body may have
reached upstream or after a stream has started.

### GitHub OIDC Facts

Source: [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)

- Workflows need `id-token: write` to request OIDC tokens.
- The default OIDC `aud` is based on the repository owner, but actions can
  request a custom audience.
- OIDC tokens include claims such as repository, repository id, owner, workflow,
  `workflow_ref`, `job_workflow_ref`, run id, run attempt, actor, event name,
  runner environment, `job_workflow_sha`, `check_run_id`, and a token id where
  available.
- GitHub supports custom OIDC subject templates, including templates that
  require `repository_id` and `job_workflow_ref`. These are stronger than
  repository-name-only checks because repository names can change.

Plan implication: ReviewRouter can bind secret writeback and leases to a
specific repository, workflow, run, attempt, event, and trusted workflow file.
Use a ReviewRouter-specific custom audience, prefer repository id and
`job_workflow_ref` claim binding where available, and reject tokens minted for
a default or unrelated audience.

Custom OIDC subject templates are useful hardening, but they are not a
universal baseline because repositories and organizations may need to opt into
or approve template changes. The v1 control plane should validate the standard
claims it receives, expose a diagnostic when stronger subject templates are
available but not configured, and never accept a weaker repository-name-only
contract for secret writeback.

### GitHub Re-Run Facts

Source: [GitHub re-running workflows and jobs](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/re-running-workflows-and-jobs)

- People with write permission can re-run workflows and jobs.
- Re-run workflows use the privileges, `GITHUB_SHA`, and `GITHUB_REF` of the
  original triggering actor/event, not the person who clicked re-run.

Plan implication: a maintainer re-run must not convert an originally untrusted
fork/Dependabot/public event into a trusted secret-backed event. OIDC
validation must bind trust to the original event context and run attempt, not
just the human who initiated the re-run.

### GitHub OIDC Claim Contract and Event Trust Snapshot

Rotating OAuth should not reuse the existing action-control-plane OIDC contract
unchanged. Legacy action sessions can be metadata-only. Rotating OAuth can
restore and refresh a credential, so its OIDC requirements must be stricter and
versioned separately.

Local code reality checked on 2026-05-24:

- `packages/features/action-control-plane/src/domain/action-control-plane.ts`
  validates `repository_id`, repository name/owner, selected installation
  state, `workflow_ref`, `job_workflow_ref`, optional
  `runner_environment`, and `jti` replay where configured.
- The current schema does not model `repository_visibility`, `actor_id`,
  `triggering_actor`, `ref`, `ref_type`, `base_ref`, `head_ref`,
  `check_run_id`, or `environment`.
- `runner_environment` is currently rejected only for `repository_dispatch`
  when it is present and not `github-hosted`. Rotating OAuth should require
  `github-hosted` unless a separate self-hosted mode is selected.
- Current protocol v1 sessions store `actor`, `run_id`, `run_attempt`, and
  `event_name`, but they do not persist a normalized original-event trust
  snapshot that can be reused by lease, writeback, freshness, and incident
  logic.
- `trustedReviewRouterReusableWorkflowRefPattern` currently allows
  ReviewRouter reusable workflows at `refs/heads/main`, moving `v1` tags,
  semver-like `v1.x.y` tags, and full SHAs for protocol v1 metadata sessions.
  Rotating OAuth must not inherit that as sufficient proof for secret restore.
- `exchange-github-oidc-token.ts` currently returns `protocolVersion: 1` and
  signs a protocol v1 action session. Rotating OAuth needs a separate exchange
  path or explicit mode that cannot be consumed by legacy runtime-config
  clients, memory clients, interaction clients, or conflict-review clients.
- `consumeOidcReplayNonceIfConfigured` makes replay protection dependency
  optional for protocol v1. Rotating OAuth must make replay protection
  mandatory and fail closed if the replay store is unavailable.

Rotating OAuth must define an `OidcTrustSnapshotV1` before secret restore. It is
safe metadata only:

```text
issuer
audience
subject_shape_id
repository_id
repository_full_name_at_issue_time
repository_owner_id
repository_visibility
workflow_ref
workflow_sha
job_workflow_ref
job_workflow_sha
run_id
run_attempt
check_run_id
event_name
ref
ref_type
base_ref
head_ref
actor
actor_id
triggering_actor
runner_environment
jti_hash
issued_at
expires_at
original_trust_decision
trust_policy_version
claim_contract_version
missing_optional_claims
```

Only the normalized snapshot is stored. The raw JWT and raw claims object are
discarded after verification.

Claim policy:

- `repository_id` is the primary repository identity; repository full name is a
  display and drift-detection field.
- `repository_visibility` must be `private` or `internal` for rotating OAuth
  v1. Public repositories are blocked even if GitHub would otherwise expose
  secrets for a specific event.
- `runner_environment` must be `github-hosted` for the no-VPS mode. A
  self-hosted runner is a different provider/runtime mode with different
  persistence assumptions.
- `workflow_ref` must identify the caller workflow path and ref. It cannot be
  an arbitrary user-provided ref.
- `workflow_sha` must be recorded when present and used for drift diagnostics.
- `job_workflow_ref` and `job_workflow_sha` are mandatory for reusable
  workflow-based rotating OAuth. Tags are acceptable only after release-channel
  policy allows them; strict enterprise mode should pin full SHA.
- `run_attempt` is part of the lease identity and idempotency key. A new
  attempt cannot reuse stale queued secret material from an older attempt.
- `check_run_id` is not the sole trust root, but when present it helps bind
  diagnostics and idempotency to the current job.
- `actor_id` is preferred over actor login for audit stability. Actor login is
  display metadata.
- `triggering_actor` is informative for re-runs, not enough to upgrade trust.
  The original event/ref trust snapshot remains authoritative.
- `environment` is rejected unless rotating OAuth explicitly supports a
  GitHub Environment path. Environment secrets are blocked in v1 because they
  can shadow repository secrets and have different approval/read timing.

Top 3 implementation options:

1. Separate rotating OAuth OIDC contract plus `OidcTrustSnapshotV1` -
   🎯 9 / 10 🛡️ 9.5 / 10 🧠 7 / 10

   Approx changes: 500-1200 LOC.

   Recommended. This keeps legacy action protocol v1 stable while making the
   secret-bearing path strict, auditable, and drift-detectable.

2. Extend the existing action protocol v1 OIDC schema in place -
   🎯 7 / 10 🛡️ 7 / 10 🧠 5 / 10

   Approx changes: 250-700 LOC.

   Lower initial complexity, but it risks breaking existing interaction,
   memory, conflict, and legacy static paths that do not need the full rotating
   OAuth trust contract.

3. Trust only GitHub default `sub`, repository id, and workflow path -
   🎯 5.5 / 10 🛡️ 5.5 / 10 🧠 3 / 10

   Approx changes: 100-300 LOC.

   Too weak for writeback. It misses visibility, runner type, reusable workflow
   SHA, original event trust, manual dispatch resolution, and re-run ambiguity.

### OIDC v2 Migration and Claim Capability Contract

Rotating OAuth should be implemented as a new OIDC capability layer, not a
parameter on the existing protocol v1 exchange.

Protocol v1 is allowed to stay permissive enough for metadata-only runtime
config, memory, interaction, and conflict-review paths. Protocol v2 is the
secret-bearing path and must enforce a narrower contract before the workflow can
reference `REVIEWROUTER_CODEX_AUTH_JSON`.

Required v2 separation:

- new route or explicit exchange mode such as
  `/api/action/v2/codex-oauth/preflight`
- new session audience such as `reviewrouter-action-codex-oauth-v2`
- new session claim type that includes `providerInstanceId`,
  `providerAuthMode`, `workflowSchemaVersion`, `templateDigest`,
  `secretName`, `releaseChannel`, `runtimeProtocolVersion`, `workflowSha`,
  `jobWorkflowSha` when applicable, `jtiHash`, and
  `originalTrustDecision`
- legacy protocol v1 session tokens cannot call lease, public-key, proxy
  preflight, or writeback endpoints
- protocol v2 session tokens cannot call legacy runtime-config, memory, or
  conflict-posting endpoints unless those routes explicitly support the v2
  audience and redaction policy
- endpoint auth errors must distinguish `invalid_protocol_audience`,
  `rotating_protocol_required`, `legacy_protocol_not_secret_bearing`, and
  `oidc_claim_contract_unsupported`

Mandatory claim matrix for GitHub-hosted rotating OAuth v1:

| Claim                    | Direct workflow                      | Reusable workflow                        | Missing behavior                                                     |
| ------------------------ | ------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------- |
| `aud`                    | exact ReviewRouter rotating audience | exact ReviewRouter rotating audience     | block as `wrong_oidc_audience`                                       |
| `repository_id`          | required                             | required                                 | block as `oidc_claim_contract_unsupported`                           |
| `repository_visibility`  | required private/internal            | required private/internal                | block as `oidc_claim_contract_unsupported`                           |
| `workflow_ref`           | required caller workflow path/ref    | required caller workflow path/ref        | block as `oidc_claim_contract_unsupported`                           |
| `workflow_sha`           | required                             | required for caller workflow diagnostics | block direct secret restore                                          |
| `job_workflow_ref`       | absent or same as caller             | required trusted reusable workflow       | block reusable secret restore                                        |
| `job_workflow_sha`       | absent or diagnostic                 | required for strict/exact channels       | block strict channel; moving channel requires compatibility approval |
| `runner_environment`     | required `github-hosted`             | required `github-hosted`                 | block as unsupported no-VPS claim contract                           |
| `event_name`             | allowlisted                          | allowlisted                              | block                                                                |
| `run_id` / `run_attempt` | required                             | required                                 | block                                                                |
| `jti`                    | required replay key                  | required replay key                      | block until another replay primitive exists                          |
| `actor_id`               | preferred stable audit id            | preferred stable audit id                | allow only if fixture marks claim unavailable                        |
| `environment`            | rejected                             | rejected                                 | block unless a separate environment-secret design ships              |

Claim capability discovery:

1. Before beta, run a no-secret diagnostic workflow in a disposable private repo
   for direct caller, reusable caller by exact SHA, reusable caller by tag, PR,
   merge queue, and `workflow_dispatch`.
2. Store only normalized capability results and hash prefixes, never raw JWTs.
3. Build fixture JSON with expected claim presence, allowed values, and
   tolerated optional gaps.
4. Compatibility registry maps fixture version + GitHub runner image +
   workflow shape + release channel to `allowed`, `blocked`, or
   `diagnostic_only`.
5. If GitHub adds, removes, renames, or changes required claims, rotating OAuth
   blocks before secret restore with `oidc_claim_contract_unsupported`.

Subject-template policy:

- if an organization already uses a custom OIDC subject template, ReviewRouter
  validates the resulting `sub` against the recorded `subject_shape_id`
- if no custom subject template is configured, ReviewRouter still requires the
  standard individual claims above and emits a hardening diagnostic, not a
  setup failure
- if a customer opts into stronger OIDC subject templates, recommended keys are
  `repository_id`, `repository_visibility`, `context`, and
  `job_workflow_ref` where applicable
- subject-template changes after setup are drift; they require a no-secret
  diagnostic run before the provider can restore auth again
- `sub` is never the only trust root because it is customizable and can omit
  fields ReviewRouter needs for leases, drift, and support diagnostics

JWKS and verifier behavior:

- JWKS fetch/cache happens before secret restore
- unknown `kid`, signature failure, issuer mismatch, wrong audience, expired
  token, `nbf` in the future, excessive clock skew, or JWKS outage maps to a
  pre-secret OIDC failure
- a transient JWKS outage is retryable; it is not a Codex reconnect state
- replay store outage blocks rotating OAuth because the same OIDC token could
  otherwise acquire multiple action sessions
- audience arrays are accepted only if the rotating audience is the sole
  effective audience accepted by policy; mixed audiences block as
  `wrong_oidc_audience` to avoid confused-deputy ambiguity

Top 3 implementation options:

1. Separate OIDC v2 validator with claim capability registry - 🎯 9 / 10 🛡️ 9.5 / 10 🧠 7.5 / 10
   Approx changes: 700-1500 LOC.
   Recommended. It keeps legacy action behavior stable and gives rotating OAuth
   a precise fail-closed contract before secret restore.

2. Extend protocol v1 validator with a `secretBearing` flag - 🎯 7 / 10 🛡️ 7 / 10 🧠 5.5 / 10
   Approx changes: 350-900 LOC.
   Faster, but easy to accidentally let a protocol v1 token reach v2-only lease
   or writeback routes.

3. Require customer-managed custom subject templates everywhere - 🎯 6 / 10 🛡️ 8 / 10 🧠 6 / 10
   Approx changes: 500-1100 LOC plus customer/org setup burden.
   Strong trust primitive, but worse UX and hard to make universal for personal
   repos, selected-repo installs, and users without org admin rights.

### GitHub App Webhook Facts

Source: [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads),
[validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
[troubleshooting webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks),
and [GitHub App webhook delivery API](https://docs.github.com/en/rest/apps/webhooks)

- GitHub App webhook payloads contain an `installation` object.
- Installation repository changes include arrays such as
  `repositories_added` and `repositories_removed`.
- The `public` webhook event is sent when repository visibility changes from
  private to public and is available to GitHub Apps with metadata access.
- Webhook signatures should be verified with `X-Hub-Signature-256` against the
  original raw body before processing the delivery.
- Webhook deliveries include headers such as `X-GitHub-Delivery`,
  `X-GitHub-Event`, `X-GitHub-Hook-ID`, and `User-Agent`.
- GitHub can deliver webhooks out of order, after delay, or under throttling.
  The delivery id is a dedupe key, not a sequence number.
- GitHub expects a 2xx response within 10 seconds; slow processing should move
  to an asynchronous queue.
- Webhook payloads are capped by GitHub, but payload bodies still contain raw
  repository/sender/event data and should not be stored by default.
- GitHub App webhook deliveries can be inspected or redelivered through the App
  webhook delivery API with an App JWT, which is useful for diagnostics but
  must not become a support path that stores raw payloads.

Plan implication: ReviewRouter should not discover critical installation and
visibility changes only at review time. Signed GitHub App webhooks should move
providers to suspended states as soon as the App is removed, repo selection
changes, or repository visibility becomes public.

Current local code reality:

- `register-github-webhook-routes.ts` verifies `X-Hub-Signature-256` against a
  Fastify raw body, dedupes by `X-GitHub-Delivery`, stores a payload hash and a
  normalized event, and avoids storing the raw payload by default.
- `GitHubWebhookDelivery` has a unique `deliveryId`, status, payload hash, and
  normalized event metadata, but rotating OAuth needs explicit projection
  versioning, retry/dead-letter policy, and source-of-truth reconciliation
  before a stale webhook can re-enable secret restore.
- current installation webhook handling mutates installation state inline after
  `tryStartProcessing`; rotating OAuth should keep the HTTP path fast and move
  state projection/reconciliation to a worker or bounded background job.

Webhook processing rule:

```text
verify raw-body signature
-> record safe webhook inbox row
-> return 2xx quickly
-> process normalized event idempotently
-> reconcile with GitHub API before active/permission-positive transitions
-> allow lease preflight to remain the final guard
```

Top 3 webhook-state options:

1. Webhook inbox + async projection + lease-time reconciliation -
   🎯 9 / 10 🛡️ 9.5 / 10 🧠 7 / 10
   Approx changes: 500-1200 LOC.
   Recommended. It matches GitHub's delivery model, keeps the endpoint within
   the 10-second expectation, and prevents stale positive events from
   re-enabling secret restore.

2. Keep inline webhook mutation and rely on lease preflight -
   🎯 7.5 / 10 🛡️ 7 / 10 🧠 4 / 10
   Approx changes: 150-400 LOC.
   Cheaper, but dashboard state can lag or flap, and slow reconciliation can
   cause failed deliveries during GitHub delivery bursts.

3. Treat webhooks as advisory logs and poll GitHub aggressively -
   🎯 6.5 / 10 🛡️ 6.5 / 10 🧠 6 / 10
   Approx changes: 350-900 LOC.
   Simpler correctness model, but worse latency, more API pressure, and still
   needs lease-time source-of-truth checks.

### Fork PR Secret Facts

Source: [GitHub Actions secrets usage](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

- GitHub does not pass repository secrets to workflows triggered from forks,
  with limited exceptions such as `GITHUB_TOKEN`.
- Dependabot and fork-like contexts require explicit safe handling.

Plan implication: Codex OAuth mode must fail closed for fork PRs, public repos,
and unknown event shapes.

### Privileged Event Facts

Source: [GitHub events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

- GitHub explicitly warns that running untrusted code through
  `pull_request_target` can grant unintended access to secrets or write
  privileges.
- GitHub also warns that `workflow_run` can access secrets and write tokens even
  when the triggering workflow was less privileged, so untrusted artifacts or
  code from the first workflow can become a privilege escalation path.

Plan implication: secret-backed Codex OAuth must not use `pull_request_target`
or `workflow_run` for untrusted PR review. If a future architecture uses
`workflow_run`, it needs a separate artifact attestation design where the
privileged workflow never checks out or executes untrusted code with secrets.

### Codex Source Facts

Source: inspected `openai/codex` source on 2026-05-24.

- Canonical file auth storage is `$CODEX_HOME/auth.json`.
- `AuthDotJson` contains `auth_mode`, `tokens`, `last_refresh`, and optional
  `agent_identity`.
- `TokenData` includes `id_token`, `access_token`, `refresh_token`, and
  `account_id`.
- Managed ChatGPT auth proactively refreshes after roughly 8 days.
- Managed refresh uses the saved refresh token and writes the refreshed token
  bundle back to storage.
- Refresh failure classifications include expired, reused, invalidated, account
  mismatch, and unknown.
- `chatgptAuthTokens` stores an externally supplied access token in an
  ephemeral auth mode and expects the host to refresh.
- Custom providers can be configured with:
  - `base_url`
  - `wire_api = "responses"`
  - `requires_openai_auth = false`
  - no `env_key`
- If a custom provider does not require OpenAI auth and has no env key, Codex
  sends no auth headers.
- A static `model_catalog_json` avoids remote model discovery.
- Remote compaction is provider-gated. Avoid naming the custom provider
  `OpenAI` or `Azure`.
- Codex configuration keys and feature flags are a compatibility contract, not
  a stable ReviewRouter-owned API. Every pinned CLI upgrade must rerun the
  custom-provider, warmup-disable, web-search-disable, and tool-loop contract
  tests before rollout.

### Codex Action Source Facts

Source: inspected `openai/codex-action` and
`openai/codex-rs/responses-api-proxy` on 2026-05-24.

- `openai/codex-action` uses a local proxy and configures Codex with a custom
  model provider at `http://127.0.0.1:<port>/v1`.
- The action has `drop-sudo` and `unprivileged-user` safety strategies.
- The official proxy reads the API key from stdin, avoids keeping it in env,
  disables some process dump vectors, and injects Authorization upstream.
- The official proxy only supports API key shaped bearer values and cannot be
  reused directly for ChatGPT OAuth access tokens without a custom
  implementation.

Plan implication: ReviewRouter should build an OAuth-aware proxy that follows
the same isolation pattern rather than writing `auth.json` into the Codex
runtime `CODEX_HOME`.

## Current ReviewRouter Baseline

Existing architecture documents already establish these invariants:

- `ai-docs/architecture/05-security-and-secrets.md`
  says SaaS should not receive Codex OAuth plaintext.
- `ai-docs/architecture/20-secret-and-trust-model.md`
  identifies the dangerous boundary as PR code running in CI with secrets.
- `ai-docs/architecture/26-oidc-validation-and-action-session-security.md`
  defines GitHub OIDC as the trust root for action control-plane sessions.
- `ai-docs/decisions/010-action-control-plane-protocol.md`
  accepts metadata-only OIDC-authenticated action communication.
- `ai-docs/decisions/017-reusable-workflow-caller.md`
  confirms reusable workflows do not remove caller secrets or permission
  constraints, and OIDC must validate `job_workflow_ref`.
- `ai-docs/architecture/33-codex-secret-seeding.md`
  defines the old local seeding flow for `CODEX_AUTH_JSON`.

Current generated workflow behavior writes `CODEX_AUTH_JSON` directly into
`$CODEX_HOME/auth.json` on every GitHub-hosted run. That is compatible with a
static seed, but it loses refreshed tokens on ephemeral runners and cannot
support reliable long-lived automatic refresh.

### Current Code Integration Points

The implementation should connect to existing ReviewRouter modules rather than
creating a parallel workflow system.

Observed integration points:

- `packages/features/workflow-provisioning` currently renders explicit,
  reusable, interaction, required, and conflict-review workflow variants.
- `packages/features/action-control-plane` already owns GitHub OIDC exchange,
  action session tokens, allowed workflow refs, `job_workflow_ref` validation,
  and replay nonce storage.
- `packages/features/repo-health` already probes workflow content and provider
  health without returning raw workflow YAML to the UI.
- `ai-docs/decisions/017-reusable-workflow-caller.md` confirms reusable
  workflows still require explicit caller permissions and secret mapping.
- `ai-docs/architecture/05-security-and-secrets.md` already forbids
  ReviewRouter SaaS from receiving Codex OAuth plaintext.
- existing workflow templates still pass legacy `CODEX_AUTH_JSON` to the action
  runtime and interaction paths. Auto-refresh mode must not be marked active
  until these paths are versioned, disabled, or redesigned.

Implementation implication:

```text
workflow-provisioning becomes schema-version aware
action-control-plane gets stricter OAuth-refresh session types
repo-health learns auto-refresh provider states
legacy CODEX_AUTH_JSON remains static/manual mode
interaction/conflict/memory paths are explicitly out of auto-refresh v1 unless
  separate product-scope spikes pass
```

Do not add a second ad hoc workflow generator for the new mode. Extend the
existing generator with provider-mode capability markers, then make repo health
and OIDC validation agree on the same schema version.

### Current Code Migration Boundary

Local inspection on 2026-05-24 shows the existing repository is still built
around the legacy static secret path:

- `packages/features/review-providers/src/domain/provider-catalog.ts` exposes
  `codex_subscription_oauth` with setup kind `codex_oauth` and secret
  `CODEX_AUTH_JSON`
- `packages/features/provider-setup/src/domain/provider-secret-setup.ts`
  generates static seeding guidance that writes `CODEX_AUTH_JSON`, including
  organization selected/private/all scopes
- `packages/features/workflow-provisioning/src/domain/workflow-template.ts`
  restores `CODEX_AUTH_JSON` into `$CODEX_HOME/auth.json` inside the same
  workflow job that later runs ReviewRouter
- `packages/features/conflict-runtime` and interaction workflows still know
  about `CODEX_AUTH_JSON`
- `packages/platform/db/prisma/schema.prisma` has coarse
  `ProviderSetupState` and `ActionRunHealthReport` rows, but no rotating auth
  generation, lease, writeback intent, setup session, or compatibility records
- dashboard setup and policy copy still describes "Codex OAuth uses
  `CODEX_AUTH_JSON`" as the subscription path

Implementation consequence:

```text
legacy static Codex subscription auth != new rotating GitHub-hosted OAuth auth
```

The new feature must not be implemented by changing the meaning of the current
`codex_subscription_oauth` value in place. That would make old repositories
look auto-refreshing while their workflows still restore a static
`CODEX_AUTH_JSON` file.

Recommended naming decision:

1. **Add a new auth mode under the existing `codex` provider**

   ```text
   🎯 9 / 10   🛡️ 9 / 10   🧠 6 / 10
   Approx changes: 400-900 LOC for catalog/setup/workflow naming surface.
   ```

   Proposed names:

   ```text
   provider kind: codex
   legacy auth mode: codex_subscription_oauth
   new auth mode: codex_chatgpt_oauth_rotating
   legacy setup kind: codex_oauth
   new setup kind: codex_oauth_rotating
   legacy secret: CODEX_AUTH_JSON
   new rotating secret: REVIEWROUTER_CODEX_AUTH_JSON
   runtime mode: codex-oauth-proxy
   workflow schema: reviewrouter-codex-oauth-proxy-v1
   ```

   This is the recommended path. It keeps user-facing provider choice simple
   while giving code, tests, telemetry, and rollback a hard boundary.

2. **Keep one auth mode and add `authPersistence: static | rotating`**

   ```text
   🎯 7 / 10   🛡️ 6 / 10   🧠 5 / 10
   Approx changes: 250-650 LOC for the naming surface, but more hidden risk.
   ```

   This looks smaller, but it spreads conditional logic across provider setup,
   workflow generation, runtime config, repo health, dashboard labels, and
   support diagnostics. The dangerous failure mode is an old static repo being
   displayed as rotating because one branch missed the persistence flag.

3. **Create a separate provider kind**

   ```text
   🎯 6 / 10   🛡️ 7 / 10   🧠 7 / 10
   Approx changes: 700-1400 LOC for the naming surface.
   ```

   This creates a very clear boundary, but it makes Codex appear as two
   providers in product UI and config. That is unnecessarily disruptive unless
   future product scope proves static and rotating Codex need totally separate
   provider semantics.

Recommendation:

Use option 1. Add a distinct `ProviderAuthMode` and `ProviderSetupKind`, keep
the `codex` provider kind, and make every old/new path branch on that explicit
auth mode.

### Domain Migration Map

| Area                         | Current static behavior                                                            | Required rotating behavior                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review-providers` catalog   | `codex_subscription_oauth` maps to `CODEX_AUTH_JSON` and runtime `codex-oauth`     | add `codex_chatgpt_oauth_rotating` with `REVIEWROUTER_CODEX_AUTH_JSON`, runtime `codex-oauth-proxy`, rotating capability, and blocked feature-scope markers |
| provider setup guidance      | `codex_oauth` command runs static seeding and can offer org secrets                | add `codex_oauth_rotating` guidance with dedicated local `CODEX_HOME`, repo-scoped secret only, setup session, and zero-plaintext contract                  |
| workflow provisioning        | generated YAML restores `CODEX_AUTH_JSON` into `$CODEX_HOME/auth.json`             | new schema uses two-job review/comment split and materializes `REVIEWROUTER_CODEX_AUTH_JSON` only for proxy bootstrap                                       |
| action control plane         | OIDC sessions validate workflow refs and runtime config                            | add OAuth-refresh session type, lease claims, generation claims, writeback intent, and stricter workflow schema checks                                      |
| repo health                  | reports coarse provider setup and provider health                                  | detect static/manual, rotating/healthy, rotating/stale, permission blocked, external drift, unknown auth, and reconnect states                              |
| support diagnostics          | aggregates safe setup states                                                       | include only safe rotating metadata: auth mode, schema version, generation number/hash prefix, lease state, drift reason, and no ciphertext/plaintext       |
| dashboard setup              | copy says Codex OAuth uses `CODEX_AUTH_JSON`                                       | distinguish "Codex subscription - static secret, manual reseed" from "Codex subscription - auto-refresh GitHub-hosted" and "Codex Enterprise access token"  |
| review config                | default Codex auth mode is static subscription OAuth                               | do not silently change existing repo configs; new setup may default to rotating after feature flag and migration gates pass                                 |
| conflict/interaction/memory  | may see `CODEX_AUTH_JSON` or assume static runtime                                 | stay legacy-static or disabled for rotating v1 until separate feature-scope spikes pass                                                                     |
| Prisma data model            | `ProviderSetupState` and `ActionRunHealthReport` are not enough for rotating state | add additive rotating-auth tables, constraints, leases, writeback intents, compatibility versions, and health events                                        |
| `scripts/seed-codex-auth.sh` | legacy static `CODEX_AUTH_JSON` seed helper                                        | keep legacy path stable; create a separate pinned installer endpoint or explicit mode for rotating setup                                                    |

### Persistence Model and State Machine Invariants

Rotating OAuth should not be squeezed into `ProviderSetupState.state =
configured`. That row can remain the product-facing coarse setup flag, but the
secret-bearing runtime needs a separate persistence model with transactional
invariants.

Local code reality checked on 2026-05-24:

- `packages/platform/db/prisma/schema.prisma` has `ProviderSetupState` keyed by
  `(workspaceId, targetKey, providerKind, authMode)` and stores only coarse
  setup state.
- `ActionRunHealthReport` is keyed by `(repositoryId, githubRunId,
githubRunAttempt)` and is useful for health display, not as an auth ledger.
- `ReviewConfigurationVersion.providerAuthMode` is a string, but
  `packages/features/review-providers/src/domain/provider-catalog.ts` currently
  allowlists only `codex_subscription_oauth`, `codex_openai_api_key`,
  `claude_code_oauth`, and `openrouter_api_key`.
- `PrismaActionControlPlaneRepository.recordHealthReport` upserts health rows,
  which is correct for status, but not strong enough for lease/writeback
  compare-and-set.

Required additive tables or equivalent models:

```text
CodexRotatingProvider
CodexRotatingSetupIntent
CodexRotatingAuthGeneration
CodexRotatingLease
CodexRotatingWritebackIntent
CodexAccountSessionGroup
CodexRotatingCompatibilityDecision
CodexRotatingHealthEvent
CodexRotatingIncidentEvent
```

Canonical ownership:

| State/material                  | Canonical writer                          | Canonical reader                         | Must not infer from         |
| ------------------------------- | ----------------------------------------- | ---------------------------------------- | --------------------------- |
| provider identity and auth mode | dashboard config mutation                 | workflow preflight, repo health, support | secret existence            |
| setup intent state              | setup-intent service                      | installer, dashboard, support            | browser `FormData` alone    |
| latest confirmed generation     | setup completion or writeback transaction | lease acquire, repo health               | GitHub `updated_at` alone   |
| active lease                    | lease service                             | proxy bootstrap, writeback, reconciler   | action health report        |
| writeback intent                | proxy/writeback endpoint                  | reconciler, support safe view            | raw ciphertext body         |
| account session group           | setup completion and isolation probe      | lease service                            | raw account id/email        |
| compatibility decision          | compatibility service                     | workflow preflight, setup, proxy         | moving tag name alone       |
| health event                    | action runtime/proxy/SaaS classifier      | dashboard/support                        | provider setup coarse state |

Minimum constraints:

- one active rotating provider per `(workspace_id, repository_id,
provider_instance_id)`
- one latest confirmed generation per active rotating provider
- one active lease per provider or account-session group according to isolation
  policy
- unique lease id and unique `(provider_id, github_run_id,
github_run_attempt)` while lease is active
- unique writeback idempotency key; identical retry is allowed only when
  generation hash, ciphertext hash, `key_id`, lease id, and secret metadata
  match
- generation numbers are monotonic per provider and cannot skip over a pending
  `reconcile_required` state
- setup intent is single-use unless the exact same idempotent completion
  payload is replayed
- provider state transitions reject direct unsafe jumps such as
  `unknown_auth_state -> active`, `reconcile_required -> active`, and
  `external_secret_drift -> active`
- deleting or deselecting a repository suspends rotating providers before new
  leases can be acquired

Illustrative compare-and-set rule:

```text
advance_generation(provider_id, previous_generation_hash, new_generation_hash)
allowed only if:
  provider state is active or setup_in_progress
  no unresolved reconcile_required/external_secret_drift exists
  active lease or setup intent belongs to this provider
  previous_generation_hash equals latest confirmed generation
  writeback intent is durably recorded before GitHub PUT
  GitHub PUT success or setup secret write success is recorded
```

Migration rules:

- Add new auth mode and tables first, behind feature flags.
- Do not migrate existing `codex_subscription_oauth` rows into rotating mode.
- Backfill only safe metadata such as repository id, existing config version,
  setup coarse state, and detected legacy secret availability.
- Never read or derive plaintext from GitHub Actions secrets during migration.
- Do not create account-session groups from legacy static secrets.
- Rollback must leave new rows inert and readable; it must not drop tables in a
  production emergency rollback.
- All new Prisma migrations must include old-row fixtures and downgrade-safe
  tests for legacy static mode.

Top 3 implementation options:

1. Additive rotating-auth ledger tables with strict CAS services -
   🎯 9 / 10 🛡️ 9.5 / 10 🧠 8 / 10

   Approx changes: 700-1700 LOC.

   Recommended. It keeps the old product model stable while giving
   refresh/writeback a real ledger and transactional state machine.

2. Extend `ProviderSetupState` with JSON metadata and a lease table -
   🎯 6.5 / 10 🛡️ 6 / 10 🧠 5 / 10

   Approx changes: 350-900 LOC.

   Smaller migration, but too much critical state ends up in one flexible row.
   JSON makes constraints, CAS rules, support views, and rollback harder to
   prove.

3. Store rotating auth state only in health reports and latest dashboard state -
   🎯 4 / 10 🛡️ 3 / 10 🧠 3 / 10

   Approx changes: 150-400 LOC.

   Not acceptable. Health rows are observations, not ownership records. This
   would fail under retries, stale queued runs, split-brain writeback, and
   support/admin recovery.

Hard rules:

- do not reuse `CODEX_AUTH_JSON` for rotating mode
- do not write rotating auth into `$CODEX_HOME/auth.json` for the Codex runtime
- do not let org-level legacy static secret scopes become rotating v1 default
- do not display auto-refresh state for a repository whose workflow schema
  still restores `CODEX_AUTH_JSON`
- do not use the global `~/.codex/auth.json` file in place for rotating mode
- do not mutate legacy static dashboard copy until the new mode is available as
  a separate option

Dashboard labels should be explicit:

```text
Codex subscription - static secret, manual refresh
Codex subscription - auto-refresh on GitHub-hosted runners
Codex Enterprise - access token
```

Mixed-secret rules:

- if both `CODEX_AUTH_JSON` and `REVIEWROUTER_CODEX_AUTH_JSON` exist, the
  selected provider auth mode and workflow schema decide which one is used
- static mode ignores `REVIEWROUTER_CODEX_AUTH_JSON`
- rotating mode refuses to use `CODEX_AUTH_JSON`
- repo health reports `mixed_static_and_rotating_secrets` as informational
  unless the workflow/config selects the wrong one
- stale old static secrets are never deleted automatically

### Action Runtime Protocol Boundary

Local inspection on 2026-05-24 shows the current action control plane is built
around protocol v1:

- `ActionSessionClaims.protocolVersion` is `1`
- `ActionRuntimeConfigResponse.protocolVersion` is `1`
- action compatibility policy receives `protocolVersion`, `actionVersion`,
  provider kinds, and provider auth modes
- current workflow generation exports `REVIEWROUTER_ACTION_VERSION`,
  `REVIEWROUTER_RUNTIME_CONFIG_MODE`, and
  `REVIEWROUTER_STATIC_CONFIG_FALLBACK`
- current generated workflows restore legacy `CODEX_AUTH_JSON` before running
  the ReviewRouter action path

Rotating OAuth must not be added as a loose optional field to protocol v1. The
old protocol has no durable slot for:

- workflow schema version
- rotating secret name
- auth generation
- lease id and lease TTL
- proxy version
- feature-scope denies
- compatibility registry version
- writeback readiness result
- comment-job split identity

Implementation options:

1. **New protocol v2 for rotating OAuth**

   ```text
   🎯 9 / 10   🛡️ 9 / 10   🧠 6 / 10
   Approx changes: 500-1100 LOC.
   ```

   Add a separate protocol shape for rotating OAuth sessions and runtime config.
   Protocol v2 requires workflow schema `reviewrouter-codex-oauth-proxy-v1`,
   action/proxy versions that advertise rotating support, and a pre-secret
   compatibility handshake. Recommended.

2. **Extend protocol v1 with optional rotating fields**

   ```text
   🎯 6 / 10   🛡️ 5 / 10   🧠 4 / 10
   Approx changes: 250-700 LOC.
   ```

   Looks smaller, but old clients can ignore optional fields, static fallback
   can hide missing fields, and support diagnostics become ambiguous. Too easy
   to accidentally run rotating OAuth with old semantics.

3. **Keep protocol v1 and encode rotating state in env vars**

   ```text
   🎯 4 / 10   🛡️ 3 / 10   🧠 3 / 10
   Approx changes: 150-500 LOC.
   ```

   Fastest, but unsafe. It makes env shape the protocol, risks leaking
   control-plane material, and cannot reliably prevent old actions from
   accepting incompatible state.

Recommendation:

Use option 1. Protocol v2 is the smallest boundary that makes old actions and
static fallback fail closed.

Protocol v2 required tuple:

```text
provider auth mode: codex_chatgpt_oauth_rotating
provider setup kind: codex_oauth_rotating
workflow schema: reviewrouter-codex-oauth-proxy-v1
action protocol: 2
action version: allowlisted rotating-capable version or full SHA
proxy version: allowlisted for selected Codex CLI version
secret name: REVIEWROUTER_CODEX_AUTH_JSON
runtime config mode: oidc only
static fallback: disabled
review job permission shape: no PR/issue write
comment job permission shape: sanitized artifact only
feature scope: review allowed, interaction/conflict/memory denied or proven
```

No-secret compatibility handshake:

```text
workflow starts
-> checkout trusted workflow only
-> request OIDC with ReviewRouter audience
-> send action version, workflow schema, workflow ref/SHA, runtime protocol,
   provider auth mode, event, run id/attempt, and repository id to SaaS
-> SaaS validates compatibility registry, repo policy, selected installation,
   provider state, expected secret name, and feature scope
-> SaaS returns safe preflight result: allow_secret_restore | blocked reason
-> only then may the workflow enter the proxy bootstrap step that references
   REVIEWROUTER_CODEX_AUTH_JSON
```

### One-Shot Secret Restore Grant

The preflight-to-bootstrap boundary is a TOCTOU point. GitHub materializes a
secret when the workflow step references it, while ReviewRouter's trust
decision is made in an earlier no-secret step. The preflight response therefore
must not be a broad boolean.

Use a one-shot restore grant:

```text
restore_grant_id
provider_instance_id
repository_id
installation_id
secret_name
workflow_schema_version
workflow_ref
workflow_sha
job_workflow_ref nullable
job_workflow_sha nullable
action_ref
action_sha
proxy_version
codex_cli_version
event_name
run_id
run_attempt
runner_environment
permission_epoch
compatibility_decision_id
feature_scope
issued_at
expires_at
used_at nullable
safe_state_version
```

Rules:

- preflight returns `restore_grant_id` and safe bootstrap metadata only when all
  pre-secret checks pass
- the grant TTL should be minutes, not hours, and must be shorter than the
  lease TTL
- lease acquire consumes the grant exactly once and revalidates the same tuple
  plus current provider state, permission epoch, repository visibility,
  workflow repair state, compatibility decision, and selected-repository
  membership
- reuse of the same grant by another step, run, attempt, workflow, feature
  scope, or provider maps to `secret_restore_grant_invalid`
- expired grant before refresh maps to `skipped_retryable`; mismatched grant or
  manually edited workflow maps to `policy_blocked` or
  `workflow_schema_mismatch`; grant replay/multiple-use maps to
  `security_invariant_failed`
- a successful lease records the consumed grant id so support can explain the
  restore path without seeing auth or raw OIDC tokens
- if SaaS config changes between preflight and bootstrap, lease acquire must
  reject the stale grant even if the workflow step already received the GitHub
  secret
- bootstrap must compute the restored generation hash only after grant
  validation, and it must not print, persist, parse, or proxy auth bytes when
  the grant is invalid
- generated workflows must keep the grant out of `$GITHUB_OUTPUT`,
  `$GITHUB_ENV`, `$GITHUB_STATE`, `$GITHUB_STEP_SUMMARY`, job outputs,
  artifacts, cache, and Codex/model-visible env

Top 3 implementation options:

1. One-shot restore grant consumed by lease acquire - 🎯 9 / 10
   🛡️ 9.5 / 10 🧠 6.5 / 10

   Approx changes: 900-2200 LOC production-grade.

   Recommended. It gives the preflight decision a narrow lifetime and makes
   config drift between preflight and bootstrap detectable before refresh.

2. Preflight boolean plus lease revalidation only - 🎯 7 / 10
   🛡️ 7 / 10 🧠 4 / 10

   Approx changes: 300-800 LOC.

   This is simpler and already partly in the plan, but the preflight result is
   too broad for support/audit and does not clearly prove one intended
   bootstrap step consumed the decision.

3. Split into separate workflow run triggered after preflight - 🎯 6.5 / 10
   🛡️ 7.5 / 10 🧠 8 / 10

   Approx changes: 1500-3500 LOC plus GitHub UX complexity.

   It can reduce same-run TOCTOU, but adds queue-time secret staleness,
   required-check, artifact attestation, and rerun complexity. Not v1 default.

Rules:

- protocol v1 responses must never include rotating lease/writeback/proxy
  fields
- protocol v2 requests must reject missing workflow schema, action version,
  proxy version, provider auth mode, run attempt, workflow SHA, or OIDC audience
- rotating OAuth must reject `REVIEWROUTER_STATIC_CONFIG_FALLBACK=true`
- static fallback must remain available for legacy static providers only
- action runtime compatibility policy must check exact provider auth modes, not
  just provider kind `codex`
- old action refs should map to `rotating_protocol_unsupported` before secret
  restore
- if the compatibility endpoint is down, rotating mode fails as
  `skipped_retryable` before secret restore; it does not fall back to static
  config
- if a workflow is manually edited to pass the rotating secret to a v1 action,
  the runtime scanner and action startup must both fail closed
- if SaaS config changes between no-secret preflight and lease acquire, lease
  acquire revalidates the same tuple and rejects mismatch

Protocol v2 response must be safe metadata only. It may include:

```text
protocolVersion
workflowSchemaVersion
providerAuthMode
providerInstanceId
expectedSecretName
expectedProxyVersion
expectedCodexCliVersion
generationNumber
safeGenerationHash
leasePreflightState
budgetPolicy
featureScope
compatibilityDecisionId
safeErrorTaxonomyVersion
```

It must not include:

```text
auth JSON
token fields
encrypted_value
GitHub public key material unless separately verified
writeback session token before secret restore
HMAC key material
raw prompt/diff/model output
full local filesystem paths
support/debug payloads
```

## Problem Statement

The current flow treats `auth.json` as a static secret. For Codex ChatGPT OAuth,
that is the wrong persistence model.

The real persistence model is:

```text
auth.json is rotating state
```

When Codex refreshes successfully, it creates a newer token bundle. That newer
bundle must become the canonical value for the next run. If the next run
restores an older secret, the old refresh token may already be invalid.

The problem is not just "how do we run refresh". It is:

- who owns the canonical rotating state
- how to serialize refresh writers
- how to update GitHub Actions secrets without exposing `Secrets: write` to PR
  runtime
- how to prevent the model process from reading refresh tokens
- how to handle cancellation between token rotation and secret writeback
- how to tell the user when reconnect is truly required

## Why the Official Persistent Runner Path Is Not the Default

OpenAI's simplest fully automated path is a self-hosted GitHub Actions runner
with persistent `CODEX_HOME`.

That is reliable because:

- the same runner keeps `auth.json` on disk
- Codex refreshes the file in place
- later jobs reuse the refreshed file
- no GitHub secret writeback is needed

It is not the desired ReviewRouter default because:

- the user must keep a machine or VPS online
- laptop sleep breaks review execution
- runner setup is scary for non-infra users
- self-hosted runner security hardening becomes the user's responsibility
- multi-repo teams need runner routing, labels, and isolation

Self-hosted persistent `CODEX_HOME` should remain a power-user fallback, not
the default onboarding path.

## Why a Simple GitHub-Hosted Writeback Is Not Enough

A minimal ephemeral-runner implementation could do:

```text
restore CODEX_AUTH_JSON
write $CODEX_HOME/auth.json
run codex exec
gh secret set CODEX_AUTH_JSON < $CODEX_HOME/auth.json
```

This is not production-grade because:

- `codex exec` can see `auth.json`.
- Prompt injection may try to read files, env, process memory, or procfs.
- A workflow token capable of writing secrets would be inside the same job.
- `gh secret set` needs credentials stronger than the default `GITHUB_TOKEN`.
- A PAT with `Secrets: write` in the workflow is too powerful.
- Parallel jobs can rotate the same refresh token and invalidate each other.
- `if: always()` writeback can be skipped by hard cancellation.
- Accidentally using an org-wide `CODEX_AUTH_JSON` causes cross-repo refresh
  races.

The proxy design exists to reduce these risks.

## Target Architecture

### High-Level Flow

```mermaid
flowchart TD
  U["User local machine"] --> I["ReviewRouter Codex installer"]
  I --> L["Dedicated CODEX_HOME per repo"]
  L --> G["GitHub repo secret: REVIEWROUTER_CODEX_AUTH_JSON"]
  G --> W["GitHub-hosted ReviewRouter workflow"]
  W --> P["ReviewRouter OAuth proxy process"]
  W --> C["codex exec with empty CODEX_HOME"]
  C --> P
  P --> O["ChatGPT Codex backend"]
  P --> K["GitHub Actions public key"]
  P --> E["encrypted_value + key_id"]
  E --> S["ReviewRouter SaaS"]
  S --> A["GitHub App Secrets: write"]
  A --> G
```

### Trust Zones

```text
User local machine
  plaintext auth exists during installer login and local validation

GitHub Actions secret storage
  encrypted at rest by GitHub
  plaintext available only to trusted workflow steps

Trusted proxy process on GitHub-hosted runner
  plaintext auth exists in memory only
  owns refresh and writeback
  this is trusted customer CI code, not ReviewRouter SaaS storage

Codex runtime process
  no auth.json
  no CODEX_AUTH_JSON env
  no writeback token
  talks only to localhost provider

ReviewRouter SaaS
  no plaintext auth
  receives only encrypted_value + key_id
  owns lease and GitHub App write
```

Important boundary:

```text
GitHub Actions runner/proxy sees plaintext transiently.
ReviewRouter SaaS must not.
Codex model/runtime process should not.
```

This means the design is "no plaintext SaaS custody", not "no plaintext
anywhere". The runner must still be treated as trusted execution for the
repository owner.

### Sensitive Material Lifecycle Matrix

| Material                          | Created/read by                            | Allowed location                                                                            | Forbidden location                                                                               | End condition                                      |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Codex `auth.json` plaintext       | local installer, trusted proxy bootstrap   | local dedicated `CODEX_HOME`, GitHub secret plaintext inside one trusted step, proxy memory | ReviewRouter SaaS, Codex runtime `CODEX_HOME`, artifacts, cache, logs, job outputs, comment jobs | overwritten by refreshed secret or local reconnect |
| Access/refresh/id tokens          | Codex login/cache, proxy refresh           | proxy memory only after workflow restore                                                    | SaaS, Codex runtime env/files, process args, support exports                                     | refresh/writeback complete or provider disabled    |
| GitHub `encrypted_value`          | runner/proxy after public-key fetch        | writeback request body, optional encrypted short-TTL retry queue                            | logs, support UI, long-term analytics                                                            | GitHub PUT success or retry TTL expiry             |
| HMAC fingerprint material         | SaaS KMS, setup/proxy session              | one-run/setup scoped memory                                                                 | Codex runtime, logs, artifacts, browser telemetry                                                | lease/setup token expiry                           |
| GitHub public-key helper token    | SaaS after OIDC/lease validation           | proxy public-key fetch step only                                                            | Codex runtime, comment job, cache, artifacts                                                     | public-key fetch complete or token expiry          |
| ReviewRouter action session token | action-control-plane exchange              | action/proxy control-plane calls                                                            | model prompt, review artifact, logs                                                              | short TTL or run end                               |
| Proxy URL and nonce               | proxy bootstrap                            | Codex custom provider config, proxy server info file mode `0600`                            | SaaS telemetry, comments, artifacts, job summaries                                               | proxy shutdown                                     |
| Sanitized review artifact         | review job sanitizer                       | explicit artifact with minimal retention or SaaS sanitized artifact store                   | raw model output store, job outputs for large payloads                                           | comment posted or retention expiry                 |
| GitHub action post-state          | ReviewRouter-owned action only when needed | non-sensitive cleanup handles only                                                          | auth, tokens, proxy URL, nonce, HMAC material, helper tokens, raw review data                    | post step completes or job ends                    |
| Temporary files and sockets       | proxy bootstrap and runtime                | `$RUNNER_TEMP` with restrictive permissions                                                 | workspace, artifacts, cache, summaries, support exports                                          | best-effort cleanup plus job isolation             |

If a material crosses into a forbidden location, incident response follows the
material-specific class. Only plaintext Codex auth exposure automatically
forces reconnect; ciphertext/HMAC/helper-token leaks usually rotate
operational material instead.

### Required GitHub App Permission

Add or request:

```text
Secrets: write
```

Purpose:

- update repository Actions secret value after refresh
- future-only: update environment secret value if a separate environment-secret
  design is later approved. This is blocked for v1.

Non-purpose:

- do not read secret plaintext
- do not receive secret plaintext from workflow
- do not use this permission to manage unrelated secrets
- do not create custom required checks in v1. Use GitHub Actions job checks
  generated by the workflow unless a later checks/statuses design is approved.
- do not request `Administration: write` for branch protection mutation. If
  branch-protection diagnostics need API inspection later, request
  `Administration: read` as a separate optional permission with clear UX.

The App already needs secret metadata read in existing flows. This plan adds
write permission only for encrypted writeback.

Existing GitHub App installations will need an explicit permission upgrade.
Repositories that do not approve the new permission must remain in legacy
static mode or self-hosted persistent mode.

Current local code reality:

- `ai-docs/architecture/14-github-permission-matrix.md` documents
  `Secrets: read` and `Organization secrets: read` for the existing standard
  App profile
- `scripts/create-github-app-manifest.mjs` currently generates
  `secrets: "read"` and `organization_secrets: "read"`
- `scripts/check-github-app-manifest-smoke.mjs` currently asserts the same
  read-only secrets profile
- `scripts/check-github-app-readiness.mjs` currently requires
  `secrets: "read"` and `organization_secrets: "read"`
- the dashboard currently has permission-upgrade copy mainly around org/ruleset
  readiness; rotating secret writeback needs first-class permission-profile
  state instead of only generic readiness flags

Implementation implication:

- rotating OAuth cannot be enabled by only changing workflow YAML or provider
  setup copy
- the GitHub App manifest generator, hosted App registration, readiness smoke,
  dashboard permission copy, permission-update dialog, repo health states, and
  installation webhook handling all need an explicit `Secrets: write` rollout
- until that rollout is accepted by an installation, the repository remains
  `permission_required` or legacy static; no PAT workaround is allowed
- after rollout, ReviewRouter still has to verify actual installation
  permissions, selected-repository membership, and explicitly scoped
  installation-token permissions before every secret restore/writeback

### SaaS Writeback Authority and Installation-Token Issuance Boundary

The no-plaintext-SaaS promise does not remove ReviewRouter's GitHub writeback
power. If a SaaS component can mint an installation token with `Secrets: write`
and submit an old or attacker-chosen `encrypted_value`, it can overwrite the
repository secret without seeing plaintext.

Official GitHub App behavior that matters:

- if an installation-token request omits `repository_ids` or `repositories`,
  the token can access all repositories granted to that installation
- if an installation-token request omits `permissions`, the token receives all
  permissions granted to the App installation
- installation tokens are bearer values and must be treated as opaque

Required token-issuance model:

```text
token_issuance_intent_id
purpose: public_key_read | secret_writeback
caller_service
caller_route_class
repository_id
installation_id
provider_instance_id
permission_epoch
requested_repository_ids
requested_permissions
lease_id nullable
writeback_intent_id nullable
public_key_request_id nullable
compatibility_decision_id
issuer_key_id
issued_at
expires_at
token_fingerprint_hmac_prefix
github_response_permission_hash
github_response_repository_scope_hash
sdk_cache_policy
sdk_cache_key_hash nullable
status
safe_reason
```

Rules:

- no generic `getInstallationToken()` helper may exist in app/business routes;
  callers must go through a typed issuer method for `public_key_read` or
  `secret_writeback`
- `public_key_read` token issuance requires OIDC/session proof, active provider
  state, selected repository membership, permission epoch, and exact repository
  id
- `secret_writeback` token issuance additionally requires active lease,
  consumed restore grant where applicable, durable writeback intent, matching
  ciphertext/generation metadata, and current repository secret metadata
- every token request explicitly sends `repository_ids` and `permissions`;
  omission is a hard failure in code review, tests, and runtime validation
- token response permissions and repository scope are normalized and hashed;
  mismatch between requested and returned scope blocks the operation before
  exposing the token to any GitHub adapter
- tokens are held only in memory of the issuer/adapter path, never persisted,
  logged, exported, or returned to workflow steps
- support/admin tools can pause writeback authority, inspect safe issuance
  metadata, and trigger reconciliation; they cannot mint tokens or replay
  writeback
- webhook inbox, dashboard sync, repo health, and setup PR workers cannot mint
  `Secrets: write` tokens. They may request source-of-truth reads through
  separate read-only adapters where needed
- emergency block freezes new token issuance for a workspace, installation,
  permission epoch, App id, issuer key id, or compatibility tuple without
  deleting customer secrets
- GitHub App private-key signing should use KMS/HSM or a dedicated signer
  service. If raw key bytes must be loaded, access is limited to the token
  issuer deployment and covered by key-compromise runbooks
- rotating helper/writeback token paths must not use generic
  `App#getInstallationOctokit(...)` or shared Octokit auth caches; they call the
  typed issuer and receive a requester already bound to the exact token intent

SDK/auth-cache implications:

- current product code already has broad GitHub App integration surfaces:
  dashboard mutation helpers create generic installation Octokit clients, worker
  factories call `app.getInstallationOctokit(...)`, and comment token issuance
  uses direct installation-token POSTs
- those existing paths are acceptable for their current feature scopes only if
  rotating OAuth writeback does not reuse their clients, caches, or helper
  factories
- `public_key_read` may use a narrow issuer-private cache only when the cache key
  includes App id, installation id, sorted repository ids, exact permission hash,
  purpose, permission epoch, issuer key id, GitHub API version/base URL, and
  compatibility decision id
- `secret_writeback` defaults to no reusable SDK cache because token freshness is
  less important than avoiding cross-purpose authority reuse; every writeback
  token is tied to one durable writeback intent and lease
- if a cache is introduced later, cache value metadata must store only safe
  token fingerprint prefix, expiry, permission hash, repository-scope hash,
  issuer key id, and purpose; the token value remains in process memory only
- a cache hit is treated like a newly minted token: returned permissions,
  repository scope, expiration, issuer key id, purpose, and permission epoch are
  validated before the requester is constructed
- any mismatch or cache decoder failure blocks the operation before token use
  and maps to `writeback_authority_paused`

Top 3 implementation options:

1. Typed token issuer with purpose-specific capabilities and issuance ledger -
   🎯 9 / 10 🛡️ 9.5 / 10 🧠 7 / 10

   Approx changes: 1200-2800 LOC production-grade.

   Recommended. It directly matches GitHub's permission model and prevents
   random SaaS paths or shared SDK auth caches from becoming secret-writeback
   paths.

2. Shared GitHub App client wrapper with strict runtime assertions -
   🎯 7 / 10 🛡️ 7 / 10 🧠 5 / 10

   Approx changes: 500-1200 LOC.

   Better than ad hoc code, but weaker: one broad helper tends to grow new
   call sites, support/webhook paths can accidentally inherit writeback
   authority, and cache behavior is easy to under-specify.

3. Separate high-trust writeback GitHub App - 🎯 8 / 10 🛡️ 9 / 10
   🧠 8.5 / 10

   Approx changes: 1800-4200 LOC plus App install/UX migration.

   Strong isolation for enterprises, but worse default UX because customers
   approve and manage another App/profile. Keep as optional hardening if the
   single-App typed issuer does not satisfy enterprise risk requirements.

### GitHub App Permission Upgrade Flow

Required v1 App permissions for this mode:

```text
Metadata: read
Secrets: write
```

Possible optional permissions, not required for v1 default:

```text
Administration: read, only for branch-protection diagnostics
Pull requests / Issues: write, only if SaaS-side comment posting is selected
Contents / Workflows: write, only if SaaS-managed setup PR is selected later
```

Upgrade rules:

- existing installations without `Secrets: write` stay in legacy/static mode
  or `permission_required`
- selected-repository installations must include the target repository before
  setup can complete
- if the setup user is not allowed to approve App permission changes, show an
  owner/admin handoff URL and keep the provider paused
- do not ask users for PATs as a workaround
- do not broaden the App to all repositories when selected-repo access is
  sufficient
- after permission acceptance, SaaS must revalidate installation id,
  repository id membership, and actual granted permissions before allowing
  lease acquisition

Permission upgrade states:

```text
app_permission_missing
app_permission_pending_owner
app_repository_not_selected
app_permission_accepted_unverified
permission_required
active
```

`app_permission_accepted_unverified` should not restore secrets yet. It is a
short transition until SaaS verifies the installation token actually has the
required repository and `Secrets: write` permission.

### GitHub App Permission Epoch and Installation Approval

The permission model must track four independent facts:

1. Desired App permission profile in ReviewRouter configuration.
2. Accepted permission grant on the customer installation.
3. Selected-repository membership for the target repository.
4. Actual permissions and repositories on the minted installation token.

Required permission epoch record:

```text
permission_profile_id
app_id
installation_id
account_id
repository_id
required_permissions_hash
accepted_permissions_hash
selected_repository_hash
granted_token_permissions_hash
verified_at
source: webhook | manual_sync | lease_preflight
```

Rules:

- App manifest changed does not mean owner approved the permission change.
- GitHub `setup_on_update`, installation callbacks, and webhooks are only
  signals to resync. They are not activation proof by themselves.
- Lease preflight must verify actual installation permissions and selected-repo
  membership before restoring `REVIEWROUTER_CODEX_AUTH_JSON`.
- Helper/writeback tokens must be requested with explicit `repository_ids` and
  explicit `permissions`. A token request that omits either one is rejected by
  the adapter and tests because it may create a broader token than intended.
- Token response permissions and repository scope are validated and folded into
  the permission epoch. If GitHub response shape changes, compatibility blocks
  this mode before secret restore.
- SaaS may mint the server-side writeback token, but no workflow step may hold
  a token that can write arbitrary repository secrets.
- 403/404 before refresh maps to `permission_required`,
  `app_repository_not_selected`, or install/repo reconciliation. 403/404 after
  refresh starts maps to `unknown_auth_state` or `reconcile_required` according
  to the writeback phase.
- Permission downgrade, selected-repo removal, App suspension, uninstall,
  repository transfer, org policy block, or token-scope mismatch increments the
  permission epoch and blocks active/new leases before the next secret restore.
- If a separate high-trust writeback App is selected later, provider state must
  bind to its App id and installation id. The standard App installation cannot
  silently substitute for the high-trust writeback App.

Top 3 permission-profile options:

1. Upgrade the existing ReviewRouter GitHub App profile -
   🎯 9 / 10 🛡️ 9 / 10 🧠 7 / 10
   Approx changes: 700-1600 LOC.
   Recommended for default no-VPS UX. It keeps onboarding to one App install,
   but needs permission epoch state, explicit token scoping, owner/admin
   handoff, and strong dashboard copy that `Secrets: write` is used only for
   encrypted repository secret writeback.

2. Create a separate ReviewRouter Codex writeback GitHub App -
   🎯 7.5 / 10 🛡️ 8.5 / 10 🧠 8 / 10
   Approx changes: 1200-2600 LOC.
   Stronger trust separation for enterprises, but much worse setup UX and more
   installation/webhook/repo-sync/product-state duplication.

3. Ask user for a PAT or fine-grained token with secrets write -
   🎯 6 / 10 🛡️ 4 / 10 🧠 5 / 10
   Approx changes: 400-1000 LOC.
   Not recommended. It pushes a powerful long-lived credential into user
   workflows/support flows and weakens the central no-plaintext/no-PAT design.

### New Secret Name

Use a new secret:

```text
REVIEWROUTER_CODEX_AUTH_JSON
```

Do not rotate the legacy secret name in place during initial rollout:

```text
CODEX_AUTH_JSON
```

Reasoning:

- old workflows may still restore `CODEX_AUTH_JSON` as a static seed
- new workflows need stronger invariants and single-writer leases
- separating names makes migration and rollback clearer
- dashboard can distinguish static legacy mode from rotating mode

## Data Ownership

### Canonical State

For no-VPS OAuth mode, canonical state is:

```text
GitHub repository Actions secret REVIEWROUTER_CODEX_AUTH_JSON
```

The secret contains a complete Codex managed ChatGPT `auth.json` payload:

```json
{
  "auth_mode": "chatgpt",
  "tokens": {
    "id_token": "...",
    "access_token": "...",
    "refresh_token": "...",
    "account_id": "..."
  },
  "last_refresh": "..."
}
```

This value is not static. It is a rotating state file.

### Derived State

Derived safe metadata stored in ReviewRouter:

```text
repository id
secret name
auth mode configured
fingerprint_key_id
latest confirmed auth generation hash
last confirmed GitHub secret metadata
last sanitized review artifact hash
review artifact retention deadline
last successful lease run id
last successful writeback time
last known safe status
last failure category
workflow schema version
setup PR branch/ref and template version
setup confirmation state: seeded | seeded_unconfirmed | active
review check mode: advisory | required | strict
last policy check conclusion and safe reason
```

Forbidden in ReviewRouter:

```text
raw auth.json
access token
refresh token
id token
plaintext serialized token bundle
raw provider request bodies
raw Codex stderr if it may include prompts or secrets
```

### Generation Fingerprint Scheme

ReviewRouter needs to compare auth generations without seeing plaintext auth.
Use a stable keyed fingerprint per provider instance:

```text
generation_hash = HMAC-SHA256(fingerprint_key, canonical_auth_json_bytes)
```

Rules:

- `fingerprint_key` is generated by ReviewRouter SaaS and stored in KMS or
  equivalent server-side secret storage
- the key is not a Codex credential and cannot refresh or access ChatGPT
- the key is a signing capability for safe metadata and must still be treated
  as sensitive operational secret material
- SaaS sends only the active `fingerprint_key_id` and one-time HMAC key
  material to the trusted proxy/installer after OIDC, local setup pairing, or
  dashboard session validation
- runner computes `restored_generation_hash`, `previous_generation_hash`, and
  `new_generation_hash`
- SaaS stores only hashes and key ids, never auth bytes
- installer sends the initial `latest confirmed auth generation hash` to SaaS
  after it writes the GitHub secret, so the first workflow run can reject stale
  queued copies
- key rotation creates a new key id and requires one successful run to migrate
  the latest generation hash
- the HMAC key material must not be passed to `codex exec`, logs, job outputs,
  artifacts, or cache
- HMAC key material sent to a runner is one-run scoped, expires quickly, and is
  bound to repository id, provider instance id, run id, run attempt, and lease
  id where applicable
- SaaS must not accept a generation hash by itself as proof of a valid auth
  JSON. OIDC, active lease, provider state, secret metadata, and ciphertext
  shape checks are still required.

Canonical auth JSON:

- parse JSON before hashing
- preserve the fields needed by Codex, including known optional fields
- serialize with deterministic key order and no insignificant whitespace
- reject duplicate JSON object keys
- reject unexpected token-bearing fields until the schema is explicitly updated
- write canonical JSON to GitHub secret during setup and writeback

This avoids false mismatches caused by whitespace or key ordering while still
letting the server detect stale queued secrets and stale writebacks.

### Auth Shape Registry

Do not bake one guessed `auth.json` shape into every layer.

ReviewRouter needs a small auth-shape registry keyed by:

```text
auth_shape_version
Codex CLI version
auth_mode
credential storage mode
supported required fields
supported optional fields
token-bearing field allowlist
canonicalization function
safe fingerprint fields
```

Rules:

- canonical v1 input is `$CODEX_HOME/auth.json` with `auth_mode: "chatgpt"`
- file-backed storage is required for this provider path
- OS keychain-backed credentials must be converted by a dedicated local login
  into the ReviewRouter `CODEX_HOME`, not scraped from the user's global store
- account/app-server state files are not accepted as substitutes for root
  `auth.json` unless a new spike proves Codex treats them as canonical auth
  cache for `codex exec`
- unknown non-token optional fields may be preserved only after the registry
  marks them safe for the pinned Codex version
- unknown token-looking fields fail setup/writeback until the schema is
  explicitly added
- canonicalization must not strip fields that the pinned Codex CLI needs to
  refresh, even if ReviewRouter does not understand their business meaning
- registry changes require compatibility tests against a disposable
  `CODEX_HOME`, not just JSON fixtures
- a schema mismatch during setup maps to local setup failure; a mismatch inside
  a workflow before refresh maps to `needs_reconnect` or `skipped_retryable`
  depending on whether the auth was structurally invalid or just unsupported by
  the current ReviewRouter version

This keeps the old "which auth file is correct?" confusion out of production:
for this mode, the only canonical secret is the file-backed Codex
`auth.json`. Other account files can be useful diagnostics, but they are not
the rotating secret unless the registry and spikes explicitly promote them.

### External Secret Drift

If `REVIEWROUTER_CODEX_AUTH_JSON` changes outside the installer or ReviewRouter
writeback flow, ReviewRouter cannot read the plaintext and cannot compute a new
generation hash.

Drift detection:

```text
GitHub secret metadata updated_at/key_id differs from last confirmed metadata
and there is no matching setup session, lease writeback, or reconciliation
record
```

State:

```text
external_secret_drift
```

Rules:

- do not assume the changed secret is valid
- do not refresh from it
- do not overwrite it automatically
- ask the user to run the setup command again so the installer can validate
  auth JSON locally, rewrite the repo secret if needed, and report a fresh
  generation hash
- support can mark the provider suspended or needs reconnect, but cannot mark
  the external value trusted without a setup session

This avoids turning manual GitHub secret edits into invisible auth-state
corruption.

### Legacy State

Legacy state remains:

```text
CODEX_AUTH_JSON
```

Treat legacy as one of:

- static manual mode
- self-hosted runner bootstrap seed
- migration source

Do not assume legacy secret is safe for automatic refresh.

## User Experience

### Ideal Setup Command

The dashboard should show a single copy-paste command when the repository
provider is Codex subscription OAuth. Production command should verify a pinned
installer artifact before executing it. Illustrative shape:

```bash
RR_INSTALLER_VERSION=vX.Y.Z
RR_INSTALLER_SHA256=<dashboard-provided-sha256>
tmp="$(mktemp)"
curl -fsSL "https://reviewrouter.site/install/codex/${RR_INSTALLER_VERSION}" -o "$tmp"
printf '%s  %s\n' "$RR_INSTALLER_SHA256" "$tmp" | shasum -a 256 -c -
bash "$tmp" --repo owner/repo --mode github-hosted-refresh --confirm-write
```

Early internal spikes may use the shorter `curl | bash` form, but production
docs should prefer verified bootstrap. The exact flags can change, but the UX
contract should remain:

- run once locally
- installer explains what it will write
- installer validates GitHub access with `gh`
- installer pairs with ReviewRouter SaaS using a short-lived setup session
  token or dashboard code that cannot read or write Codex auth
- installer creates or reuses a dedicated ReviewRouter Codex session
- installer writes directly to GitHub secret
- installer reports only safe setup metadata, initial generation hash, and
  secret metadata to SaaS
- ReviewRouter SaaS never sees plaintext auth

The setup session token must:

- expire quickly
- bind to repository id, provider instance id, and current GitHub App
  installation
- bind to exact installer version, installer digest, release channel, workflow
  schema version, provider auth mode, and target secret name
- allow recording safe provider setup state only
- not grant access to repo code, Codex auth JSON, GitHub secret values, or
  writeback APIs
- be rejected if copied to another repository or provider instance

### Local Setup Pairing and Anti-Confusion Protocol

The production rotating setup must be a new paired setup protocol. It must not
inherit legacy static behaviors from the current `/install/codex` endpoint.

Local code reality checked on 2026-05-24:

- `apps/web/src/server/install-codex-redirect.ts` sends browser requests to
  `/getting-started#codex-oauth`, but curl/no-accept requests still redirect to
  the raw GitHub `main` `scripts/seed-codex-auth.sh` legacy script.
- `packages/features/provider-setup/src/domain/provider-secret-setup.ts`
  currently builds static `CODEX_AUTH_JSON` commands for
  `codex_subscription_oauth`, including org-scope variants.
- `scripts/seed-codex-auth.sh` validates a Codex auth file and writes
  `CODEX_AUTH_JSON` directly to GitHub through `gh`; it can infer a repository
  from git remotes or `gh repo view`.
- `apps/web/app/api/dashboard/provider-secret-setup/confirm/route.ts` accepts
  browser `FormData` and delegates to dashboard actions. The current confirm
  path verifies secret metadata, but it is not a paired rotating OAuth setup
  completion protocol.

Required production shape:

```text
dashboard creates setup intent
-> command contains setup_intent_id and one-time verifier/challenge
-> installer downloads exact artifact and verifies digest
-> installer resolves target repo id through GitHub, not only owner/repo text
-> installer compares resolved repo/provider/secret/version/digest to setup intent
-> installer creates or reuses dedicated file-backed CODEX_HOME
-> installer validates auth locally and computes safe fingerprints
-> installer writes REVIEWROUTER_CODEX_AUTH_JSON to exact repo secret
-> installer completes setup with safe metadata and idempotency key
-> SaaS records active or seeded_unconfirmed state
```

Setup intent fields:

```text
setup_intent_id
workspace_id
repository_id
github_repository_id
repository_full_name_at_issue_time
github_installation_id
provider_instance_id
provider_kind
provider_auth_mode
secret_name
secret_scope
installer_version
installer_digest
release_channel
workflow_schema_version
expected_setup_origin
created_by_actor_id
expires_at
challenge_hash
state
```

Installer completion fields:

```text
setup_intent_id
installer_version
installer_digest
resolved_github_repository_id
resolved_repository_full_name
provider_instance_id
secret_name
secret_scope
auth_shape_version
codex_cli_version
account_fingerprint_hash
generation_hash
github_secret_created_or_updated
github_secret_updated_at
idempotency_key
```

Forbidden completion fields:

```text
auth_json
access_token
refresh_token
id_token
device_code
user_code
verification_uri
verification_uri_complete
raw gh stdout
raw codex stdout
raw local paths
shell history
terminal transcript
browser callback query
```

Anti-confusion rules:

- Production rotating commands must use a versioned installer endpoint. The
  unversioned `/install/codex` endpoint can remain legacy static only.
- Non-interactive setup cannot infer target repo from local git remote or `gh`
  context. It must use the dashboard-issued setup intent and verify the resolved
  GitHub repository id.
- Interactive setup may display detected repo as a convenience, but must show
  the dashboard-bound repo id/full name and require explicit confirmation if
  they differ.
- Organization secrets are blocked for rotating OAuth v1. One rotating auth
  stream belongs to one repository/provider instance.
- A copied command from repo A to repo B must fail before reading auth.
- A replayed setup completion must either return the same idempotent result or
  mark the attempt `replayed`; it must not advance generation metadata with a
  different hash.
- If GitHub secret write succeeds but setup completion fails, dashboard shows
  `seeded_unconfirmed`. Rerun of the same setup intent may finish completion
  only while the intent is unexpired and the generation hash matches.
- If the setup intent expires after secret write but before completion, require
  a fresh setup intent and local revalidation. Do not infer trust from GitHub
  secret `updated_at` alone.
- A local callback or browser-based pairing UX may be added later, but the
  callback must only deliver the setup intent and verifier. It must never
  receive or forward plaintext auth.

Top 3 implementation options:

1. Signed setup intent plus one-time verifier and idempotent completion -
   🎯 9 / 10 🛡️ 9.5 / 10 🧠 7 / 10

   Approx changes: 500-1200 LOC.

   Recommended. It prevents repo/provider mixups, command replay, copied
   command confusion, and false configured states while keeping the UX to one
   command.

2. Dashboard-generated command with static flags and metadata-only confirm -
   🎯 7 / 10 🛡️ 6.5 / 10 🧠 4 / 10

   Approx changes: 250-700 LOC.

   Better than the current legacy static flow, but it relies too much on
   command text and does not create a strong replay/idempotency boundary.

3. Reuse legacy `/install/codex` plus existing provider-secret confirm -
   🎯 5 / 10 🛡️ 4 / 10 🧠 2 / 10

   Approx changes: 50-200 LOC.

   Not acceptable for rotating OAuth. It is fine for legacy static seeding, but
   it is too easy to confuse repo scope, secret name, auth mode, installer
   version, and setup state.

### Installer Zero-Plaintext Contract

The local installer is inside the user's trust boundary. It can read Codex
`auth.json`, but ReviewRouter SaaS still must not.

Installer network allowlist before `auth.json` is read:

```text
reviewrouter.site installer download
ReviewRouter setup-session metadata endpoint
GitHub API through gh / api.github.com
OpenAI/Codex login endpoints through codex login/smoke
package/checksum endpoints only before auth is materialized
```

Installer network allowlist after `auth.json` is read:

```text
GitHub public-key/secret write through gh
ReviewRouter setup completion endpoint with safe metadata only
OpenAI/Codex smoke through codex CLI
```

Forbidden after `auth.json` is read:

- POSTing raw auth JSON, token fields, raw auth file path, device auth code,
  browser callback data, shell history, terminal transcript, or command output
  to ReviewRouter SaaS
- sending raw auth to crash reporting, analytics, APM, session replay, support
  upload, or telemetry
- downloading new executable code unless it was already pinned and
  checksum/signature verified before auth materialization
- writing raw auth to temporary files outside the dedicated `CODEX_HOME`
- including raw auth in local setup logs or dashboard diagnostics

Allowed safe setup completion payload:

```json
{
  "repository_id": 123,
  "provider_instance_id": "rrp_...",
  "secret_name": "REVIEWROUTER_CODEX_AUTH_JSON",
  "secret_scope": "repo",
  "auth_shape_version": "codex-auth-json-v1",
  "codex_version": "pinned-or-detected",
  "installer_version": "pinned",
  "initial_generation_hash": "hmac-non-reversible",
  "account_id_hash": "hmac-non-reversible",
  "github_secret_metadata": {
    "name": "REVIEWROUTER_CODEX_AUTH_JSON",
    "created_or_updated": true,
    "updated_at": "safe timestamp if available"
  }
}
```

Do not include `auth_json`, `access_token`, `refresh_token`, `id_token`,
`device_code`, `user_code`, `verification_uri_complete`, raw Codex stdout, raw
GitHub CLI stdout, or full local filesystem paths in that payload.

If the installer crashes after reading auth but before GitHub secret write, it
must fail closed with local cleanup instructions and must not upload crash
details. If it crashes after GitHub secret write but before setup completion,
the dashboard should show `seeded_unconfirmed` and ask the user to rerun setup;
the rerun should be idempotent and recompute the initial generation hash.

### Dedicated Session

Do not copy the user's main `~/.codex/auth.json` by default.

Instead create:

```text
~/.reviewrouter/codex/<github-repository-id>/
```

Then run:

```bash
CODEX_HOME="$HOME/.reviewrouter/codex/<github-repository-id>" \
codex login --device-auth
```

Fallback if device auth is unavailable:

```bash
CODEX_HOME="$HOME/.reviewrouter/codex/<github-repository-id>" \
codex login
```

Installer configures file-backed storage:

```toml
cli_auth_credentials_store = "file"
```

If the user's global Codex install uses OS credential storage, account-scoped
files, or a newer local layout, the installer should not silently import it.
It should either run a dedicated login inside the ReviewRouter `CODEX_HOME` or
offer an explicit "import existing session" path with the same validation and
warning text.

### Local Credential Source Resolver

The installer must treat auth discovery as a typed resolver, not as a filesystem
search. This is the local equivalent of the auth-shape registry and prevents
the earlier "which of these two auth files is correct?" failure mode.

Supported v1 sources:

| Source                                                            | Default          | Allowed behavior                                                                                                                           |
| ----------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh dedicated login in `$HOME/.reviewrouter/codex/<repo-id>`    | yes              | create config with `cli_auth_credentials_store = "file"`, run `codex login --device-auth` or `codex login`, validate and write repo secret |
| Existing dedicated ReviewRouter `CODEX_HOME` for the same repo id | yes              | validate local metadata, auth shape, account hash, generation hash, and smoke before reuse                                                 |
| Global `~/.codex/auth.json`                                       | no               | advanced explicit import only, copy into dedicated `CODEX_HOME`, never use in place                                                        |
| OS keychain / `auto` credential store                             | no               | detect if practical, explain dedicated file-backed login, never scrape/export keychain                                                     |
| Codex app/IDE account files or app-server state                   | no               | diagnostics only unless a future spike promotes a schema                                                                                   |
| Browser cookies or local browser session                          | never            | forbidden                                                                                                                                  |
| Enterprise `CODEX_ACCESS_TOKEN`                                   | no for this mode | separate provider mode                                                                                                                     |

Resolver states:

```text
fresh_login_required
dedicated_session_valid
dedicated_session_missing
dedicated_session_shape_unsupported
global_import_available
global_import_blocked_by_default
keyring_detected
managed_config_mismatch
corporate_ca_required
account_replacement_required
```

Rules:

- do not scan the whole home directory for `auth.json`
- do not prefer a newer-looking account file over canonical root `auth.json`
- do not use the user's normal `~/.codex/auth.json` in place, because their
  local CLI and the GitHub secret-backed stream would then share one rotating
  token stream
- if advanced global import is enabled later, require a flag such as
  `--import-existing-codex-session`, show a local warning, copy bytes into the
  dedicated `CODEX_HOME`, then run the exact same schema, smoke, fingerprint,
  and account-replacement checks as fresh login
- local safe metadata may be stored beside the dedicated auth file, for example
  `.reviewrouter-session.json`, but it must contain only repo id, provider id,
  Codex CLI version, auth shape version, safe account/workspace fingerprints,
  generation hash, and setup timestamp
- if the dedicated local session directory is deleted but the GitHub secret is
  still configured, dashboard can keep remote reviews active, but local
  reconnect must require a fresh dedicated login or validated import
- if `CODEX_CA_CERTIFICATE` or `SSL_CERT_FILE` is needed for login/smoke, use
  it locally but never send full certificate paths or PEM contents to SaaS

User-facing resolver copy should be precise:

```text
ReviewRouter will create a separate Codex login for this repository.
It will not reuse your normal Codex app/CLI session unless you choose the
advanced import path.
```

### Codex Account and Workspace Lifecycle

The dedicated Codex session is still a real customer ChatGPT/Codex account
session. ReviewRouter must make account ownership explicit.

Rules:

- ReviewRouter never asks for the user's ChatGPT password, recovery codes, or
  raw browser cookies
- ReviewRouter does not provide or share a ReviewRouter-owned ChatGPT account
  for customer repositories
- setup records only safe account/workspace fingerprints, for example
  `account_id_hash`, `workspace_id_hash` when available, and plan/type bucket
- dashboard should show "Connected account changed" without showing raw account
  identifiers
- replacing the connected ChatGPT account requires explicit confirmation and is
  blocked while a lease is active
- if setup detects a different `account_id_hash` than the previous trusted
  generation, it must classify the operation as account replacement, not normal
  refresh
- if a customer needs a team-owned account/process, they own that governance;
  ReviewRouter should recommend following the customer's ChatGPT workspace
  policy rather than sharing personal credentials
- if ChatGPT Enterprise/Codex access tokens are available, treat them as a
  separate provider mode, not as a hidden replacement for Plus/Pro OAuth

Account lifecycle cases:

| Case                                            | Classification                                                              | Recovery                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| subscription/seat removed                       | `account_required` or `needs_reconnect` after proven permanent auth failure | reconnect with an entitled account                                 |
| workspace policy changed                        | `account_required`                                                          | reconnect under the required workspace or switch provider mode     |
| device auth disabled by admin                   | setup blocked                                                               | use browser login or enterprise access-token provider if allowed   |
| connected account hash changed during setup     | explicit account replacement                                                | confirm replacement, write new generation, invalidate old metadata |
| connected account hash changed during writeback | `unknown_auth_state` or `external_secret_drift`                             | pause and rerun local setup                                        |
| user who set up session leaves company          | `account_required` when entitlement/revocation is detected                  | repo owner reruns setup with approved account                      |
| plan downgraded / quota removed                 | `quota_limited` or `account_required` depending on upstream signal          | adjust plan or reconnect                                           |

Do not overfit to one upstream error string. The proxy should classify
permanent 401/403/account/entitlement failures through a tested mapping and
default to safe reconnect guidance when the account can no longer refresh.

### Account Authorization and Quota Ownership

OpenAI's documented CI/CD account-auth path is advanced and still treats
`auth.json` like a password. ReviewRouter's no-VPS path must therefore be
explicit about who owns the account session, quota, and workspace policy.

Required setup consent facts:

```text
consent_version
policy_document_hash
workspace_id
repository_id
provider_instance_id
setup_actor_github_id
account_fingerprint_hash
workspace_fingerprint_hash nullable
auth_mode
feature_scope: review_only | review_plus_maintenance | future_expanded_scope
maintenance_refresh_acknowledged
no_plaintext_saas_acknowledged
repository_content_to_codex_acknowledged
quota_usage_acknowledged
workspace_policy_acknowledged
setup_channel
created_at
expires_or_revalidation_required_at nullable
```

Rules:

- local setup must ask for explicit confirmation before writing the rotating
  GitHub secret; a copied curl command alone is not enough proof that the actor
  understood account-auth CI usage
- consent is tied to the safe account/workspace fingerprint and repository id;
  it cannot be reused for another repository, account, workspace, auth mode, or
  feature scope
- consent copy must say that repository review content is processed by Codex
  under the connected ChatGPT account/workspace policy and may consume that
  account's subscription quota
- consent copy must say ReviewRouter SaaS should not receive plaintext
  `auth.json`, access tokens, refresh tokens, or id tokens
- if maintenance refresh is enabled, consent must distinguish normal review
  runs from scheduled/background refresh attempts
- consent is invalidated by account replacement, workspace mismatch, public
  visibility change, feature-scope expansion, enabling interaction/conflict
  paths, enabling maintenance refresh after initial setup, material retention
  or logging-policy change, provider-mode switch, or enterprise/workspace policy
  revocation
- support/admin tools can show consent status, version, safe hashes, and
  revalidation reason; they cannot create, force, backdate, or override consent
- if consent is missing or stale, setup/review maps to
  `account_authorization_required`, not `needs_reconnect`, `policy_blocked`, or
  `account_required`
- if the ChatGPT account itself no longer works, use `account_required`; if the
  account may still work but approval/governance is missing, use
  `account_authorization_required`

Top 3 account-authorization options:

1. Versioned local consent bound to account/workspace/repo fingerprints -
   🎯 9 / 10 🛡️ 9 / 10 🧠 5.5 / 10

   Approx changes: 450-1100 LOC.

   Recommended. It keeps setup self-serve while proving the customer explicitly
   accepted account-auth CI behavior and quota ownership.

2. Dashboard-only checkbox before showing installer command -
   🎯 7 / 10 🛡️ 6 / 10 🧠 3 / 10

   Approx changes: 150-400 LOC.

   Easier, but weak: copied commands, stale browser sessions, and support flows
   can drift from the actual local account used by `codex login`.

3. Enterprise/admin policy requirement for every rotating setup -
   🎯 8 / 10 🛡️ 9 / 10 🧠 8 / 10

   Approx changes: 900-2200 LOC plus customer admin workflow.

   Strong for enterprise customers, but too heavy as the universal Plus/Pro
   default. Keep as a strict workspace option later.

### Account Session Group and Multi-Repo Policy

The product goal is one command per repository, but the security model must not
pretend that repository-scoped `CODEX_HOME` automatically means
account-independent upstream refresh behavior. The upstream account may still
apply account, workspace, device, or client policy across multiple local
sessions.

Local code reality:

- current `ProviderSetupState` stores only `workspaceId`, optional
  `repositoryId`, `targetKey`, `providerKind`, `authMode`, `state`, and
  timestamps
- current static Codex setup guidance can recommend organization secrets for
  selected/private/all repositories
- there is no durable account-session group, isolation status, or cross-repo
  account-level lease in the current model

Required new concept:

```text
CodexOAuthAccountSessionGroup
```

Safe fields only:

```text
workspace_id
account_fingerprint_hash
workspace_fingerprint_hash nullable
fingerprint_key_id
isolation_status: unknown | isolated | serialized | interfering | blocked
first_provider_instance_id
active_provider_count
last_isolation_spike_version
last_interference_reason
updated_at
```

Rules:

- account/workspace fingerprints are non-reversible HMACs; raw OpenAI account
  ids, emails, workspace names, plan ids, token claims, or browser/session ids
  are never stored
- local setup computes the same safe fingerprint discipline as generation
  hashes and sends only the resulting safe hash metadata
- if the account fingerprint is missing or unstable, multi-repo rotating setup
  defaults to `account_isolation_unknown`
- before Spike E passes, a second repository under the same account hash must
  either use account-level serialization or stay blocked with clear dashboard
  copy
- if Spike E proves independent streams for the pinned Codex/auth shape, the
  compatibility registry may mark that version tuple as `isolated`; changing
  Codex CLI, auth schema, upstream account type, or workspace policy resets the
  status to `unknown`
- if interference is detected, do not retry refresh loops; mark the group
  `interfering`, pause affected providers, and require account serialization,
  one-active-repo policy, or a future upstream-supported token mode
- org-level static `CODEX_AUTH_JSON` setups can remain legacy/manual, but they
  are not an input to rotating account-session groups

Top 3 rollout options:

1. Prove isolation first, then use per-provider leases -
   🎯 7.5 / 10 🛡️ 7.5 / 10 🧠 5 / 10
   Approx changes: 300-700 LOC.
   Best UX if true, but risky as the default until real refresh interference
   tests pass for the pinned Codex version and supported account types.

2. Account-level serialization until isolation is proven -
   🎯 9 / 10 🛡️ 9 / 10 🧠 7 / 10
   Approx changes: 700-1400 LOC.
   Recommended for beta/first production. It may queue or skip refresh-needed
   reviews across repos for the same account hash, but it prevents silent
   cross-repo token invalidation.

3. Block more than one rotating repo per account hash until isolation is proven -
   🎯 8 / 10 🛡️ 9 / 10 🧠 4 / 10
   Approx changes: 250-600 LOC.
   Safest and simplest, but poor UX for users who naturally enable
   ReviewRouter across several repositories.

Initial decision:

Use option 2 for private beta and first production unless Spike E gives strong
evidence for option 1. Keep option 3 as an emergency compatibility-registry
fallback if account-level serialization still shows interference.

### Browser Link Handling

When device auth is available:

- display the verification URL and user code
- if running on macOS desktop, optionally open the URL with `open`
- if running in Linux desktop, optionally use `xdg-open`
- if headless, print exact instructions
- do not send the code to ReviewRouter SaaS

### Local Validation

Before writing to GitHub:

- verify `gh auth status`
- verify repo exists and the current GitHub identity can set repo secrets
- verify Codex CLI exists or install a pinned stable version
- verify `auth.json` exists under dedicated `CODEX_HOME`
- verify `auth.json` raw byte size is safely under GitHub's 48 KB secret limit
  with headroom for future token shape changes
- parse JSON
- reject duplicate JSON keys
- canonicalize auth JSON before smoke, fingerprint, and secret write
- require `auth_mode == "chatgpt"`
- require `tokens.refresh_token` non-empty
- require `tokens.access_token` non-empty
- require `tokens.id_token` non-empty
- reject API-key mode, access-token-only mode, and experimental
  `chatgptAuthTokens` exports for this path
- compute only local safe fingerprints, for example HMAC or salted hash of
  account id and token generation, never raw tokens
- verify the fingerprint key id supplied by SaaS matches the provider instance
- pre-mask the full auth JSON and individual token strings in local/CI logs
  before any command could echo them
- warn if `last_refresh` missing or old
- run a real smoke:

```bash
CODEX_HOME="$HOME/.reviewrouter/codex/<repo-id>" \
codex exec \
  --json \
  --sandbox read-only \
  --config 'approval_policy="never"' \
  --ignore-rules \
  "Reply with the single word OK."
```

The smoke should not print token data or full auth path.

If the auth JSON ever approaches the 48 KB secret limit, stop setup and do not
invent a GPG-in-repo workaround. Large-secret workarounds would either put
encrypted blobs in the repository or require another secret, which weakens the
no-plaintext-SaaS and simple rollback story.

### Installer Supply Chain

The `curl | bash` installer is convenient, but it is a high-trust bootstrap
path. Production installer requirements:

- serve only over HTTPS with HSTS
- pin the installer version in dashboard-generated commands when practical
- publish installer checksum or signature for advanced users
- do not follow untrusted redirects
- print the resolved installer version and ReviewRouter API origin
- avoid downloading executable dependencies after Codex auth is created unless
  they are pinned and checksum-verified
- avoid package-manager installs after Codex auth is created; package lifecycle
  scripts are executable code and must complete before auth materialization
- support `--dry-run` and `--print-plan` modes that never read or write
  `auth.json`
- keep the command idempotent for the same repo/provider instance

Bootstrap options:

1. Pinned download + checksum/signature + execute - 🎯 9 🛡️ 8 🧠 5
   Approx changes: 250-600 LOC.
   Dashboard command downloads a versioned installer, verifies checksum or
   signature, then runs it. Best production default while keeping UX close to
   one command.

2. Plain `curl | bash` latest installer - 🎯 7 🛡️ 4 🧠 2
   Approx changes: 50-150 LOC.
   Good for early internal spike only. Too much mutable bootstrap trust for
   production OAuth setup.

3. Manual package install from GitHub release/Homebrew/npm - 🎯 8 🛡️ 8 🧠 7
   Approx changes: 500-1200 LOC plus release infra.
   Stronger for advanced users, but worse first-run UX and more packaging
   maintenance.

Production dashboard should still show one copy-paste command, but that command
should verify the installer artifact before execution where the platform makes
that practical. The old unpinned `curl | bash` form should remain an internal
spike shortcut, not the final recommended command.

### Installer Bootstrap Root of Trust

The checksum shown by the dashboard and the installer downloaded from
`reviewrouter.site` usually share the same control plane. That protects against
network, CDN, cache, and redirect tampering, but it does not protect against a
compromised ReviewRouter web app, release account, or signing pipeline.

Trust levels:

1. **Dashboard-pinned command**

   ```text
   🎯 9 / 10   🛡️ 7 / 10   🧠 5 / 10
   Approx changes: 400-800 LOC.
   ```

   Best default UX. It gives a single command with exact installer version,
   expected digest, release channel, repo id, and setup session pairing.
   Residual risk: the user is trusting ReviewRouter's web/control plane to show
   the right command.

2. **GitHub release asset + attestation verification**

   ```text
   🎯 8 / 10   🛡️ 9 / 10   🧠 7 / 10
   Approx changes: 900-1800 LOC plus release pipeline work.
   ```

   Stronger for security-sensitive customers. The user can verify the installer
   artifact against ReviewRouter's GitHub release, immutable release metadata
   or artifact attestation where available, and expected repository identity.
   UX is worse, so this should be an advanced "verify installer" path.

3. **Offline signing-key verification**

   ```text
   🎯 7 / 10   🛡️ 9 / 10   🧠 8 / 10
   Approx changes: 1200-2500 LOC plus key-management/runbook work.
   ```

   Strongest independence from the web app, but adds signing-key custody,
   rotation, revocation, documentation, and user support complexity. Useful
   only if enterprise customers require it.

Recommendation:

Use option 1 as the default production UX, and implement option 2 as the
documented high-security path before broad launch. Option 3 is a later
enterprise hardening path unless customer requirements demand it.

Production release artifact contract:

```json
{
  "channel": "stable",
  "installer_version": "vX.Y.Z",
  "installer_sha256": "hex",
  "installer_url": "https://reviewrouter.site/install/codex/vX.Y.Z",
  "source_repository": "777genius/review-router",
  "source_commit": "full_sha",
  "release_tag": "vX.Y.Z",
  "workflow_schema_version": "reviewrouter-codex-oauth-proxy-v1",
  "proxy_version": "vX.Y.Z",
  "codex_cli_version": "0.125.0",
  "compatibility_state": "allowed",
  "created_at": "timestamp"
}
```

Rules:

- `/install/codex` may remain a legacy static seeding convenience endpoint, but
  rotating mode must use a versioned installer endpoint or explicit mode
- redirects from rotating installer endpoints must resolve to immutable
  release assets or content-addressed objects, not raw `main`
- dashboard copy must show the resolved version and digest before the user runs
  the command
- installer prints the same version, digest, ReviewRouter API origin, GitHub
  repo id, and target secret name before reading auth
- installer refuses to continue if the manifest says `blocked`,
  `deprecated`, wrong channel, wrong repository id, or wrong workflow schema
- installer refuses downgrade unless the compatibility registry marks that
  downgrade as a recovery path
- setup session pairing must bind the installer version and manifest digest so
  a copied command cannot be replayed with a different artifact
- release manifest and compatibility state are recorded in safe provider
  metadata for support and incident response

Failure handling:

| Failure                                                    | State                                                                     | Recovery                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| digest mismatch                                            | `installer_integrity_failed`                                              | stop before auth read; ask user to retry or use GitHub release verification  |
| manifest blocked                                           | `installer_blocked`                                                       | stop before auth read; dashboard explains upgrade or wait                    |
| release asset missing                                      | `installer_unavailable`                                                   | stop before auth read; do not fall back to raw main                          |
| attestation verification failed in advanced mode           | `installer_integrity_failed`                                              | stop before auth read; report safe release metadata only                     |
| dashboard command version differs from downloaded manifest | `installer_version_mismatch`                                              | stop before auth read                                                        |
| setup session binds different version/digest               | `setup_session_mismatch`                                                  | stop before auth read and require fresh command                              |
| compromise suspected after setup                           | `suspended` or `needs_reconnect` depending on plaintext exposure evidence | emergency-block versions, rotate operational keys, publish recovery guidance |

Incident distinction:

- compromised dashboard command before auth read means setup should stop or
  versions should be emergency-blocked; reconnect is not required unless
  plaintext auth could have been read
- compromised installer after auth read is treated as possible plaintext auth
  exposure and requires fresh dedicated Codex login
- compromised proxy/action release used in CI is treated as possible CI secret
  exposure if it ran after secret materialization
- compromised Codex CLI package requires compatibility block and impact review;
  reconnect is required only if auth was likely exposed

### Runtime Package Installation Policy

Secret-backed jobs should not install mutable runtime packages after auth is
restored.

Rules:

- Codex CLI, ReviewRouter proxy, sanitizer, and helper tools are installed or
  verified before `REVIEWROUTER_CODEX_AUTH_JSON` is materialized
- package references are exact versions plus integrity/checksum where practical
- no `latest`, floating dist-tags, branch refs, or PR-produced artifacts in
  secret-backed steps
- package manager lifecycle scripts are either disabled where compatible or
  completed before secret restore
- if a pinned package requires lifecycle scripts to install correctly, that
  package is treated as trusted executable release material and covered by
  supply-chain tests
- no repo `npm install`, `pnpm install`, `yarn install`, `pip install`,
  `cargo build`, `go generate`, or similar dependency/build command runs after
  secret restore
- no package manager reads project-controlled `.npmrc`, `.yarnrc`, `.pnpmfile`,
  lockfile hooks, install scripts, or registry config after secret restore
- generated workflow should set a clean package-manager environment for
  ReviewRouter-owned installs, not inherit repository package-manager config

### GitHub Secret Write

Installer writes:

```text
REVIEWROUTER_CODEX_AUTH_JSON
```

Use repository secret by default:

```bash
gh secret set REVIEWROUTER_CODEX_AUTH_JSON --repo owner/repo < "$AUTH_FILE"
```

Do not use organization secret for rotating mode by default.

Before writing, check for conflicting lower-scope secrets if environments are
introduced later. A same-named environment secret could override the repository
secret for jobs using that environment and silently restore a different
generation.

### Workflow Provisioning and Upgrade

The installer also needs to install or update the GitHub Actions workflow, but
that must not require ReviewRouter SaaS to see Codex auth.

Recommended production path:

1. installer uses the user's local `gh` authentication to create a setup branch
   or update a temporary clone
2. installer writes a generated workflow from a pinned template
3. installer opens or updates a PR such as
   `reviewrouter/codex-oauth-refresh-setup`
4. user reviews and merges the PR
5. ReviewRouter SaaS records the workflow schema version only after OIDC proves
   the merged workflow is running from the expected trusted ref

Why not let SaaS silently push workflow changes:

- it would require broader GitHub App contents/pull-request permissions
- it increases blast radius if ReviewRouter is compromised
- workflow changes are code and should stay reviewable in the customer's repo
- the user's local `gh` already has the rights needed for setup if they can set
  repo secrets

Workflow provisioning options:

1. Local installer opens setup PR with user's `gh` auth - 🎯 9 🛡️ 8 🧠 6
   Approx changes: 500-1000 LOC.
   Best default. SaaS does not need contents write, and customer sees workflow
   changes before merge.

2. ReviewRouter GitHub App opens setup PR - 🎯 8 🛡️ 7 🧠 7
   Approx changes: 700-1400 LOC plus App permission upgrade.
   Smoother web UX, but requires more App permissions and a stricter App
   compromise model.

3. Installer edits local working tree and asks user to commit - 🎯 7 🛡️ 7 🧠 4
   Approx changes: 250-600 LOC.
   Simple, but fragile with dirty worktrees, nonstandard branches, and users
   running setup outside a clone.

Upgrade rules:

- never overwrite user-edited workflow content without showing a diff or
  updating a setup PR
- include workflow schema version and ReviewRouter action/proxy versions
- preserve unrelated workflow triggers, labels, and customer configuration only
  through a structured template merge, not broad string replacement
- if merge is ambiguous, open a PR with explicit conflict comments instead of
  mutating the file in place
- support rollback PR that disables the new mode without deleting secrets
- workflow changes must be idempotent across repeated installer runs
- existing `CODEX_AUTH_JSON` users keep working until the new workflow is
  merged and verified

### Workflow Provenance and Runtime Attestation

Local code reality as of this plan review:

- `workflow-template.ts` renders reusable and explicit workflows from string
  templates and already validates action refs, API URLs, environment keys, and
  some provider capability markers
- `provision-reviewrouter-workflow.ts` records setup PR state with
  `workflowStyle`, `actionVersion`, branch, workflow path, and PR URL
- `workflow-setup-readiness.ts` treats a workflow as current when the expected
  action ref and marker groups are present
- there is no rotating OAuth template digest, no runtime workflow attestation
  tuple, and no "merged but not yet proven by trusted run" configured state

For static and non-secret modes, marker-based readiness is acceptable enough.
For rotating OAuth it is not. A customer or bot can edit
`.github/workflows/reviewrouter.yml`, a setup PR can be merged but never run
from the default branch, or a moving reusable workflow tag can resolve to a
different runtime than the setup flow expected. None of those cases should be
allowed to restore `REVIEWROUTER_CODEX_AUTH_JSON`.

Generated rotating workflow headers should include stable ReviewRouter-owned
metadata comments near the top:

```yaml
# reviewrouter-workflow-schema: reviewrouter-codex-oauth-proxy-v1
# reviewrouter-template-digest: sha256:<canonical-template-digest>
# reviewrouter-action-ref: 777genius/review-router@<exact-ref-or-channel>
# reviewrouter-release-channel: <internal|canary|exact|v1>
# reviewrouter-provider-auth-mode: codex_chatgpt_oauth_rotating
# reviewrouter-secret: REVIEWROUTER_CODEX_AUTH_JSON
# reviewrouter-setup-intent: <safe-setup-intent-id>
# reviewrouter-setup-generation: <safe-generation-hash-prefix>
```

Those comments are a diagnostics and repair aid, not the trust root. The
runtime must attest the full tuple before the secret is materialized:

```text
repository_id
repository_full_name
repository_visibility
workflow_path
workflow_ref
workflow_sha
job_workflow_ref
job_workflow_sha
action_ref
action_sha
workflow_schema_version
template_digest
release_channel
provider_auth_mode
secret_name
runtime_protocol_version
setup_intent_id or setup_generation marker
provider_instance_id
run_id
run_attempt
event_name
runner_environment
```

The first no-secret preflight performs this check:

1. Action starts with no `REVIEWROUTER_CODEX_AUTH_JSON` in env, args, files, or
   step outputs.
2. Action obtains GitHub OIDC with the ReviewRouter audience.
3. Action sends only safe attestation fields to ReviewRouter SaaS.
4. SaaS validates OIDC claims, provisioning state, template digest, workflow
   schema, provider auth mode, secret name, action/proxy/Codex compatibility,
   and release-channel policy.
5. SaaS returns either an allow decision plus short-lived action-session
   material or a safe blocker such as `workflow_pending_verification`,
   `workflow_schema_mismatch`, `workflow_drift_detected`,
   `rotating_protocol_unsupported`, or `permission_required`.
6. Only after the allow decision may the workflow run the proxy bootstrap step
   that receives `REVIEWROUTER_CODEX_AUTH_JSON`.

Setup PR merge semantics:

- creating or merging the setup PR records `setup_pr_open` or
  `workflow_pending_verification`, not `configured`
- the provider becomes active only after a run from the trusted default ref
  proves the exact expected schema marker and template digest
- if the setup PR is merged but Actions are disabled or blocked by org policy,
  the state remains pending with policy-specific guidance
- if the setup branch is updated after the setup intent was issued, the
  installer opens or updates the same setup PR with a new digest and generation
  marker instead of reusing stale metadata

Runtime drift rules:

- PR changes under `.github/workflows/**` may be reviewed as source text after
  sanitization, but cannot change the trusted workflow identity for that run
- `workflow_dispatch` cannot supply or override schema, action ref, workflow
  SHA, provider auth mode, secret name, or template digest
- manual edits to the default-branch workflow after setup pause rotating OAuth
  until a repair setup PR restores a known digest or a new trusted digest is
  recorded
- YAML syntax changes that preserve comments but alter executable behavior are
  drift, not compatible customization
- reusable workflow callers must include `job_workflow_ref` and
  `job_workflow_sha` in the OIDC attestation where GitHub supplies them; strict
  channels require immutable SHA agreement, while moving channels require an
  allowlisted compatibility decision for the resolved SHA
- a missing workflow content read permission does not imply trust; it produces
  `workflow_attestation_incomplete` unless the OIDC and release-channel policy
  explicitly provide an equivalent trusted digest proof

Template digest rules:

- digest is computed over a canonical generated workflow representation, not
  over arbitrary user-edited YAML text
- comments, whitespace, trigger ordering, and generated env ordering must be
  deterministic for ReviewRouter-owned templates
- if user customization is supported later, it must be represented as a
  versioned structured patch with its own digest input, not freeform in-place
  edits
- provisioning stores digest per file path and per provider feature-scope,
  because review, interaction, required-check, and conflict-review workflows
  have different secret and permission boundaries
- setup repair compares recorded digest, default-branch digest, and generated
  candidate digest and chooses one of `current`, `repair_pr_needed`,
  `manual_review_needed`, or `unsupported_customization`

### Workflow Provisioning State Taxonomy and Repair Semantics

Workflow state needs to be explicit because it is not Codex auth state. A
rotating provider can have a valid saved Codex session while the generated
workflow is not yet trusted enough to restore it.

First-class workflow/setup states:

```text
setup_pr_open
workflow_pending_verification
workflow_drift_detected
workflow_schema_mismatch
workflow_attestation_incomplete
rotating_protocol_unsupported
control_plane_version_unsupported
workflow_repair_required
workflow_disabled_by_rollback
```

State meanings:

- `setup_pr_open`: installer created or updated the setup PR, but it has not
  been merged into the trusted default ref
- `workflow_pending_verification`: setup PR is merged or workflow exists, but
  no trusted no-secret runtime attestation has proven the exact schema/digest
- `workflow_drift_detected`: default-branch workflow changed after setup and
  no longer matches a recorded or allowlisted digest
- `workflow_schema_mismatch`: workflow file is ReviewRouter-shaped but the
  schema, provider auth mode, secret name, permission shape, or feature scope
  does not match the rotating provider
- `workflow_attestation_incomplete`: OIDC/runtime preflight cannot prove the
  required workflow tuple because a required claim, workflow read, template
  digest, or release-channel proof is missing
- `rotating_protocol_unsupported`: workflow/action/proxy version cannot speak
  the rotating protocol v2 required before secret restore
- `control_plane_version_unsupported`: SaaS is older than the workflow/action
  protocol or has emergency-blocked the requested compatibility tuple
- `workflow_repair_required`: ReviewRouter can generate a deterministic repair
  PR, but the provider must stay inactive until that PR is merged and attested
- `workflow_disabled_by_rollback`: rollback intentionally made the rotating
  workflow inert while leaving secrets untouched for later recovery

Rules:

- these states are pre-secret states; `REVIEWROUTER_CODEX_AUTH_JSON` is not
  materialized and no refresh starts
- none of these states means `needs_reconnect` unless a separate Codex auth
  failure is proven
- support/admin cannot manually clear them to `active`; only a successful
  no-secret runtime attestation from trusted default ref can do that
- a repair PR must include the previous digest, candidate digest, provider auth
  mode, secret name, workflow schema, release channel, and setup intent marker
- if repair generation is ambiguous, use `manual_review_needed` inside
  `workflow_repair_required`, not silent string patching
- final policy check maps these states according to advisory/required/strict
  mode, but repo health must still show the exact workflow reason
- legacy static workflows remain valid only for legacy static provider mode;
  their existence cannot satisfy rotating workflow verification

Top 3 workflow-state implementation options:

1. First-class workflow state machine plus repair PR planner - 🎯 9 / 10
   🛡️ 9.5 / 10 🧠 7 / 10

   Approx changes: 700-1600 LOC production-grade.

   Recommended. This prevents auth-state confusion and gives support/dashboard
   exact recovery actions without making SaaS silently mutate workflow code.

2. Collapse workflow setup problems into `policy_blocked` with reason codes -
   🎯 7 / 10 🛡️ 7 / 10 🧠 4 / 10

   Approx changes: 250-700 LOC.

   Usable for MVP, but weak for support and final-check semantics. Users will
   see too many different workflow failures as one generic policy blocker.

3. Keep workflow readiness as derived UI-only metadata - 🎯 5 / 10
   🛡️ 4.5 / 10 🧠 3 / 10

   Approx changes: 100-300 LOC.

   Not recommended. It lets lease/writeback paths and support tooling drift
   away from dashboard readiness, which is exactly how rotating secrets get
   restored under an unverified workflow.

Top 3 attestation implementation options:

1. Runtime attestation tuple plus recorded template digest - 🎯 9 / 10 🛡️ 9.5 / 10 🧠 7.5 / 10
   Approx changes: 600-1400 LOC.
   Recommended. This gives us a concrete trust contract between setup,
   default-branch workflow, OIDC, runtime protocol, release channel, and secret
   restore.

2. Static YAML marker only - 🎯 6.5 / 10 🛡️ 6 / 10 🧠 4 / 10
   Approx changes: 250-700 LOC.
   Easier to bolt onto the current readiness scanner, but comments can drift
   away from executable behavior and cannot prove reusable workflow SHA or
   runtime protocol.

3. Trust action ref/version only - 🎯 5 / 10 🛡️ 4 / 10 🧠 3 / 10
   Approx changes: 100-300 LOC.
   Too weak for rotating OAuth. It can detect old actions, but not workflow
   content drift, wrong secret name, stale setup intent, or PR-controlled
   workflow confusion.

### Repository and Organization Policy Preflight

Before setup claims success, classify repository/org policy blockers:

```text
actions_disabled
actions_not_allowed_for_repo
action_reference_not_allowed
reusable_workflow_not_allowed
workflow_permissions_too_restrictive
selected_repository_not_installed
app_permission_pending_owner
app_permission_missing
merge_queue_requires_merge_group
branch_protection_diagnostics_unavailable
```

Preflight should check, where permissions allow:

- GitHub Actions enabled for the repository and not blocked by org/enterprise
  policy
- generated action/reusable workflow references match the org allowlist
- selected repository is included in the ReviewRouter GitHub App installation
- required `Secrets: write` permission is granted and verified
- workflow can request `id-token: write`
- branch-protection diagnostics are available or explicitly best-effort
- merge queue enabled state, if final ReviewRouter check is required

If the installer cannot inspect an org policy because the current user lacks
rights, do not guess. Mark preflight as `unknown_policy` with exact admin
instructions and keep the provider in advisory or paused setup mode until the
first trusted workflow run proves the contract.

Policy-blocked UX should be specific:

```text
GitHub Actions is disabled for this repository.
ReviewRouter action is not allowed by your organization Actions policy.
ReviewRouter GitHub App is installed, but this repository is not selected.
An organization owner must approve the ReviewRouter App permission update.
```

Do not turn policy blockers into reconnect guidance; the Codex session can be
valid while GitHub policy prevents execution.

### Organization Secret Policy

For rotating Codex OAuth:

```text
repo secret: allowed and recommended
org selected-repo secret for exactly one repo: possible later, not default
org selected-repo secret for multiple repos: blocked
org visibility all: blocked
```

Reason:

Codex refresh token state must be one file per serialized workflow stream.
Multiple repositories sharing one org secret can refresh concurrently and
invalidate each other.

## Workflow Architecture

### Event Safety

Allowed for secret-backed Codex OAuth:

```text
pull_request from same repository, if policy allows
merge_group, only when repository uses merge queue and required-check mode is enabled
workflow_dispatch by maintainer/admin
schedule for maintenance refresh, if enabled
repository_dispatch from trusted ReviewRouter App flow, if implemented
```

Blocked:

```text
pull_request from fork
pull_request_target
workflow_run unless a separate artifact-attestation design is approved
Dependabot unless explicitly trusted later
public repository default secret-backed mode
unknown event shape
```

### PR Actor and Ref Trust

"Same repository PR" is not by itself a complete trust policy. It only means
GitHub can pass repository secrets to the workflow. ReviewRouter still needs a
separate actor/ref policy for secret-backed agent execution.

Default v1 policy:

```text
same-repo pull_request: allowed only when head repo id equals base repo id and
  actor/author association satisfies the repository's ReviewRouter trust policy
workflow_dispatch: allowed only for users with write/admin permission and with
  a resolved trusted PR/head SHA, not arbitrary user-supplied refs
merge_group: allowed only for final policy check or proven merge-queue review
schedule: allowed only for maintenance with no PR checkout
repository_dispatch: blocked for OAuth review unless a separate signed dispatch
  design is implemented
```

Trust inputs:

```text
repository id
head repository id
base repository id
head sha
base sha
merge sha when present
actor
triggering_actor for reruns when available
author_association
event sender type
manual dispatch input PR number/head SHA
repository ruleset/branch protection mode where available
```

Rules:

- do not checkout a ref supplied directly by `workflow_dispatch` input
- resolve manual PR number through GitHub API, then bind checkout/review to the
  resolved head SHA and base repository id
- reject PRs from forks and Dependabot before secret restore
- reject same-repo PRs whose actor/author association is below the configured
  trust threshold when strict actor policy is enabled
- do not let maintainer re-run convert an originally untrusted fork,
  Dependabot, public, or actor-blocked event into a trusted secret-backed run
- report actor/ref rejection as `policy_blocked` or skipped-by-policy, not
  `needs_reconnect`
- final policy check must map actor/ref skips deliberately according to
  advisory/required/strict mode

This is mostly about blast radius. Codex runtime should still be isolated from
auth, but the job is reading PR-controlled content and producing review output,
so event trust must be explicit rather than inherited from GitHub's secret
availability rules.

Never check out PR-controlled workflow files before the trusted workflow schema
and OIDC claims are validated. For same-repo PRs, the workflow definition must
come from a trusted branch/ref, not from attacker-controlled changes to
`.github/workflows/**`.

Queued-run stale secret rule:

- the workflow may be queued with an old `REVIEWROUTER_CODEX_AUTH_JSON`
- the proxy bootstrap must compute a keyed generation hash from the restored
  auth before refresh
- lease acquire sends that generation hash to SaaS
- SaaS compares it to the latest confirmed generation for the provider
- mismatch means `stale_queued_secret`; the run skips without refresh and asks
  for a fresh rerun

This is mandatory because repository and organization secrets are read when the
workflow run is queued, not when the proxy step starts.

### Maintenance Refresh

Low-activity repositories may not run Codex often enough for natural refresh.
Offer an optional scheduled maintenance workflow:

```text
schedule weekly, private repos only
-> acquire same OIDC lease
-> restore current REVIEWROUTER_CODEX_AUTH_JSON
-> compute restored generation and reject stale queued state
-> start proxy
-> run a minimal Codex smoke or proxy refresh-only path if proven safe
-> write back only if refresh happened
-> no checkout of PR code
-> no PR comments
```

Rules:

- disabled by default until quota impact is measured
- same single-writer lease as PR reviews
- same fork/public/repo-visibility guards
- schedule should avoid the top of the hour and include deterministic per-repo
  jitter where practical
- schedule is best effort; it must not be the only mechanism that detects stale
  or expiring sessions
- maintenance health should alert/dashboard when no successful maintenance run
  occurs within the expected window plus grace period
- maintenance must respect provider/org/account budgets and back off after
  upstream 429/quota errors
- maintenance must never run from a workflow file that is not on the default
  branch and verified by OIDC
- no repository dependency install
- no model review prompt or diff
- dashboard must show last maintenance refresh separately from last PR review

Maintenance modes:

1. Passive only, no scheduled refresh - 🎯 8 🛡️ 8 🧠 3
   Approx changes: 100-250 LOC.
   Lowest quota risk. Users may still hit reconnect after long inactivity.

2. Weekly best-effort maintenance refresh - 🎯 8 🛡️ 7 🧠 6
   Approx changes: 350-800 LOC.
   Recommended after private beta if quota impact is acceptable. It improves
   reliability but cannot be treated as a guarantee because GitHub schedules can
   be delayed or dropped.

3. SaaS-driven `repository_dispatch` maintenance - 🎯 7 🛡️ 7 🧠 8
   Approx changes: 700-1600 LOC.
   More controllable than cron, but requires more GitHub App/API behavior and
   replay/rate-limit protection. Later option, not v1 default.

### Environment Policy

First production release should not use GitHub Environments in the
secret-backed Codex review job.

Rules:

- generated `codex-review` job must not set `environment:`
- installer/workflow scanner warns if an existing workflow variant introduces
  `environment:` around the secret-backed job
- same-named environment secret `REVIEWROUTER_CODEX_AUTH_JSON` is treated as a
  hard blocker unless a future environment-secret design is implemented
- if a customer needs deployment-environment approvals, run those in a separate
  no-Codex-auth job and pass only sanitized review status
- OIDC validation should reject unexpected `environment` claims if GitHub adds
  them to the subject template for this job

Reason:

Environment secrets override repository secrets for jobs that reference the
environment, and environment secrets are read at job start rather than workflow
queue time. That creates a different stale-secret and drift model than the one
this plan validates.

### Required Check and Merge Policy

ReviewRouter review comments and ReviewRouter merge gating are separate
product concepts. The OAuth refresh machinery must not accidentally become a
required check with ambiguous semantics.

Generated workflow should include a stable final job:

```text
reviewrouter-codex-policy
```

Rules:

- final policy job uses `if: always()` and `needs` all ReviewRouter jobs, so it
  reports a deterministic conclusion even when review/comment jobs skip or fail
- no workflow-level `paths`, `branches`, or commit-message skip mechanism should
  be used for the required ReviewRouter check; use job-level conditions instead
- check/job names must be stable and unique across ReviewRouter workflows to
  avoid ambiguous required status checks
- if customer enables branch protection, recommend requiring only the final
  policy job, not internal bootstrap/proxy/comment jobs
- generated workflow should include `merge_group` only if the repository uses
  merge queue and the final policy check is intended to be required there
- required-check source must be the expected GitHub Actions/App source; if
  ReviewRouter later posts custom checks through the GitHub App, source
  migration must be a separate rollout

Default conclusions:

| State                                           | Required check conclusion                                   | Rationale                                                         |
| ----------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Successful review                               | `success`                                                   | Review completed normally.                                        |
| Fork/public/unsupported event skipped by policy | `neutral` or `success` if not configured as blocking        | Avoid blocking untrusted contexts that cannot receive secrets.    |
| `permission_required`                           | `failure` if configured as required, otherwise `neutral`    | Repo owner action is needed.                                      |
| `needs_reconnect`                               | `failure` if configured as required, otherwise `neutral`    | User action is needed and reviews are not happening.              |
| `unknown_auth_state`                            | `failure` if configured as required                         | Auth state is unsafe to continue automatically.                   |
| `reconcile_required`                            | `failure` if configured as required                         | Automation is paused until safe metadata recovery.                |
| `quota_limited`                                 | `neutral` by default, optionally `failure` for strict repos | Auth is not invalid; blocking merge is a product policy decision. |
| `stale_queued_secret`                           | `neutral` with rerun guidance                               | The current run is stale, not a code failure.                     |
| Internal invariant/security violation           | `failure`                                                   | Unsafe workflow/proxy behavior must block when required.          |

Dashboard should make this explicit:

```text
Codex review check mode:
  advisory: never intentionally blocks merge
  required: blocks on auth/config/security states that prevent review
  strict: also blocks on quota_limited and skipped review states
```

Do not let GitHub's successful `neutral`/`skipped` semantics silently decide
product policy. ReviewRouter should choose a check conclusion deliberately and
document it in dashboard setup copy.

### Runner OS Scope

Initial no-VPS OAuth proxy mode supports:

```text
ubuntu-latest / GitHub-hosted Linux only
```

Blocked for the first production release:

```text
windows-latest
macos-latest
self-hosted in github-hosted-refresh mode
```

Reasons:

- process hardening and `drop-sudo` behavior are OS-specific
- Linux gives the clearest path for unprivileged user namespaces and procfs
  hardening
- Windows needs a separate threat model before secrets are restored
- self-hosted runners should use the persistent `CODEX_HOME` mode instead of
  the GitHub-hosted refresh proxy mode

### Permissions

Workflow-level permissions should be minimal:

```yaml
permissions: {}
```

Review job permissions:

```yaml
permissions:
  contents: read
  id-token: write
```

The review job must not have `pull-requests: write`, `issues: write`, or
`contents: write`. It restores Codex auth, runs the proxy, runs Codex, and
produces only a sanitized review artifact.

Comment job permissions:

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
```

The comment job must run only after the review job exits. It must not receive
Codex auth, proxy tokens, writeback tokens, helper tokens, HMAC material, OIDC
tokens from the review job, raw model output, raw prompt, or raw diff. It
validates the sanitized artifact again before posting.

No `secrets: write` GitHub token should exist in the workflow.

The ReviewRouter SaaS uses GitHub App installation credentials for secret
writeback, and only after OIDC plus lease validation.

If a short-lived helper token is minted for GitHub public-key retrieval, it must
be downscoped to read-only secret metadata/public-key access, passed only to
the proxy bootstrap/public-key-fetch code, and removed before `codex exec`
starts. If GitHub does not allow a sufficiently downscoped token for the
installed App permissions, this is a blocking spike result.

The token creation request must explicitly set a repository subset and the
smallest accepted permission subset. Illustrative shape:

```json
{
  "repository_ids": ["<current-repository-id>"],
  "permissions": {
    "secrets": "read"
  }
}
```

Never mint a helper token without explicit `repository_ids` and `permissions`,
because GitHub otherwise grants all repositories and permissions available to
the installation token. Verify the response permissions; metadata read may be
implicit in GitHub App installation tokens and should not be guessed if the API
rejects it.

### Step Separation

The trusted proxy bootstrap step is the only step that receives:

```text
REVIEWROUTER_CODEX_AUTH_JSON
```

Codex runtime step receives:

```text
CODEX_HOME=<empty temp dir with config.toml only>
REVIEWROUTER_PROXY_URL=http://127.0.0.1:<port>/<nonce>/v1
```

Codex runtime step must not receive:

```text
REVIEWROUTER_CODEX_AUTH_JSON
CODEX_AUTH_JSON
OPENAI_API_KEY
GITHUB_TOKEN
github.token-derived credentials
GitHub App token
ReviewRouter writeback secret
ReviewRouter OIDC raw token
```

Preferred job separation:

```text
codex-review job:
  permissions: contents: read, id-token: write
  restores auth, runs proxy, runs Codex, writes sanitized review artifact

post-review-comment job:
  needs: codex-review
  permissions: contents: read, pull-requests: write, issues: write
  receives only sanitized artifact, validates it again, posts comment
```

Reason:

`GITHUB_TOKEN` is a job-level credential and is also available through the
`github.token` context. A step-level promise to "introduce the token later" is
not enough for a production security boundary when the same job contains Codex
and third-party or generated logic.

### Child Process Environment Firewall

GitHub runner jobs contain useful metadata and hidden capabilities that are not
ordinary repository secrets. A no-plaintext auth design still fails if the
Codex subprocess can read OIDC request credentials, job file-command paths, or
job-scoped GitHub credentials.

Official GitHub docs establish three relevant facts:

- jobs need `id-token: write` before OIDC JWTs can be requested
- OIDC tokens can be requested from the runner through
  `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
- GitHub creates a per-job `GITHUB_TOKEN`, and job-level `permissions` define
  what code in that job can do with it

Required environment model:

```text
trusted action/preflight process:
  may temporarily see GitHub runner env, OIDC request env, action-session
  token, helper token, HMAC material, and proxy/writeback control material

proxy process:
  may receive auth bytes through private bootstrap channel and writeback
  control material in memory only

Codex runtime process:
  receives only allowlisted safe env and nonce-prefixed data-plane proxy URL

repo/model-controlled subprocess:
  same or stricter env than Codex runtime; no GitHub, OIDC, writeback, helper,
  file-command, cache, artifact, package-registry, or auth material
```

Recommended allowlist for Codex/runtime children:

```text
CI=true
LANG=C.UTF-8
LC_ALL=C.UTF-8
PATH=<fixed trusted tool path>
HOME=<trusted temp home>
TMPDIR=<trusted temp dir>
RUNNER_TEMP=<trusted temp dir if a tool requires it>
CODEX_HOME=<trusted temp Codex home>
REVIEWROUTER_PROXY_URL=http://127.0.0.1:<port>/<nonce>/v1
REVIEWROUTER_SAFE_RUN_ID=<safe id>
REVIEWROUTER_SAFE_FEATURE_SCOPE=pr_review
```

Forbidden for Codex/runtime children:

```text
GITHUB_TOKEN
ACTIONS_ID_TOKEN_REQUEST_URL
ACTIONS_ID_TOKEN_REQUEST_TOKEN
ACTIONS_RUNTIME_TOKEN
ACTIONS_CACHE_URL
ACTIONS_RESULTS_URL
GITHUB_ENV
GITHUB_OUTPUT
GITHUB_STATE
GITHUB_STEP_SUMMARY
GITHUB_PATH
GITHUB_EVENT_PATH when raw event payload is not needed
INPUT_*
NODE_AUTH_TOKEN
NPM_TOKEN
YARN_NPM_AUTH_TOKEN
GH_TOKEN
GITHUB_APP_TOKEN
REVIEWROUTER_CODEX_AUTH_JSON
CODEX_AUTH_JSON
REVIEWROUTER_WRITEBACK_TOKEN
REVIEWROUTER_HELPER_TOKEN
REVIEWROUTER_HMAC_KEY
raw proxy admin URLs
```

Implementation rules:

- construct child env from an allowlist, not from `process.env` minus a
  denylist
- use `env -i` for shell wrappers or explicit `env` objects for Node/process
  spawning
- keep `GITHUB_EVENT_PATH` out of model-controlled processes unless a sanitized
  event projection is explicitly required
- clear OIDC request variables and action-session material after exchange and
  before launching any subprocess
- no third-party action, package lifecycle script, repo script, or
  model-influenced command runs after OIDC/action-session acquisition unless it
  executes under the same child env firewall
- if a tool requires a runner path variable, pass a synthetic path under the
  trusted temp root, not GitHub's file-command path
- sentinel tests should print environment variable names, args, cwd, home,
  temp dirs, and known file-command path patterns, but never real token values

Top 3 implementation options:

1. Explicit allowlist env builder used by every child process - 🎯 9 / 10
   🛡️ 9.5 / 10 🧠 6.5 / 10

   Approx changes: 900-2200 LOC production-grade.

   Recommended. This makes the security boundary testable and survives new
   GitHub runner variables, new action dependencies, and future proxy helpers.

2. Denylist cleanup before launching Codex - 🎯 6 / 10 🛡️ 5.5 / 10
   🧠 4 / 10

   Approx changes: 300-800 LOC.

   Faster, but brittle. New runner variables, package tokens, file-command
   paths, or ReviewRouter helper variables can slip through.

3. Separate sandbox/container for Codex runtime - 🎯 8 / 10 🛡️ 9 / 10
   🧠 8.5 / 10

   Approx changes: 1800-4000 LOC plus runner compatibility work.

   Stronger isolation, but GitHub-hosted container semantics, filesystem
   mounts, networking, and startup overhead make it a later hardening option,
   not the first no-VPS implementation.

### Checkout

Use:

```yaml
- uses: actions/checkout@v6 # or a pinned commit SHA for strict installs
  with:
    persist-credentials: false
    lfs: false
    submodules: false
    fetch-depth: 1
```

Avoid running package install scripts before the secret trust decision.
After secret restore, do not run dependency installation from PR-controlled
code. The proxy/action package must already be installed, vendored, or fetched
from a pinned immutable artifact before the auth secret is materialized.

Checkout rules:

- do not use a PAT or SSH key for checkout in the secret-backed job
- do not enable submodules or recursive submodules in v1; `.gitmodules` is
  PR-controlled input and can point at unexpected repositories
- do not enable Git LFS in v1; LFS downloads are extra network and credential
  surface that the review does not need by default
- do not checkout a manual user-provided ref directly
- for `pull_request`, prefer the GitHub-provided merge ref or a resolved head
  SHA according to the selected review semantics; record which was reviewed
- for `workflow_dispatch`, resolve PR/head SHA through GitHub API before
  checkout and bind it into OIDC/action-session metadata
- keep `persist-credentials: false` and verify `.git/config` does not retain a
  credential helper or tokenized remote after checkout
- do not run `git submodule update`, package manager install hooks, or any repo
  script after secret restore
- if a future feature needs submodules/LFS, it requires a separate trust and
  credential design

### Workspace and Checkout Containment

The checkout should be treated as untrusted input, not as the runtime home for
the trusted proxy or Codex credentials. This matters even with
`persist-credentials: false`, because the checkout can contain `.git` metadata,
repo-controlled config files, symlinks, package-manager files, generated
content, and paths that later get uploaded by overly broad artifact rules.

Default v1 layout:

```text
trusted control root: $RUNNER_TEMP/reviewrouter-control
raw checkout root: $RUNNER_TEMP/reviewrouter-checkout
sanitized review root: $RUNNER_TEMP/reviewrouter-review-root
artifact staging root: $RUNNER_TEMP/reviewrouter-artifacts
Codex runtime CODEX_HOME: $RUNNER_TEMP/reviewrouter-codex-home
```

Rules:

- proxy auth buffers, OIDC/session material, helper tokens, writeback state,
  public-key fetch state, HMAC material, and proxy server-info files live only
  under the trusted control root or proxy memory
- raw checkout root is never passed as `CODEX_HOME`, artifact root, cache root,
  or proxy temp root
- Codex runs with `cwd` set to the sanitized review root, not the raw checkout
  root
- sanitized review root is read-only to Codex where the runner/sandbox allows
  it; any writable scratch path is separate and not uploaded
- `.git`, git hooks, local git config, credential helpers, tokenized remotes,
  submodule checkout metadata, LFS smudge state, and cache directories are not
  copied into the sanitized review root
- repo files such as `.github/workflows/**`, `.gitmodules`, `.npmrc`,
  `.yarnrc`, package manager configs, and tool config files can be reviewed as
  data only; they are not trusted as workflow, dependency, or execution config
  after secret restore
- broad artifact/cache globs such as the checkout root, `$GITHUB_WORKSPACE`,
  `$RUNNER_TEMP`, `**/*`, or parent directories of the control/proxy roots are
  rejected by workflow scanning
- worktree mutation detection checks both the raw checkout root and sanitized
  review root after Codex exits

Sanitized snapshot builder contract:

- input is the resolved and recorded PR head or merge SHA selected by the
  actor/ref policy
- copy regular tracked files only, subject to path, file-count, byte, and
  generated/vendor/binary policies
- reject or represent as safe metadata: absolute paths, traversal, NUL bytes,
  Windows drive prefixes, control characters, symlink escapes, hardlink
  surprises, sparse checkout anomalies, nested git repositories, submodule
  entries, LFS pointers, and invalid-encoding files
- normalize file modes and timestamps so the model sees content, not host
  filesystem identity
- never copy `.git`, `.hg`, `.svn`, hook directories, local git config,
  credentials, package-manager caches, dependency directories created by
  installs, core dumps, screenshots, shell history, or runner temp files
- run the same pre-model secret redaction pass on snapshot-derived review
  packets before the proxy forwards anything upstream
- emit explicit scope metadata for every skipped file class, so the review does
  not pretend to be complete when input was intentionally excluded

Top 3 workspace containment options:

1. Trusted control root plus sanitized read-only review snapshot -
   🎯 9 / 10 🛡️ 9 / 10 🧠 7 / 10
   Approx changes: 700-1500 LOC.
   Recommended. It makes the secret-bearing control plane physically separate
   from the PR content Codex can inspect, and it gives us concrete tests for
   symlink, artifact, cache, and `.git` leakage.

2. Raw checkout as Codex cwd with stricter scanners -
   🎯 7 / 10 🛡️ 6 / 10 🧠 4 / 10
   Approx changes: 250-700 LOC.
   Faster, but too easy to regress through artifact globs, tool config,
   symlinks, hidden git metadata, or future workflow changes.

3. No local checkout, GitHub API and diff-only review -
   🎯 7 / 10 🛡️ 8 / 10 🧠 8 / 10
   Approx changes: 1200-2500 LOC.
   Smaller filesystem attack surface, but weaker review context and more API
   pagination/truncation complexity. Good future high-security option, not the
   best default for useful reviews.

### Cache, Artifact, and Output Policy

Secret-backed jobs must not use GitHub Actions cache or artifacts as implicit
state channels.

Rules:

- detect `ACTIONS_STEP_DEBUG`, `ACTIONS_RUNNER_DEBUG`, `runner.debug`, shell
  xtrace, ReviewRouter verbose modes, and action debug flags before secret
  restore; default v1 behavior is block or skip secret-backed review with
  `policy_blocked`/`debug_logging_blocked`
- do not restore caches after `REVIEWROUTER_CODEX_AUTH_JSON` is materialized
- do not save caches from a job that has seen Codex auth
- do not derive cache keys from PR-controlled files in secret-backed jobs
- do not upload proxy temp dirs, Codex home, shell history, logs, core dumps, or
  workspace-wide archives
- do not write auth, HMAC key material, helper tokens, proxy URL, nonce, or
  provider request bodies to `$GITHUB_OUTPUT`, `$GITHUB_ENV`,
  `$GITHUB_STATE`, `$GITHUB_STEP_SUMMARY`, annotations, artifacts, or job
  summaries
- do not use job outputs to move sanitized review payloads between jobs; use a
  bounded sanitized artifact or SaaS sanitized artifact store
- upload only an explicit allowlist of sanitized ReviewRouter result artifacts
- upload artifacts with fixed artifact names, explicit paths, explicit minimal
  `retention-days`, and ReviewRouter-owned schema/version metadata
- comment jobs must download only the exact named artifact expected for the run,
  not all artifacts in the run, and must verify schema, repository id, PR
  number, head SHA, run id, run attempt, artifact hash, and producer job id
- long log/artifact retention, debug reruns, and downloaded log archives must be
  treated as expected customer states in tests, not as impossible support paths
- if build provenance or binary distribution is added later, use artifact
  attestations for those build artifacts, not for Codex auth state

Sanitized review artifact contract:

```text
format: ReviewRouter-owned JSON schema, not free-form Markdown
contents: validated findings, safe summary, safe run metadata
forbidden: auth state, proxy URL, nonce, tokens, raw model output, raw prompt,
  raw diff, upstream bodies, shell output dumps, hidden files, symlinks,
  workspace archives, screenshots, binary blobs
size: strict per-field and total byte limits
retention: shortest GitHub artifact retention supported by product policy
consumer: downstream comment job revalidates schema and redaction before posting
```

If GitHub artifact retention or visibility is unacceptable for a customer tier,
use SaaS-side sanitized artifact posting with explicit product retention, or
skip comment posting and expose only an in-run safe summary.

### Action Lifecycle and Post-Step Policy

GitHub JavaScript actions can define `pre`/`post` lifecycle behavior, and
workflow commands can write values to `$GITHUB_STATE` for an action's post step.
That makes "the secret is gone from the next YAML step" an incomplete boundary.

Rules:

- after `REVIEWROUTER_CODEX_AUTH_JSON` is materialized, do not run third-party
  marketplace actions, composite actions, or JavaScript actions unless they are
  on a pinned allowlist for this mode
- prefer ReviewRouter-owned shell/binary steps after secret restore, because
  their lifecycle is visible in the generated workflow
- ReviewRouter-owned actions must not write auth, token material, proxy URL,
  nonce, HMAC material, helper tokens, OIDC tokens, raw prompt, raw diff, raw
  model output, or sanitized artifact bodies into `$GITHUB_STATE`
- any action used after secret restore must have its `action.yml` inspected in
  CI for `pre`, `post`, nested `uses`, and unexpected shell commands
- cleanup must happen in the proxy process and explicit shell traps where
  possible, not in a hidden post action that receives state from earlier steps
- generated workflows should avoid `uses:` steps after secret restore except
  for pinned ReviewRouter-owned actions whose post behavior is tested
- if a future action needs post cleanup, the post step can receive only opaque
  non-sensitive handles, never auth-derived material
- tests should fail if a generated workflow writes sensitive values to
  `$GITHUB_STATE` or uses a non-allowlisted action after secret restore

This closes a common CI blind spot: action post steps run later in the same job
and may see state that is not obvious from the main review step.

### Temp File and Cleanup Policy

Cleanup is hygiene, not the primary security control.

Rules:

- write proxy sockets, server-info files, temporary auth buffers, and sanitized
  intermediate files under `$RUNNER_TEMP`, not under the repository workspace
- create directories with mode `0700` and sensitive files with mode `0600`
- keep auth plaintext in memory whenever practical; if a temporary file is
  unavoidable, use a random path under a private temp directory and delete it
  immediately after proxy ingestion
- do not rely on `trap`, post actions, or job cleanup to make an unsafe design
  safe. The job must remain safe if the runner is killed before cleanup.
- verify temp paths are not under the artifact allowlist, cache paths, summary
  paths, or checkout workspace
- after proxy exit, best-effort cleanup removes temp files and terminates local
  listeners, then emits only safe status
- on cancellation or hard kill, next-run safety comes from lease state and
  no-artifact/no-cache policy, not from successful local deletion

### Workflow Command Injection Policy

Untrusted text printed to GitHub Actions logs can be interpreted as workflow
commands unless command processing is stopped.

Rules:

- generated secret-backed shell snippets must use `set -euo pipefail` but not
  `set -x`, `bash -x`, `npm --verbose`, or other tracing modes after secret
  restore
- never print raw model output, raw diffs, raw prompts, or raw upstream errors
  in secret-backed steps
- wrap any unavoidable untrusted diagnostic block with a random
  `::stop-commands::<token>` / `::<token>::` pair
- register `::add-mask::` values before any untrusted output is emitted
- use a fresh high-entropy stop-commands token per block and never derive it
  from PR/model-controlled text
- create annotations only through ReviewRouter safe helpers that cap message
  size, strip workflow-command syntax, strip links/images where needed, and
  allowlist file paths
- do not allow model output to write annotations, summaries, outputs, or env
  files
- test token-looking strings split across lines, JSON escapes, URL encoding,
  base64-like chunks, and ANSI/control characters

This protects against log-command injection and masking bypasses, not just
straight token echo.

### Codex Runtime Invocation

Run Codex with a disposable runtime home and defensive flags:

```bash
CODEX_HOME="$RUNNER_TEMP/reviewrouter-codex-home" \
codex exec \
  --json \
  --sandbox read-only \
  --config 'approval_policy="never"' \
  --ephemeral \
  --ignore-user-config \
  --ignore-rules \
  --disable plugins \
  --disable apps \
  --disable tool_suggest \
  -c 'web_search="disabled"' \
  -c 'check_for_update_on_startup=false' \
  -c 'history.persistence="none"' \
  -c 'feedback.enabled=false' \
  -c 'chatgpt_base_url="http://127.0.0.1:<port>/<nonce>/backend-api"' \
  -c 'model_provider="reviewrouter-codex-proxy"' \
  -c 'model_catalog_json="<static-model-catalog-json>"' \
  -c 'model_providers.reviewrouter-codex-proxy={ name = "ReviewRouter Codex Proxy", base_url = "http://127.0.0.1:<port>/<nonce>/v1", wire_api = "responses", requires_openai_auth = false }' \
  "<review prompt>"
```

Requirements:

- no repo-controlled `~/.codex/config.toml`
- no repo-controlled AGENTS/rules loaded implicitly
- no Codex plugin/app/tool-suggest remote warmup in secret-backed jobs
- no hosted `web_search` tool in secret-backed jobs unless explicitly designed
- no persistent Codex conversation history in the runner home
- no feedback submission surfaces in CI when supported by the pinned CLI
- no write access needed for review
- no approval prompts
- no provider, GitHub, OIDC, or writeback token in the subprocess env
- no direct ChatGPT backend egress from the Codex process except through the
  local proxy/sink
- worktree diff before and after Codex review must be unchanged, except for
  explicitly allowed ReviewRouter output files if any are introduced later

The exact `-c` keys are part of the pinned Codex CLI compatibility contract.
If a future CLI removes or renames these settings, the upgrade is blocked until
the equivalent security behavior is proven.

If ReviewRouter later wants to honor project instructions, it must inject a
bounded, sanitized, ReviewRouter-controlled instruction packet rather than
letting Codex load arbitrary repo config in a secret-backed job.

### Codex CLI Binary Contract and Upgrade Policy

The rotating OAuth mode depends on Codex CLI behavior that is not just
"install a package and run review". The CLI binary is part of the security
boundary because it decides which config keys are honored, which endpoints are
called, whether local provider path prefixes are preserved, whether tools are
available, and how JSONL events are emitted.

Current local/project facts:

- local `codex --version` reports `codex-cli 0.125.0`
- local `codex exec --help` exposes `--ephemeral`, `--ignore-user-config`,
  `--ignore-rules`, `--json`, `--sandbox`, `--config`, `--disable`, and
  `--ask-for-approval`
- generated workflow code currently installs `@openai/codex@0.125.0`
- `npm view @openai/codex version dist-tags --json` on 2026-05-24 reports
  `latest` as `0.133.0` and an `alpha` dist-tag, so production must not treat
  local or current workflow version as automatically current

Required compatibility record per Codex CLI version:

```text
codex_cli_version
npm_package_name
npm_dist_integrity_or_lock_hash
platform_package_or_binary_id
node_version
help_snapshot_hash
exec_help_snapshot_hash
required_flag_matrix
config_key_matrix
custom_provider_contract_hash
jsonl_event_schema_hash
network_egress_fixture_hash
model_catalog_fixture_hash
approved_review_workload_fixture
release_channel
compatibility_state
```

Rules:

- no `@openai/codex@latest`, alpha/beta/native dist-tags, or unpinned platform
  package tags in secret-backed workflows
- no upgrade from `0.125.0` to `0.133.0` or any later version without rerunning
  the full compatibility suite
- package resolution and install occur before auth secret materialization
- package-manager lifecycle scripts are either avoided through prebuilt
  verified artifacts or proven not to execute repo-controlled code
- `codex --version`, `codex exec --help`, required hardening flags, and config
  overrides are recorded in a sanitized artifact before the review secret is
  restored
- version mismatch between generated workflow, compatibility registry, runtime
  preflight, and actual `codex --version` fails before secret restore
- JSONL event parser is versioned; unknown event types or schema drift fail
  closed before posting comments or writeback
- network fixture tests must prove no unexpected remote egress outside the
  local proxy/sinks for the hardened invocation
- the model catalog fixture must be derived from the pinned CLI behavior, not
  copied blindly from an older spike

Top 3 upgrade strategies:

1. Exact pinned CLI plus compatibility registry -
   🎯 9 / 10 🛡️ 9 / 10 🧠 6 / 10
   Approx changes: 300-800 LOC.
   Recommended. It keeps user workflows predictable and allows controlled
   upgrades without treating npm `latest` as safe.

2. Bundle a ReviewRouter-tested Codex binary/proxy artifact -
   🎯 8 / 10 🛡️ 9 / 10 🧠 8 / 10
   Approx changes: 900-2200 LOC plus release infrastructure.
   Stronger reproducibility, but ReviewRouter owns more distribution and
   platform-specific verification surface.

3. Install npm `latest` and rely on runtime smoke -
   🎯 5 / 10 🛡️ 4 / 10 🧠 3 / 10
   Approx changes: 100-300 LOC.
   Not recommended. The first breakage would happen in customer CI, possibly
   after secrets are materialized.

### Shell Command Policy

Codex review mode should be read-only analysis, not arbitrary CI execution.

Default policy:

- allow filesystem inspection commands needed for review
- avoid running repo package scripts, tests, build scripts, install scripts, or
  arbitrary project CLIs after secrets are restored
- if test execution is required later, run it in a separate no-secret job and
  pass only sanitized results into Codex
- no outbound network from shell tools unless a future spike proves a safe
  network profile
- no access to `GITHUB_TOKEN`, helper tokens, HMAC keys, auth JSON, writeback
  session tokens, or setup session tokens
- fail closed when Codex requests escalated permissions or write access

Reason:

Even without plaintext auth, untrusted repository code can still exfiltrate
proxy URLs, spend quota within the allowed budget, leak repository context, or
poison logs/artifacts if allowed to execute freely.

### Review Input Scope and Large Diff Policy

Review input is another control plane. If it is incomplete, too large, or
ambiguous, the user should see a scope-limited review rather than a confident
full-review result.

Collector rules:

- collect PR metadata, file list, and diff scope before secret restore where
  possible
- record immutable `base_sha`, `head_sha`, merge/ref choice, and collection
  method
- use paginated GitHub APIs or local `git diff --name-status`/`git diff --numstat`
  with explicit limits; never assume the first API page is the full PR
- cap total files, total changed lines, total raw diff bytes, per-file diff
  bytes, and total model input tokens
- classify skipped files by safe reason: binary, too_large, generated,
  vendored, deleted_only, rename_only, submodule, symlink, lfs_pointer,
  unsupported_encoding, path_policy, file_count_limit, token_budget
- normalize paths and reject absolute paths, `..`, NUL bytes, Windows drive
  prefixes, control characters, and paths outside the repository root
- do not follow symlinks when collecting review input
- do not fetch LFS content or submodule content in v1
- for renamed files, review the new path and include old path as safe metadata
  only when needed for comment placement
- for deleted files, review deletion context only when diff is available and
  do not attempt to read the deleted path from the worktree
- for generated or vendored files, skip by default unless repository config
  explicitly includes them before secret restore
- if GitHub API or local diff collection reports truncation, surface
  `review_scope_limited` in health and final policy mapping
- raw diffs are not sent to SaaS; only safe scope metadata and sanitized
  findings leave the runner

Prompt construction rules:

- build a bounded ReviewRouter-controlled review packet, not an unbounded
  concatenation of diff text
- include scope metadata so Codex knows which files are intentionally skipped
- include only repository-local normalized paths
- chunk large reviews deterministically if chunking is implemented; chunking
  must share the same lease/proxy budget and cannot retry accepted model
  requests silently
- if the diff exceeds the configured review budget, prefer a partial review
  with explicit scope copy over a failed secret-backed run, unless the customer
  uses strict mode

Final policy mapping:

| Scope state                            | Advisory                     | Required                     | Strict  |
| -------------------------------------- | ---------------------------- | ---------------------------- | ------- |
| complete review                        | success                      | success                      | success |
| scope-limited by configured budget     | neutral                      | neutral or success by config | failure |
| scope-limited by GitHub/API truncation | neutral                      | neutral with warning         | failure |
| collector invariant failure            | neutral or failure by config | failure                      | failure |

This separates review completeness from auth health. A huge PR should not tell
the user to reconnect Codex, and an auth refresh should not hide that only part
of the PR was reviewed.

### Review Input Secret Redaction and Data Disclosure Policy

The auth design protects Codex OAuth plaintext from ReviewRouter SaaS. It does
not automatically protect secrets that a pull request itself introduces. The
review packet sent from the customer's GitHub runner to Codex/OpenAI must be
treated as customer code disclosure and scanned before any model request.

Disclosure rules:

- dashboard and setup copy must clearly state that bounded review content is
  sent from the customer runner to the customer's Codex/OpenAI account
- copy must also state that ReviewRouter SaaS does not receive raw diffs,
  raw prompts, raw model output, or Codex auth plaintext in this mode
- user must connect an OpenAI/ChatGPT workspace that is allowed to process the
  repository data under the customer's own workspace policies
- if the customer requires no external model processing for a repository, this
  provider mode is not appropriate and setup must refuse or require a different
  provider

Pre-model scanning rules:

- scan the exact bounded review packet before it is passed to Codex
- scan diff hunks, added lines, file names, metadata strings, generated
  context, and any ReviewRouter instruction packet fields
- detect at least private keys, SSH keys, PEM/certificate-looking blocks,
  JWT-like tokens, OAuth/access/refresh tokens, API-key-looking values, cloud
  credentials, database URLs, webhook secrets, HTTP auth headers, `.env` style
  assignments, npm/pypi/rubygems tokens, and GitHub tokens
- keep the scanner local to the runner and deterministic for the pinned
  workflow version
- run the same redaction pass before final comments, artifacts, logs, memory,
  SaaS telemetry, and support exports
- do not rely only on GitHub masking, because GitHub warns structured secrets
  are harder to redact reliably in logs
- do not rely only on GitHub secret scanning or push protection, because its
  coverage depends on product tier, repository type, enabled settings,
  supported patterns, token age, pattern pairs, and push size

Redaction format:

```text
[REDACTED_SECRET:<class>:<confidence>:<stable_id>]
```

Rules for the placeholder:

- `stable_id` is a keyed non-reversible digest scoped to the run, repository,
  and finding class
- raw secret bytes are never sent to SaaS, Codex/OpenAI, logs, comments,
  artifacts, memory, metrics, or support exports
- repeated occurrences of the same secret in one run get the same placeholder
  so the model can reason about duplication without seeing the value
- low-confidence token-like strings are redacted by default in model input but
  reported as possible false positives in safe metadata
- the model may receive the file path, line range, secret class, confidence,
  and safe remediation guidance, but not the value

Review behavior:

| Secret scan state                        | Advisory                                                    | Required                        | Strict                       |
| ---------------------------------------- | ----------------------------------------------------------- | ------------------------------- | ---------------------------- |
| no secrets detected                      | normal review                                               | normal review                   | normal review                |
| high-confidence secret redacted          | review redacted packet, emit security finding without value | same, optionally fail by policy | fail or block by policy      |
| low-confidence token-like value redacted | review redacted packet with safe note                       | neutral or success by config    | neutral or failure by config |
| scanner budget exceeded                  | `review_scope_limited`                                      | neutral or failure by config    | failure                      |
| unparseable secret-bearing file          | skip file with `security_scan_blocked`                      | failure by config               | failure                      |

The important product behavior is that a suspected leaked secret still creates
an actionable finding, but the finding says "a GitHub token-like value was added
at path:line" rather than repeating the token.

Optional GitHub integration:

- if the customer grants security/secret-scanning read permissions, ReviewRouter
  can consume alert metadata to enrich dashboard state
- this integration must not be required for v1 auto-refresh
- secret scanning alert URLs, types, states, and counts are safe metadata only
  after path and text sanitization
- do not fetch or store raw committed secret values through GitHub APIs

### Process Output Backpressure Policy

Every subprocess in the secret-backed job needs bounded output.

Rules:

- capture stdout/stderr through a bounded buffer with byte and line limits
- never stream raw tool output directly to GitHub logs after secret restore
- redact before writing any diagnostic line
- stop reading and terminate the process if output exceeds hard limits
- classify output overflow as `review_scope_limited`, `skipped_retryable`, or
  safe review failure depending on whether refresh started and whether the
  model/tool request was accepted
- store only safe tail summaries or hashes for diagnostics, not full output
- do not pass oversized shell output into memory endpoints or sanitized review
  artifacts
- ANSI escapes, control characters, workflow-command-shaped text, long single
  lines, invalid UTF-8, and binary output must be escaped or dropped before
  logs/artifacts/comments
- debug logging variables such as `ACTIONS_STEP_DEBUG` and
  `ACTIONS_RUNNER_DEBUG` should be detected and warned/blocked for
  secret-backed mode according to product policy

This prevents a read-only command like `find` or `cat` from becoming a
resource-exhaustion path or a second exfiltration channel.

### Review Output and PR Comment Policy

Codex output is untrusted until sanitized. The product may need to post review
comments, but it must not treat raw model output as safe telemetry or safe
Markdown.

Rules:

- prefer a structured review schema over free-form Markdown
- validate every finding field before posting or storing
- allow only repository-local file paths and valid diff line references
- cap number of findings, body length, code block length, and total comment
  size
- strip or escape raw HTML, images, external links, autolinks, hidden comments,
  task-list commands, and table abuse unless explicitly needed
- neutralize `@mentions`, issue/PR autolinks, and workflow-command-shaped text
- run the same token/redaction patterns over final comments before posting
- never post raw prompt, raw diff, raw upstream body, raw proxy error, auth file
  paths, token claims, or diagnostic dumps
- store only the sanitized review artifact needed for product UX and audit,
  with a bounded retention period
- if sanitization fails, post a short safe failure summary or no comment

Posting model output has three possible shapes:

```text
preferred runner split:
  codex-review job has no PR/issue write permission
  -> Codex exits
  -> sanitized review artifact is produced
  -> post-review-comment job starts with PR/issue write permission
  -> artifact is validated again
  -> comment is posted

same-job runner posting:
  Codex exits
  -> sanitized review artifact is produced
  -> posting step runs later in the same job
  -> this is weaker because GITHUB_TOKEN is job-scoped and github.token exists
     for the job

SaaS posts comments:
  runner sends only sanitized structured review artifact
  -> SaaS never receives raw prompt, raw diff, raw model stream, auth state, or
     proxy diagnostics
  -> SaaS renderer applies the same Markdown allowlist and redaction pass
```

Decision:

1. Preferred two-job runner posting - 🎯 9 🛡️ 9 🧠 6
   Approx changes: 250-600 LOC.
   Best default because Codex and comment-write permission never share a job.

2. SaaS posts sanitized comments - 🎯 7 🛡️ 8 🧠 7
   Approx changes: 500-1100 LOC.
   Good for centralized UX, but SaaS receives review artifacts and owns more
   GitHub comment behavior.

3. Same-job delayed posting - 🎯 6 🛡️ 5 🧠 4
   Approx changes: 100-250 LOC.
   Only acceptable as an internal spike shortcut. It is not the production
   default because job-scoped `GITHUB_TOKEN` weakens step-order isolation.

Do not rely on the model to "only output JSON" as a security boundary. Treat
schema validation, path validation, diff-line validation, link policy, mention
neutralization, and final redaction as mandatory post-processing.

Review output is a user-facing artifact, not a license to store raw model
responses. This policy keeps prompt injection from turning PR comments into a
secondary exfiltration or social-engineering channel.

### Result Freshness, Comment Dedupe, and Posting Backpressure Policy

The review artifact is safe only for the exact PR state it was built from. A
slow workflow, manual re-run, force-push, or merge-queue run can otherwise post
stale comments after the PR has changed.

Artifact identity:

```text
repo_id
pr_number
base_sha
head_sha
event_name
run_id
run_attempt
workflow_ref
workflow_sha
review_scope_hash
sanitized_artifact_hash
posting_key = repo_id:pr_number:head_sha:provider_mode:artifact_hash
```

Posting rules:

- before posting, fetch the current PR and compare current `head.sha` with the
  artifact `head_sha`
- if the PR is closed, merged, converted to draft by policy, or has a different
  head SHA, do not post inline findings
- stale artifacts may update a single ReviewRouter-owned summary comment to
  say the result was skipped as outdated, or may post nothing according to
  repository policy
- merge-group runs should produce the final policy check only; do not post PR
  comments unless the run has a proven PR number/head mapping
- every posted summary comment must contain a ReviewRouter-owned safe marker
  added by the renderer, never by the model
- the marker may include only safe metadata: provider mode, schema version,
  repo id hash, PR number, head SHA, artifact hash, and posting key
- the renderer may use the marker to update the existing latest ReviewRouter
  comment instead of creating duplicates
- inline comments use finding-level dedupe keys so re-runs do not repeat the
  same comment on the same path/line/head/finding hash
- if a previous ReviewRouter comment exists for an older head, default behavior
  is to leave it untouched or mark it superseded in the summary; do not delete
  user discussion threads automatically

Posting backpressure:

- cap inline comments per run and collapse overflow into the summary
- cap GitHub API calls and stop on secondary rate-limit or abuse-throttle
  signals
- if GitHub rejects an inline location because the line is no longer in the
  diff, do not retry against a guessed line; downgrade that finding to the
  summary or skip it
- comment posting failure must not trigger auth reconnect guidance
- final policy mapping must distinguish review failure from comment-posting
  failure, because a review can be complete even if comments are rate-limited

State mapping:

| Posting state               | Meaning                                                | Policy impact                       |
| --------------------------- | ------------------------------------------------------ | ----------------------------------- |
| `posted`                    | current head matched and comments/check summary posted | normal                              |
| `updated_existing`          | same posting key updated safely                        | normal                              |
| `skipped_outdated`          | artifact head no longer matches PR head                | neutral or failure by strict policy |
| `skipped_merge_group`       | merge queue run had no safe PR comment target          | final check only                    |
| `posting_rate_limited`      | GitHub limited comment API writes                      | review complete, comment degraded   |
| `posting_location_failed`   | inline line no longer accepts a comment                | summary fallback or skip            |
| `posting_validation_failed` | artifact or marker failed validation                   | failure in required/strict          |

This keeps ReviewRouter from becoming noisy. A review bot that leaves stale or
duplicated comments is functionally broken even when the OAuth refresh path is
correct.

### Reusable Workflow Considerations

If this mode runs through a reusable workflow:

- caller still owns event, permissions, and secret mapping
- called workflow cannot elevate caller token permissions
- environment secrets do not pass through `workflow_call`
- OIDC validation must bind `job_workflow_ref`
- production references should use a release tag or commit SHA, not a mutable
  branch

Source: [GitHub reusable workflow reference](https://docs.github.com/en/enterprise-cloud@latest/actions/reference/workflows-and-actions/reusing-workflow-configurations),
[reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[workflow syntax for `workflow_call` secrets](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
and [OIDC with reusable workflows](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows)

Additional facts:

- caller repository Actions settings must allow the called reusable workflow,
  and the called private/internal repository must allow caller access
- only supported keywords are allowed on a job that calls a reusable workflow;
  setup must not assume a normal job can be patched after `uses:`
- if caller `permissions` are omitted, the called workflow receives the caller
  repository default `GITHUB_TOKEN` permissions
- called workflows can only maintain or reduce `GITHUB_TOKEN` permissions from
  the caller; they cannot elevate a missing permission
- `secrets: inherit` can pass all secrets available to the caller job. Rotating
  OAuth must use explicit secret mapping instead.
- a secret passed to a nested reusable workflow must be passed again through
  `jobs.<job_id>.secrets`; secrets are not an implicit global capability across
  nested workflow chains
- the called workflow gets `github.token` and `secrets.GITHUB_TOKEN` associated
  with the caller workflow context
- GitHub-hosted runner assignment and billing are evaluated from the caller's
  context; the called workflow cannot use hosted runners from its own
  repository
- reusable workflow OIDC tokens include caller workflow claims and, for called
  workflows, `job_workflow_ref` for the reusable workflow. `job_workflow_sha`
  should be treated as mandatory for strict exact-SHA channels when available.

Current local code reality:

- `workflow-template.ts` renders reusable review/interaction/conflict callers
  with explicit secret mappings such as `CODEX_AUTH_JSON`, `CODEX_CONFIG_TOML`,
  `OPENAI_API_KEY`, and provider tokens; it does not currently render
  `secrets: inherit`
- the current reusable caller can pass legacy static `CODEX_AUTH_JSON`; the
  rotating workflow schema must use a new secret name and reject legacy reusable
  callers that still expose broad static provider secrets
- local action-control-plane tests already exercise trusted
  `job_workflow_ref` cases for current action protocol; rotating OAuth needs a
  separate v2 validator and no-secret fixture matrix for direct, reusable exact
  SHA, reusable tag, and blocked branch refs

Reusable rotating rules:

- generated reusable callers must map only required secrets by name:
  `REVIEWROUTER_CODEX_AUTH_JSON` for the secret-backed review job and no Codex
  OAuth secret for interaction, conflict, memory, setup, or comment jobs unless
  a later schema explicitly enables those paths
- `secrets: inherit` is rejected by the workflow scanner for any rotating
  provider mode
- caller job `permissions` must be explicit and minimal. If the called workflow
  needs `id-token: write`, `contents: read`, or comment-posting permissions for
  a separate sanitized job, the caller must state them. The called workflow
  cannot rely on repository defaults.
- called workflow jobs that materialize auth must not define `environment:` and
  must reject environment-secret shadowing
- reusable workflow outputs must contain only safe status ids and artifact
  hashes, never review payloads, auth-adjacent material, raw model output, raw
  prompt, raw diff, proxy URL, nonce, helper token, HMAC material, or OIDC
  token material
- nested reusable workflow chains are blocked for rotating v1 unless every hop
  is ReviewRouter-owned, exact-pinned or compatibility-approved, explicitly
  passes only allowlisted secrets, and emits OIDC claims that bind the final
  called workflow identity

Top 3 reusable workflow options:

1. Explicit reusable caller contract with OIDC caller/callee attestation -
   🎯 9 / 10 🛡️ 9.5 / 10 🧠 7 / 10
   Approx changes: 650-1500 LOC.
   Recommended. It gives the convenient client CI/CD path without letting
   `secrets: inherit`, default token permissions, or moving reusable refs become
   implicit trust.

2. Use explicit non-reusable workflow only for rotating OAuth v1 -
   🎯 8 / 10 🛡️ 9 / 10 🧠 5 / 10
   Approx changes: 250-800 LOC.
   Safer and simpler for launch, but worse maintainability for customer CI
   integration and slower runtime upgrades.

3. Allow `secrets: inherit` and rely on called workflow validation -
   🎯 5 / 10 🛡️ 4 / 10 🧠 3 / 10
   Approx changes: 100-300 LOC.
   Not recommended. It is convenient but violates least privilege and can pass
   unrelated org/repo/environment secrets into the called workflow surface.

### Product Feature Interaction Scope

The first auto-refresh OAuth release is for the PR review path only.

Existing ReviewRouter product paths need explicit treatment:

| Path                                    | v1 auto-refresh behavior                                                                             | Reason                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| PR review                               | supported after all gates pass                                                                       | this is the primary workflow this plan designs                                  |
| Required final policy check             | supported                                                                                            | consumes safe state only, not auth                                              |
| PR comment posting                      | supported only in downstream comment job or SaaS sanitized mode                                      | keeps PR/issue write permission away from Codex                                 |
| Interaction/discussion replies          | blocked for auto-refresh v1 unless separately redesigned                                             | current interaction flow needs PR/issue write and may run Codex in the same job |
| Conflict review / `repository_dispatch` | blocked for auto-refresh v1 unless nonce, OIDC, and event trust are separately proven                | dispatch payloads and fallback flows have a different trust model               |
| Review memory runtime                   | allowed only for safe metadata/memory snippets before secret restore, not raw auth/diff/model output | memory is a separate persistence surface                                        |
| Reusable workflow caller                | allowed only with exact trusted `job_workflow_ref` and explicit secret mapping                       | caller controls permissions and secret exposure                                 |
| Legacy static `CODEX_AUTH_JSON`         | still supported but labelled manual refresh                                                          | migration and rollback path                                                     |

Rules:

- dashboard must not show "auto-refresh enabled" for discussion or conflict
  workflows until their generated workflow schema supports the same boundaries
- if a repo has discussion replies enabled, setup should either keep that path
  on legacy static mode with clear copy or disable Codex OAuth discussion for
  this provider mode
- any job with `pull-requests: write`, `issues: write`, `actions: write`, or
  `contents: write` must not receive `REVIEWROUTER_CODEX_AUTH_JSON`
- memory endpoints must receive only bounded safe retrieval hints and sanitized
  findings, never raw prompts, diffs, auth, proxy URLs, nonces, tokens, or model
  streams
- conflict review fallback must not pass the rotating OAuth secret through
  `repository_dispatch` client payloads or untrusted artifacts
- repository health must report per-path capability: review auto-refresh active,
  interaction unsupported, conflict unsupported, memory safe/disabled

This prevents a partial implementation from hardening the main review job while
leaving a side workflow with the old "auth in job that can comment" shape.

## OAuth Proxy Design

### Responsibilities

The proxy owns:

- parsing restored `auth.json`
- validating managed ChatGPT auth shape
- holding plaintext tokens in memory
- adding ChatGPT backend auth headers
- refreshing token bundle when stale
- retrying once after 401 when refresh succeeds
- encrypting updated auth for GitHub Actions secret storage
- sending encrypted writeback payload to ReviewRouter SaaS
- exposing safe health and metrics

The proxy does not own:

- GitHub secret write credentials
- posting PR comments
- reading repository code
- deciding PR trust policy alone
- storing plaintext auth on disk

### Process Input

Start the proxy with auth via stdin, not env:

```bash
printenv REVIEWROUTER_CODEX_AUTH_JSON | \
  env -u REVIEWROUTER_CODEX_AUTH_JSON reviewrouter-codex-oauth-proxy ...
```

Then unset/mask the variable for all later steps.

GitHub Actions still injects the secret into the bootstrap step through
`secrets.*`, usually as an environment variable or action input. The security
contract is narrower:

- only the bootstrap step receives it
- `set -x` is disabled
- the value and token substrings are registered with `::add-mask::` before any
  other output
- the proxy consumes it immediately through stdin or file descriptor
- every later step runs with the secret removed from env
- `codex exec` never receives it

### Process Hardening

Match or exceed the security posture of `openai/codex-action` proxy:

- avoid keeping auth in environment variables
- read helper tokens through stdin or an inherited file descriptor where
  practical, not long-lived env
- disable core dumps where supported
- mark process non-dumpable on Linux where supported
- avoid debug endpoints in production
- avoid request and response body dumps
- avoid logging Authorization, account id if too sensitive, token claims, or
  raw upstream errors containing token text
- bind only to `127.0.0.1`
- choose a random high port
- generate a random per-run nonce
- require the nonce on every local proxy request, preferably through an
  unguessable path prefix because Codex custom provider headers may not be
  configurable
- reject missing or wrong nonce before reading the full body
- treat nonce as protection against unrelated local processes and accidental
  calls, not as a full prompt-injection boundary. Codex runtime config may
  reveal the proxy URL to shell tools.
- write server info and nonce path with mode `0600`
- run before `drop-sudo` or under an unprivileged user as appropriate
- no unauthenticated `/shutdown` endpoint
- delete temp auth material and server info on normal exit
- avoid uploading proxy temp directories as artifacts
- enforce max request body bytes, max response body bytes, max upstream calls,
  max tool turns, max tokens, and max elapsed runtime
- make request/body limits account for the observed baseline Codex payload
  size, currently tens of KB before any real diff is included
- if shell network isolation is not possible, assume malicious tool commands can
  call the allowlisted proxy path and rely on strict allowlist, budget, and no
  plaintext endpoints
- handle SIGTERM and job cancellation by immediately stopping new requests,
  cancelling/closing upstream streams, flushing safe lease status, and exiting
  before GitHub job timeout escalates to hard kill where possible

### Linux Process and Procfs Boundary

The proxy and Codex runtime are sibling processes on a GitHub-hosted runner.
Even when the proxy holds tokens only in memory and the Codex child receives a
clean environment, model-controlled tools may still inspect process metadata
and filesystem surfaces exposed by the same OS account.

Assumed attacker probes:

```text
ps auxww
cat /proc/*/environ
cat /proc/*/cmdline
ls -la /proc/*/fd
readlink /proc/*/fd/*
cat /proc/net/tcp /proc/net/tcp6
lsof -nP
find "$RUNNER_TEMP" -maxdepth 5 -type f -print
gcore / ptrace attempts where available
core dump generation
curl 127.0.0.1:<port> without nonce or to non-data-plane paths
```

Required controls:

- no token, auth JSON, helper token, HMAC material, writeback token, restore
  grant, OIDC request token, or raw proxy admin URL may appear in any process
  argv or environment
- every non-stdio file descriptor not needed by Codex is closed before
  launching Codex or any model-controlled subprocess
- sensitive file descriptors in proxy/bootstrap use close-on-exec by default
- proxy process is marked non-dumpable on Linux where supported, and core dumps
  are disabled before auth is read
- private control roots use mode `0700`; files containing server info, restore
  grant metadata, or transient bootstrap material use mode `0600`
- Codex runtime home and sanitized review root are not parents or siblings that
  contain proxy/control roots; no symlink from review root can reach control
  roots
- server-info files exposed to Codex contain only the nonce-prefixed data-plane
  URL, never admin/control paths, PIDs, lease ids, helper tokens, or filesystem
  paths to control roots
- process and procfs sentinel tests run after proxy start and before model
  request; any sensitive sentinel visible through `ps`, `/proc`, FDs, temp
  paths, logs, summaries, or artifacts blocks the runner image in the
  compatibility registry

Top 3 process-isolation options:

1. Same-job Linux hardening plus procfs/FD sentinel harness - 🎯 8.5 / 10
   🛡️ 8.5 / 10 🧠 7 / 10

   Approx changes: 900-2200 LOC production-grade.

   Recommended for v1 only if the spike proves GitHub-hosted Linux behavior is
   stable across runner image updates. It keeps UX simple while making the
   actual same-user process boundary testable.

2. Separate container/namespace for Codex runtime - 🎯 8 / 10
   🛡️ 9 / 10 🧠 8.5 / 10

   Approx changes: 1800-4500 LOC plus runner compatibility work.

   Stronger isolation if GitHub-hosted container semantics can be proven, but
   it adds mount/network/user-namespace complexity and may fight Codex sandbox
   expectations.

3. Disable shell/tools and run Codex in model-only mode - 🎯 7 / 10
   🛡️ 8 / 10 🧠 6 / 10

   Approx changes: 600-1400 LOC plus product capability loss.

   It reduces same-run probing, but weakens review quality and still requires
   process-boundary tests for the Codex process itself.

If none of these pass on GitHub-hosted Linux, the no-VPS OAuth proxy mode must
stay internal and users needing auto-refresh should use the self-hosted
persistent `CODEX_HOME` fallback.

### Proxy Capability Separation

The proxy has two very different jobs:

```text
data plane: accept Codex model-provider Responses requests
control plane: manage refresh, lease, public-key fetch, encryption, writeback
```

These must not share an HTTP routing surface.

Recommended implementation:

1. **Single proxy process, data-plane-only HTTP listener**

   ```text
   🎯 9 / 10   🛡️ 9 / 10   🧠 6 / 10
   Approx changes: 500-1200 LOC.
   ```

   The HTTP listener visible to Codex exposes only nonce-prefixed Responses
   endpoints. Refresh/writeback/public-key/lease operations are internal
   functions using in-memory state and private file descriptors. This is the
   default recommendation.

2. **Single HTTP listener with hidden admin routes and admin token**

   ```text
   🎯 7 / 10   🛡️ 5 / 10   🧠 4 / 10
   Approx changes: 250-600 LOC.
   ```

   Smaller, but a routing bug, logging bug, CORS/method bug, or token leak can
   expose control-plane capability to the model process. Do not use for
   production rotating OAuth.

3. **Separate auth broker process plus dumb Responses proxy**

   ```text
   🎯 8 / 10   🛡️ 9 / 10   🧠 8 / 10
   Approx changes: 1200-2500 LOC.
   ```

   Strong isolation, but more process lifecycle and cancellation complexity.
   Keep as fallback if the single-process design cannot pass malicious prompt
   and cancellation spikes.

Capability matrix:

| Capability                     | Holder                              | Transport                                            | Visible to Codex/tools |
| ------------------------------ | ----------------------------------- | ---------------------------------------------------- | ---------------------- |
| model-provider URL and nonce   | Codex runtime config                | temp `config.toml`                                   | yes                    |
| OAuth access/refresh/id tokens | proxy process memory                | stdin/file descriptor at bootstrap                   | no                     |
| writeback session token        | proxy process memory                | private file descriptor or in-memory session         | no                     |
| GitHub public-key helper token | proxy bootstrap or proxy memory     | private file descriptor or short-lived internal call | no                     |
| lease id and generation hash   | proxy memory and SaaS safe metadata | action session/control-plane API                     | no raw token material  |
| budget policy                  | signed safe config                  | action-control-plane response                        | safe subset only       |
| shutdown signal                | parent job/process supervisor       | OS signal/process lifecycle                          | no HTTP endpoint       |
| safe health output             | action runtime after proxy exit     | bounded JSON file or API call                        | safe metadata only     |

Rules:

- no `/refresh`, `/writeback`, `/public-key`, `/lease`, `/health`, `/debug`,
  `/metrics`, `/shutdown`, `/admin`, or `/config` endpoint on the data-plane
  listener
- no "hidden" admin route protected only by nonce, header, query parameter, or
  bearer token on the data-plane listener
- no route should disclose whether refresh token exists, what account/workspace
  is connected, token expiry, upstream headers, lease token, helper token, HMAC
  material, or writeback status
- the data-plane listener can return only OpenAI Responses-compatible success
  bodies or safe OpenAI-shaped error bodies with ReviewRouter safe reason codes
- missing nonce, wrong nonce, wrong method, query string, unsupported path,
  unsupported header, and oversized body are rejected before body buffering
  where possible
- CORS is disabled; preflight requests are rejected unless a future Codex
  client contract requires them
- HTTP redirects are disabled; the proxy never redirects to upstream or local
  control endpoints
- request smuggling defenses should normalize path, method, headers, transfer
  encoding, and content length before routing
- safe health/metrics should be emitted out-of-band after proxy exit or through
  ReviewRouter-owned control-plane calls, not through the Codex-visible
  listener

Responses body firewall:

- enforce exact allowed model ids from the static model catalog
- reject hosted tool types such as web search, file search, code interpreter,
  computer use, MCP, image generation, audio, realtime, or remote file APIs
  unless a separate product design enables them
- reject unexpected `include`, `attachments`, file ids, vector store ids,
  remote connector fields, or provider-specific escape hatches
- cap JSON depth, array length, string length, total body bytes, streaming
  output bytes, and event count
- classify a direct but otherwise valid `/v1/responses` call as
  `direct_data_plane_call` for telemetry and budget accounting, not as an auth
  incident
- never let a data-plane request invoke refresh proactively; proactive refresh
  happens only at proxy startup or before first normal Codex request after
  writeback readiness has already been proven

Important assumption:

The nonce URL is discoverable. Codex can read its own runtime config or a tool
can infer command-line/config state. Therefore the nonce protects against
accidental unrelated local traffic and stale processes, not against a malicious
prompt with shell access.

### Codex Custom Provider Config

Create a temp `CODEX_HOME` for Codex runtime:

```text
$RUNNER_TEMP/reviewrouter-codex-home
```

Write only `config.toml`.

This is illustrative. The exact model id and static model catalog shape must be
resolved from the pinned Codex CLI version during implementation.

```toml
model_provider = "reviewrouter-codex-oauth-proxy"
model = "<codex-review-model>"

[model_providers.reviewrouter-codex-oauth-proxy]
name = "ReviewRouter Codex OAuth Proxy"
base_url = "http://127.0.0.1:12345/<nonce>/v1"
wire_api = "responses"
requires_openai_auth = false
model_catalog_json = '''
{
  "object": "list",
  "data": [
    {
      "id": "<codex-review-model>",
      "object": "model",
      "created": 0,
      "owned_by": "openai"
    }
  ]
}
'''
```

Notes:

- exact model catalog shape must be tested against the pinned Codex CLI version
- do not name provider `OpenAI` or `Azure`
- do not set `requires_openai_auth = true`
- do not set `env_key`
- do not write `auth.json` into this runtime `CODEX_HOME`

### Endpoint Allowlist

Paths below are normalized after the nonce prefix is stripped. Raw requests
must arrive under:

```text
/<nonce>/...
```

Initial allowlist:

```text
POST /v1/responses
```

Conditional after E2E proof:

```text
POST /v1/responses/compact
```

Explicitly deny:

```text
GET /v1/models
POST /v1/files
GET /v1/files/*
POST /v1/images/*
WebSocket endpoints
Realtime endpoints
MCP endpoints
plugin endpoints
analytics endpoints
unknown paths
query strings unless explicitly required
```

Local-only compatibility sinks:

```text
GET /backend-api/plugins/featured -> safe empty response, no upstream egress
```

Only add such sinks after a spike proves Codex still tries the path under a
hardened invocation. They are compatibility stubs, not proxy pass-throughs.

Rationale:

- static `model_catalog_json` should avoid `/models`
- custom provider should avoid OpenAI/Azure remote compaction behavior
- file upload and remote tool features expand token exposure and quota risk
- ReviewRouter review does not need broad Codex app features

### Streaming and Upstream Retry Policy

The proxy must support both non-streaming JSON responses and streaming
server-sent events if the pinned Codex CLI uses streaming.

Streaming rules:

- pass streaming chunks through without logging raw event bodies
- enforce stream duration, idle timeout, event count, byte count, token budget,
  and tool-turn budget
- hash upstream `response.id` or equivalent identifiers before telemetry
- close upstream stream when Codex disconnects or the job is cancelled
- classify stream disconnect after first upstream event as review failure, not
  as auth state corruption unless refresh was also in progress
- never upload partial stream bodies as artifacts or support diagnostics

Retry rules:

- do not retry a `POST /v1/responses` request after the request body may have
  reached upstream, unless an idempotency key contract is proven for the pinned
  upstream path
- do not retry after an SSE stream has started
- a clean upstream `401` before response creation may trigger the refresh path
  once, then retry the original request once after writeback confirmation
- network failure before any bytes are written upstream is retryable within the
  normal request budget
- network failure after bytes are written upstream is not retried automatically
  by the proxy
- if Codex CLI itself retries, the proxy must still enforce per-run request and
  budget limits

This avoids accidental duplicate reviews, duplicate tool-call loops, and quota
surprises.

### Upstream Request Headers

The proxy injects:

```text
Authorization: Bearer <access_token>
ChatGPT-Account-ID: <account_id when present>
X-OpenAI-Fedramp: true when token claims require it
```

The proxy strips inbound:

```text
Authorization
OpenAI-*
ChatGPT-Account-ID
X-OpenAI-Fedramp
Host
Connection
Proxy-*
```

It also rejects requests that attempt to smuggle token-like material through
headers, query strings, or unexpected JSON fields. Rejection logs should include
only a safe reason code and size metadata.

The proxy should preserve safe Codex client headers only if needed by upstream
and tested.

### Upstream Base URL

Default upstream for managed ChatGPT Codex responses:

```text
https://chatgpt.com/backend-api/codex
```

Expected response path:

```text
https://chatgpt.com/backend-api/codex/responses
```

This must be validated in the spike against the pinned Codex CLI version.

### Refresh Strategy

Refresh before first upstream call when:

```text
last_refresh missing
last_refresh older than configured threshold
access token already expired or near expiry
```

Default threshold:

```text
7 days
```

Codex source currently uses roughly 8 days. Use 7 days in proxy to refresh
slightly earlier and reduce first-request 401s.

Refresh preconditions:

Before any refresh attempt, including proactive refresh and 401-triggered
refresh, the proxy must prove writeback readiness:

```text
active lease still valid
restored generation still current
lease has enough TTL left for refresh + encryption + GitHub writeback
SaaS writeback endpoint reachable
GitHub public key capability available
current GitHub public key fetched or fetch can be retried safely
provider not suspended by kill switch or policy
provider/org/account not over ReviewRouter safety budget
```

If preconditions fail before the refresh request is sent, do not refresh. Fail
the run safely as `active` or `skipped_retryable`, because the saved secret has
not been rotated by this run.

Refresh after upstream 401:

```text
receive 401
-> acquire in-process refresh mutex
-> re-check current token generation
-> prove the 401 happened before response creation or stream start
-> refresh once
-> encrypted writeback barrier
-> retry original upstream request once
```

Never call refresh concurrently inside one proxy process.

Ambiguous refresh rule:

If the refresh HTTP request may have reached upstream but the proxy does not
receive a definitive response, for example timeout after request write,
connection reset, process kill, or malformed response after a 2xx/3xx boundary,
classify the provider as `unknown_auth_state`. The upstream may have rotated
the refresh token even though the proxy did not receive the new auth JSON.

Clock rule:

- parse token expiry locally only for refresh timing
- never store raw JWT claims in SaaS telemetry
- use skew-tolerant expiry checks
- if runner clock appears badly skewed, fail before refresh and report
  `runner_clock_skew` rather than making expiry decisions from bad time

### Refresh Endpoint Ownership

Preferred production implementation:

- either reuse Codex's managed refresh code through a small Rust crate/binary if
  feasible and license-compatible
- or implement the same managed refresh behavior only after source-level proof
  and strict tests

Do not invent a generic OAuth flow.

Do not expose refresh endpoint details in user docs.

### Writeback Barrier

Before a successful refresh:

```text
lease active
-> writeback readiness preflight passes
-> proxy has current GitHub public key or approved fetch path
-> SaaS accepts a pending refresh intent for this lease
```

After a successful refresh:

```text
refresh succeeds
-> proxy has new auth.json in memory
-> proxy revalidates lease TTL and secret metadata
-> proxy encrypts auth.json locally
-> proxy sends only encrypted_value + key_id + lease token to ReviewRouter SaaS
-> SaaS verifies OIDC-bound lease and writes GitHub secret
-> SaaS returns durable writeback confirmation
-> proxy continues run
```

The preferred capability is a short-lived GitHub App installation token
downscoped to public-key/secret-metadata read. If that is not possible, the
fallback must still prevent SaaS key substitution, for example by having the
runner verify `key_id` and public key material against GitHub through an
independent authenticated channel. Plain SaaS-provided public key material is
not acceptable without verification.

If writeback preflight fails before refresh, the run does not rotate auth and
may be retried safely.

If writeback fails after refresh, the run enters:

```text
unknown_auth_state
```

In `unknown_auth_state`, do not blindly retry with the old GitHub secret on the
next run. The old refresh token may already be invalid.

### Budget and Rate-Limit Policy

Budget controls are not just cost controls. They prevent a prompt-injected or
buggy workflow from using a valid Codex subscription session as a quota tunnel.

Budgets:

```text
per proxy process: max upstream requests, bytes, stream events, runtime
per review: max model responses, tool turns, comment findings
per repository: daily/weekly review and refresh caps
per provider instance: refresh attempt cap and unknown-state cap
per account hash: optional aggregate cap if multi-repo sessions interfere
per maintenance refresh: lower cap than normal PR review
```

Classification:

- upstream 429/quota/rate-limit before refresh -> `quota_limited` or safe
  review failure; do not reconnect
- upstream 429 during refresh request before token rotation is known ->
  `skipped_retryable` with backoff
- upstream 429 after refresh may have rotated -> `unknown_auth_state` only if
  the refresh outcome is ambiguous, otherwise `quota_limited`
- repeated quota failures suppress maintenance refresh and surface dashboard
  guidance, not login guidance

Backoff:

- exponential backoff with jitter for retryable upstream/GitHub/SaaS limits
- no automatic retry loops inside a single workflow after quota classification
- maintenance refresh pauses after repeated quota failures until next window or
  user action
- ReviewRouter SaaS kill switch can pause a provider/org/all providers without
  deleting GitHub secrets

## ReviewRouter SaaS Responsibilities

### Lease Service

Create a single-writer lease per auth stream:

```text
repository_id
secret_scope
secret_name
provider_instance_id
workflow_schema_version
```

Lease binds to:

```text
github_run_id
github_run_attempt
workflow_ref
job_workflow_ref
event_name
actor
triggering_actor when available
head_repository_id
base_repository_id
head_sha
base_sha
author_association when available
repository_visibility
runner_environment
nonce
fingerprint_key_id
restored_auth_generation_hash
last_confirmed_generation_hash_at_acquire
secret_metadata_updated_at_on_acquire
created_at
expires_at
job_timeout_minutes
proxy_shutdown_deadline
```

Only the lease holder can write back a refreshed secret.

### Lease Rules

- At most one active lease per auth stream.
- Lease expires after a bounded time, for example 30 minutes.
- Lease TTL must be longer than the maximum Codex review runtime plus the
  maximum refresh/writeback retry window.
- Proxy must not start refresh if the remaining lease TTL is below a configured
  safety margin.
- GitHub job `timeout-minutes` must be lower than lease TTL, and proxy shutdown
  deadline must be earlier than job timeout.
- A later run should not steal a live lease unless the previous run is known
  completed, cancelled, expired, or manually overridden.
- Expired leases move the auth stream to `unknown` if refresh may have occurred.
- Runs that did not start the proxy or did not receive auth can release safely.
- Runs whose restored auth generation does not match the latest confirmed
  provider generation must not start the proxy refresh path. Mark
  `stale_queued_secret` and request a fresh rerun.
- Runs that refreshed but did not write back must mark `unknown_auth_state`.
- Before writing the refreshed secret, SaaS must re-read secret metadata. If
  `updated_at` changed since lease acquisition and the change was not made by
  this lease, reject writeback as stale and mark `external_secret_drift` with
  reason `manual_reseed_detected`.
- If the secret was deleted after lease acquisition, do not recreate it during
  writeback. Treat that as operator intervention and mark `external_secret_drift`
  with reason `manual_secret_change_detected`.
- If GitHub's public key changed between encryption and writeback, reject once,
  refetch key through the approved public-key path, re-encrypt locally, and
  retry only from the same active lease.
- If refresh produced byte-identical auth state, skip secret writeback and mark
  the lease complete without rotation.
- If refresh intent was registered but no refresh request was sent, release the
  lease as retryable without entering unknown state.
- Idempotent retry from the same lease is allowed for a short grace window when
  `new_generation_hash` and `encrypted_value_hash` match the pending writeback.

### OIDC Validation

Validate:

```text
iss
aud exact ReviewRouter custom audience
signature
exp / nbf / iat with small skew
sub expected shape for trusted workflow
jti replay where available
repository_id exact match
repository owner id exact match
repository full name current mapping
repository_visibility private or internal
installation selected repo membership
workflow_ref allowed path
workflow_sha recorded and drift-checked when present
job_workflow_ref exact trusted reusable workflow when applicable
job_workflow_sha expected pinned reusable workflow commit when applicable
run_id
run_attempt
check_run_id when available
event_name allowlist
ref and ref_type expected for the event
base_ref/head_ref expected for PR events when present
original event trust context for re-runs
head/base repository id policy
head/base sha policy
actor, actor_id, triggering actor, and author-association policy
runner_environment github-hosted for no-VPS mode
actor permission for manual runs
environment claim absent unless an explicit GitHub Environment mode is enabled
workflow schema version
current repository id after rename/transfer
claim contract version and missing-optional-claim policy
```

Reject:

```text
fork PR context
same-repo PR blocked by actor/ref trust policy
public repo OAuth mode unless explicitly unsupported-safe mode is chosen
unknown event
stale queued secret generation
workflow_dispatch with arbitrary or unresolved user-supplied ref
unselected repository
removed installation
wrong workflow path
wrong reusable workflow ref
wrong reusable workflow sha when claim is available
public repository visibility
self-hosted runner environment in no-VPS mode
unexpected environment claim
missing mandatory rotating OAuth claim
optional claim missing without a declared safer fallback
default or wrong audience
unexpected subject shape
re-run of originally untrusted event
repository rename/transfer not reflected in installation mapping
replayed jti
expired OIDC
```

### Writeback API Contract

Illustrative endpoint:

```text
POST /api/action/v1/codex-oauth/writeback
```

Request body:

```json
{
  "lease_id": "rr_lease_...",
  "secret_name": "REVIEWROUTER_CODEX_AUTH_JSON",
  "github_key_id": "...",
  "encrypted_value": "...",
  "auth_fingerprint": {
    "fingerprint_key_id": "...",
    "account_id_hash": "...",
    "previous_generation_hash": "...",
    "new_generation_hash": "...",
    "restored_generation_hash": "...",
    "last_refresh": "2026-05-24T12:00:00Z"
  },
  "idempotency_key": "lease_id:run_id:run_attempt:new_generation_hash",
  "client": {
    "codex_version": "<pinned-codex-version>",
    "proxy_version": "..."
  }
}
```

Forbidden fields:

```text
auth_json
access_token
refresh_token
id_token
plaintext
raw_headers
raw_request_body
raw_response_body
```

Server must reject any request containing suspicious plaintext-looking fields.

Server must also reject:

```text
wrong secret name
wrong key id for current GitHub public key
encrypted_value with invalid base64 shape
encrypted_value outside expected size bounds
wrong fingerprint key id
restored generation older than latest confirmed generation
writeback without active lease
writeback after secret metadata changed externally
writeback from wrong run id or run attempt
duplicate writeback with different encrypted_value for the same idempotency key
writeback generation hash signed with expired or wrong-scoped HMAC key
writeback where HMAC key scope does not match repository, provider, run,
attempt, and lease
```

### SaaS Consistency Model

Writeback and lease state must be updated transactionally enough that the
dashboard never claims a refreshed generation is active when GitHub did not
durably accept the secret update.

Preferred pattern:

```text
transaction stores writeback_intent with:
  lease id, run id, run attempt, previous_generation_hash,
  new_generation_hash, encrypted_value_hash, GitHub key id,
  expected secret metadata, and idempotency key
-> GitHub PUT secret is attempted with current repository id/name
-> transaction stores GitHub PUT response status, response time, observed
   secret metadata, and writeback_confirmed
-> latest confirmed generation moves forward only after PUT success is durably
   recorded
-> outbox publishes safe provider health/audit event
```

Rules:

- do not store `latest confirmed auth generation hash` until after GitHub PUT
  success is known
- do not start GitHub PUT without a durable writeback intent row; otherwise a
  crash can leave no safe metadata for support or reconciliation
- store only ciphertext hash by default; retain `encrypted_value` itself only in
  an encrypted short-TTL retry queue if the implementation chooses SaaS-side PUT
  retry without asking the runner to resubmit
- if DB commit fails after GitHub PUT succeeds, enter `reconcile_required`
  rather than pretending no write happened
- if SaaS crashes between GitHub PUT and DB commit, a reconciler must compare
  pending writeback records and GitHub secret metadata before allowing another
  refresh
- if the only evidence is GitHub `updated_at`, reconciliation must not mark the
  generation confirmed. `updated_at` can prove "something changed", not "this
  generation is current"
- a runner retry with the same lease/idempotency key/new generation/ciphertext
  hash may complete the writeback while the lease is still valid
- after lease expiry, ambiguous writeback state becomes `reconcile_required` or
  `unknown_auth_state`; do not refresh again from the old queued secret
- outbox events must be safe metadata only and idempotent by lease id and
  generation hash
- support tooling can force `needs_reconnect` or `suspended`, but cannot mark a
  new generation confirmed without a recorded GitHub write success

Reconciliation outcomes:

| Evidence                                                                   | Outcome                                                                       |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Durable intent + recorded GitHub 201/204 + DB commit failed after response | `reconcile_required`, can confirm after metadata checks and idempotency proof |
| Durable intent + no GitHub response + same runner retries within lease     | retry same PUT/idempotency path                                               |
| Durable intent + no response + lease expired                               | `unknown_auth_state` unless reconnect/local setup proves current auth         |
| GitHub `updated_at` changed but no matching durable intent                 | `external_secret_drift`                                                       |
| GitHub secret deleted after intent                                         | `external_secret_drift` or `needs_reconnect`, never recreate silently         |

### Encrypted Writeback Payload Custody and Replay Ledger

The no-plaintext boundary is not enough by itself. A stored GitHub
`encrypted_value` cannot be decrypted by ReviewRouter SaaS, but it can still be
submitted to GitHub later to replace the Actions secret. That makes ciphertext
a credential update capability for the exact repository/key pair it was
encrypted for.

Required model:

```text
writeback_intent_id
idempotency_key
provider_instance_id
repository_id
installation_id
permission_epoch
workflow_schema_version
secret_name
lease_id
run_id
run_attempt
previous_generation_hash
new_generation_hash
ciphertext_hash
ciphertext_size_bucket
github_key_id
public_key_hash
public_key_fetched_at
expected_secret_updated_at
status
github_put_status
github_put_observed_at
encrypted_value_storage: none | encrypted_retry_queue
encrypted_value_retention_until nullable
kms_key_id nullable
retry_attempt_count
safe_reason
```

Rules:

- store `ciphertext_hash`, size bucket, `key_id`, public-key hash, generation
  hashes, lease/run identity, and permission epoch as normal safe metadata
- store raw `encrypted_value` only when SaaS-side retry is explicitly enabled
  for writeback ambiguity; otherwise discard it before the request handler
  returns
- raw `encrypted_value` retention is capped at 24h maximum and should be much
  shorter than the lease plus retry window where possible
- retry uses the same idempotency key and is allowed only while the lease,
  permission epoch, repository id, installation id, secret metadata, workflow
  schema, and latest confirmed generation still match the intent
- after a newer generation is confirmed, all older ciphertext retry payloads
  are permanently stale and cannot be written even if GitHub still accepts the
  `key_id`
- after external secret drift, local reseed, provider deletion, repository
  transfer, App permission loss, selected-repository removal, public visibility
  change, or workflow schema drift, purge pending encrypted retry payloads and
  require the normal recovery path
- same idempotency key with a different ciphertext hash, generation hash,
  public-key hash, `key_id`, repo, installation, lease, run, attempt, or secret
  name maps to `security_invariant_failed`
- KMS outage, retry payload decrypt failure, or missing `kms_key_id` blocks
  retry. If refresh may have happened, move to `unknown_auth_state`; if the
  failure is before refresh, use `skipped_retryable`
- support and audit projections expose only hash prefixes, size buckets,
  status, TTL, key ids, and safe reason codes
- incident response treats ciphertext leak as operational-material exposure:
  purge retry queues, invalidate active writeback sessions, block stale
  idempotency keys, and require reconnect only if plaintext auth or current
  auth state is also unknown

Top 3 implementation options:

1. Hash-only by default plus encrypted short-TTL retry queue only for ambiguous
   writeback - 🎯 9 / 10 🛡️ 9.5 / 10 🧠 7 / 10

   Approx changes: 800-1900 LOC production-grade.

   Recommended. It keeps normal operation close to zero-custody while still
   allowing safe recovery from crash/lost-response cases where the exact same
   GitHub PUT may need to be retried.

2. Store encrypted writeback bodies for broad support/reconciliation -
   🎯 6 / 10 🛡️ 5 / 10 🧠 5 / 10

   Approx changes: 500-1200 LOC.

   Not recommended. It is easier to operate, but it turns ReviewRouter into a
   long-lived holder of credential update material and makes support/admin
   tooling riskier.

3. Never store raw `encrypted_value`, force runner resubmit on ambiguity -
   🎯 8 / 10 🛡️ 8.5 / 10 🧠 6 / 10

   Approx changes: 500-1100 LOC.

   Safer from a custody perspective, but more brittle under GitHub/API crashes:
   the runner may have already refreshed and lost the exact ciphertext needed
   to resolve an ambiguous writeback without asking the user to reconnect.

### API Ingress and Telemetry Guardrails

The no-plaintext-SaaS boundary can be broken by infrastructure, not just
application code. Every endpoint involved in setup, lease, health, public-key
fetch, and writeback needs route-specific logging policy.

Rules:

- disable request and response body capture at CDN, load balancer, reverse
  proxy, API gateway, framework middleware, APM, tracing, and error reporting
  for auth-sensitive routes
- treat `encrypted_value`, HMAC key material, setup tokens, OIDC JWTs, helper
  tokens, nonce, proxy URLs, and sanitized review artifacts as sensitive fields
  with explicit redaction
- never send auth-sensitive request bodies to crash reporters or session replay
  tools
- structured logs use allowlisted fields only, not "log entire request except"
  filtering
- route tests must fail if a sensitive field appears in logs, traces, spans,
  metrics labels, error events, or support exports
- support exports must be generated from safe metadata views, not raw database
  rows or HTTP captures

`encrypted_value` is ciphertext, but it is still the credential update payload.
Do not log or retain it unless an implementation-specific retry queue makes it
strictly necessary, and then store only for a bounded time with encryption at
rest and no support UI exposure.

### Sensitive Route Registry and Telemetry Sink Harness

The plan must not rely on "developers remember not to log bodies". The
production implementation needs an explicit privacy class for every route that
can touch auth-adjacent material, and an automated harness that runs the same
sentinel corpus through all known observability sinks.

Local code reality checked on 2026-05-24:

- `apps/api/src/app.ts` creates `Fastify({ logger: false })` and has a global
  `onError` hook that logs only `error.message`.
- `packages/platform/logger/src/index.ts` is a thin console logger without a
  central serializer, sensitive-field policy, route privacy class, or sink
  capture tests.
- `packages/features/action-control-plane/src/interface/http/register-action-control-plane-routes.ts`
  already uses strict Zod schemas and body limits for several action routes,
  but route privacy is implicit and not registered centrally.
- `packages/features/support-diagnostics` currently selects and summarizes
  safe counts/statuses, which is the right pattern, but rotating OAuth needs a
  separate safe view that proves no raw ciphertext, token, request body, prompt,
  diff, or model output can enter support exports.
- `apps/web/app/api/dashboard/provider-secret-setup/confirm/route.ts` reads
  form data directly and delegates to a dashboard action. The rotating OAuth
  setup completion route must not inherit this shape without a sensitive-route
  tag, strict schema, field allowlist, and sentinel test.

Required route classes:

```text
public_safe
dashboard_form
webhook_raw_body
action_control_plane
rotating_setup_completion
rotating_oidc_exchange
rotating_runtime_preflight
rotating_lease_acquire
rotating_public_key_helper
rotating_writeback
rotating_provider_health
rotating_compatibility_check
rotating_support_export
rotating_sanitized_artifact_ingest
```

Every route class must define:

- whether request bodies are allowed at all
- max body bytes and parser type
- response body capture policy
- allowed log fields
- allowed trace/span attributes
- allowed metric labels
- safe error code mapping
- support export visibility
- whether `encrypted_value` can be retained in a short-TTL encrypted retry
  store
- required sentinel tests

Allowlisted fields for secret-backed routes:

```text
route_id
request_id
workspace_id
repository_id
provider_instance_id
run_id
run_attempt
workflow_schema_version
action_version
proxy_version
codex_cli_version
release_channel
feature_scope
status
safe_reason
duration_ms_bucket
body_size_bucket
version_tuple
kid
```

Forbidden in logs, spans, metric labels, error events, support exports, and
long-lived DB rows:

```text
request body
response body
raw URL query string
Authorization header
Cookie header
GitHub OIDC JWT
setup token
writeback token
helper installation token
HMAC material
auth.json
access token
refresh token
id token
device code
encrypted_value outside an approved short-TTL retry queue
full proxy URL
nonce
raw prompt
raw diff
raw model output
raw exception stack that includes request/body snippets
validation error detail that echoes offending values
```

Important distinction:

- `encrypted_value` is not plaintext, but it is still credential update
  material. Treat it as sensitive. Support UI should see only ciphertext hash
  prefix, byte bucket, `key_id`, generation id, and state.
- OIDC JWT claims can be safe after verification only when individually
  selected and normalized. Never log the raw JWT or raw claims object.
- Validation errors should return stable safe codes, not Zod issue payloads
  that may include user-supplied values.
- Metrics must reject high-cardinality labels and sensitive-like labels. Use
  buckets and enums.

Top 3 implementation options:

1. Central sensitive-route registry plus telemetry sink harness - 🎯 9 / 10
   🛡️ 9.5 / 10 🧠 7 / 10

   Approx changes: 600-1400 LOC.

   Recommended. This gives every route a declared privacy class and makes
   logging/APM/support behavior testable. It is the only option that scales
   safely when middleware, hosting, APM, or support tooling changes.

2. Per-route ad hoc redaction helpers - 🎯 6.5 / 10 🛡️ 6 / 10 🧠 4 / 10

   Approx changes: 250-700 LOC.

   Faster, but weak against drift. One new route, framework error handler, APM
   integration, or support export can bypass the helper.

3. Disable detailed logging globally on API - 🎯 5.5 / 10 🛡️ 7 / 10
   🧠 3 / 10

   Approx changes: 100-300 LOC.

   Simpler and reduces body leak risk, but it hurts incident response and still
   does not prove APM, gateway, validation errors, route-level handlers,
   support exports, or future middleware cannot capture sensitive values.

Implementation notes:

- Add a `sensitiveRouteRegistry` package or module used by Fastify and Next.js
  route handlers.
- Route registration must fail in tests if a rotating OAuth path is missing a
  privacy class.
- Add a log serializer and error serializer that accept a route privacy class
  and output only allowlisted fields.
- Add a test logger, test trace exporter, test metric sink, test error reporter,
  and test support-export sink. The same sentinel corpus must be asserted
  absent from every sink.
- Keep Fastify `logger: false` unless a structured logger with route-level
  redaction is introduced and tested.
- Keep support diagnostics as safe projections. Do not expose raw DB rows for
  rotating OAuth tables through support/admin APIs.
- If production hosting enables request logging, body capture, session replay,
  error breadcrumbs, or APM spans outside the Node process, the deployment
  manifest must include an explicit route-level disable rule and the staging
  harness must verify it.

### Control-Plane Key Management

ReviewRouter's no-plaintext boundary depends on more than the Codex
`auth.json` rule. Several ReviewRouter-owned keys can authorize or confuse the
writeback path.

Key classes:

| Key/material                        | Purpose                                                   | Rotation rule                                                                  | Compromise response                                                                                          |
| ----------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| GitHub App private key              | Mint App JWTs and installation tokens                     | keep multiple active keys during normal rotation; delete old key after rollout | emergency pause helper-token minting and secret writeback, rotate App key, audit installation-token issuance |
| Action-session signing key          | Sign short-lived action API sessions                      | version with `kid`, support grace period shorter than max session TTL          | reject new sessions on old key, expire active sessions, rotate signing key                                   |
| Setup/writeback token signing key   | Authorize local setup and writeback calls                 | versioned short-TTL tokens, rotate independently from action sessions          | invalidate outstanding setup/writeback tokens, require setup retry if needed                                 |
| HMAC fingerprint key                | Compute non-reversible auth generation/account hashes     | per-provider key id, rotate with migration run                                 | invalidate scoped runner material, rotate key id, require one trusted run/setup to migrate latest hash       |
| Encrypted retry queue key           | Encrypt short-TTL ciphertext retry payloads if retained   | KMS-managed rotation with TTL-bound data                                       | purge retry queue if decrypt/rotation state is ambiguous                                                     |
| Incident/compatibility override key | Authorize emergency block/unblock operations if separated | dual-control or release-owner approval                                         | freeze overrides, audit, require manual release-owner recovery                                               |

Rules:

- every signed/encrypted artifact carries `kid` or key version metadata
- key material never goes to GitHub Actions unless it is explicitly one-run
  scoped HMAC material or a downscoped helper token
- KMS/signing-key unavailability before auth restore maps to
  `skipped_retryable`; do not restore the OAuth secret if ReviewRouter cannot
  issue or validate the control-plane material needed to keep the run safe
- active key rotation cannot break in-flight leases that have not restored auth
  yet, but must not allow stale writebacks after the allowed grace window
- deleting a key before all signed tokens expire is a production incident unless
  the compatibility registry has already blocked new secret restore
- support/admin tools can rotate keys and suspend providers but cannot export
  private key material or raw KMS plaintext
- key rotation events are audited with actor, reason, affected key ids, and safe
  provider counts, not secrets or token bodies
- dependency checks should alert before certificate/key expiry or GitHub App
  key removal creates a production outage

GitHub App private key compromise is not the same as Codex `auth.json`
exposure. It usually requires pausing ReviewRouter writeback and rotating App
keys, but customer Codex reconnect is required only if plaintext Codex auth or
writeback integrity is also suspected compromised.

### Database Invariants and Migrations

The state machine relies on database guarantees, not only application code.

Required invariants:

```text
provider_instance_id belongs to exactly one workspace/repository installation
active lease uniqueness: one active lease per provider auth stream
account-session lease uniqueness: one refresh-capable lease per account-session group when isolation is unknown, serialized, or interfering
writeback intent uniqueness: one idempotency key maps to one generation and one ciphertext hash
generation monotonicity: latest_confirmed_generation can only advance from the currently confirmed generation
provider state transition validity: unsafe states cannot jump directly to active
repository identity: repository id is durable; owner/name are display/lookup fields
installation identity: selected-repository membership is revalidated before lease/writeback
```

Database rules:

- use unique constraints or transactional compare-and-set for active lease
  acquisition; do not rely on in-memory locks
- writeback intent is inserted before GitHub PUT and has a durable status
  history
- confirming a generation requires the matching writeback intent, GitHub PUT
  success, expected provider id, expected secret name, expected key id, and
  current repository installation
- idempotent retry with the same idempotency key is allowed only when
  generation hash and ciphertext hash match exactly
- duplicate idempotency key with different ciphertext is a security invariant
  failure and moves provider to `suspended`
- schema migrations for this feature must be additive until rollback is
  proven; do not drop legacy `CODEX_AUTH_JSON` state during rollout
- backfills must never read or infer plaintext secrets
- provider deletion/uninstall creates a tombstoned safe audit row and revokes
  leases/session material before removing dashboard visibility
- tests should simulate DB transaction conflicts, deadlocks, duplicate writes,
  stale reads, and crash between every durable state transition

### Rotating OAuth Data Model Additions

The current `ProviderSetupState` and `ActionRunHealthReport` records are useful
for coarse dashboard health, but they are not the source of truth for rotating
Codex OAuth. Additive Prisma migrations should introduce dedicated tables or
equivalent strongly typed models for rotating state.

Minimum model set:

| Model                            | Purpose                                                                                                  | Plaintext allowed                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `CodexOAuthProviderInstance`     | one rotating provider instance for a workspace/repository/auth mode                                      | no                                              |
| `CodexOAuthAccountSessionGroup`  | non-reversible account/workspace fingerprint grouping and isolation policy across provider instances     | no                                              |
| `CodexOAuthAuthGeneration`       | monotonic generation metadata, safe auth fingerprint, account/workspace fingerprint, secret name, key id | no                                              |
| `CodexOAuthLease`                | single active refresh/writeback writer with TTL and run identity                                         | no                                              |
| `CodexOAuthWritebackIntent`      | idempotent record of encrypted writeback attempt and GitHub PUT result                                   | ciphertext only if retry queue policy allows it |
| `CodexOAuthSetupSession`         | short-lived local setup session state and setup PR pairing                                               | no                                              |
| `CodexOAuthCompatibilityVersion` | installer/workflow/proxy/Codex/action version allow/block decision                                       | no                                              |
| `CodexOAuthProviderHealthEvent`  | append-only safe state transitions for support and dashboard history                                     | no                                              |

Required fields:

- `workspaceId`, `repositoryId`, `installationId`, `providerInstanceId`, and
  selected `authMode`
- durable GitHub repository id; owner/name are display fields
- workflow schema version, action/proxy version, installer version, and pinned
  Codex CLI version
- latest confirmed generation number and safe generation hash
- safe non-reversible account/workspace fingerprint
- provider state and reason code from the taxonomy
- `kid` or version for every HMAC/signing/encryption key used to compute safe
  hashes or verify artifacts

Required constraints:

- one active rotating Codex OAuth provider per repository/auth mode unless
  multi-provider selection is explicitly designed
- one active lease per provider instance and auth stream
- generation number can only advance by compare-and-set from the currently
  confirmed generation
- idempotency key is unique and maps to exactly one generation hash and one
  ciphertext hash
- duplicate idempotency key with different ciphertext hash suspends the
  provider
- writeback confirmation requires matching provider instance, secret name,
  GitHub key id, repository installation, generation number, and successful
  GitHub PUT
- uninstall/repository removal/permission loss blocks new leases before any
  secret is restored

Migration rules:

- migrations are additive until rollback and legacy static compatibility are
  proven
- old `ProviderSetupState` rows remain readable and continue to power legacy
  static setup UI
- no backfill attempts to inspect GitHub secret values or infer plaintext
  `auth.json`
- if rotating tables are absent or behind an old schema version, workflow
  provisioning must not generate rotating OAuth YAML
- rollback leaves legacy `CODEX_AUTH_JSON` static mode functional and leaves
  `REVIEWROUTER_CODEX_AUTH_JSON` unused

### Retention Policy

Default retention:

```text
plaintext auth: never stored in SaaS
encrypted_value request body: transient, or <= 24h encrypted retry retention
HMAC key material sent to runner: one-run scoped, <= 30m TTL
setup session token: <= 30m TTL, single repository/provider scope
writeback session token: <= lease TTL, single lease scope
OIDC JWT: verify then discard, keep safe claim subset only
GitHub App installation token issued to runner: <= GitHub token TTL, discard
safe auth generation hashes: retained with provider audit history
provider audit metadata: 180d default, product/legal configurable
sanitized review artifacts: 30d default or repository-configured retention
GitHub sanitized review artifacts: shortest supported Actions artifact
  retention, preferably 1d where available
raw model output: not retained
raw prompt/diff: not retained by this feature
support exports: safe metadata only
```

Deletion rules:

- uninstall, repository removal, or provider deletion revokes active leases and
  deletes setup/writeback session material immediately
- provider metadata moves to tombstoned safe audit state, with no tokens,
  ciphertext bodies, prompts, diffs, or model output
- pending encrypted retry payloads are purged on provider deletion, permission
  loss, external drift, or retention expiry
- KMS key retirement must make old HMAC material unusable for new writes while
  preserving enough safe audit metadata to explain historical states
- support export and account deletion flows must use safe views, not direct
  dumps of request tables, traces, spans, or retry queues

Retention and deletion defaults need product/legal sign-off before private beta,
but implementation must ship with enforced TTLs from the first internal spike.

### Public Key Strategy

Preferred production flow:

```text
SaaS issues a short-lived GitHub App installation token scoped to Secrets: read
-> runner/proxy uses that token to fetch the GitHub Actions public key directly
   from GitHub
-> token is removed before Codex runtime starts
```

Why:

- GitHub docs require `Secrets: read` for repository public-key retrieval
- the default workflow `GITHUB_TOKEN` does not have a `secrets` permission knob
  and should not be assumed to work for this endpoint
- if ReviewRouter SaaS returns the public key material, a compromised server could
  substitute a key it controls
- direct GitHub public key fetch with a read-only App token gives a stronger
  no-plaintext-SaaS story
- downscoped helper token exposure is less sensitive than public-key
  substitution, because GitHub never returns plaintext secret values

Avoid:

```text
SaaS returns arbitrary public key material that runner trusts blindly
workflow receives a token with Secrets: write
public-key read token is passed to codex exec
```

Fallback rule:

If a helper token cannot be downscoped enough, do not silently switch to
trusting arbitrary SaaS-provided key material. Either:

- prove that `GITHUB_TOKEN` or another existing runner credential can fetch the
  repo public key without gaining secret write access, or
- add a signed/key-pinned verification flow, or
- block the feature and use self-hosted persistent mode.

### Secret Write Operation

SaaS uses its GitHub App installation token to:

```text
PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}
```

with:

```json
{
  "encrypted_value": "...",
  "key_id": "..."
}
```

SaaS logs only:

```text
repo id
secret name
key id
encrypted value length
run id
run attempt
lease id
safe status
GitHub status code class
last confirmed secret metadata hash
```

SaaS never logs:

```text
encrypted value body if avoidable
plaintext secret
token claims from auth.json
raw writeback request body
```

Secret update adapter rules:

- use only the current installation token for the repository
- send a pinned `X-GitHub-Api-Version` header and treat unexpected
  request/response shape as compatibility drift
- never accept owner/repo from request body without resolving repository id
- resolve current owner/name from repository id before GitHub REST calls, so
  repository rename does not break writeback
- verify the secret name matches the provider instance
- verify the App installation still has repository access
- treat GitHub `403` as permission upgrade required
- treat GitHub `404` as installation/repository drift
- treat GitHub primary or secondary rate limit as retryable only before
  refresh, or during the same active lease if refresh already happened
- retry GitHub `5xx` with bounded backoff only while lease remains active
- never retry with a different ciphertext for the same idempotency key

Repository lifecycle rules:

- repo rename: continue by repository id, update display name and generated
  workflow references on next setup PR
- repo transfer to another owner: suspend until the new installation and
  permission mapping are verified
- App uninstalled or repository removed from installation: suspend and do not
  request or restore auth
- repository visibility changed to public: suspend secret-backed OAuth mode
  before acquiring a lease

GitHub App webhook rules:

- verify webhook signatures before mutating provider state
- verify signatures against the raw request body before JSON parsing or
  normalized-event projection
- record a webhook inbox row with delivery id, event/action, installation id,
  repository id when present, payload hash, normalized event hash, status,
  received timestamp, retry count, and projection version
- return a 2xx response quickly after safe inbox recording; slow GitHub API
  sync, permission epoch updates, and provider projections run asynchronously
- on installation deleted, suspended, or repository removed from installation,
  move provider to `suspended`
- on repository visibility changed to public, move provider to `suspended`
  before the next lease can be acquired
- on repository rename, update display name but keep repository id as the
  durable key
- on permission change removing `Secrets: write`, move provider to permission
  required
- duplicate delivery id with the same payload hash is idempotent; duplicate
  delivery id with a different payload hash is suspicious and cannot mutate
  state
- out-of-order positive events such as install created, repo added, permission
  accepted, or unsuspended cannot move a provider back to `active` without a
  fresh GitHub API source-of-truth check
- failed webhook projection enters a retry/dead-letter path and surfaces
  `sync_stale`; it must not tell users to reconnect Codex
- webhook handling is advisory and early, not the only guard. Lease acquire
  still revalidates current GitHub App installation and repository visibility.

## State Machine

### States

```text
unconfigured
seeded
seeded_unconfirmed
setup_pr_open
workflow_pending_verification
workflow_drift_detected
workflow_schema_mismatch
workflow_attestation_incomplete
rotating_protocol_unsupported
control_plane_version_unsupported
workflow_repair_required
workflow_disabled_by_rollback
secret_restore_grant_issued
account_authorization_required
active
stale_queued_secret
lease_acquired
proxy_started
pre_refreshing
review_running
refreshing
encrypted_writeback_pending
writeback_confirmed
unknown_auth_state
skipped_retryable
reconcile_required
permission_required
policy_blocked
debug_logging_blocked
sync_stale
process_isolation_unsupported
writeback_authority_paused
quota_limited
account_required
needs_reconnect
security_invariant_failed
suspended
external_secret_drift
disabled
```

### Normal Path

```text
unconfigured
-> seeded
-> setup_pr_open
-> workflow_pending_verification
-> active
-> secret_restore_grant_issued after no-secret preflight succeeds for a run
-> lease_acquired
-> proxy_started
-> review_running
-> writeback_confirmed when refresh happened
-> active
```

If local setup writes the GitHub secret but cannot confirm safe metadata:

```text
unconfigured
-> seeded_unconfirmed
-> seeded after idempotent setup rerun completes safe metadata recording
-> setup_pr_open or workflow_pending_verification until workflow is merged
-> active after trusted no-secret runtime attestation succeeds
```

If no refresh happened:

```text
review_running
-> active
```

### Refresh Path

```text
proxy_started
-> pre_refreshing
-> encrypted_writeback_pending
-> writeback_confirmed
-> review_running
```

or:

```text
review_running
-> refreshing after upstream 401 or stale detection
-> encrypted_writeback_pending
-> writeback_confirmed
-> review_running
```

### Failure States

`unknown_auth_state` means:

- a refresh may have happened
- writeback durability is not confirmed
- old secret may or may not still work
- automatic retry can make things worse

`skipped_retryable` means:

- no refresh request was sent
- the persisted GitHub secret is still assumed current
- the run skipped because a precondition failed, such as SaaS outage, GitHub
  public-key fetch failure, lease TTL too low, runner clock skew, or upstream
  temporary outage before rotation
- automatic retry is safe with backoff

`reconcile_required` means:

- GitHub secret write may have succeeded, but SaaS did not durably record the
  confirmed generation
- automatic refresh is paused until a reconciler or support workflow determines
  whether the GitHub secret metadata matches the pending writeback
- no plaintext auth is available or required for reconciliation

`seeded_unconfirmed` means:

- local setup may have written `REVIEWROUTER_CODEX_AUTH_JSON` to GitHub
- ReviewRouter did not durably record the safe initial generation metadata
- user should rerun setup; the installer must recompute local fingerprints and
  complete idempotently without SaaS reading plaintext auth

`setup_pr_open` means:

- the local installer created or updated a workflow setup PR
- the Codex secret may already exist, but the trusted default branch workflow
  has not yet adopted the rotating schema
- recovery is to review and merge the setup PR, not reconnect Codex

`workflow_pending_verification` means:

- the workflow exists or setup PR is merged, but no trusted no-secret runtime
  attestation has proven the expected workflow tuple
- secret restore is blocked until a trusted default-ref run verifies schema,
  digest, action/proxy versions, provider auth mode, and secret name

`workflow_drift_detected`, `workflow_schema_mismatch`,
`workflow_attestation_incomplete`, `rotating_protocol_unsupported`,
`control_plane_version_unsupported`, and `workflow_repair_required` mean:

- the saved Codex auth may still be valid
- workflow/runtime trust is not currently proven
- recovery is repair PR, action/proxy/workflow upgrade, compatibility unblock,
  or trusted attestation rerun, never automatic fallback to static mode

`workflow_disabled_by_rollback` means:

- a rollback intentionally made the rotating workflow inert
- secrets are left untouched and unused
- legacy static mode may continue independently if configured

`secret_restore_grant_issued` means:

- no-secret runtime preflight passed and ReviewRouter issued a short-lived
  one-shot grant for the exact run/attempt/workflow tuple
- the grant is not proof that the secret was restored or that refresh is safe
- lease acquire must consume the grant and revalidate current state before auth
  bytes are parsed or used

`account_authorization_required` means:

- the saved Codex session may still be structurally valid, but ReviewRouter does
  not have current customer authorization for this account-auth CI usage
- examples: missing setup consent, stale consent version, account/workspace
  fingerprint not bound to the consent, feature-scope expansion, maintenance
  refresh enabled after initial consent, material retention/logging policy
  change, or enterprise/workspace policy revocation
- no OAuth secret should be restored and no refresh should start
- recovery is local setup or explicit reauthorization by an authorized
  repository/workspace actor; support/admin cannot force this state to active

`external_secret_drift` means:

- GitHub secret metadata changed outside ReviewRouter setup/writeback
- ReviewRouter cannot verify the new plaintext value
- automatic refresh is paused until the user reruns setup locally

`permission_required` means:

- GitHub App permissions or selected-repository access are insufficient for the
  safe writeback/public-key flow
- refresh has not started in this run, or the state would instead be
  `unknown_auth_state`
- user/admin must approve the GitHub App permission update or reinstall the App

`policy_blocked` means:

- GitHub org/repo/enterprise policy prevents the generated workflow from
  running safely
- examples: Actions disabled, action reference not allowlisted, reusable
  workflow blocked, selected repository not installed, workflow permissions too
  restrictive, actor/ref trust policy blocked the event
- Codex auth may be valid; do not ask for reconnect unless auth failure is
  separately proven

`debug_logging_blocked` means:

- GitHub Actions debug logging, runner diagnostic logging, shell tracing, or a
  ReviewRouter verbose mode is enabled for a secret-backed run
- auth has not been restored and no refresh has started
- recovery is to disable debug for the secret-backed job, rerun, or use an
  internal sentinel-only canary path; do not ask the user to reconnect Codex

`sync_stale` means:

- webhook projection, GitHub App permission sync, or repository access sync is
  delayed, dead-lettered, or behind current GitHub state
- auth may still be valid, but secret restore is blocked until a source-of-truth
  GitHub API reconciliation succeeds
- recovery is sync/reconcile/admin handoff, not Codex reconnect

`process_isolation_unsupported` means:

- the current GitHub-hosted runner image, process launcher, proxy hardening, or
  Codex sandbox tuple cannot prove that model-controlled subprocesses are
  isolated from proxy memory-adjacent surfaces, procfs, inherited FDs, temp
  files, or control roots
- no OAuth secret has been restored and no refresh has started
- recovery is compatibility block, runner image update, hardening fix, or
  fallback to self-hosted persistent `CODEX_HOME`, not Codex reconnect

`writeback_authority_paused` means:

- ReviewRouter SaaS cannot safely mint GitHub App installation tokens or use
  secret-writeback authority for this provider, installation, permission epoch,
  issuer key, or compatibility tuple
- examples: token issuer policy drift, omitted `repository_ids`, omitted
  `permissions`, overbroad token response, unapproved caller, signer/KMS outage,
  SDK token-cache scope mismatch, cross-purpose cached token, App private-key
  compromise suspicion, or emergency writeback freeze
- no OAuth refresh should start while this state is known before refresh
- if refresh already happened, map to `unknown_auth_state` or
  `reconcile_required` according to whether GitHub PUT proof exists

`quota_limited` means:

- Codex/ChatGPT upstream, GitHub, or ReviewRouter safety budget limited the run
- auth may still be valid
- user should retry later, reduce scope, or adjust plan/provider settings
- do not ask for reconnect unless a separate permanent auth failure is proven

`account_required` means:

- the saved Codex session is structurally present, but the connected ChatGPT
  account/workspace/plan no longer satisfies the provider requirements
- examples: subscription removed, workspace policy changed, account disabled,
  required workspace mismatch, user who owned session left the organization
- recovery is account/workspace action or local setup with an approved account

`stale_queued_secret` means:

- GitHub queued the run before a newer secret generation was confirmed
- the runner received an old auth JSON from the queued secret context
- no refresh should be attempted from this run
- rerunning after the current secret generation is visible is the safe recovery

`needs_reconnect` means:

- refresh failed permanently
- token expired, revoked, reused, invalidated, or account mismatch
- user must run installer/login again

`security_invariant_failed` means:

- a core no-plaintext or single-writer invariant was violated or could not be
  proven
- examples: duplicate idempotency key with different ciphertext, ciphertext
  replay after a newer generation, retry payload retained outside approved TTL,
  impossible generation rollback, or support/admin path trying to access raw
  ciphertext
- automatic refresh and secret restore are blocked until incident triage or a
  verified rollback clears the state
- do not ask for Codex reconnect unless plaintext auth was exposed or the
  current auth state is also unknown

`suspended` means:

- policy prevents running
- GitHub permission missing
- repo became public
- GitHub App permission update not accepted
- repeated failures exceeded threshold

## Failure Matrix

| Stage                  | Failure                                                              | State                                      | User impact                               | Recovery                                                                      |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------- |
| Installer before login | Codex CLI missing                                                    | unconfigured                               | setup stops                               | install pinned Codex CLI                                                      |
| Installer login        | device auth disabled                                                 | unconfigured                               | fallback needed                           | browser login or enable device auth                                           |
| Installer smoke        | Codex returns auth error                                             | unconfigured                               | setup stops                               | rerun `codex login`                                                           |
| Installer GitHub write | `gh` lacks repo rights                                               | unconfigured                               | setup stops                               | login correct GitHub account                                                  |
| Installer completion   | secret write succeeded but SaaS completion failed                    | seeded_unconfirmed                         | setup uncertain                           | rerun setup idempotently                                                      |
| Setup PR               | setup PR opened but not merged                                       | setup_pr_open                              | auto-refresh not active yet               | review and merge setup PR                                                     |
| Workflow verification  | setup PR merged but no trusted default-ref run                       | workflow_pending_verification              | secret restore blocked                    | run trusted workflow preflight                                                |
| Workflow verification  | default-branch workflow edited manually                              | workflow_drift_detected                    | secret restore blocked                    | open/merge repair setup PR                                                    |
| Workflow verification  | wrong schema, secret name, auth mode, or permission shape            | workflow_schema_mismatch                   | secret restore blocked                    | regenerate workflow setup PR                                                  |
| Workflow verification  | required OIDC/workflow attestation fact missing                      | workflow_attestation_incomplete            | secret restore blocked                    | repair workflow or compatibility policy                                       |
| Workflow verification  | old action/proxy cannot speak rotating protocol                      | rotating_protocol_unsupported              | secret restore blocked                    | upgrade action/proxy/workflow                                                 |
| Workflow verification  | SaaS cannot support workflow protocol or emergency block             | control_plane_version_unsupported          | secret restore blocked                    | wait for control-plane upgrade or rollback                                    |
| Secret restore         | restore grant expired before bootstrap                               | skipped_retryable                          | review skipped before refresh             | rerun workflow                                                                |
| Secret restore         | restore grant tuple mismatch                                         | policy_blocked or workflow_schema_mismatch | secret use blocked                        | repair workflow or rerun trusted preflight                                    |
| Secret restore         | restore grant reused or consumed by another run                      | security_invariant_failed                  | auto mode blocked                         | incident triage and stale grant invalidation                                  |
| Workflow start         | secret missing                                                       | unconfigured                               | review skipped                            | run setup command                                                             |
| Workflow start         | auth JSON exceeds GitHub secret size policy                          | unconfigured                               | setup stops                               | reconnect after product decision                                              |
| Workflow start         | unsupported runner OS                                                | suspended                                  | review skipped                            | use GitHub-hosted Linux or self-hosted persistent mode                        |
| Setup consent          | consent missing, stale, or not bound to this repo/account/workspace  | account_authorization_required             | setup/review paused before secret restore | rerun local setup and confirm current account-auth CI policy                  |
| Setup consent          | feature scope or maintenance refresh enabled beyond recorded consent | account_authorization_required             | setup/review paused before secret restore | reauthorize with updated scope                                                |
| Setup preflight        | Actions disabled or action reference not allowed                     | policy_blocked                             | setup/review paused                       | ask repo/org admin to update policy                                           |
| Setup preflight        | App installed but repository not selected                            | permission_required                        | setup paused                              | select repository in App install                                              |
| Setup preflight        | App permission update pending owner approval                         | permission_required                        | setup paused                              | org/account owner approves App permission                                     |
| Setup preflight        | webhook or installation sync is stale/dead-lettered                  | sync_stale                                 | setup/review paused                       | run source-of-truth reconciliation                                            |
| SaaS before lease      | ReviewRouter API unavailable                                         | skipped_retryable                          | review skipped                            | retry later, do not restore auth                                              |
| OIDC exchange          | invalid claims                                                       | suspended                                  | review skipped                            | update workflow/App install                                                   |
| OIDC exchange          | `workflow_run` or `pull_request_target` event                        | suspended                                  | review skipped                            | use generated safe workflow                                                   |
| OIDC exchange          | re-run of originally untrusted event                                 | suspended                                  | review skipped                            | use trusted same-repo event                                                   |
| OIDC exchange          | same-repo PR actor/ref blocked by trust policy                       | policy_blocked                             | review skipped                            | maintainer/admin adjusts policy or reviews manually                           |
| Workflow dispatch      | arbitrary ref or unresolved PR input                                 | policy_blocked                             | review skipped                            | dispatch against a resolved PR/head SHA                                       |
| Lease acquire          | restored generation older than latest confirmed                      | stale_queued_secret                        | run skipped                               | rerun workflow after current secret is visible                                |
| Lease acquire          | Actions step/runner debug or shell tracing enabled                   | debug_logging_blocked                      | review skipped before auth restore        | disable debug and rerun                                                       |
| Lease acquire          | runner/procfs/process isolation unsupported                          | process_isolation_unsupported              | review skipped before auth restore        | block tuple or use persistent runner fallback                                 |
| Lease acquire          | another run active                                                   | active                                     | run waits or skips                        | later run retries after lease                                                 |
| Lease acquire          | lease TTL too low for refresh                                        | skipped_retryable                          | run skipped                               | retry with fresh lease                                                        |
| Proxy start            | malformed auth JSON                                                  | needs_reconnect                            | review skipped                            | run setup command                                                             |
| Proxy start            | connected account/workspace hash mismatch                            | account_required                           | review skipped                            | reconnect with approved account                                               |
| Proxy start            | consent fingerprint mismatches restored account/workspace hash       | account_authorization_required             | review skipped before refresh             | reauthorize or reconnect intentionally                                        |
| Proxy start            | runner clock skew too high                                           | skipped_retryable                          | review skipped                            | retry on healthy runner                                                       |
| Public key fetch       | Secrets: read helper token unavailable                               | permission_required                        | review skipped before refresh             | accept App permission update                                                  |
| Public key fetch       | helper token has write capability                                    | suspended                                  | review skipped                            | block release until downscoped path exists                                    |
| Public key fetch       | token issuer policy drift or unapproved caller                       | writeback_authority_paused                 | review skipped before refresh             | block token issuer tuple and investigate                                      |
| Public key fetch       | installation token response broader than requested                   | writeback_authority_paused                 | review skipped before refresh             | block issuer and compatibility tuple                                          |
| Public key fetch       | SDK token cache returns wrong-purpose or wrong-scope token           | writeback_authority_paused                 | review skipped before refresh             | disable cache tuple and inspect issuer ledger                                 |
| Pre-refresh            | writeback readiness preflight fails                                  | skipped_retryable                          | review skipped                            | retry after dependency recovers                                               |
| Pre-refresh            | transient network failure before request sent                        | skipped_retryable                          | run fails safely                          | retry with backoff                                                            |
| Pre-refresh            | refresh request outcome ambiguous                                    | unknown_auth_state                         | auto mode paused                          | reconnect or support-guided recovery                                          |
| Pre-refresh            | refresh token expired                                                | needs_reconnect                            | review skipped                            | reconnect Codex                                                               |
| Pre-refresh            | refresh token reused                                                 | needs_reconnect                            | review skipped                            | reconnect Codex                                                               |
| Pre-refresh            | refresh succeeded, encryption failed                                 | unknown_auth_state                         | auto mode paused                          | reconnect or manual recovery                                                  |
| Pre-refresh            | refresh succeeded, SaaS unavailable                                  | unknown_auth_state                         | auto mode paused                          | reconnect if old secret fails                                                 |
| Pre-refresh            | refresh succeeded, GitHub 403                                        | unknown_auth_state                         | auto mode paused                          | accept App permission update, reconnect if needed                             |
| Review                 | upstream 401 then refresh ok                                         | active                                     | invisible to user                         | writeback then retry once                                                     |
| Review                 | upstream stream disconnect after first event                         | active                                     | review fails                              | retry whole workflow if needed                                                |
| Review                 | proxy retries model request after body sent                          | suspended                                  | unsafe behavior                           | block release, fix proxy                                                      |
| Review                 | upstream 401 but writeback preflight unavailable                     | skipped_retryable                          | review fails safely                       | retry later                                                                   |
| Review                 | upstream 401 refresh permanent fail                                  | needs_reconnect                            | review skipped/fails                      | reconnect Codex                                                               |
| Review                 | upstream account entitlement/workspace failure                       | account_required                           | review skipped                            | reconnect under approved account/workspace                                    |
| Review                 | account/workspace policy revocation discovered before refresh        | account_authorization_required             | review skipped                            | reauthorize under current workspace policy                                    |
| Review                 | model quota/rate limit                                               | quota_limited                              | review fails                              | retry later, reduce scope, or upgrade plan                                    |
| Review                 | proxy killed before refresh                                          | active                                     | run fails                                 | retry safe                                                                    |
| Review                 | proxy killed after refresh before writeback                          | unknown_auth_state                         | auto mode paused                          | reconnect likely required                                                     |
| Writeback              | GitHub public key changed                                            | active if retry succeeds                   | delay                                     | refetch key and retry                                                         |
| Writeback              | GitHub App permission missing before refresh                         | permission_required                        | review skipped                            | accept permission update                                                      |
| Writeback              | secret-write token cannot be minted before refresh                   | writeback_authority_paused                 | review skipped                            | fix issuer/signer/permission epoch                                            |
| Writeback              | secret-write token cache mismatch before refresh                     | writeback_authority_paused                 | review skipped                            | disable token cache and rerun readiness                                       |
| Writeback              | GitHub App permission missing after refresh                          | unknown_auth_state                         | paused                                    | accept permission update, reconnect if needed                                 |
| Writeback              | secret-write token cannot be minted after refresh                    | unknown_auth_state                         | paused                                    | restore authority, reconnect if old secret fails                              |
| Writeback              | secret-write token cache mismatch after refresh                      | unknown_auth_state                         | paused                                    | disable token cache, reconcile writeback proof, reconnect if old secret fails |
| Writeback              | secret deleted during lease                                          | unknown_auth_state if refresh happened     | paused                                    | explicit reconnect                                                            |
| Writeback              | local installer reseeded during lease                                | active or seeded                           | stale run rejected                        | do not overwrite newer secret                                                 |
| Drift check            | GitHub secret changed outside setup/writeback                        | external_secret_drift                      | reviews paused                            | rerun local setup                                                             |
| Writeback              | GitHub rate limited after refresh                                    | unknown_auth_state if retry fails          | paused                                    | retry within lease or reconnect                                               |
| Writeback              | same idempotency key with different ciphertext                       | security_invariant_failed                  | auto mode blocked                         | incident triage, block stale key                                              |
| Writeback              | old ciphertext retry after newer generation                          | security_invariant_failed                  | auto mode blocked                         | purge retry queue, preserve newest generation                                 |
| Writeback              | encrypted retry payload retained past TTL                            | security_invariant_failed                  | auto mode blocked                         | purge payload, audit retention path                                           |
| Writeback              | retry queue KMS decrypt fails after refresh                          | unknown_auth_state                         | paused                                    | do not replay, reconnect if old secret fails                                  |
| Writeback              | SaaS response lost after GitHub PUT                                  | pending or active                          | retry may happen                          | idempotent retry with same generation                                         |
| Writeback              | GitHub PUT succeeded but DB commit failed                            | reconcile_required                         | auto mode paused                          | metadata-only reconciliation                                                  |
| Cancellation           | before proxy start                                                   | active                                     | safe                                      | retry                                                                         |
| Cancellation           | during upstream stream with no refresh                               | active                                     | review fails                              | retry                                                                         |
| Cancellation           | after refresh before writeback                                       | unknown_auth_state                         | paused                                    | reconnect or support-guided recovery                                          |
| Fork PR                | secrets unavailable                                                  | active                                     | skipped                                   | maintainer trusted rerun later                                                |
| Workflow changed in PR | trusted workflow mismatch                                            | suspended                                  | skipped                                   | merge trusted workflow update first                                           |
| Repo renamed           | repository id matches but name changed                               | active or suspended                        | may need setup PR                         | resolve current name by id                                                    |
| Repo transferred       | installation mapping changed                                         | suspended                                  | skipped                                   | approve new App install                                                       |
| Public repo            | OAuth mode blocked                                                   | suspended                                  | skipped                                   | switch provider or private repo                                               |

## Concurrency Model

### Why GitHub `concurrency` Is Not Enough

GitHub workflow `concurrency` helps reduce duplicate runs, but it is not a full
auth-stream lock because:

- old workflow versions may lack the group
- manual dispatches can use different workflow names
- reusable workflow callers can differ
- runs can be cancelled at unsafe points
- multiple repositories can share an org secret by mistake
- GitHub does not know whether token refresh occurred

Use GitHub `concurrency` as a secondary control only.

Workflow template rule:

- do not use `cancel-in-progress: true` for the secret-backed refresh job
- if GitHub concurrency is used, it should reduce duplicate review work, not be
  the auth lock
- server lease remains authoritative because GitHub may cancel pending runs,
  process groups in a non-obvious order, and cannot know whether refresh
  started
- if the product wants "latest PR only" behavior, split it into a no-secret
  preflight/cancellation layer before auth restore

### Account-Level Serialization Fallback

The target design assumes dedicated per-repo Codex logins create independent
refresh streams. Spike E must prove this. If it fails, add an account-level
serialization layer:

```text
account_id_hash
provider_instance_id
repository_id
secret_name
```

Rules:

- account hash is computed client-side with the same non-reversible fingerprint
  discipline as generation hashes
- leases for the same account hash serialize refresh across repositories
- no org-wide shared secret is introduced
- normal review may still run only if no refresh is needed and upstream accepts
  the current access token
- any refresh-needed run waits, skips, or asks for rerun rather than racing
  another repo's refresh

Scores if needed:

```text
🎯 7.5 / 10   🛡️ 8.5 / 10   🧠 8 / 10
Approx changes: +500-1200 LOC on top of the base plan.
```

This fallback is worse UX for users with many repos, but safer than allowing
cross-repo refresh-token invalidation.

### Required Server Lease

Lease key:

```text
installation_id
repository_id
provider_instance_id
secret_name
secret_scope
```

Lease value:

```text
lease_id
run_id
run_attempt
workflow_ref
job_workflow_ref
event_name
created_at
expires_at
status
rotation_started_at nullable
writeback_confirmed_at nullable
```

Proxy must notify:

```text
proxy_started
refresh_started
writeback_started
writeback_confirmed
proxy_finished_no_refresh
proxy_failed
proxy_sigterm_received
upstream_stream_started
upstream_stream_finished
upstream_stream_aborted
```

If `refresh_started` happened and no `writeback_confirmed` arrives before lease
expiry, mark `unknown_auth_state`.

## Security Threat Model

### Threat: Model Prompt Injection Reads Auth

Risk:

Prompt tries to run commands like:

```text
cat ~/.codex/auth.json
env
ps aux
cat /proc/*/environ
curl localhost proxy admin endpoints
```

Controls:

- Codex runtime `CODEX_HOME` contains no `auth.json`
- runtime env excludes raw auth secret
- no GitHub secret write token in runtime env
- proxy has no plaintext debug endpoints
- proxy binds loopback only
- no unauthenticated shutdown endpoint
- `drop-sudo` or unprivileged user strategy where available
- disable network from shell tools where feasible
- malicious prompt tests in CI

Residual risk:

- model can still spend quota through allowed `/responses` requests
- model can still ask proxy to call upstream within allowed limits

Mitigation:

- max requests
- max tokens
- max elapsed time
- budget policy from SaaS config

### Threat: Model Uses Proxy as a Quota Tunnel

Risk:

The model or a prompted shell command reads Codex runtime config, learns the
nonce-prefixed proxy URL, and sends extra `/responses` requests directly.

Controls:

- proxy exposes no plaintext auth, refresh, debug, admin, file, model-list, or
  writeback endpoints
- proxy data-plane listener exposes no public-key, lease, health, metrics,
  shutdown, status, or config endpoints
- refresh/writeback/control-plane capability is internal to the proxy process
  and not routable through localhost HTTP
- proxy enforces strict method/path/schema allowlist
- proxy rejects hosted tool, remote file, MCP, image/audio/realtime, unexpected
  include, model override, and attachment fields that are outside the pinned
  ReviewRouter review contract
- proxy enforces per-run request, token, body-size, and elapsed-time budgets
- proxy classifies unexpected direct calls separately for diagnostics
- shell network isolation is preferred when the pinned Codex/sandbox stack can
  enforce it reliably

Residual:

- an attacker may spend some user quota inside the allowed budget
- this must fail as quota abuse, not as credential disclosure
- the nonce URL should be assumed visible to the model and tools

Acceptance:

- malicious prompt can at worst consume the configured per-run budget
- no proxy response reveals auth headers, token claims, refresh output, or
  writeback credentials

### Threat: Duplicate Upstream Model Request

Risk:

The proxy or Codex retries a `POST /v1/responses` request after upstream already
accepted it, causing duplicate model cost, duplicated tool-call loops, or
confusing review output.

Controls:

- proxy never retries model requests after request body write or stream start
- retry after 401 is allowed only before response creation/stream start
- request and stream counters enforce a hard per-run budget
- telemetry records safe retry category, not raw prompt or response body
- E2E spike verifies forced disconnects do not replay accepted requests

Residual:

- user may need to rerun the workflow after a mid-stream network failure
- this is preferable to hidden duplicate spend and duplicate side effects

### Threat: Workflow Change Exfiltrates Secret

Risk:

A same-repo contributor edits workflow to print `REVIEWROUTER_CODEX_AUTH_JSON`.

Controls:

- branch protection
- CODEOWNERS for `.github/workflows/**`
- dashboard warnings
- secret-backed run only after trusted workflow path and schema validation
- generated workflow updates through PR
- do not run secret-backed mode from PR-controlled workflow files

Residual:

- any CI secret can be abused by trusted maintainers with workflow write access

### Threat: Required Check Confusion

Risk:

Branch protection requires a ReviewRouter check, but workflow skips, renamed
jobs, duplicate check names, neutral/skipped conclusions, or merge queue gaps
make PRs either merge without intended review or remain pending forever.

Controls:

- one stable final policy job name for branch protection
- final job uses `if: always()` and maps every ReviewRouter state to an
  intentional conclusion
- no workflow-level skips for the required ReviewRouter check
- advisory/required/strict modes are configured explicitly in dashboard
- merge queue uses `merge_group` when the final check is required there
- generated job names are unique across ReviewRouter workflows
- migration tests ensure check names stay stable across workflow schema upgrades

Residual:

- repository owners can still configure branch protection incorrectly; dashboard
  should detect common misconfigurations and show precise setup guidance

### Threat: Review Comment Injection or Output Leakage

Risk:

The model emits Markdown that mentions users, links to external trackers,
embeds images, imitates trusted ReviewRouter instructions, leaks raw prompt or
diff content, or includes token-looking data in PR comments.

Controls:

- raw model output is parsed into a structured review schema
- comment renderer uses an allowlist Markdown subset
- preferred workflow posts comments from a downstream job; the Codex review job
  has no PR/issue write permission
- raw HTML, images, external links, hidden comments, and workflow-command-shaped
  text are stripped or escaped
- `@mentions` and issue/PR autolinks are neutralized unless explicitly allowed
- findings are capped by count, length, path, and diff location validity
- final comment body goes through redaction before posting
- if validation fails, post only a short safe failure message or no comment

Residual:

- review comments can still contain repository context by design
- retention and visibility should match the repository's own PR access model

### Threat: Privileged Event Trampoline

Risk:

`workflow_run` or `pull_request_target` starts a privileged workflow that has
secrets, then checks out or executes untrusted PR code/artifacts.

Controls:

- block `pull_request_target` for this mode
- block `workflow_run` unless a separate artifact attestation design is
  approved
- validate `workflow_ref`, `job_workflow_ref`, `event_name`, `run_id`, and
  `run_attempt` through OIDC
- run secret restore only after fork/public/event guards
- do not consume artifacts produced by untrusted workflows in a secret-backed
  job

### Threat: SaaS Sees Plaintext

Risk:

Bug or malicious change sends `auth_json` to ReviewRouter API.

Controls:

- request schema rejects plaintext-looking fields
- code review rule: writeback endpoint only accepts `encrypted_value`
- audit-log redaction tests
- no raw request body logging
- integration test that sends forbidden fields and expects rejection
- local encryption before SaaS

### Threat: Compromised SaaS Substitutes Public Key

Risk:

If SaaS gives the runner an encryption key, compromised SaaS can decrypt.

Control:

- runner fetches GitHub public key directly from GitHub
- if helper token is needed, token only grants public-key read capability
- SaaS-provided public key material must be independently verified before use

### Threat: Helper Token Leaks on Runner

Risk:

The short-lived GitHub App token used for public-key retrieval is printed,
inherited by `codex exec`, or captured by a malicious prompt.

Controls:

- helper token is downscoped to secret metadata/public-key read only
- helper token is delivered only to the bootstrap/proxy public-key-fetch path
- helper token is removed before Codex runtime starts
- shell env policy excludes token-like variables
- malicious prompt suite checks env, procfs, logs, and process arguments

Residual:

- a compromised trusted workflow step could learn secret names and metadata
- it should not learn plaintext secret values or gain writeback capability

### Threat: Codex Tool Writes Repository Files

Risk:

The model requests write-capable tools or commands even though the review job
should be read-only.

Controls:

- run `codex exec` with read-only sandbox and `approval_policy="never"`
- ignore repo-controlled Codex config and rules
- disable plugins/apps/tool suggestions for this mode
- compare worktree status before and after Codex execution
- fail the run if unexpected files changed
- add malicious prompt tests that request `apply_patch`, shell redirects, and
  generated file writes

Residual:

- if future Codex versions change sandbox behavior, the pinned CLI contract
  tests must catch it before upgrade

### Threat: Concurrent Refresh Token Reuse

Risk:

Two runs restore same auth file. One refreshes first. The other uses old
refresh token and causes permanent invalidation or confusing 401s.

Controls:

- repo-scoped dedicated secret
- no multi-repo org secret for rotating mode
- server lease before proxy receives auth
- in-process refresh mutex
- generation hash in writeback
- stale run detection

### Threat: Writeback After Stale Run

Risk:

Older run writes older auth over newer auth.

Controls:

- lease owner check
- run id and run attempt binding
- generation hash
- reject writeback if lease is no longer active
- reject writeback after a newer confirmed generation
- reject writeback if GitHub secret metadata changed after lease acquisition
  outside the current lease

### Threat: Ciphertext Poisoning

Risk:

A compromised trusted workflow step or action package sends arbitrary encrypted
data to the writeback endpoint. SaaS cannot decrypt the ciphertext, so it
cannot prove the value is a valid Codex `auth.json`.

Controls:

- writeback endpoint is available only after OIDC validation and active lease
- trusted workflow path and `job_workflow_ref` are pinned
- proxy package/action version is pinned by immutable version and checksum where
  possible
- proxy binary is installed before secret restore or bundled with the action
- request schema includes generation hashes and strict expected secret name
- server validates current GitHub key id, ciphertext shape, ciphertext size, and
  idempotency key
- writeback token/session is held only by the proxy process and not exposed to
  Codex runtime

Residual:

- if trusted workflow code itself is compromised, the attacker can cause
  denial-of-service by replacing the secret with unusable encrypted data
- this should not reveal plaintext auth to ReviewRouter SaaS

### Threat: Fingerprint Key Misuse

Risk:

The HMAC fingerprint key is leaked or reused outside its intended repo/provider
scope. An attacker cannot decrypt Codex auth with it, but could forge safe
generation metadata and confuse stale-run detection.

Controls:

- key material is one-run scoped for runner use
- key scope binds repository id, provider instance id, run id, run attempt, and
  lease id
- SaaS verifies OIDC, lease, provider state, GitHub secret metadata, and
  ciphertext shape in addition to generation hashes
- key rotation is supported by key id
- HMAC key material is forbidden in logs, outputs, artifacts, cache, and Codex
  subprocess env

Residual:

- compromised trusted workflow can still cause denial-of-service by writing
  unusable ciphertext through a valid lease

### Threat: SaaS Writeback Split-Brain

Risk:

GitHub accepts a secret update, but SaaS crashes before recording the new
generation, causing later runs to treat the current secret as stale or unknown.

Controls:

- writeback uses explicit `writeback_started` and `writeback_confirmed` states
- DB update after GitHub PUT stores generation hash and GitHub metadata before
  dashboard marks provider active
- reconciler handles "GitHub PUT succeeded, DB commit unknown" as
  `reconcile_required`
- support runbook can suspend or require reconnect without seeing plaintext
  auth
- no automatic refresh starts while reconciliation is required

### Threat: Logs Leak Tokens

Controls:

- never echo secret
- no `set -x` around secret steps
- never write secrets or token-derived material to `$GITHUB_OUTPUT`,
  `$GITHUB_ENV`, `$GITHUB_STEP_SUMMARY`, annotations, or job summaries
- redact token-shaped strings
- proxy logs safe categories only
- no raw upstream body logs
- no `codex --debug` in production mode
- artifact allowlist

### Threat: Infrastructure Captures Sensitive Bodies

Risk:

An API gateway, reverse proxy, APM agent, trace exporter, error reporter, or
support export captures request bodies containing ciphertext, OIDC tokens,
setup tokens, HMAC key material, proxy URLs, or unsanitized review output.

Controls:

- route-specific body logging is disabled for auth-sensitive endpoints
- APM/tracing/error reporting uses allowlisted safe attributes only
- sensitive fields are redacted before serialization
- no session replay or raw HTTP capture for setup/writeback routes
- tests inject sentinel values and fail if they appear in logs, traces, metrics,
  or support exports

Residual:

- infrastructure configuration becomes part of the security release checklist

### Threat: Cache or Artifact Poisoning

Risk:

A previous untrusted run populates a cache/artifact consumed by the
secret-backed job, or a secret-backed job saves sensitive temp files for a
later untrusted run.

Controls:

- no cache restore after secret materialization
- no cache save from jobs that have seen Codex auth
- no artifact download from untrusted workflow runs
- no workspace-wide artifact upload
- explicit sanitized artifact allowlist only
- proxy/action binaries are pinned immutable artifacts, not PR-produced
  artifacts

Residual:

- GitHub-hosted runner image and first-party actions remain trusted supply
  chain dependencies

### Threat: Installer or Action Supply Chain Compromise

Risk:

The installer, proxy package, Codex CLI package, or generated workflow fetches a
mutable artifact that steals auth before local protections apply.

Controls:

- dashboard-generated commands use pinned installer/proxy/Codex versions
- package integrity or checksum is verified before auth is read
- no `latest` tags for secret-backed action/proxy/Codex runtime
- no dependency install from PR-controlled code after secret restore
- emergency kill switch disables new setup and secret-backed runs
- release process signs or attests ReviewRouter proxy artifacts when available

Residual:

- ReviewRouter release infrastructure becomes a high-trust dependency and needs
  separate release hardening

### Threat: Installer Exfiltrates Auth During Setup

Risk:

The local installer legitimately reads `auth.json`, then accidentally or
maliciously sends plaintext auth, device codes, terminal output, or crash
payloads to ReviewRouter SaaS or telemetry systems.

Controls:

- installer has explicit network phases before and after auth materialization
- setup completion schema allows only safe metadata and rejects
  plaintext-looking fields client-side before send
- no analytics, APM, crash reporting, session replay, or support upload runs
  after auth is read
- executable downloads happen only before auth is read and only with
  pinned/checksum-verified artifacts
- local logs redact full auth JSON and individual token strings before smoke
  commands run
- crash after GitHub secret write enters `seeded_unconfirmed` and is recovered
  by idempotent local setup rerun

Residual:

- the installer binary/script is still a high-trust local component. Production
  must prefer pinned verified artifacts over mutable `curl | bash`.

### Threat: Public Repository Abuse

Controls:

- block Codex OAuth mode by default for public repositories
- explain API-key or enterprise alternatives
- allow self-hosted/persistent only if user explicitly accepts risk later
- never run secret-backed fork PR review

## Observability

### Safe Metrics

```text
codex_oauth_setup_started_total
codex_oauth_setup_succeeded_total
codex_oauth_setup_unconfirmed_total by safe reason
codex_oauth_lease_acquired_total
codex_oauth_lease_conflict_total
codex_oauth_refresh_started_total
codex_oauth_refresh_succeeded_total
codex_oauth_refresh_failed_total by safe reason
codex_oauth_refresh_ambiguous_total by safe reason
codex_oauth_skipped_retryable_total by safe reason
codex_oauth_writeback_succeeded_total
codex_oauth_writeback_failed_total by safe reason
codex_oauth_unknown_state_total
codex_oauth_reconcile_required_total
codex_oauth_needs_reconnect_total
codex_oauth_account_required_total by safe reason
codex_oauth_account_authorization_required_total by safe reason and consent version
codex_oauth_oidc_rejected_total by safe reason
codex_oauth_public_key_fetch_failed_total by safe reason
codex_oauth_cli_contract_failed_total by safe reason
codex_oauth_upstream_stream_started_total
codex_oauth_upstream_stream_aborted_total by safe reason
codex_oauth_model_request_retry_blocked_total by safe reason
codex_oauth_quota_limited_total by safe reason
codex_oauth_maintenance_suppressed_total by safe reason
codex_oauth_review_scope_limited_total by safe reason
codex_oauth_process_output_limited_total by safe reason
codex_oauth_sensitive_input_redacted_total by class and confidence
codex_oauth_sensitive_input_blocked_total by safe reason
codex_oauth_comment_posted_total
codex_oauth_comment_skipped_total by safe reason
codex_oauth_comment_updated_existing_total
codex_oauth_comment_rate_limited_total by safe reason
```

### Safe Health Fields

```text
provider: codex_oauth
mode: github_hosted_refresh
status: active | seeded_unconfirmed | setup_pr_open | workflow_pending_verification | workflow_drift_detected | workflow_schema_mismatch | workflow_attestation_incomplete | rotating_protocol_unsupported | control_plane_version_unsupported | workflow_repair_required | workflow_disabled_by_rollback | secret_restore_grant_issued | account_authorization_required | skipped | skipped_retryable | stale_queued_secret | external_secret_drift | reconcile_required | permission_required | policy_blocked | process_isolation_unsupported | writeback_authority_paused | quota_limited | account_required | needs_reconnect | unknown_auth_state | security_invariant_failed | suspended
run_id
run_attempt
workflow_schema_version
release_channel
configured_action_ref
resolved_action_sha
proxy_version
codex_version
refresh_attempted: boolean
refresh_request_sent: boolean
refresh_outcome: none | succeeded | permanent_failure | transient_before_send | ambiguous_after_send
upstream_stream_started: boolean
upstream_request_replayed: false
token_age_bucket: <1d | 1-7d | 7-14d | >14d | unknown
budget_state: ok | soft_limited | hard_limited | unknown
account_state: ok | changed | entitlement_missing | workspace_mismatch | unknown
review_scope_state: complete | limited | truncated | failed | unknown
review_input_secret_state: none | redacted | blocked | scanner_failed | unknown
comment_post_state: none | posted | updated_existing | skipped_outdated | skipped_merge_group | posting_rate_limited | posting_location_failed | posting_validation_failed | unknown
files_seen_count
files_reviewed_count
files_skipped_count
diff_bytes_bucket
process_output_state: ok | truncated | overflow | invalid_encoding | unknown
auth_generation_hash: keyed non-reversible hash
writeback_confirmed: boolean
reconciliation_required: boolean
safe_error_code
```

### Forbidden Telemetry

```text
auth.json
tokens
JWT bodies
Authorization headers
raw provider response body
raw prompt
raw diff
model output dump
raw unsanitized review output
encrypted_value body unless strictly needed and redacted
setup token
HMAC key material
OIDC JWT
proxy URL / nonce
```

## Dashboard UX

### Provider States

Display:

```text
Not connected
Setup pending confirmation
Connected
Refreshing
Temporarily skipped
Stale queued run skipped
External secret changed
Reconciliation required
Workflow setup pending
Workflow verification pending
Workflow repair required
Needs reconnect
Auth state uncertain
Security invariant failed
Permission update required
Policy blocked
Process isolation unsupported
Writeback authority paused
Quota limited
Account action required
Account authorization required
Skipped for fork PR
Unsupported for public repo
```

### User-Facing Messages

Needs reconnect:

```text
Codex session needs reconnect. The saved session can no longer refresh.
Run the setup command again from a machine where you can sign in to Codex.
```

Account authorization required:

```text
ReviewRouter needs updated approval before using this Codex account session in
CI. Rerun the local setup command and confirm the current repository, account
policy, quota usage, and feature scope.
```

Unknown state:

```text
Codex auth state is uncertain. A refresh may have happened, but GitHub secret
writeback was not confirmed. Run the setup command again to avoid repeated
failed reviews.
```

Stale queued run:

```text
Skipped this Codex review because the workflow was queued with an older saved
session. Rerun the workflow so GitHub loads the latest refreshed secret.
```

Temporarily skipped:

```text
Codex review was skipped before refreshing the saved session because a required
service was temporarily unavailable. The saved session was not changed. Retry
the workflow later.
```

Setup pending confirmation:

```text
Codex auth may have been written to GitHub, but ReviewRouter did not finish
recording the safe setup metadata. Rerun the setup command. ReviewRouter still
cannot see your Codex credentials.
```

Permission update required:

```text
ReviewRouter needs updated GitHub App permissions to keep Codex auth refreshed.
Approve the permission update, then rerun the workflow. The saved Codex session
was not changed.
```

Policy blocked:

```text
GitHub organization or repository policy is blocking the generated
ReviewRouter workflow. Your Codex session may still be valid. Ask a repository
or organization admin to update Actions/App policy, then rerun setup.
```

Process isolation unsupported:

```text
ReviewRouter skipped this Codex review before restoring auth because the
current runner image or process sandbox could not prove the required isolation.
Your Codex session was not changed. Retry after ReviewRouter ships a compatible
runner/proxy update, or use the persistent runner fallback.
```

Writeback authority paused:

```text
ReviewRouter skipped this Codex review before refreshing because GitHub
writeback authority is paused or cannot be safely scoped. Your saved Codex
session was not changed. Retry after ReviewRouter resolves the GitHub App token
issuer or permission issue.
```

External secret changed:

```text
The Codex auth secret changed outside ReviewRouter setup or writeback.
Run the setup command again locally so ReviewRouter can verify the new session
without seeing its plaintext.
```

Reconciliation required:

```text
GitHub may have accepted a refreshed Codex session, but ReviewRouter did not
finish recording the safe metadata. Reviews are paused until the state is
reconciled without decrypting the secret.
```

Workflow setup pending:

```text
Codex auth is saved, but the ReviewRouter workflow setup PR is not merged yet.
Merge the setup PR, then wait for ReviewRouter to verify the workflow from the
trusted default branch.
```

Workflow verification pending:

```text
Codex auth is saved, but ReviewRouter has not yet verified the generated
workflow from a trusted default-branch run. Reviews will start after that
verification succeeds.
```

Workflow repair required:

```text
ReviewRouter found a workflow mismatch or drift before restoring Codex auth.
Open or merge the repair setup PR. You do not need to reconnect Codex unless a
separate auth failure is shown.
```

Security invariant failed:

```text
ReviewRouter blocked Codex auto-refresh because a safety invariant failed.
Your Codex session may still be valid, but reviews are paused until
ReviewRouter support or a verified rollback clears the unsafe state.
```

Quota limited:

```text
Codex review was skipped because the subscription or ReviewRouter safety budget
is temporarily limited. Your saved Codex session was not changed. Retry later
or reduce the review scope.
```

Review scope limited:

```text
Codex review completed with limited scope because this pull request is larger
than the configured review budget or GitHub did not expose the full diff.
ReviewRouter did not change your Codex session.
```

Account action required:

```text
The saved Codex session belongs to an account or workspace that no longer
matches this repository's ReviewRouter provider. Reconnect from a machine where
you can sign in with an approved Codex account.
```

Check mode copy:

```text
Advisory mode posts review feedback without intentionally blocking merge.
Required mode blocks only when ReviewRouter cannot safely run or verify the
Codex review. Strict mode also blocks on skipped or quota-limited reviews.
```

Branch protection guidance:

```text
If you want ReviewRouter to block merges, require only the final
reviewrouter-codex-policy check. Do not require internal bootstrap, proxy,
comment, or maintenance jobs.
```

Dashboard should warn when it can detect:

- branch protection requires an internal ReviewRouter job instead of final
  policy job
- branch protection requires old workflow/check names after schema migration
- merge queue is enabled but generated workflow lacks `merge_group`
- final policy check is reported by an unexpected source/App
- final policy check has not reported on the latest PR head SHA

## Support and Admin Runbooks

Support tooling must preserve the same no-plaintext boundary as production
traffic. Admins can operate states and metadata, not credentials.

Allowed admin actions:

- suspend a provider or organization
- mark `needs_reconnect` with a safe reason
- mark `permission_required` after GitHub permission checks fail
- clear `skipped_retryable` after dependencies recover
- start metadata-only reconciliation for `reconcile_required`
- mark `external_secret_drift` after GitHub metadata drift is detected
- request local setup/reconnect from the user
- request account-auth CI reauthorization from the user or approved repository
  actor
- rotate HMAC fingerprint keys and invalidate outstanding one-run material
- view safe state, lease ids, run ids, workflow refs, versions, and safe error
  codes

Forbidden admin actions:

- view, download, decrypt, or paste Codex `auth.json`
- view refresh/access/id tokens, OIDC JWT bodies, helper tokens, setup tokens,
  writeback tokens, HMAC runner material, or raw ciphertext request bodies
- mark a new auth generation confirmed without a recorded GitHub secret PUT
  success or reconciler proof
- rewrite `REVIEWROUTER_CODEX_AUTH_JSON` from SaaS-supplied plaintext
- bypass OIDC, lease ownership, event policy, or repository visibility checks
- retry refresh automatically from `unknown_auth_state`
- clear `external_secret_drift` without a local setup validation
- create, backdate, override, or force-clear account-auth consent

Runbooks:

| State                               | Support action                                                                                                                                                                          | Must not do                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `needs_reconnect`                   | Ask user to rerun local setup. Keep reviews skipped until new generation is verified.                                                                                                   | Do not retry old refresh token in a loop.                                                   |
| `seeded_unconfirmed`                | Ask user to rerun setup. Installer recomputes local generation hash and completes safe metadata recording.                                                                              | Do not trust GitHub `updated_at` alone as the initial generation.                           |
| `unknown_auth_state`                | Stop automation. Prefer local reconnect. If product later ships recovery, require explicit safe proof that current GitHub secret is valid.                                              | Do not rerun from the old queued secret.                                                    |
| `reconcile_required`                | Run metadata-only reconciler against pending writeback record and GitHub secret metadata.                                                                                               | Do not assume GitHub PUT failed just because DB commit failed.                              |
| `external_secret_drift`             | Ask user to rerun setup from trusted local machine.                                                                                                                                     | Do not refresh from externally changed secret.                                              |
| `permission_required`               | Ask owner to approve GitHub App permission update or reinstall selected repo access.                                                                                                    | Do not introduce PATs or workflow `Secrets: write` tokens.                                  |
| `policy_blocked`                    | Give exact GitHub org/repo Actions/App policy blocker and admin handoff instructions.                                                                                                   | Do not ask user to reconnect Codex or create PAT workarounds.                               |
| `debug_logging_blocked`             | Ask user to rerun with Actions debug/runner diagnostic logging disabled, or use internal sentinel-only diagnostics.                                                                     | Do not restore auth just to debug, and do not ask for Codex reconnect.                      |
| `sync_stale`                        | Run webhook/installation/repository reconciliation and show stale sync status.                                                                                                          | Do not treat delayed webhooks as auth failure.                                              |
| `process_isolation_unsupported`     | Block the runner/proxy/Codex tuple, rerun compatibility spike, or guide to persistent runner fallback.                                                                                  | Do not restore auth with best-effort process hardening.                                     |
| `writeback_authority_paused`        | Pause token issuer/writeback authority, inspect safe issuance ledger and SDK cache-key diagnostics, disable affected cache tuple, rotate signer/App key if needed, and rerun readiness. | Do not mint broad installation tokens or ask the user for a PAT.                            |
| `quota_limited`                     | Explain retry/backoff, scope reduction, or plan/provider settings.                                                                                                                      | Do not tell user to reconnect unless auth failure is separately proven.                     |
| `account_authorization_required`    | Ask an authorized actor to rerun local setup and confirm the current account-auth CI policy, feature scope, quota ownership, and workspace policy.                                      | Do not force consent from support/admin or treat missing consent as a broken Codex session. |
| `account_required`                  | Ask repo owner to reconnect with an approved Codex account/workspace or switch provider mode.                                                                                           | Do not treat account/workspace entitlement loss as GitHub policy failure.                   |
| `setup_pr_open`                     | Ask user to review and merge setup PR.                                                                                                                                                  | Do not mark provider active from secret existence.                                          |
| `workflow_pending_verification`     | Ask user to run/wait for trusted default-ref verification.                                                                                                                              | Do not restore auth from setup PR merge alone.                                              |
| `workflow_drift_detected`           | Open or recommend a repair setup PR with exact drift reason.                                                                                                                            | Do not ask for Codex reconnect.                                                             |
| `workflow_schema_mismatch`          | Regenerate workflow setup PR for expected schema/auth mode.                                                                                                                             | Do not fall back to static workflow semantics.                                              |
| `workflow_attestation_incomplete`   | Diagnose missing OIDC/workflow proof and repair policy/workflow.                                                                                                                        | Do not treat missing proof as trust.                                                        |
| `rotating_protocol_unsupported`     | Upgrade action/proxy/workflow or keep legacy static mode.                                                                                                                               | Do not pass rotating secret to protocol v1.                                                 |
| `control_plane_version_unsupported` | Wait for compatible SaaS/control-plane rollout or rollback workflow.                                                                                                                    | Do not bypass compatibility registry.                                                       |
| `stale_queued_secret`               | Ask for workflow rerun after current generation is visible.                                                                                                                             | Do not refresh from stale queued auth.                                                      |
| `skipped_retryable`                 | Allow retry with backoff once dependency recovers.                                                                                                                                      | Do not mark reconnect required unless a permanent auth failure is proven.                   |

Every support action requires actor, timestamp, provider id, repository id,
reason code, and ticket/reference id. Audit rows must store safe metadata only
and must be covered by the same retention policy as provider audit metadata.

## Incident Response

Incident response must assume different materials have different blast radius.
Do not treat every event as reconnect, and do not underreact to plaintext auth
exposure.

Incident classes:

| Class                                      | Examples                                                                  | Immediate action                                                                                                                 | User action                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Plaintext auth suspected exposed           | `auth.json`, refresh/access/id token in logs/artifacts/SaaS/issue comment | Emergency-block provider/org, stop secret restore, preserve safe evidence, purge public copies where possible                    | Rerun local setup with a fresh dedicated Codex login; revoke/log out old session if available |
| Encrypted writeback payload exposed        | `encrypted_value`, ciphertext hash, key id                                | Redact/purge logs, rotate retry queue entries, verify no secret write permission was exposed                                     | Usually none unless paired with write permission compromise                                   |
| HMAC/fingerprint material exposed          | runner HMAC key, setup/writeback scoped material                          | Invalidate scoped material, rotate fingerprint key id, block writes signed with old scope                                        | Usually none                                                                                  |
| Helper/App token exposed                   | public-key helper token, installation token                               | Revoke/expire token, block current run, inspect token permissions and logs                                                       | Usually none unless token had broader permissions                                             |
| GitHub App private key exposed             | private key used to mint App JWTs and installation tokens                 | Emergency-block helper-token minting and writeback, rotate GitHub App key, audit installation-token issuance and App permissions | Usually none unless Codex auth plaintext/writeback integrity was also compromised             |
| Action/setup/writeback signing key exposed | action-session JWT signer, setup token signer, writeback token signer     | Rotate signer, invalidate active sessions/tokens, block replayed or old `kid` after grace                                        | Usually rerun workflow/setup only if an active operation was interrupted                      |
| Proxy/action/installer compromise          | bad release artifact, checksum mismatch, endpoint allowlist regression    | Compatibility `emergency_blocked`, disable new setup, block secret restore before proxy start                                    | Rerun setup only after fixed pinned version                                                   |
| Telemetry leak sentinel hit                | fake token appears in logs/APM/support export                             | Disable affected route/version, purge sink, add regression test before re-enable                                                 | Usually none if sentinel only                                                                 |

Evidence bundle rules:

- store only safe metadata: provider id, repo id, run id, run attempt, version,
  workflow ref, state transitions, safe error codes, sentinel ids, log sink ids
- never attach raw logs containing suspected secrets to tickets
- support export must redact before ticket creation, not after
- all incident state transitions are audited with actor and reason
- customer-facing message must distinguish "session may be leaked" from
  "automation/policy failed"

Recovery rules:

- if plaintext Codex auth may have leaked, mark provider `needs_reconnect` and
  do not attempt refresh/writeback from the old secret
- if only ciphertext or HMAC metadata leaked, prefer rotation/invalidation of
  operational material without forcing Codex reconnect
- if action/proxy compatibility is blocked, keep GitHub secret intact but unused
- never delete customer secrets automatically during incident response
- after re-enable, require the same compatibility and malicious-prompt tests
  that would gate a new release

Reconciliation required:

```text
Codex auth update may have reached GitHub, but ReviewRouter did not finish
recording the new generation. Reviews are paused while ReviewRouter checks
GitHub secret metadata. No Codex credentials are visible to ReviewRouter.
```

External secret changed:

```text
The Codex GitHub secret was changed outside ReviewRouter setup or writeback.
ReviewRouter cannot verify the new value without seeing plaintext credentials.
Run the setup command again to validate the session locally and reconnect.
```

Permission required:

```text
ReviewRouter needs GitHub App Secrets: write permission to keep Codex OAuth
fresh on GitHub-hosted runners. Plaintext Codex credentials still stay out of
ReviewRouter SaaS.
```

Fork PR skip:

```text
Skipped Codex subscription review because this pull request comes from a fork
and secret-backed reviews are disabled for untrusted code.
```

Public repo unsupported:

```text
Codex subscription OAuth with auth.json is not enabled for public repositories.
Use a private repository, a trusted self-hosted runner, or another provider
mode.
```

## Installer Plan

### Phase 1: Local Dedicated Session

Tasks:

- add `--mode github-hosted-refresh`
- resolve GitHub repo id via `gh api`
- fetch pinned installer/action/proxy metadata before auth is materialized
- enforce installer network phase separation before and after auth is read
- run repository/organization policy preflight and classify blockers before
  claiming setup success
- resolve local Codex credential source through the explicit resolver states
  and refuse unsupported implicit sources
- create `~/.reviewrouter/codex/<repo-id>`
- write config with `cli_auth_credentials_store = "file"`
- run `codex login --device-auth`
- fallback to `codex login`
- validate auth file shape
- verify account/workspace fingerprint against previous trusted generation or
  require explicit account replacement confirmation
- present and record versioned account-auth CI consent before writing the
  rotating GitHub secret
- run smoke
- write `REVIEWROUTER_CODEX_AUTH_JSON` repo secret
- notify ReviewRouter SaaS with safe setup status only
- reject any setup completion payload that contains plaintext-looking auth
  fields before sending
- record local setup metadata without tokens, including repo id, Codex CLI
  version, and auth file shape version
- record initial generation hash and fingerprint key id in SaaS after secret
  write succeeds
- refuse to overwrite while SaaS reports an active lease unless user explicitly
  confirms a reconnect recovery
- handle crash/retry after secret write but before setup completion as
  idempotent `seeded_unconfirmed`

Tests:

- setup session token expires
- setup session token rejects wrong repo/provider instance
- missing `gh`
- `gh` unauthenticated
- wrong repo
- missing Codex CLI
- malformed auth JSON
- API-key auth mode rejected
- missing refresh token rejected
- account/workspace hash mismatch requires explicit replacement confirmation
- account entitlement/workspace policy failure maps to `account_required`
- missing, stale, wrong-version, wrong-repo, wrong-account, wrong-workspace, or
  wrong-feature-scope consent maps to `account_authorization_required`
- maintenance refresh cannot be enabled unless consent records that scope
- old `last_refresh` warns
- repo secret write command selected
- org multi-repo mode blocked
- dry run prints no secret
- dry run does not request or hash auth JSON
- active lease warning blocks accidental reseed
- Actions disabled / action not allowlisted maps to `policy_blocked`
- App permission update pending owner approval maps to `permission_required`
- selected repository missing from App installation maps to
  `permission_required`
- oversized auth JSON fails before `gh secret set`
- structured JSON secret is masked by full value and token substrings before
  any smoke output
- installer refuses to send setup completion payload with `auth_json`,
  `access_token`, `refresh_token`, `id_token`, device code, or raw stdout fields
- installer performs no executable downloads after auth materialization
- installer crash after GitHub secret write can rerun idempotently without
  trusting GitHub `updated_at` alone

### Phase 2: Workflow Template

Tasks:

- add new provider mode to workflow provisioning
- generate workflow from pinned template and schema version
- open or update a setup PR using local `gh` auth by default
- pass `REVIEWROUTER_CODEX_AUTH_JSON` only to proxy bootstrap step
- install pinned Codex CLI and ReviewRouter proxy package
- install or verify proxy package before secret restore
- pin tool versions; do not use `latest`
- verify package checksum/signature where available
- disable caches/artifact downloads after secret restore
- run secret-backed job only from trusted workflow refs
- reject `workflow_run` and `pull_request_target` in generated templates
- configure temp runtime `CODEX_HOME`
- ensure provider subprocess env allowlist excludes raw secrets
- preserve existing legacy `CODEX_AUTH_JSON` mode as fallback
- add workflow schema version
- add OIDC session exchange before lease
- split generated workflow into secret-backed `codex-review` job and
  downstream `post-review-comment` job
- add child-process environment firewall helper that launches Codex and any
  model-controlled subprocess with an explicit allowlist, not inherited runner
  environment
- add stable final `reviewrouter-codex-policy` job with advisory/required/strict
  policy mapping
- map `account_required` to final policy conclusions according to
  advisory/required/strict mode
- include `merge_group` trigger only when repository uses merge queue and
  required-check mode is enabled
- preserve legacy workflow mode until setup PR is merged and verified by OIDC
- produce rollback PR that disables new mode without deleting user secrets

Tests:

- setup PR is idempotent when installer runs twice
- workflow merge preserves unrelated user configuration or fails with explicit
  conflict guidance
- SaaS cannot silently push workflow changes in the default path
- generated review job contains `id-token: write`
- generated review job does not contain `pull-requests: write`,
  `issues: write`, or `contents: write`
- generated comment job is downstream of review job and contains only the
  permissions needed to post sanitized comments
- generated final policy job has stable name, `if: always()`, and deterministic
  conclusions for every ReviewRouter state
- fork guard appears before secret restore
- no `pull_request_target`
- no `workflow_run`
- no `permissions: write-all`
- no secret in global env
- secret only appears in proxy bootstrap step
- no dependency install from PR-controlled code after secret restore
- no `$GITHUB_OUTPUT`, `$GITHUB_ENV`, or step-summary writes containing
  auth-derived material
- no cache save/restore around secret-backed steps
- `codex exec` uses `--ignore-user-config` and `--ignore-rules`
- `codex exec` uses `--sandbox read-only`, `--ephemeral`, and
  `approval_policy="never"`
- Codex runtime env excludes `GITHUB_TOKEN`
- Codex runtime env excludes `ACTIONS_ID_TOKEN_REQUEST_URL`,
  `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_RUNTIME_TOKEN`,
  `ACTIONS_CACHE_URL`, `ACTIONS_RESULTS_URL`, `GITHUB_ENV`,
  `GITHUB_OUTPUT`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY`, `GITHUB_PATH`,
  package registry tokens, and ReviewRouter helper/writeback/HMAC material
- child process launcher tests fail if `process.env` is passed through without
  allowlist projection
- comment job receives only sanitized artifact and not Codex auth/proxy material
- reusable workflow caller maps new secret explicitly

### Phase 3: OAuth Proxy

Tasks:

- implement proxy binary or bundled JS/Rust tool
- read auth from stdin
- validate JSON
- start loopback HTTP server
- write server info file
- generate nonce path prefix
- implement `/v1/responses`
- implement strict method/path/query allowlist
- implement local compatibility deny/empty sinks for known Codex warmup paths
- inject ChatGPT headers upstream
- implement refresh mutex
- implement pre-refresh threshold
- implement 401 refresh and one retry
- implement local GitHub public key fetch
- encrypt refreshed auth
- call SaaS writeback endpoint
- expose safe health events
- verify worktree unchanged after Codex runtime unless explicitly allowed
- disable persistent history and feedback surfaces when supported by CLI
- enforce shell command policy for secret-backed review mode

Tests:

- auth not in env after start
- malformed JSON rejected
- API-key auth rejected for OAuth proxy mode
- no refresh token rejected
- only `/v1/responses` allowed
- wrong nonce/path prefix denied before body read
- unknown path denied
- inbound Authorization stripped
- upstream Authorization injected
- 401 causes one refresh and retry
- concurrent requests share one refresh
- refresh failure classified
- account/workspace/entitlement permanent failures classified as
  `account_required`
- writeback failure after refresh marks unknown
- logs contain no token-looking substrings

### Phase 4: SaaS Lease and Writeback

Tasks:

- add GitHub App `Secrets: write` permission copy and upgrade flow
- detect existing installations that have not accepted the new permission
- add permission-profile migration, permission epoch ledger, owner/admin
  approval handoff, and explicit installation-token scope verification
- add typed GitHub App installation-token issuer with `public_key_read` and
  `secret_writeback` purposes, issuance ledger, caller allowlist, KMS/signer
  key ids, and emergency pause controls
- isolate rotating OAuth GitHub App token minting from generic Octokit
  `getInstallationOctokit(...)` helpers and shared SDK auth caches
- add lease persistence
- add OIDC-bound lease acquire endpoint
- add one-shot secret restore grant service consumed by lease acquire before
  auth bytes are parsed or proxied
- add rotating OAuth OIDC claim contract and `OidcTrustSnapshotV1`
- add OIDC v2 exchange route/session audience separated from protocol v1
- add OIDC claim capability registry and no-secret diagnostic fixture capture
- add subject-template diagnostics and drift detection
- add writeback endpoint accepting ciphertext only
- add GitHub secret update adapter
- add public-key provenance validator and sealed-box envelope metadata
- add one-shot public-key helper capability scoped to exact repo/secret
- add writeback confirmation state machine that requires GitHub PUT proof
- add encrypted writeback payload custody ledger, ciphertext hash-only safe
  views, optional encrypted short-TTL retry queue, and replay/rollback guards
- add GitHub webhook inbox/projection hardening for rotating providers,
  including raw-body signature verification, payload hash dedupe,
  async projection, dead-letter handling, and lease-time reconciliation
- add GitHub Actions debug/log/archive/summary/output/artifact channel scanner,
  including blocking policy for debug reruns before secret restore and canary
  verification for log archives and job summaries
- add reusable workflow caller/callee contract scanner and OIDC attestation,
  including `secrets: inherit` rejection, explicit caller permissions, exact
  secret mapping, called workflow SHA policy, and nested workflow blocking
- add sensitive-route registry entries for setup, lease, public-key, writeback,
  provider health, compatibility, support export, and artifact ingest endpoints
- add logging/APM/error/support telemetry sink harness for auth-sensitive
  routes
- add provider health state transitions
- add dashboard reconnect state
- add dashboard permission-upgrade state
- add dashboard account-required state and account replacement confirmation
- add audit events without secrets

Tests:

- OIDC invalid audience rejected
- OIDC default audience rejected
- OIDC unexpected subject shape rejected
- OIDC missing mandatory rotating claim rejected
- OIDC v2 required claim missing maps to `oidc_claim_contract_unsupported`
- protocol v1 action session rejected by rotating OAuth lease/writeback routes
- protocol v2 secret-bearing session rejected by legacy runtime-config and
  memory routes unless explicitly allowlisted
- OIDC public repository visibility rejected
- OIDC self-hosted runner rejected for no-VPS mode
- OIDC unexpected environment claim rejected
- raw OIDC JWT and raw claims object never persist
- no-secret preflight returns one-shot restore grant only after full tuple
  validation
- lease acquire consumes restore grant exactly once and rejects expired,
  replayed, wrong run, wrong attempt, wrong workflow, wrong permission epoch,
  wrong compatibility decision, or wrong provider grants
- bootstrap with missing/invalid restore grant does not parse, log, proxy, or
  fingerprint auth bytes
- wrong repo id rejected
- wrong workflow path rejected
- wrong `job_workflow_ref` rejected
- wrong `job_workflow_sha` rejected when the claim is present
- unexpected `check_run_id`/run binding rejected when the claim is present
- same-repo PR blocked by strict actor/ref trust policy maps to
  `policy_blocked`
- workflow_dispatch arbitrary ref input is rejected unless resolved to a
  trusted PR/head SHA through GitHub API
- duplicate `jti` rejected
- re-run of originally untrusted event rejected
- fork event rejected
- public repo rejected
- lease conflict blocks second run
- stale lease handling
- writeback without lease rejected
- writeback with plaintext field rejected
- writeback with wrong run id rejected
- writeback with SaaS-supplied public key rejected before encryption
- wrong repository public key, wrong `key_id`, wrong public-key hash, wrong
  secret name, and wrong repository id rejected before writeback
- raw `encrypted_value` is absent from durable tables, logs, support exports,
  and safe projections unless explicitly stored in the encrypted retry queue
- encrypted retry queue records require TTL, KMS key id, ciphertext hash,
  lease/run identity, permission epoch, public-key hash, and generation hash
- retry with same idempotency key succeeds only for the exact same ciphertext,
  generation, public key, lease, run attempt, repo, installation, secret name,
  permission epoch, and workflow schema
- retry with same idempotency key but different ciphertext or bound metadata
  maps to `security_invariant_failed`
- stale ciphertext retry after newer generation, external drift, local reseed,
  provider deletion, permission loss, repository transfer, public visibility
  change, workflow schema drift, or lease expiry is rejected before GitHub PUT
- retry queue KMS outage or decrypt failure blocks replay and maps to
  `unknown_auth_state` only when refresh may already have happened
- GitHub PUT success proof accepts only `201` create and `204` update
- GitHub secret metadata existence, `updated_at`, and dashboard manual
  confirmation cannot advance rotating generation
- stale queued generation rejected before proxy refresh
- HMAC key scope mismatch rejected
- reconcile required state blocks new refresh
- GitHub 403 maps to permission required
- GitHub 404 maps to repo/install issue
- GitHub rate limit maps to retryable or unknown according to refresh state
- GitHub App permission epoch resolver separates desired App profile, accepted
  installation permissions, selected-repository membership, and minted token
  permissions
- manifest generator and readiness smoke distinguish `standard`,
  `rotating-writeback`, and optional org/ruleset permission profiles
- token issuer rejects missing `repository_ids`, missing `permissions`, and
  overbroad token requests before minting helper/writeback tokens
- token response permissions and repository scope are validated before lease
  activation
- token issuer rejects generic callers, support/admin callers, webhook
  projectors, dashboard sync, setup PR workers, omitted `repository_ids`,
  omitted `permissions`, overbroad token responses, wrong purpose, wrong
  permission epoch, and missing lease/writeback intent
- token issuer tests reject shared Octokit/App auth cache hits with wrong
  purpose, repo id, permissions, permission epoch, API base URL, issuer key, or
  compatibility tuple
- rotating helper/writeback adapters cannot call generic
  `getInstallationOctokit(...)`, dashboard setup clients, repo-health clients,
  worker setup clients, or comment-token issuers
- writeback token issuance requires durable writeback intent and active lease;
  public-key helper token issuance cannot request `Secrets: write`
- token issuance ledger stores safe HMAC fingerprint, permission hash, repo
  scope hash, issuer key id, caller id, purpose, status, and TTL, never token
  plaintext
- signer/KMS outage or emergency token-issuer pause maps to
  `writeback_authority_paused` before refresh
- webhook route verifies raw-body `X-Hub-Signature-256` before parsing and
  stores only safe inbox metadata plus payload hashes
- duplicate webhook delivery id with same payload hash is idempotent; duplicate
  delivery id with different payload hash is rejected as suspicious
- out-of-order active/permission-positive webhook cannot re-enable rotating
  provider without GitHub API source-of-truth reconciliation
- webhook worker retry/dead-letter state surfaces stale sync diagnostics and
  lease preflight still blocks unsafe secret restore
- generated workflow scanner rejects `ACTIONS_STEP_DEBUG`,
  `ACTIONS_RUNNER_DEBUG`, `runner.debug`, shell xtrace, verbose package
  managers, unsafe annotation helpers, job-output payload transfer, broad
  artifact upload, artifact download-all, and missing artifact retention before
  secret restore
- disposable debug-mode canary fetches step logs, runner diagnostic logs,
  summaries, annotations, artifact manifests, and downloaded artifacts and
  proves sentinel secrets are absent
- reusable workflow scanner rejects `secrets: inherit`, missing explicit
  `workflow_call` secret declarations, missing caller job `permissions`,
  `environment:` in the called secret-backed job, broad provider secret
  mapping, nested reusable workflow chains, and unsafe reusable workflow outputs
- reusable OIDC v2 validator rejects missing/wrong `job_workflow_ref`, missing
  strict-channel `job_workflow_sha`, branch-based called workflow refs, caller
  workflow mismatch, and called workflow resolved SHA not allowed by the
  compatibility registry
- sensitive-route sentinel values are absent from logs, traces, metrics, error
  events, support exports, DB rows, artifacts, and summaries
- validation/body-parser errors on sensitive routes never echo offending values
- existing App installation missing new permission maps to permission upgrade
- account replacement cannot proceed during active lease
- account-required state blocks auto refresh until explicit reconnect or
  approved provider switch

### Phase 5: Migration

Tasks:

- keep legacy `CODEX_AUTH_JSON` mode
- mark legacy mode as static OAuth in dashboard
- offer "upgrade to auto-refresh" command
- create new secret instead of overwriting old
- update workflow through setup PR
- after stable adoption, suggest deleting old `CODEX_AUTH_JSON`
- document rollback to legacy static or self-hosted persistent runner

Tests:

- old workflows still detected
- new workflows detected
- mixed secrets do not conflict
- rollback disables proxy mode
- dashboard status distinguishes modes

## Production Line Count Estimate

MVP estimate:

```text
installer changes including credential-source resolver: 700-1200 LOC
provider catalog/setup/data-model migration boundary: 450-1050 LOC
account-auth CI consent and quota-ownership guard: 250-650 LOC
installer release manifest and bootstrap verification: 400-800 LOC
workflow template: 700-1200 LOC
action protocol v2 and static-fallback rejection: 400-900 LOC
mixed-fleet release channels and rollback controls: 300-800 LOC
GitHub App permission upgrade and secret wire-contract hardening: 250-650 LOC
GitHub App permission epoch, manifest profile, and token-scope verifier: 300-700 LOC
GitHub webhook inbox, async projection, ordering, and reconcile guard: 300-750 LOC
GitHub Actions debug/log/archive/summary/artifact retention policy: 300-800 LOC
Reusable workflow caller/callee secret contract and OIDC attestation: 250-650 LOC
encrypted writeback payload custody, retry TTL policy, and replay/rollback guard: 350-850 LOC
GitHub runner implicit credential env firewall and child-process launcher harness: 300-750 LOC
workflow provisioning state taxonomy, repair-state mapper, and exact recovery copy: 250-650 LOC
one-shot secret restore grant, preflight-to-bootstrap TOCTOU guard, and grant audit: 350-850 LOC
Linux procfs/process/FD hardening probe and compatibility blocker: 350-850 LOC
typed GitHub App token issuer, issuance ledger, and writeback authority pause: 350-850 LOC
GitHub SDK token-cache isolation and scope-cache tests: 100-300 LOC
account-session grouping and multi-repo refresh serialization: 500-1200 LOC
Codex CLI binary contract and upgrade harness: 300-800 LOC
sensitive route registry and telemetry sink harness: 400-900 LOC
rotating OIDC claim contract and original-event trust snapshot: 300-700 LOC
OIDC v2 claim capability, subject-template diagnostics, and protocol-v1 separation: 250-550 LOC
setup pairing anti-confusion and completion-state harness: 300-800 LOC
persistence state machine, CAS invariants, and additive migration harness: 350-900 LOC
workflow provenance, template digest, and runtime attestation harness: 400-900 LOC
public-key provenance, sealed-box envelope, and writeback proof harness: 300-750 LOC
proxy, data/control-plane separation, input/output limiters, and pre-model redaction: 1300-2550 LOC
SaaS lease/writeback/key registry: 800-1500 LOC
comment freshness/dedupe and posting backpressure: 250-600 LOC
workspace snapshot and checkout containment: 500-1100 LOC
tests: 4150-9300 LOC
total: 16600-37500 LOC
```

Production-grade estimate:

```text
installer, credential-source resolver, pairing, zero-plaintext setup, and migration UX: 1900-3500 LOC
current-code migration, provider catalog/setup adapters, data migrations, and legacy compatibility: 1100-2300 LOC
versioned account-auth CI consent, workspace-policy revalidation, quota-ownership UX, and support-safe audit: 650-1700 LOC
release manifest, artifact verification, attestation path, and bootstrap incident runbooks: 1200-2600 LOC
action protocol v2, compatibility handshake, static-fallback removal, and legacy action safety: 900-1800 LOC
mixed-fleet release channels, exact-pin/canary policy, rollback drills, and cohort dashboarding: 700-1600 LOC
workflow provisioning/setup PR, actor/ref policy, final checks, action lifecycle, cache/output policy, feature-scope, and compatibility: 2300-4200 LOC
GitHub secret wire contract, opaque token handling, secret-size contract, and public-key/writeback response drift tests: 700-1600 LOC
GitHub App permission profile migration, permission epoch ledger, owner handoff UX, and token-scope verifier: 900-2100 LOC
GitHub webhook inbox hardening, projection ordering, dead-letter/reconcile UX, and delivery diagnostics: 800-1900 LOC
GitHub Actions debug-mode scanner, log/archive retention canaries, summary/output wrappers, and artifact digest verifier: 700-1800 LOC
Reusable workflow explicit-secret mapping, permission downgrading, OIDC caller/callee attestation, and nested workflow guard: 700-1700 LOC
encrypted writeback custody ledger, short-TTL encrypted retry queue, replay/rollback guard, and support-safe projections: 800-1900 LOC
GitHub runner implicit credential env firewall, child-process launcher, and disposable env-leak E2E: 900-2200 LOC
workflow provisioning state taxonomy, repair PR planner, final-check mapping, and support-safe workflow diagnostics: 700-1600 LOC
one-shot secret restore grant service, lease-consumption guard, TOCTOU replay tests, and support-safe audit trail: 1100-2600 LOC
Linux process/procfs/FD isolation harness, runner-image compatibility matrix, and same-user probe fixtures: 1100-2500 LOC
typed installation-token issuer, caller allowlist, signer/KMS boundary, issuance ledger, and authority-pause runbooks: 1000-2500 LOC
GitHub SDK/App auth cache isolation, cache-poisoning harness, and generic-client quarantine: 350-900 LOC
account-session group registry, multi-repo isolation policy, account-level lease fallback, and dashboard states: 1000-2200 LOC
Codex CLI binary contract matrix, install integrity, JSONL parser versioning, and network fixture tests: 800-1800 LOC
sensitive-route privacy registry, logging/APM harness, and support-safe view enforcement: 900-2200 LOC
rotating OIDC claim contract, original-event trust snapshot, and claim-drift fixture matrix: 700-1600 LOC
rotating OIDC v2 validator, claim capability registry, subject-template diagnostics, JWKS/audience drift harness, and protocol-v1 separation: 700-1500 LOC
setup intent pairing, anti-confusion UX, idempotent completion states, and replay-safe support views: 800-1900 LOC
persistence ledger tables, state-machine repositories, transactional CAS, additive migrations, and safe projections: 900-2100 LOC
workflow provenance registry, template digest storage, runtime attestation, and repair PR UX: 1000-2300 LOC
public-key provenance, sealed-box envelope validators, one-shot helper capability, GitHub PUT proof, and writeback reconciler hardening: 900-2100 LOC
OAuth proxy with data/control-plane separation, Responses firewall, hardening, and shell policy: 2300-4600 LOC
review input collector, path policy, secret redaction, and process output backpressure: 900-1700 LOC
workspace snapshot builder, checkout containment, artifact/cache isolation, and malicious repo fixtures: 1200-2600 LOC
refresh state machine, fingerprinting, auth-shape registry, and encryption: 1100-2200 LOC
SaaS lease/writeback/key-management/audit/dashboard/runbooks/compatibility/incident/account lifecycle registry: 2700-5100 LOC
review output sanitizer, comment freshness/dedupe, retention, and support-safe exports: 1000-2000 LOC
unit/integration/e2e/security/supply-chain/key-rotation/merge-queue/account-lifecycle/account-authorization/account-session-isolation/codex-cli-contract/materialization/runner-credential-env-firewall/secret-restore-grant/process-procfs-isolation/saas-token-issuer-boundary/github-sdk-token-cache/actor-ref/action-lifecycle/local-credential-source/large-diff/redaction/workspace-containment/github-secret-wire-contract/public-key-provenance/encrypted-writeback-custody/comment-idempotency/sensitive-route-telemetry/OIDC-claim-contract/OIDC-v2-capability/setup-pairing/persistence-state-machine/workflow-provenance/workflow-repair-states/permission-epoch/webhook-inbox/actions-debug-channel/reusable-workflow-boundary tests: 12850-28100 LOC
docs/support copy/release/incident checklist: 600-1200 LOC
total: 48650-105900 LOC
```

The high count is because the production design includes:

- security boundary enforcement
- OIDC validation
- rotating OIDC claim contract and original-event trust snapshot
- OIDC v2 capability discovery, subject-template diagnostics, JWKS/audience
  failure handling, and protocol-v1 separation
- single-writer lease
- generation fingerprinting and stale queued run detection
- setup pairing and installer supply-chain checks
- setup intent anti-confusion, replay protection, and idempotent completion
  state machine
- rotating-auth persistence ledger, transactional CAS, migration rollback, and
  safe support projections
- installer zero-plaintext network contract
- workflow setup PR generation and idempotent upgrades
- workflow provenance, template digest, runtime attestation, and repair PR UX
- encrypted writeback
- public-key provenance, sealed-box envelope binding, and GitHub PUT proof
- encrypted writeback payload custody, replay guard, and retry TTL policy
- GitHub runner implicit credential env firewall and child-process launcher
  proof
- workflow provisioning state taxonomy, repair PR planner, and exact recovery
  copy
- one-shot secret restore grant and preflight-to-bootstrap TOCTOU proof
- Linux process/procfs/FD isolation proof for proxy and Codex sibling processes
- SaaS writeback authority split, typed installation-token issuer, and safe
  issuance ledger
- GitHub SDK/App auth cache isolation and generic installation-client quarantine
- GitHub App permission profile migration, owner approval handoff, permission
  epoch, and token-scope verification
- GitHub webhook inbox, ordering-safe projection, dead-letter handling, and
  source-of-truth reconciliation
- GitHub Actions debug/log archive, summary, annotation, output, artifact, and
  cache channel hardening
- reusable workflow explicit-secret mapping, caller permission contract, OIDC
  caller/callee binding, and nested workflow guard
- account-session group policy and multi-repo refresh serialization fallback
- account-auth CI consent, quota ownership, and workspace-policy revalidation
- Codex CLI binary contract, JSONL parser versioning, and network fixture
  evidence
- exact secret materialization and masking proof
- sensitive route registry plus logging/APM/support-export sink harness
- proxy isolation
- action lifecycle, cache, artifact, output, and shell-command policy
- package lifecycle script boundaries
- control-plane key management and DB invariants
- bounded review input, path policy, and process output backpressure
- migration states
- dashboard recovery UX
- review comment sanitizer and bounded artifact schema
- retention jobs and support-safe exports
- environment-secret policy, quota classification, maintenance health, and
  compatibility kill switches
- required-check, advisory/required/strict policy, and merge-queue semantics
- actor/ref trust policy and checkout hardening
- workspace snapshot builder and checkout/artifact/cache containment
- org policy preflight, permission handoff, and incident response
- Codex account/workspace lifecycle, account replacement confirmation, and
  Enterprise access-token provider separation
- product feature-scope boundaries for interaction, conflict review, reusable
  workflows, and memory
- malicious prompt tests
- real GitHub e2e workflows

It is not just a refresh script.

## Options Considered

### Option 1: OAuth Proxy + Encrypted Writeback

```text
🎯 8.6 / 10   🛡️ 9 / 10   🧠 9.8 / 10
Approx changes: 48650-105900 LOC production-grade.
```

Pros:

- best no-VPS user experience
- SaaS never sees plaintext auth
- workflow never receives a GitHub secret-write PAT
- Codex runtime does not see refresh token
- single-writer lease handles refresh token rotation
- clean dashboard reconnect states

Cons:

- most complex implementation
- requires GitHub App `Secrets: write`
- requires careful E2E validation against Codex CLI behavior
- proxy must track upstream endpoint behavior

Recommendation:

Use this as the target production architecture.

### Option 2: Self-Hosted Runner + Persistent CODEX_HOME

```text
🎯 8 / 10   🛡️ 9 / 10   🧠 5 / 10
Approx changes: 800-1500 LOC plus user runner setup.
```

Pros:

- closest to official OpenAI recommended automated account-auth path
- no GitHub secret writeback needed after bootstrap
- Codex refreshes `auth.json` in place
- fewer ReviewRouter components

Cons:

- bad default UX
- user must keep a machine or VPS online
- runner hardening becomes user responsibility
- not ideal for many small repos/users

Recommendation:

Keep as advanced fallback and documentation path.

### Option 3: GitHub-Hosted Restore/Run/Writeback Without Proxy

```text
🎯 7 / 10   🛡️ 6.5 / 10   🧠 7 / 10
Approx changes: 2500-4500 LOC.
```

Pros:

- simpler than proxy
- follows OpenAI ephemeral restore/run/persist shape
- could ship faster

Cons:

- Codex runtime sees `auth.json`
- prompt injection blast radius is larger
- filesystem/procfs/sudo hardening must be perfect
- writeback race still needs lease
- security story is weaker

Recommendation:

Do not use as default. Use only as a short-lived internal spike if proxy
compatibility is blocked.

## Implementation Dependency Map

Build order matters more than raw coding speed. The implementation should land
in slices that can be tested without ever exposing real Codex OAuth credentials
to an unfinished path.

### Slice 0: Spike Harness Only

Purpose:

- disposable private repositories
- pinned Codex CLI
- local mock provider
- no customer feature flag
- no production secret writeback

Exit:

- Spikes A, B, F, H, K, L, V, AK, AS, AA, AB, AD, AE, and AF pass with fake
  or disposable credentials
- Spikes AG, AH, and AI pass before any real OAuth credential is used with a
  broad customer-facing proxy build
- any failure updates the plan before product code is broadened

### Slice 1: Domain Model and State Machine

Add behind an internal flag:

- provider auth mode `codex_chatgpt_oauth_rotating`
- provider setup kind `codex_oauth_rotating`
- runtime mode `codex-oauth-proxy`
- workflow schema marker `reviewrouter-codex-oauth-proxy-v1`
- action runtime protocol v2 request/response types for rotating OAuth
- no-secret compatibility handshake state before secret restore
- provider mode enum for `github_hosted_proxy`
- auth shape registry
- generation hash types
- account/workspace fingerprint types
- lease and writeback intent domain models
- additive Prisma models for provider instance, auth generation, lease,
  writeback intent, setup session, compatibility version, and safe health event
- provider state transitions
- safe error-code taxonomy

No workflow should restore the new OAuth secret yet. Legacy
`codex_subscription_oauth` and `CODEX_AUTH_JSON` behavior must remain
unchanged in this slice.

### Slice 2: Workflow Provisioning Schema

Extend existing workflow provisioning:

- new workflow schema version
- new secret name `REVIEWROUTER_CODEX_AUTH_JSON`
- review/comment/final-policy job split
- provider-mode capability markers
- reusable workflow trust markers
- explicit unsupported markers for interaction/conflict paths
- repo-health detection for static vs auto-refresh modes

Exit:

- generated YAML tests prove the new secret appears only in the proxy bootstrap
  step
- interaction/conflict workflows do not receive the new rotating secret
- a repository using `codex_subscription_oauth` still generates the old static
  workflow and old setup copy
- a repository using `codex_chatgpt_oauth_rotating` refuses old workflow schema
  and old `CODEX_AUTH_JSON` restore semantics
- generated rotating workflow disables static runtime fallback and performs
  compatibility preflight before any step references
  `REVIEWROUTER_CODEX_AUTH_JSON`

### Slice 3: Installer and Local Setup

Add:

- verified installer bootstrap
- new rotating installer endpoint or explicit installer mode that is separate
  from `scripts/seed-codex-auth.sh`
- dedicated `CODEX_HOME`
- local auth-shape validation
- local smoke
- direct GitHub secret write
- setup PR creation/update
- safe setup completion payload
- `seeded_unconfirmed` recovery
- account replacement confirmation

Exit:

- local setup can run twice idempotently
- SaaS receives no plaintext in negative tests
- setup refuses active-lease overwrite

### Slice 4: Proxy and Action Runtime

Add:

- proxy binary/package
- stdin auth ingestion
- custom provider config
- nonce path enforcement
- public-key fetch
- refresh preflight
- encrypted writeback request
- safe health events
- worktree unchanged check

Exit:

- malicious prompt suite cannot read auth or mutate repo
- no model request replay after upstream acceptance
- writeback readiness blocks refresh before unsafe rotation

### Slice 5: SaaS Lease and GitHub Writeback

Add:

- OIDC-bound lease acquire endpoint
- scoped helper token issue path
- public-key provenance validator and sealed-box envelope binding
- writeback endpoint accepting ciphertext only
- durable writeback intent before GitHub PUT
- GitHub App secret update adapter
- reconciler
- compatibility registry enforcement
- incident and support-safe admin states

Exit:

- stale queued secret and SaaS split-brain E2E pass
- GitHub App permission upgrade and selected-repo edge cases pass
- public-key substitution, stale key, wrong key id, and metadata-only
  confirmation attempts fail before generation confirmation

### Slice 6: Review Output Boundary

Add:

- structured sanitizer
- bounded sanitized artifact
- downstream comment job validation
- result freshness and comment dedupe validator
- final policy check mapper
- retention jobs
- telemetry sentinel tests

Exit:

- raw model output never reaches GitHub comments, SaaS logs, artifacts, or
  support exports
- stale review artifacts do not post inline comments after PR head changes
- repeated re-runs update or skip existing ReviewRouter comments without
  duplicates
- advisory/required/strict behavior is tested in private repos

### Slice 7: Private Beta

Enable only after:

- all production readiness gates pass
- disposable private repo E2E suite passes
- dashboard can explain every paused state
- support can resolve states without plaintext credentials

Stop conditions:

- unexpected upstream 401/403 wave
- Codex CLI custom provider contract changes
- GitHub public-key/writeback response shape changes
- any plaintext-auth sentinel appears outside the allowed local/proxy boundary
- interaction/conflict/memory paths consume the rotating secret accidentally

## Required Spikes Before Full Build

### Spike A: Custom Provider Minimal Proof

Goal:

Prove Codex can run a review through a local unauthenticated custom provider
with static model catalog and no `auth.json` in runtime `CODEX_HOME`.

Acceptance:

- `codex exec` calls only `POST /v1/responses` on the configured model
  provider
- no `/models` request when `model_catalog_json` is configured
- no `Authorization` header is sent to the local custom provider
- tool-call loop works through the custom provider
- remote plugin/app/tool-suggest warmup is disabled or routed to a local deny
  sink
- hosted `web_search` is absent unless explicitly enabled by ReviewRouter
- no remote compaction call for custom provider in normal review
- provider name does not trigger OpenAI/Azure special behavior

Status from 2026-05-24 local spike:

- passed for simple response
- passed for real `exec_command` tool-call loop
- passed for no provider auth header
- passed for static model catalog avoiding `/models`
- passed for disabling plugin warmup with `--disable plugins --disable apps
--disable tool_suggest`
- passed for removing hosted `web_search` with `web_search="disabled"`
- still open for full PR review workload and remote compaction behavior

### Spike B: OAuth Proxy Upstream Proof

Goal:

Prove a local proxy can inject ChatGPT Codex access token headers and receive
valid upstream responses.

Acceptance:

- upstream endpoint works for the selected model
- account id header behavior is correct
- FedRAMP header handling is understood
- 401 classification is observable without logging tokens

### Spike C: Refresh and Writeback Proof

Goal:

Prove refresh updates auth, encrypted writeback updates repo secret, and the
next GitHub-hosted run uses the refreshed secret.

Acceptance:

- disposable private repo
- forced stale `last_refresh`
- run refreshes
- writeback confirmed
- next run succeeds without local reseed
- no plaintext secret appears in logs/artifacts/SaaS

### Spike D: Cancellation Proof

Goal:

Understand exact behavior when job is cancelled around refresh/writeback.

Acceptance:

- cancellation before proxy start leaves state active
- cancellation after `refresh_started` without writeback marks unknown
- dashboard shows reconnect guidance

### Spike E: Multi-Repo Session Isolation Proof

Goal:

Prove that dedicated per-repo Codex logins under the same ChatGPT account create
independent refresh streams and do not invalidate each other under normal use.
Until this is proven for the pinned Codex CLI/auth schema/account type tuple,
the production default is account-level serialization or one-active-repo
blocking for the same safe account hash.

Acceptance:

- create at least two disposable private repositories, preferably three for
  concurrent refresh pressure
- run installer separately for each repository with different dedicated
  `CODEX_HOME` directories under the same ChatGPT account
- verify each setup records the same safe account fingerprint without exposing
  raw account identifiers
- force stale refresh in repo A and verify repo B and repo C still review
  successfully without reseed
- force stale refresh in repo B and verify repo A and repo C still review
  successfully
- run overlapping refresh-needed workflows for two repositories and verify
  either independent success or deterministic account-level serialization
- verify account replacement in one repository does not silently change the
  account-session group for another repository
- verify changing Codex CLI version, auth shape, account type, or workspace
  policy resets isolation status to `unknown` until revalidated
- if sessions interfere, mark the account-session group `interfering`, block or
  serialize refresh for that account hash, and avoid reconnect loops
- no raw account ids, emails, workspace names, or token claims appear in logs,
  SaaS DB rows, support exports, artifacts, or telemetry

Follow-up if failed:

- implement account-level serialization fallback
- add account hash to lease conflict diagnostics
- re-score UX before enabling more than one repo per ChatGPT account
- add dashboard copy explaining that multiple repositories are using the same
  Codex account and refresh is serialized for safety

### Spike F: Public-Key Capability Proof

Goal:

Prove the runner can obtain GitHub's repository Actions public key without
receiving any token that can write secrets.

Acceptance:

- helper credential cannot create/update/delete secrets
- helper credential can fetch only the public key and safe secret metadata
- helper credential is removed before Codex starts
- public key substitution by SaaS is not possible in the accepted path
- stale `key_id` retry works once and stays under the same active lease

### Spike G: Event and Workflow Trust Proof

Goal:

Prove the generated workflow cannot restore Codex OAuth secrets for untrusted
events or PR-controlled workflow changes.

Acceptance:

- fork PR receives no secret-backed Codex run
- Dependabot PR receives no secret-backed Codex run
- public repo is blocked
- `pull_request_target` is absent
- `workflow_run` is absent or separately blocked by policy
- OIDC validation rejects wrong `workflow_ref`, wrong `job_workflow_ref`, wrong
  `run_attempt`, and non-`github-hosted` runner environment

### Spike H: Queued Secret Staleness Proof

Goal:

Prove the system does not refresh from an old auth JSON that GitHub loaded when
the workflow was queued before a newer writeback.

Acceptance:

- queue run A and run B with the same secret generation
- let run A refresh and write generation B
- let run B start after run A completes
- run B computes restored generation A
- SaaS rejects run B at lease acquire as `stale_queued_secret`
- rerunning run B after writeback loads generation B and succeeds

### Spike I: Shell-to-Proxy Abuse Proof

Goal:

Prove what a malicious prompt can do if shell tools can read the nonce-prefixed
proxy URL from Codex runtime config.

Acceptance:

- prompt attempts to `cat` runtime config and `curl` the proxy
- nonce-less requests fail
- non-allowlisted nonce-prefixed paths fail
- allowlisted `/responses` requests cannot reveal auth material
- per-run budget stops repeated direct proxy calls
- if shell network isolation is available and stable, direct shell calls to the
  proxy are blocked without breaking normal Codex custom-provider traffic

### Spike AG: Proxy Capability Separation and Responses Firewall Proof

Goal:

Prove the Codex-visible localhost listener is only a bounded Responses
data-plane, and cannot reach refresh, writeback, lease, public-key, health,
metrics, shutdown, status, debug, or admin capability.

Acceptance:

- proxy process starts with OAuth auth, writeback token, helper token, lease id,
  HMAC material, and budget config available only through memory or private
  file descriptors, not through the model-provider listener
- data-plane listener exposes only nonce-prefixed `POST /v1/responses` and any
  separately proven `/v1/responses/compact` path
- probes for `/refresh`, `/writeback`, `/public-key`, `/lease`, `/health`,
  `/metrics`, `/shutdown`, `/status`, `/debug`, `/admin`, `/config`, `/models`,
  `/files`, query-string variants, method overrides, and path traversal variants
  are rejected before sensitive work
- unsupported Responses body fields for hosted tools, remote file APIs, MCP,
  image/audio/realtime, attachments, vector stores, unexpected `include`, model
  override, and provider-specific escape hatches are rejected with safe errors
- valid direct data-plane calls can spend only the configured per-run budget and
  are classified as `direct_data_plane_call`, not as auth exposure
- data-plane requests cannot trigger proactive refresh unless startup or normal
  first-request readiness checks already selected refresh internally
- safe health/metrics are emitted out-of-band and never through the
  Codex-visible listener
- CORS, redirects, request smuggling, duplicate content-length,
  transfer-encoding ambiguity, encoded slash/dot segments, and oversized JSON
  are covered by tests
- proxy URL/nonce exposure in runtime config is treated as expected and does
  not break the security boundary

### Spike AZ: Linux Process, Procfs, and FD Isolation Proof

Goal:

Prove that a model-controlled process on the same GitHub-hosted Linux runner
cannot read proxy-held auth or control material through process metadata,
procfs, inherited file descriptors, temp files, server-info files, core dumps,
or sibling-process inspection.

Acceptance:

- proxy starts with OAuth auth, helper token, writeback token, restore grant,
  HMAC material, and lease metadata absent from argv and environment
- proxy marks sensitive FDs close-on-exec, closes non-required inherited FDs
  before Codex launch, disables core dumps, uses restrictive umask, and marks
  the process non-dumpable on Linux where supported
- malicious same-user probe attempts `ps auxww`, `/proc/*/environ`,
  `/proc/*/cmdline`, `/proc/*/fd`, `/proc/net/tcp*`, `lsof`, temp-dir scans,
  core-dump generation, and ptrace/gcore attempts
- probe output cannot reveal auth JSON, token substrings, restore grant,
  writeback/helper/HMAC material, OIDC request env, control-root paths, proxy
  admin paths, server-info files, or raw upstream headers
- server-info visible to Codex contains only nonce-prefixed data-plane URL and
  safe version metadata, not PID, control paths, lease id, helper token, or
  writeback status
- private control root mode is `0700`, sensitive file mode is `0600`, and no
  symlink/hardlink from checkout or sanitized review root can reach it
- GitHub runner image update that changes procfs, ptrace, user namespace,
  shell sandbox, or Codex sandbox behavior blocks the compatibility tuple
  before secret restore
- if any probe finds sensitive material, state maps to
  `process_isolation_unsupported` before refresh, or
  `security_invariant_failed` if auth was already restored in an internal
  canary

### Spike AH: Action Runtime Protocol v2 and Static-Fallback Rejection Proof

Goal:

Prove rotating OAuth cannot run through protocol v1, static runtime fallback,
old action refs, old workflow schemas, or configs that do not explicitly opt
into `codex_chatgpt_oauth_rotating`.

Acceptance:

- protocol v1 runtime config never returns rotating OAuth lease, proxy,
  writeback, generation, or secret-name fields
- protocol v2 request requires workflow schema, action version, proxy version,
  provider auth mode, repository id, run id, run attempt, workflow ref/SHA,
  event, and ReviewRouter OIDC audience
- compatibility policy rejects rotating OAuth for old action refs, unknown
  action versions, static config mode, static fallback, wrong workflow schema,
  wrong provider auth mode, wrong secret name, and unsupported feature scope
- compatibility policy distinguishes configured action ref, resolved action
  SHA, release channel, and exact version when deciding whether secrets may be
  restored
- generated rotating workflow performs no-secret compatibility preflight before
  any step references `REVIEWROUTER_CODEX_AUTH_JSON`
- when compatibility preflight fails or SaaS is unavailable, workflow exits as
  `skipped_retryable` or `policy_blocked` before secret restore
- lease acquire revalidates the same tuple after preflight so config changes
  between preflight and proxy bootstrap cannot slip through
- manually edited workflow that passes `REVIEWROUTER_CODEX_AUTH_JSON` to a v1
  action fails at workflow scanner and action startup
- old static `codex_subscription_oauth` workflows continue using protocol v1
  and `CODEX_AUTH_JSON` without being labelled auto-refresh
- repo health reports `rotating_protocol_unsupported`,
  `workflow_schema_mismatch`, `static_fallback_forbidden`, and
  `action_version_unsupported` as distinct safe states
- support diagnostics show protocol/schema/action mismatch without exposing
  secrets, raw YAML, or runtime config bodies

### Spike AI: Mixed-Fleet Release and Rollback Proof

Goal:

Prove legacy static, rotating canary exact-pin, rotating GA exact-pin, rotating
moving-`v1`, blocked, and suspended repositories can coexist without hidden
migration or unsafe secret restore.

Acceptance:

- new rotating setup PRs use exact refs or full SHAs until release-stage policy
  explicitly permits moving `v1`
- compatibility preflight sends configured action ref, resolved action SHA,
  release channel, workflow schema, protocol version, provider auth mode, run
  id, and run attempt before secret restore
- registry can allow one exact version, block another exact version, and keep
  legacy static `@v1` working in the same workspace
- moving `v1` rollback does not affect exact-pinned rotating repositories
- exact-version emergency block prevents secret restore even when the workflow
  still references that exact version
- SaaS rollback with newer customer workflow returns
  `control_plane_version_unsupported` before secret restore
- newer SaaS with older rotating workflow returns `rotating_protocol_unsupported`
  or `workflow_schema_mismatch` before secret restore
- installer rerun does not convert exact-pinned rotating repos to moving `v1`
  unless the user or workspace policy explicitly chooses that channel
- rollback PR disables rotating provider mode and workflow schema without
  deleting `REVIEWROUTER_CODEX_AUTH_JSON` or legacy `CODEX_AUTH_JSON`
- dashboard and repo health show release cohort and safe blocker reason:
  canary, GA exact, GA moving, blocked version, unsupported control plane, or
  legacy static

### Spike AJ: Workspace Snapshot and Checkout Containment Proof

Goal:

Prove secret-bearing control state, raw checkout state, Codex-visible review
input, and uploadable artifacts are physically separated and enforceable on a
real GitHub-hosted Linux runner.

Acceptance:

- generated workflow creates separate trusted control, raw checkout, sanitized
  review, artifact staging, and Codex home roots under `$RUNNER_TEMP`
- control/proxy/auth roots are never descendants of raw checkout,
  `$GITHUB_WORKSPACE`, artifact staging, cache paths, or upload globs
- Codex runs with `cwd` set to the sanitized review root and receives no path
  to raw checkout, control root, proxy temp root, or `auth.json`
- sanitized review root contains no `.git`, git hooks, local git config,
  tokenized remotes, credential helpers, proxy server-info files, auth files,
  session tokens, helper tokens, OIDC tokens, HMAC material, or writeback state
- snapshot builder rejects or safely represents absolute paths, traversal,
  NUL bytes, Windows drive prefixes, control characters, symlink escapes,
  nested git repositories, hardlink surprises, submodules, and LFS pointers
- `.github/workflows/**`, `.gitmodules`, package-manager configs, and tool
  configs are reviewable as data but cannot drive checkout, dependency install,
  workflow selection, cache keys, or execution after secret restore
- checkout scanner rejects tokenized remotes, credential helpers, unexpected
  submodule state, LFS smudge/download state, and repo-controlled git config
  before secret restore proceeds
- workflow scanner rejects artifact/cache paths that include raw checkout,
  control root, proxy temp dirs, Codex home, `$RUNNER_TEMP`, `$GITHUB_WORKSPACE`,
  parent directories, or broad recursive globs
- malicious repo fixtures with symlinks, `.gitmodules`, LFS pointers,
  `.npmrc`, package hooks, fake workflow commands, nested git directories, and
  oversized/generated files do not leak secrets, mutate checkout, or reach
  uploadable artifacts
- post-run mutation checks prove both raw checkout and sanitized review root are
  unchanged except for explicit safe ReviewRouter scratch/output paths
- failure mode is `policy_blocked` or `security_invariant_failed` before model
  request when containment cannot be proven

### Spike AK: GitHub Secret Wire Contract and Permission Upgrade Proof

Goal:

Prove the rotating OAuth path works with the real GitHub App permission model,
repository public-key API, LibSodium encryption, secret-size limits, and new
opaque installation token formats without exposing plaintext to ReviewRouter
SaaS.

Acceptance:

- current standard App profile with only `Secrets: read` is detected as
  insufficient and maps to `permission_required` before secret restore
- upgraded App registration requests `Secrets: write`, existing installations
  require owner/admin acceptance, and rejected/pending upgrades keep legacy
  static repositories working
- selected-repository installations are revalidated after permission acceptance
  and before every lease/writeback
- helper installation token is minted with explicit `repository_ids` and
  minimal `permissions`, and the response permissions are verified
- helper/writeback tokens are treated as opaque variable-length bearer tokens;
  tests include old and new GitHub token shapes and reject any fixed-length or
  prefix-based validator
- repository public-key response validates owner, repo, `key_id`, key material
  shape, API version, and safe status-code mapping
- runner rejects public keys supplied by ReviewRouter SaaS or by setup payloads;
  only GitHub API or locally trusted `gh` output can be used as key source
- public-key hash, `key_id`, owner/repo, repository id, installation id,
  secret name, and API version are bound into the encryption envelope metadata
- runner encrypts canonical auth JSON locally, sends only `encrypted_value`,
  `key_id`, safe hashes, and lease metadata to SaaS, and proves plaintext is
  absent from SaaS request logs, APM, traces, support exports, and DB rows
- raw canonical auth JSON size, encrypted base64 size, and writeback request
  body size are measured with fixtures below limit, near limit, and above limit
- `auth_secret_too_large` before refresh is safe/retryable only after user
  action; too-large refreshed auth after refresh maps to `unknown_auth_state`
- stale public key causes exactly one re-encrypt retry under the same lease
- GitHub 403, 404, validation error, primary rate limit, secondary rate limit,
  and abuse throttling map to distinct safe states according to whether refresh
  has started
- GitHub REST API response-shape drift blocks writeback-capable versions in the
  compatibility registry before refresh starts

### Spike BA: SaaS Writeback Authority and Token Issuer Boundary Proof

Goal:

Prove ReviewRouter's GitHub App private-key authority and installation-token
minting cannot be reached from generic SaaS routes, support tools, webhook
workers, dashboard sync, or compromised non-writeback services.

Acceptance:

- all installation-token minting goes through typed issuer methods with purpose
  `public_key_read` or `secret_writeback`; no generic app-wide token helper is
  available to business routes
- rotating OAuth paths never use generic `App#getInstallationOctokit(...)`,
  shared Octokit auth caches, dashboard setup clients, repo-health clients,
  worker setup clients, or comment-token issuers
- token issuer always sends explicit `repository_ids` and explicit
  `permissions`; omitted fields fail unit tests and runtime validation
- `public_key_read` cannot request `Secrets: write`, and `secret_writeback`
  cannot mint unless active lease, consumed restore grant where applicable,
  durable writeback intent, permission epoch, and ciphertext/generation binding
  all match
- support/admin/dashboard/webhook/repo-health callers cannot mint writeback
  tokens even with elevated internal roles
- returned token permissions and repository scope are validated before the
  token reaches a GitHub adapter; overbroad, narrower, missing, or malformed
  responses map to `writeback_authority_paused`
- SDK cache poisoning tests inject broad, cross-repo, cross-purpose, expired,
  wrong-epoch, and wrong-base-URL cached tokens; every case is rejected before
  the token reaches a requester
- token plaintext is never persisted, logged, exported, returned to workflow,
  or included in incident bundles; safe audit uses HMAC fingerprint prefix,
  permission hash, repository-scope hash, issuer key id, caller id, purpose,
  TTL, status, and safe reason
- signer/KMS outage, App private-key compromise simulation, issuer key
  rotation, and emergency pause block helper-token minting and writeback without
  deleting customer secrets
- disposable GitHub App E2E proves a token minted for public-key read cannot
  update a secret, and a writeback token cannot access repositories outside the
  selected repository id

### Spike AS: Public-Key Provenance and Writeback Confirmation Proof

Goal:

Prove ReviewRouter cannot substitute an encryption key, cannot confirm a
rotating generation from GitHub secret metadata alone, and cannot accidentally
reuse the legacy dashboard `ProviderSetupState` confirmation path for
auto-refreshing Codex OAuth.

Acceptance:

- local setup path fetches the repository public key through `gh api` or an
  equivalent GitHub API call and validates owner/repo, repository id, key shape,
  `key_id`, API host, and API version before encryption
- GitHub-hosted refresh path fetches the public key from GitHub using a
  one-shot helper capability scoped to the exact repository id, installation
  id, owner/repo, and secret name
- helper capability cannot create, update, delete, or list unrelated secrets
  and is unavailable to Codex runtime, comment jobs, artifacts, cache, logs, and
  job summaries
- public key supplied by SaaS, wrong repository key, wrong `key_id`, changed
  owner/repo, changed repository id, unsupported GitHub API host, or malformed
  key blocks before encryption
- ciphertext hash, public-key hash, `key_id`, generation hash, lease id,
  idempotency key, repository id, installation id, and secret name are all
  required for writeback
- duplicate writeback with same idempotency key succeeds only when every bound
  hash and metadata field matches; any mismatch is rejected as conflict
- GitHub PUT `201` and `204` are the only success statuses that can advance
  writeback proof
- crash before PUT, crash after PUT before DB commit, lost SaaS response,
  GitHub timeout after request body send, unexpected status, and retry with
  changed ciphertext each map to documented states
- `ProviderSetupState` manual confirmation, GitHub secret existence,
  `updated_at`, organization secret metadata, and dashboard "verified" mode
  cannot mark rotating OAuth active or confirm latest generation
- support views expose only safe key id, hash prefixes, state, timestamps,
  GitHub status code class, and reason code

### Spike AX: Encrypted Writeback Payload Custody and Replay Proof

Goal:

Prove that ciphertext-only writeback does not accidentally become a stored
credential-update replay mechanism in ReviewRouter SaaS.

Acceptance:

- successful writeback discards raw `encrypted_value` after GitHub PUT success
  and durable DB confirmation
- raw `encrypted_value` can exist only in an encrypted retry queue with
  explicit TTL, KMS key id, ciphertext hash, lease/run identity, generation
  hash, public-key hash, permission epoch, and workflow schema version
- the retry queue can replay only the exact same idempotency key and bound
  metadata within the active lease/retry window
- same idempotency key with different ciphertext or different bound metadata
  maps to `security_invariant_failed`
- older ciphertext cannot be written after a newer generation is confirmed,
  even if the GitHub `key_id` still appears valid
- pending encrypted retry payloads are purged on provider deletion, permission
  loss, selected-repository removal, repository transfer, public visibility
  change, external secret drift, local setup reseed, workflow schema drift,
  lease expiry, retention expiry, and incident response
- KMS outage, missing `kms_key_id`, or decrypt failure blocks retry without
  logging or exporting ciphertext bodies
- support/admin safe views, audit exports, telemetry snapshots, DB debug tools,
  and incident bundles cannot query raw ciphertext bodies
- ciphertext leak drill purges retry queues and blocks stale idempotency keys
  without forcing reconnect unless plaintext auth was exposed or the current
  auth state is unknown
- disposable GitHub E2E proves stale encrypted writeback is rejected before
  GitHub PUT by attempting replay after a newer confirmed generation

### Spike AT: GitHub App Permission Epoch and Installation Approval Proof

Goal:

Prove ReviewRouter can upgrade from the existing read-only secrets profile to
rotating writeback without confusing manifest configuration, owner approval,
selected-repository membership, and actual installation-token scope.

Acceptance:

- standard read-only App profile remains valid for legacy static provider paths
  and is never mislabeled as auto-refreshing
- manifest generator and readiness checks support explicit `standard` and
  `rotating-writeback` profiles, plus optional org/ruleset diagnostics without
  broadening the rotating writeback default
- existing installation without approved `Secrets: write` maps to
  `permission_required` with owner/admin handoff, not reconnect
- approved permission with target repository missing from selected-repository
  installation maps to `app_repository_not_selected` or `permission_required`
  before secret restore
- accepted permission without lease-preflight verification remains
  `app_permission_accepted_unverified` and cannot acquire a lease
- installation-token requests that omit `repository_ids` or `permissions`, or
  request broader permissions than the profile requires, are rejected by the
  adapter and tests
- token response permissions, repository scope, App id, installation id, and
  account id are validated and folded into the active permission epoch
- permission removal, selected-repository removal, App uninstall, App suspend,
  repository transfer, owner transfer, and org policy block increment the
  permission epoch and block new leases
- an active lease that loses permission before refresh maps to
  `permission_required`; losing permission after refresh starts maps to
  `unknown_auth_state` or `reconcile_required` according to the recorded phase
- if a separate high-trust writeback App is implemented later, provider setup
  binds to its App id and installation id and cannot mix the standard App with
  the writeback App

### Spike AV: GitHub Actions Debug, Summary, and Artifact Channel Proof

Goal:

Prove GitHub Actions' non-obvious output channels cannot persist or expose
rotating Codex auth when customers enable debug logging, rerun with diagnostics,
download log archives, or inspect artifacts and summaries long after the run.

Acceptance:

- generated rotating workflow scanner rejects `ACTIONS_STEP_DEBUG`,
  `ACTIONS_RUNNER_DEBUG`, `runner.debug`, `set -x`, `bash -x`, verbose package
  manager flags, raw `::warning::`/`::error::` writes, unsafe summary writes,
  broad artifact globs, `download-artifact` without an exact name, and job
  outputs carrying review payloads after secret restore
- first production behavior blocks or skips secret-backed review before auth
  restore when debug logging is detected; dashboard copy says debug logging is
  blocked for secret-backed Codex OAuth, not that Codex needs reconnect
- disposable canary runs enable step debug, runner diagnostic logs, and debug
  rerun where GitHub allows it, then download step logs, runner diagnostic log
  archives, job summaries, annotations, artifacts, and comment-job downloads
  to prove sentinel auth/token/proxy/HMAC values are absent
- `::add-mask::` registration is tested as defense-in-depth only. Tests also
  prove values printed before mask registration would fail the harness, and
  therefore the workflow never depends on post-hoc masking for correctness
- untrusted model/tool output is wrapped with high-entropy `stop-commands`
  tokens and cannot create annotations, masks, outputs, saved state, env vars,
  summary Markdown, hidden links/images, or workflow commands
- sanitized artifact upload uses fixed name, explicit minimal `retention-days`,
  ReviewRouter schema version, producer job id, run id, run attempt, repository
  id, PR number, head SHA, and artifact hash
- comment job downloads only the expected named artifact, rejects default-name
  `artifact`, duplicate artifacts, digest/hash mismatch, symlinks, hidden files,
  path traversal, binary blobs, and unexpected file counts before posting
- long GitHub artifact/log retention is treated as expected customer behavior;
  incident recovery never relies on retroactively changing retention to make a
  plaintext leak safe

### Spike AW: Reusable Workflow Secret Contract and Caller/Callee Proof

Goal:

Prove the convenient reusable workflow integration preserves the same
secret-boundary as explicit generated workflows and cannot widen access through
`secrets: inherit`, caller defaults, environment secret shadowing, nested
workflow hops, or moving called-workflow refs.

Acceptance:

- generated rotating reusable caller maps only explicitly required secrets and
  never emits `secrets: inherit`
- called reusable workflow declares every required `workflow_call` secret and
  rejects undeclared or legacy static secret names for rotating provider mode
- caller job declares explicit minimal `permissions`; missing `id-token: write`
  or other required permissions fails setup/runtime preflight before auth
  restore because the called workflow cannot elevate caller token permissions
- called secret-backed job does not define `environment:` and cannot receive an
  environment secret that shadows `REVIEWROUTER_CODEX_AUTH_JSON`
- OIDC v2 records and validates caller `workflow_ref`/`workflow_sha` plus
  called `job_workflow_ref`/`job_workflow_sha` where available; trusted caller
  path plus untrusted called workflow ref is rejected
- strict/enterprise reusable mode requires immutable called workflow SHA.
  Moving tags are allowed only after compatibility registry resolves and
  records the exact called workflow SHA; branch refs are blocked for production
  secret restore
- reusable workflow outputs carry only safe status ids and artifact hashes;
  raw review payloads, model output, prompt, diff, proxy URL, nonce, HMAC,
  helper tokens, OIDC tokens, and auth-adjacent material are rejected
- nested reusable workflows are blocked for rotating v1 unless every hop is
  ReviewRouter-owned, exact-pinned or compatibility-approved, has explicit
  secret mapping, and has OIDC caller/callee evidence
- disposable E2E covers explicit workflow, reusable exact SHA, reusable release
  tag, reusable branch ref blocked, `secrets: inherit` blocked, missing caller
  permissions blocked, environment secret shadow blocked, and nested reusable
  chain blocked

### Spike AU: Webhook Inbox, Ordering, and Reconciliation Proof

Goal:

Prove GitHub App webhooks can improve responsiveness without becoming the
authority that accidentally re-enables secret restore from stale, replayed,
delayed, or out-of-order events.

Acceptance:

- webhook route verifies `X-Hub-Signature-256` over the exact raw body and
  rejects missing signature, modified body, wrong secret, legacy SHA-1-only
  signature, and JSON parser body mutation before projection
- route records a safe inbox row and returns a 2xx response quickly; slow GitHub
  API sync and provider projection run in a worker or bounded background job
- inbox idempotency uses delivery id plus payload hash; same delivery/hash is a
  no-op, same delivery with different hash is suspicious and cannot mutate state
- raw payload bodies are not stored by default; support can see only delivery
  id, event/action, installation id, repository id, safe normalized event
  fields, hashes, status, retry count, and reconciliation timestamps
- out-of-order install/repo-added/permission-accepted/unsuspended events cannot
  move a provider from `suspended`, `permission_required`,
  `external_secret_drift`, or `unknown_auth_state` back to `active` without a
  fresh GitHub API source-of-truth check
- App uninstall, selected-repo removal, permission removal, public visibility,
  repository transfer, and App suspension can block immediately from a signed
  webhook, but lease preflight still revalidates if a webhook was delayed or
  missed
- worker retry exhaustion dead-letters safely, surfaces `sync_stale`, and never
  asks the user to reconnect Codex unless an auth failure is independently
  proven
- GitHub App webhook delivery API diagnostics can inspect recent delivery
  metadata with an App JWT, but diagnostic export still excludes raw payload
  bodies and token-like headers

### Spike AL: Codex CLI Binary Contract and Upgrade Proof

Goal:

Prove each supported Codex CLI version can run the ReviewRouter rotating OAuth
review path with the required hardening flags, local custom provider behavior,
JSONL parser schema, package integrity, and no unexpected remote egress.

Acceptance:

- fixture records `codex --version`, `codex exec --help`, npm package version,
  package integrity or lock hash, platform package/dist-tag, Node version, and
  ReviewRouter action/proxy version
- generated workflow refuses `@openai/codex@latest`, alpha/beta/native
  dist-tags, and version mismatches between workflow, compatibility registry,
  runtime preflight, and actual CLI output
- required flags are present and honored: `--ephemeral`,
  `--ignore-user-config`, `--ignore-rules`, `--json`, `--sandbox read-only`,
  `--disable`, and approval policy `never`
- required config keys are accepted and produce the expected behavior:
  `model_provider`, static `model_catalog_json`, custom provider `base_url`,
  `wire_api = "responses"`, `requires_openai_auth = false`,
  `chatgpt_base_url` sink, web-search disabled, history disabled, and feedback
  disabled where supported
- local custom provider receives no Authorization header and preserves the
  nonce path prefix on every request
- hardened invocation produces only allowlisted local proxy/sink requests and
  no unapproved `chatgpt.com`, OpenAI, plugin, model-list, telemetry, feedback,
  update-check, file, MCP, image, realtime, or web-search egress
- JSONL event parser accepts known events for the pinned CLI and rejects
  unknown or shape-drifted events before comment posting or writeback
- static model catalog fixture suppresses `/models` and does not trigger
  provider-specific OpenAI/Azure behavior
- full PR review fixture, large review fixture, tool-call loop fixture, and
  cancellation fixture pass through the proxy without raw prompt/body logging
- upgrade from `0.125.0` to `0.133.0` or later remains blocked until this spike
  passes and the compatibility registry marks the tuple allowlisted

### Spike AM: Sensitive Route Privacy and Telemetry Sink Proof

Goal:

Prove rotating OAuth routes cannot leak auth-adjacent material through
framework logging, validation errors, gateway-style access logs, APM/tracing,
metrics, error reporting, support diagnostics, DB rows, artifacts, or job
summaries.

Acceptance:

- central sensitive-route registry covers setup completion, OIDC exchange,
  runtime preflight, lease acquire, public-key helper, writeback, provider
  health, compatibility check, support export, and sanitized artifact ingest
  before any implementation route is enabled
- every registered route has an explicit privacy class, body limit, allowed log
  fields, trace/span attributes, metric labels, error response policy, and
  support export visibility
- test harness injects unique sentinel strings into plaintext-looking aliases,
  `encrypted_value`, OIDC JWTs, setup/writeback tokens, helper tokens, HMAC
  material, nonce/proxy URLs, raw prompt, raw diff, raw model output, headers,
  query strings, validation-error values, and exception messages
- sentinels are absent from framework logs, route logs, access logs, validation
  responses, unhandled error responses, trace spans, metric labels, error
  events, support exports, persistent DB rows, workflow summaries, artifacts,
  and test crash dumps
- `encrypted_value` is absent everywhere except an explicitly enabled
  encrypted short-TTL retry queue; support UI can access only hash prefix, byte
  bucket, `key_id`, generation id, and state
- raw OIDC JWTs, Authorization headers, cookies, setup tokens, writeback
  tokens, and helper tokens are never logged, even on 400, 401, 403, 413, 429,
  500, timeout, and body-parser failures
- validation errors return stable safe codes and never echo offending body
  fields, header values, query values, Zod issue values, or raw stack traces
- metric label validator rejects high-cardinality and sensitive-like fields
  before metrics are emitted
- staging deployment config proves body capture is disabled for auth-sensitive
  routes at CDN/load balancer/reverse proxy/API gateway/framework/APM/tracing
  and error-reporting layers
- a simulated telemetry vendor/middleware change without a registry update
  fails compatibility checks before secret-backed routes can run

### Spike AN: GitHub OIDC Claim Contract and Event Trust Proof

Goal:

Prove the secret-bearing rotating OAuth path validates a stricter GitHub OIDC
contract than legacy action protocol v1, stores only normalized safe trust
metadata, and cannot be confused by re-runs, reusable workflows,
`workflow_dispatch`, public repositories, self-hosted runners, or claim drift.

Acceptance:

- rotating OAuth uses a ReviewRouter custom audience and rejects default,
  missing, array-mismatched, or unrelated audiences
- `OidcTrustSnapshotV1` records only normalized safe metadata and hash prefixes;
  raw JWTs and raw claims objects are discarded and never enter logs, DB rows,
  traces, metrics, support exports, artifacts, or summaries
- claim contract requires `repository_id`, repository owner identity,
  repository visibility, workflow identity, run identity, event name, runner
  environment, and replay identifier before secret restore
- missing optional claims are represented as explicit capability bits and safe
  downgrade decisions; no missing claim silently widens trust
- public repositories, self-hosted runner environment, unexpected environment
  claim, unresolved manual ref, fork PR, Dependabot PR, actor-blocked same-repo
  PR, `pull_request_target`, and `workflow_run` all fail before secret restore
- reusable workflow runs require trusted `job_workflow_ref` and, in strict
  channel, pinned `job_workflow_sha`; tag-based refs pass only for approved
  release channels
- `workflow_dispatch` resolves PR/head SHA through GitHub API and binds
  repository id, base/head SHA, actor, and trust decision into the action
  session before checkout or secret restore
- maintainer/admin re-runs keep the original event/ref trust decision and
  cannot turn an originally untrusted run into a trusted secret-backed run
- merge queue and scheduled runs have explicit allow/deny matrices; scheduled
  runs are blocked for refresh/writeback unless actor lifecycle and repository
  freshness are separately proven
- OIDC discovery and fixture tests detect new, removed, or shape-changed claims
  and update compatibility registry state before rotating OAuth is allowed

### Spike AR: OIDC v2 Migration and Claim Capability Proof

Goal:

Prove the existing protocol v1 action-control-plane can remain backward
compatible while rotating OAuth uses a separate secret-bearing OIDC contract
that blocks before secret restore when GitHub claim availability, workflow
identity, audience, replay, or release-channel SHA policy is not proven.

Acceptance:

- protocol v1 exchange continues to issue existing runtime-config sessions for
  legacy static review, interaction, memory, and conflict paths without
  requiring new rotating claims
- protocol v2 exchange rejects protocol v1 action-session tokens and legacy
  runtime clients cannot call v2 lease, public-key, proxy preflight, or
  writeback endpoints
- no-secret diagnostic workflow captures direct and reusable OIDC capability
  fixtures for a disposable private repository without storing raw JWTs or raw
  claim objects
- v2 validator requires `repository_visibility`, `workflow_sha`,
  `runner_environment`, `jti`, and applicable `job_workflow_ref` /
  `job_workflow_sha` before secret restore
- v2 validator rejects missing replay store, JWKS outage after retry budget,
  unknown `kid`, wrong issuer, wrong or mixed audience, expired token, clock
  skew outside tolerance, and changed required claim shape before secret
  restore
- v2 validator does not inherit protocol v1's
  `trustedReviewRouterReusableWorkflowRefPattern` as sufficient trust; moving
  `main`/`v1` refs require release-channel compatibility approval and resolved
  SHA evidence
- custom OIDC subject template presence, absence, and post-setup drift are
  represented as safe diagnostics or blockers according to policy, never as
  repository-name-only trust
- disposable repo E2E proves direct workflow, exact-SHA reusable workflow,
  tag-based reusable workflow, PR, merge queue, and `workflow_dispatch` produce
  expected capability decisions
- support/dashboard views show safe claim capability state, fixture version,
  subject-shape id, missing claim codes, and remediation without raw claims

### Spike J: Supply Chain and Cache Boundary Proof

Goal:

Prove the workflow does not fetch mutable or PR-controlled executable content
after Codex auth is restored, and does not persist sensitive state through
caches, artifacts, outputs, or summaries.

Acceptance:

- generated workflow contains no `latest` action/proxy/Codex version in
  secret-backed mode
- proxy/Codex installer verifies package integrity or checksum before secret
  restore
- no dependency install from PR-controlled code after secret restore
- no package-manager lifecycle scripts run after secret restore
- no non-allowlisted `uses:` action runs after secret restore
- no sensitive values are written to `$GITHUB_STATE`
- no cache restore/save in the secret-backed job after secret restore
- no artifact download from untrusted workflow runs
- no secret-derived values appear in `$GITHUB_OUTPUT`, `$GITHUB_ENV`,
  `$GITHUB_STEP_SUMMARY`, annotations, artifacts, or job summaries

### Spike K: Ambiguous Refresh Outcome Proof

Goal:

Prove that the proxy distinguishes failures before refresh from failures after
the refresh request may have reached upstream.

Acceptance:

- SaaS outage before refresh request yields `skipped_retryable`
- GitHub public-key failure before refresh request yields `skipped_retryable`
- lease TTL too low before refresh request yields `skipped_retryable`
- timeout before request body is sent yields `skipped_retryable`
- timeout after request body is sent yields `unknown_auth_state`
- process kill during refresh request yields `unknown_auth_state`
- no case that may have rotated the refresh token is auto-retried from the old
  GitHub secret

### Spike L: Streaming and Model Retry Proof

Goal:

Prove the proxy handles the pinned Codex CLI's Responses traffic without
unsafe replay, raw stream logging, or broken cancellation behavior.

Acceptance:

- detect whether Codex uses SSE streaming for normal review
- streaming chunks pass through without raw body logs
- stream idle timeout, duration, byte, event, request, and token budgets work
- upstream disconnect after stream start does not replay the request
- upstream disconnect before request body write can retry within budget
- clean 401 before response creation can refresh and retry once
- 401 after stream start or response creation does not replay the model request
- Codex process cancellation closes upstream stream and reports safe status
- no partial stream bodies appear in logs, artifacts, summaries, or SaaS

### Spike M: OIDC Re-Run and Reconciliation Proof

Goal:

Prove the control plane rejects re-run privilege confusion and handles SaaS
writeback split-brain without plaintext credentials.

Acceptance:

- OIDC token uses a ReviewRouter custom audience
- default or wrong audience is rejected
- unexpected `sub` or workflow subject shape is rejected
- re-run of an originally untrusted fork/Dependabot/public event is rejected
- GitHub secret PUT success followed by simulated SaaS DB commit failure enters
  `reconcile_required`
- reconciler can resolve safe metadata states or require reconnect without
  reading plaintext auth
- support tooling cannot mark a new generation confirmed without recorded
  GitHub write success

### Spike N: External Drift and Webhook Proof

Goal:

Prove ReviewRouter reacts safely when GitHub state changes outside the normal
installer/writeback path.

Acceptance:

- manual `gh secret set REVIEWROUTER_CODEX_AUTH_JSON` outside setup/writeback
  is detected by metadata drift and enters `external_secret_drift`
- provider does not refresh from externally changed secret
- rerunning setup clears drift only after local validation and generation hash
  reporting
- installation removed or repository removed webhook suspends provider
- repository public visibility webhook suspends provider
- webhook replay or invalid signature is rejected
- lease acquire revalidates GitHub state even if webhook delivery was missed
- webhook delivery delay, throttling, and out-of-order delivery do not cause
  stale positive events to re-enable secret restore
- duplicate webhook delivery with the same payload hash is idempotent; duplicate
  delivery id with a different payload hash is rejected as suspicious
- webhook projection failure enters retry/dead-letter handling and surfaces
  stale sync diagnostics instead of Codex reconnect guidance
- raw webhook payloads are not persisted; only normalized event metadata and
  safe hashes are available to support

### Spike O: Review Output, Telemetry, and Retention Proof

Goal:

Prove that the feature's output and observability paths cannot become a second
secret channel after the core auth proxy is hardened.

Acceptance:

- raw model output is never posted directly to GitHub
- structured review artifact validation rejects invalid paths, invalid diff
  lines, oversized findings, raw HTML, images, external tracking links,
  workflow-command-shaped text, and mention/autolink abuse
- preferred runner-side posting uses a separate downstream comment job with
  PR/issue write permissions; SaaS-side posting receives only sanitized review
  artifacts if that alternative is selected
- writeback, lease, setup, public-key, support export, and provider health
  endpoints do not log request/response bodies at framework, gateway, APM,
  trace, metric, error-reporting, or support-export layers
- sentinel token strings injected into setup/writeback/review output never
  appear in logs, traces, spans, metrics labels, artifacts, summaries, or
  support exports
- transient encrypted retry payloads, setup tokens, writeback tokens, HMAC
  runner material, and helper tokens expire and are purged by retention jobs
- support UI cannot access raw ciphertext bodies, raw model output, raw prompts,
  raw diffs, OIDC JWT bodies, or token-like values
- admin runbooks cannot mark a generation confirmed without GitHub PUT success
  or reconciler proof

### Spike P: Job Permission Split and Writeback Intent Proof

Goal:

Prove the two most fragile operational assumptions:

1. Codex runs in a job that cannot post or mutate PRs.
2. GitHub secret writeback can be retried/reconciled without plaintext auth and
   without relying on GitHub `updated_at` as a fake version number.

Acceptance:

- `codex-review` job has `contents: read` and `id-token: write`, but no
  `pull-requests: write`, `issues: write`, `contents: write`, or secrets write
  permission
- `post-review-comment` job has comment permissions but no Codex auth secret,
  proxy URL, helper token, writeback token, HMAC key material, raw prompt, raw
  diff, or raw model output
- a malicious prompt cannot create comments because the review job token cannot
  write PR comments
- comment job revalidates the sanitized artifact and suppresses unsafe output
- writeback endpoint persists durable intent before GitHub PUT
- retry with same lease/idempotency key/generation/ciphertext hash is safe
- duplicate retry with different ciphertext for the same idempotency key is
  rejected
- GitHub `updated_at` alone never confirms a generation
- crash before PUT response, crash after PUT response, lost SaaS response, and
  lease expiry each map to the documented states

### Spike Q: Installer Zero-Plaintext and Workflow Provisioning Proof

Goal:

Prove the one-command setup does not undermine the no-plaintext SaaS boundary
and can install/upgrade workflow files without surprising the customer.

Acceptance:

- dashboard command uses a pinned installer version and verifies checksum or
  signature before execution where practical
- installer downloads all executable dependencies before auth materialization
  and blocks executable downloads after `auth.json` is read
- setup completion endpoint rejects payloads containing `auth_json`,
  `access_token`, `refresh_token`, `id_token`, device auth codes, raw stdout, or
  full local filesystem paths
- installer network calls after auth materialization match the documented
  allowlist
- credential source resolver accepts fresh dedicated login and same-repo
  dedicated session reuse, but rejects implicit global auth, keyring scraping,
  app/IDE state, app-server account files, and browser cookies
- optional advanced global import, if implemented, copies into the dedicated
  `CODEX_HOME` and then runs the same validation path before secret write
- crash after GitHub secret write but before setup completion enters
  `seeded_unconfirmed` and rerun completes idempotently
- installer opens or updates a workflow setup PR through local `gh` auth in the
  default path
- SaaS does not need contents write permission for the default workflow
  provisioning path
- repeated installer runs update the same setup PR without duplicating workflow
  blocks
- ambiguous workflow merge opens a PR with explicit conflict guidance rather
  than mutating user workflow in place
- rollback PR disables the new mode without deleting `CODEX_AUTH_JSON` or
  `REVIEWROUTER_CODEX_AUTH_JSON`

### Spike AQ: Workflow Provenance and Runtime Attestation Proof

Goal:

Prove rotating OAuth setup cannot become active from setup PR state alone and
that secret restore is allowed only when the running workflow proves the same
schema, digest, release channel, provider mode, secret name, and runtime
protocol that provisioning recorded.

Acceptance:

- generated rotating workflow includes schema marker, template digest,
  provider auth mode, release channel, secret name, setup intent id, setup
  generation marker, and exact action/proxy/Codex references where the selected
  channel requires exact pins
- provisioning persists per-file template digest, workflow schema version,
  workflow path, release channel, provider auth mode, secret name, setup intent
  id, and pending verification state
- setup PR merge does not mark the provider configured until a trusted run from
  the default branch completes the no-secret runtime attestation
- first runtime preflight obtains OIDC and sends only safe attestation fields
  before any reference to `REVIEWROUTER_CODEX_AUTH_JSON`
- SaaS validates OIDC `workflow_ref`/`workflow_sha`, reusable
  `job_workflow_ref`/`job_workflow_sha`, repository id, visibility, runner
  environment, action ref/SHA, workflow schema, template digest, release
  channel, runtime protocol, provider auth mode, secret name, and compatibility
  registry decision as one tuple
- missing marker, digest mismatch, wrong workflow path, wrong secret name,
  wrong provider auth mode, stale setup intent, wrong action ref, wrong action
  SHA, wrong reusable workflow SHA, or unsupported runtime protocol blocks
  secret restore with a specific safe reason
- PR changes to `.github/workflows/reviewrouter.yml` are reviewable input but
  cannot satisfy runtime attestation for the run
- `workflow_dispatch` with user-supplied inputs cannot override schema, digest,
  action ref, workflow SHA, provider mode, secret name, or provider instance id
- manual default-branch workflow edit produces `workflow_drift_detected` and a
  repair setup PR path, not reconnect guidance
- moving `v1` channel is accepted only when the compatibility registry accepts
  the resolved workflow/action SHA; strict channel requires immutable SHA match
- rollback setup PR records a new inert digest/state that disables rotating
  secret restore without deleting secrets
- support/dashboard views expose only safe workflow path, schema, digest
  prefix, release channel, state, and reason code

### Spike AO: Setup Pairing Anti-Confusion and Completion Proof

Goal:

Prove the one-command rotating OAuth setup cannot configure the wrong
repository/provider, cannot be replayed into another repo, cannot be completed
with plaintext-bearing payloads, and cannot falsely mark a provider active when
GitHub secret write or safe completion state is ambiguous.

Acceptance:

- production rotating setup uses a versioned installer endpoint and never
  falls back to legacy `/install/codex` raw `main` static seeding
- setup intent binds workspace id, repository id, GitHub repository id,
  installation id, provider instance id, provider auth mode, target secret
  name, installer version, installer digest, release channel, workflow schema
  version, setup origin, actor id, expiry, and one-time challenge
- installer verifies the setup intent before reading any Codex auth file
- copied command from another repository, stale setup intent, wrong provider
  instance, wrong secret name, wrong installer digest, wrong release channel,
  or mismatched GitHub repository id stops before auth read
- non-interactive setup refuses target inference from local git remotes or
  `gh repo view`; interactive setup shows detected and dashboard-bound targets
  and requires explicit confirmation on mismatch
- setup completion accepts only safe metadata and rejects plaintext auth,
  token-like fields, raw local paths, raw command output, browser callback
  data, and full terminal transcripts
- duplicate completion with the same idempotency key and generation hash returns
  the same result; duplicate completion with different generation or secret
  metadata is rejected as replay/conflict
- GitHub secret write success followed by setup completion failure produces
  `seeded_unconfirmed`, and rerun recovers only after local auth validation and
  matching generation hash
- expired setup intent after GitHub secret write cannot be used to mark active;
  a fresh setup intent and local revalidation are required
- support diagnostics and audit logs expose only safe setup intent state,
  reason codes, hash prefixes, and timestamps

### Spike AP: Persistence State Machine and Migration Proof

Goal:

Prove the rotating OAuth persistence model enforces auth ownership,
lease/writeback idempotency, generation monotonicity, safe rollback, and legacy
static compatibility without relying on coarse setup or health rows as an auth
ledger.

Acceptance:

- additive Prisma migrations create rotating provider, setup intent,
  generation, lease, writeback intent, account-session group, compatibility
  decision, health event, and incident event records without modifying or
  deleting legacy static `ProviderSetupState` rows
- old `codex_subscription_oauth` repositories remain manual-refresh static
  mode after migration and are never displayed as auto-refreshing
- new rotating auth mode cannot be selected unless provider catalog, setup
  guidance, workflow schema, action protocol, secret name, compatibility
  registry, and setup intent state all match
- database constraints or transactional compare-and-set enforce one active
  lease per auth stream, monotonic generations, single-use setup intents,
  idempotent writeback keys, and repository/provider tenant isolation
- latest confirmed generation cannot advance from action health reports,
  GitHub `updated_at`, secret existence, support action, or dashboard form data
  alone
- simulated concurrent leases, duplicate writebacks, retry after DB timeout,
  stale queued generation, external drift, secret deletion, and repository
  deselection all resolve to documented states
- emergency rollback disables rotating mode through feature flag,
  compatibility registry, auth mode, and workflow schema while leaving new rows
  readable and legacy static workflows functional
- support/admin safe views cannot access ciphertext bodies, raw claim objects,
  raw logs, token-looking strings, or plaintext auth
- migration/backfill job is resumable, bounded, metadata-only, and never reads
  GitHub secret plaintext or tries to infer trust from legacy secret metadata

### Spike AF: Installer Release and Bootstrap Root-of-Trust Proof

Goal:

Prove the production setup command does not depend on mutable installer
contents, mutable redirects, floating package tags, or unverifiable release
artifacts before it reads Codex auth.

Acceptance:

- production rotating dashboard command contains an exact installer version,
  digest, release channel, repo target, and setup session pairing value
- rotating installer endpoint is versioned and does not redirect to raw `main`
  or another mutable branch
- installer verifies digest before execution or, for shell-only bootstrap,
  before any code path reads `auth.json`
- installer prints resolved version, digest, ReviewRouter API origin, target
  GitHub repository id, target provider instance, and target secret name before
  auth materialization
- setup session rejects a command whose installer version or manifest digest
  does not match the paired session
- release manifest records source commit, release tag, installer digest, proxy
  version, workflow schema version, Codex CLI version, and compatibility state
- compatibility registry can block a release manifest before dashboard shows it
  and before an already-downloaded installer reads auth
- advanced verification path can verify the GitHub release asset and attestation
  metadata where available, or returns a clear unsupported state without
  weakening the default path
- digest mismatch, missing release asset, manifest blocked, attestation failure,
  version mismatch, and setup-session mismatch stop before auth is read
- legacy `/install/codex` static seeding endpoint remains supported for static
  mode but is not shown as the production rotating installer command
- tests prove the installer never falls back to raw `main`, `latest`, floating
  dist-tags, or PR-produced artifacts
- incident runbook distinguishes dashboard command compromise, installer
  compromise, proxy/action compromise, Codex CLI package compromise, and
  registry/GitHub release compromise

### Spike R: Environment, Maintenance, Budget, and Drift Kill-Switch Proof

Goal:

Prove the feature stays safe after it is "working": environment secrets do not
shadow repo auth, maintenance refresh does not create false reliability, quota
limits are classified correctly, and compatibility drift disables unsafe runs
before secrets are restored.

Acceptance:

- generated `codex-review` job has no `environment:`
- same-named environment secret is detected and blocks secret-backed mode
- maintenance schedule uses non-top-of-hour timing and deterministic jitter
- delayed/dropped maintenance run produces stale-health dashboard state, not a
  reconnect loop
- maintenance refresh backs off after quota/rate limits and does not burn
  repeated user quota
- upstream 429 before refresh maps to `quota_limited` or safe review failure
- upstream 429 during/after refresh maps according to ambiguous-refresh rules
- compatibility registry can block unsafe installer/proxy/Codex/workflow
  version combinations
- emergency block prevents secret restore before proxy start
- canary/sentinel failures in logs, endpoint allowlist, or sanitizer trigger
  internal-only/block state before broad rollout

### Spike S: Required Check and Merge Queue Proof

Goal:

Prove ReviewRouter's final PR status behaves exactly as the customer selected:
advisory, required, or strict, without pending checks, accidental passes, or
merge-queue gaps.

Acceptance:

- generated workflow has a stable final `reviewrouter-codex-policy` job name
- final policy job uses `if: always()` and reports for every state, including
  skipped review/comment jobs
- workflow-level path/branch/commit-message skipping does not leave the final
  required check pending
- same-repo PR actor/ref policy skips map to deliberate final policy
  conclusions, not accidental GitHub `skipped`
- advisory mode does not intentionally block merge on `needs_reconnect`,
  `quota_limited`, or skipped review states
- required mode blocks on unsafe auth/config/security states but not on
  intentionally skipped untrusted fork/public contexts unless configured
- strict mode blocks on `quota_limited`, skipped reviews, and stale queued runs
- merge-queue repository includes `merge_group` and reports the same final
  policy check in queue runs
- branch protection configured to require the final check from the expected
  source passes/fails exactly as the policy table says
- internal job failures cannot be hidden by downstream skipped jobs
- check names remain stable across workflow schema upgrades

### Spike T: Org Policy, Permission Upgrade, and Incident Response Proof

Goal:

Prove onboarding failure modes are classified precisely and incident response
does not either over-rotate harmless metadata leaks or under-react to plaintext
auth exposure.

Acceptance:

- Actions disabled, action not allowlisted, reusable workflow blocked, and
  workflow permissions too restrictive map to `policy_blocked`
- setup user who cannot approve GitHub App permission update receives an
  owner/admin handoff and provider stays paused
- selected-repository App installation missing target repo maps to
  `permission_required`
- permission accepted but not yet verified cannot acquire lease or restore
  secrets
- no PAT workaround is offered for any org policy or App permission blocker
- plaintext auth leak simulation marks provider `needs_reconnect` and blocks
  refresh/writeback from old secret
- ciphertext/HMAC/helper-token leak simulations rotate/invalidate operational
  material without forcing Codex reconnect unless broader compromise is proven
- compromised installer/proxy/action artifact moves compatibility registry to
  `emergency_blocked` and prevents secret restore
- incident evidence bundle contains only safe metadata and no raw logs
- customer-facing incident copy distinguishes session leak, policy blocker, and
  automation compatibility blocker

### Spike U: Codex Account and Workspace Lifecycle Proof

Goal:

Prove the system handles ChatGPT/Codex account lifecycle changes without
misclassifying them as GitHub policy, quota, or random refresh failures.

Acceptance:

- setup records only safe account/workspace fingerprints, not raw account ids
  or user emails
- reconnect with a different account hash requires explicit account replacement
  confirmation
- account replacement is blocked while a lease is active
- permanent account entitlement or workspace mismatch maps to
  `account_required`
- subscription/seat removal does not become `policy_blocked` or
  `external_secret_drift`
- user leaving company / account disabled produces clear owner/admin recovery
  copy
- workspace policy change or managed configuration mismatch produces
  `account_required`
- plan downgrade or rate-limit loss maps to `quota_limited` when auth remains
  valid and `account_required` only when entitlement is missing
- Enterprise Codex access-token provider remains separate from Plus/Pro OAuth
  auto-refresh path
- account hash mismatch during writeback pauses automation instead of
  overwriting a newer trusted generation

### Spike U2: Account Authorization and Quota Ownership Proof

Goal:

Prove ReviewRouter cannot use a customer's Codex ChatGPT account session in CI
without current, repo-bound, account-bound authorization and clear quota/workspace
ownership.

Acceptance:

- local setup records a consent version before `REVIEWROUTER_CODEX_AUTH_JSON`
  is written
- consent is bound to workspace id, repository id, provider instance id, setup
  actor GitHub id, account/workspace fingerprint hash, auth mode, feature scope,
  policy document hash, and setup channel
- setup copy explains repository content processing under the connected
  ChatGPT workspace/account, subscription quota usage, optional maintenance
  refresh, and the no-plaintext-SaaS boundary
- copied command, stale setup intent, dashboard-only checkbox without local
  account binding, and support-created consent all fail before secret write
- missing, stale, wrong-version, wrong-repo, wrong-account, wrong-workspace,
  wrong-feature-scope, or maintenance-not-acknowledged consent maps to
  `account_authorization_required`
- support/admin can inspect only safe consent metadata and revalidation reasons;
  it cannot create, backdate, override, or force-clear consent
- account disabled or entitlement removed maps to `account_required`, while
  missing/stale authorization with a potentially valid account maps to
  `account_authorization_required`
- enabling future interaction/conflict/memory use of the rotating secret
  invalidates review-only consent and requires a new feature-scope approval

### Spike V: GitHub Secret Materialization and Masking Proof

Goal:

Prove the canonical auth bytes survive the whole GitHub path and never leak
through shell, env, masking, outputs, or multiline handling.

Acceptance:

- installer canonicalizes auth as compact single-line JSON
- `gh secret set` writes the value without byte changes
- workflow restores the secret into the proxy bootstrap step only
- proxy receives exact bytes through `printf '%s'`/stdin, with no appended
  newline, shell escaping, or Unicode normalization
- `restored_generation_hash` computed in workflow matches the local setup hash
  for the same canonical bytes
- secret presence checks use booleans, not raw secret in `if:`
- full compact JSON, token substrings, and sentinel token-like values are
  masked before any command emits output
- raw secret does not appear in process args, `$GITHUB_OUTPUT`, `$GITHUB_ENV`,
  `$GITHUB_STEP_SUMMARY`, annotations, cache, artifacts, job summaries, or
  uploaded logs
- malformed multiline, trailing-newline, CRLF, and shell-metacharacter fixtures
  fail safely or canonicalize before storage
- base64/enveloped format is rejected unless the auth-shape registry explicitly
  enables a matching `auth_shape_version`

### Spike AY: GitHub Runner Implicit Credential and Env Firewall Proof

Goal:

Prove the secret-backed review job can use OIDC and job-scoped GitHub
credentials for trusted preflight while keeping those capabilities out of
Codex, model-controlled tools, repo-controlled commands, logs, artifacts, and
support bundles.

Acceptance:

- generated review job has `id-token: write`, but Codex child env does not
  contain `ACTIONS_ID_TOKEN_REQUEST_URL` or
  `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
- generated review job has the minimal `GITHUB_TOKEN` permissions needed for
  checkout/preflight, but Codex child env and proxy child env do not contain
  `GITHUB_TOKEN`, `GH_TOKEN`, `github.token`-derived credentials, or tokenized
  git remotes
- child env is constructed from an allowlist; tests fail if the launcher passes
  inherited `process.env` to Codex or model-controlled subprocesses
- malicious prompt/env-dump fixture can see only the safe allowlist and cannot
  read GitHub file-command paths such as `GITHUB_ENV`, `GITHUB_OUTPUT`,
  `GITHUB_STATE`, `GITHUB_STEP_SUMMARY`, or `GITHUB_PATH`
- OIDC exchange is performed before secret restore, then OIDC request env and
  action-session material are cleared before any child process starts
- no third-party action, package lifecycle script, repo script, or
  model-influenced command runs in the credential-bearing action/preflight
  process after OIDC/action-session acquisition
- cache/artifact service env such as `ACTIONS_RUNTIME_TOKEN`,
  `ACTIONS_CACHE_URL`, and `ACTIONS_RESULTS_URL` is absent from Codex and
  model-controlled child processes
- package registry credentials such as `NODE_AUTH_TOKEN`, `NPM_TOKEN`, and
  `YARN_NPM_AUTH_TOKEN` are absent even if repository/org workflows define
  them
- reusable workflow variants prove caller/callee `id-token: write` behavior
  does not leak OIDC request env into Codex child processes
- disposable GitHub-hosted runner E2E captures env names, args, cwd, temp/home
  paths, artifact manifests, summaries, and logs with sentinel names only and
  proves no forbidden capability names or values are present

### Spike W: Product Feature Interaction Proof

Goal:

Prove the new auto-refresh provider cannot be accidentally consumed by existing
side paths such as interaction replies, conflict review, reusable workflows, or
memory runtime.

Acceptance:

- generated review workflow uses the new rotating secret only in the proxy
  bootstrap step
- interaction/discussion workflow either does not receive
  `REVIEWROUTER_CODEX_AUTH_JSON` or is explicitly disabled for this provider
  mode
- conflict-review and `repository_dispatch` paths do not receive the rotating
  OAuth secret in client payloads, job env, reusable workflow secrets, or
  artifacts
- memory endpoints receive only safe metadata and sanitized snippets, not raw
  diff, prompt, model output, auth, proxy URL, nonce, HMAC material, or helper
  tokens
- repo-health reports per-path compatibility and does not call the provider
  globally healthy when review is active but interaction/conflict are blocked
- reusable workflow caller passes the new secret explicitly only for trusted
  auto-refresh review schema versions
- OIDC validation rejects a caller workflow that uses the trusted file path but
  calls an untrusted reusable workflow ref
- dashboard copy distinguishes "PR review auto-refresh active" from "discussion
  replies require separate setup or remain disabled"

### Spike X: PR Actor, Manual Dispatch, and Checkout Trust Proof

Goal:

Prove secret-backed review only runs for explicitly trusted PR/ref contexts and
does not expand checkout/network scope through submodules, LFS, or arbitrary
manual refs.

Acceptance:

- fork PR and Dependabot PR are rejected before secret restore
- same-repo PR from a blocked actor/author association maps to
  `policy_blocked` or skipped-by-policy without touching auth
- maintainer re-run of an originally untrusted event is still rejected
- `workflow_dispatch` with arbitrary `ref`, branch, SHA, or PR number input
  does not checkout that value directly
- manual dispatch resolves PR/head SHA through GitHub API and binds resolved
  repository id, head SHA, base SHA, and actor into action-session metadata
- generated checkout uses `persist-credentials: false`, `lfs: false`,
  `submodules: false`, and bounded fetch depth
- `.gitmodules`, nested submodules, Git LFS pointers, and tokenized remote URLs
  do not trigger extra network fetches in the secret-backed job
- `.git/config` after checkout does not retain tokenized remotes or credential
  helpers
- final policy check maps actor/ref skips deliberately in advisory, required,
  and strict modes
- repo-health reports actor/ref policy blockers separately from Codex auth
  failures
- no actor/ref policy failure tells the user to reconnect Codex

### Spike Y: Action Lifecycle, Package Scripts, and Cleanup Proof

Goal:

Prove hidden CI lifecycle mechanisms cannot persist or exfiltrate auth after the
visible secret restore step.

Acceptance:

- generated workflow has no third-party `uses:` steps after secret restore
- any ReviewRouter-owned action after secret restore is pinned and inspected for
  `pre`, `post`, nested `uses`, unexpected shell commands, and `$GITHUB_STATE`
  writes
- `$GITHUB_STATE`, `$GITHUB_OUTPUT`, `$GITHUB_ENV`, summaries, annotations, and
  artifacts never receive auth, proxy URL, nonce, HMAC material, helper token,
  writeback token, OIDC token, raw prompt, raw diff, or raw model output
- package installation and package lifecycle scripts complete before auth
  materialization
- package-manager config from the checked-out repository is not read after
  secret restore
- killing the job before cleanup does not create a secret leak or unsafe retry;
  lease state and no-artifact/no-cache policy still protect the next run
- temp files live only under private `$RUNNER_TEMP` directories with restrictive
  permissions
- proxy cleanup removes temp files and local listeners on normal exit, but tests
  prove cleanup failure is not required for safety

### Spike Z: Control-Plane Key and Database Invariant Proof

Goal:

Prove ReviewRouter-owned keys and persistence constraints cannot accidentally
authorize stale, cross-tenant, or duplicate writebacks.

Acceptance:

- GitHub App private key rotation works with two active keys and no downtime for
  normal writeback
- simulated GitHub App private key compromise moves compatibility registry to
  emergency block, prevents helper-token minting and secret writeback, and does
  not ask users to reconnect Codex unless plaintext auth exposure is suspected
- action-session, setup-token, and writeback-token signing keys include `kid`
  and reject old tokens after the grace window
- KMS/signing-key outage before auth restore maps to `skipped_retryable`
  without restoring `REVIEWROUTER_CODEX_AUTH_JSON`
- HMAC fingerprint key rotation requires a trusted setup/run to migrate latest
  generation hash and rejects old scoped runner material
- active lease uniqueness is enforced by database constraints or transactional
  compare-and-set under concurrent requests
- duplicate idempotency key with identical generation/ciphertext hash is safe;
  duplicate idempotency key with different ciphertext moves provider to
  `suspended`
- latest confirmed generation cannot advance without matching writeback intent
  and recorded GitHub PUT success
- repo transfer, selected-repository removal, and installation id mismatch
  cannot write a secret by stale owner/name
- additive migrations and rollback preserve legacy static mode without reading
  any GitHub secret plaintext

### Spike AA: Review Input Scope and Backpressure Proof

Goal:

Prove large or unusual pull requests produce bounded, honest review behavior
without leaking raw diffs or overwhelming logs, memory, artifacts, or model
context.

Acceptance:

- PR file collection paginates until completion or an explicit file-count limit
- collector detects GitHub/API diff truncation and sets `review_scope_limited`
- binary, too-large, generated, vendored, deleted-only, rename-only, symlink,
  submodule, LFS pointer, invalid-encoding, and unsupported path fixtures are
  classified with safe skip reasons
- path normalization rejects absolute paths, `..`, NUL bytes, drive prefixes,
  control characters, and paths outside the repository root
- prompt builder enforces file, byte, line, and token budgets before Codex
  starts
- partial review output includes clear scope metadata and does not claim full
  coverage
- strict mode can fail on scope-limited review while advisory mode reports a
  neutral/safe warning
- subprocess stdout/stderr exceeding byte, line, invalid-UTF8, or long-line
  limits is truncated or terminates the process without printing raw output
- workflow-command-shaped, ANSI/control-character, and binary output does not
  reach logs, artifacts, summaries, comments, memory endpoints, or SaaS
- debug logging variables are detected and handled according to policy for
  secret-backed jobs
- auth state transitions remain correct when output overflow happens before
  refresh, during review after refresh, and after upstream stream start

### Spike AB: Pre-Model Secret Redaction and Disclosure Proof

Goal:

Prove ReviewRouter can produce useful PR findings without sending suspected
secret values from the PR to Codex/OpenAI, ReviewRouter SaaS, logs, artifacts,
comments, memory, metrics, or support exports.

Acceptance:

- dashboard/setup copy explicitly discloses that bounded review input is sent
  from the customer runner to the customer's Codex/OpenAI account
- the runner scanner redacts high-confidence private keys, SSH keys, PEM blocks,
  JWTs, OAuth tokens, cloud credentials, database URLs, webhook secrets,
  package-registry tokens, GitHub tokens, HTTP auth headers, and `.env`
  assignments before Codex starts
- repeated secret occurrences use the same run-scoped placeholder without
  exposing the value
- low-confidence token-like strings are redacted in model input and surfaced as
  safe possible-false-positive metadata
- real-looking canary tokens are absent from proxy upstream payloads, workflow
  logs, artifacts, comments, telemetry, memory endpoints, support exports, and
  crash/error reporting sinks
- a PR that adds a secret still produces an actionable finding that references
  class and path/line only
- scanner budget overflow and unparseable secret-bearing files map to
  `review_scope_limited` or `security_scan_blocked`, not to a raw model request
- optional GitHub secret scanning metadata enrichment works only with safe
  alert metadata and is not required for the v1 flow
- strict/advisory/required policy behavior is deterministic for no-secret,
  redacted-secret, low-confidence, scanner-overflow, and blocked-file states

### Spike AC: Result Freshness and Comment Idempotency Proof

Goal:

Prove a slow, re-run, or force-pushed review cannot post stale or duplicate PR
comments, and cannot make the final policy check tell a different story from
the posted review output.

Acceptance:

- sanitized artifacts carry repository id, PR number, base SHA, head SHA, event
  name, run id, run attempt, workflow ref, workflow SHA, scope hash, artifact
  hash, and posting key
- comment job re-fetches the PR before posting and rejects artifacts whose
  head SHA no longer matches the current PR head
- stale artifacts do not post inline comments; policy allows either a single
  safe outdated summary update or no comment
- repeated re-runs for the same head/artifact update or skip existing
  ReviewRouter comments instead of creating duplicates
- inline finding dedupe keys prevent duplicate comments for the same
  path/line/head/finding hash
- old-head ReviewRouter comments are not deleted automatically because they may
  contain user discussion
- merge-group runs produce final policy checks without PR comments unless PR
  mapping is explicitly proven
- GitHub 422 line-placement failures downgrade to summary or skip without
  guessing a new line
- GitHub secondary rate-limit or abuse-throttle responses stop posting and
  report `posting_rate_limited`
- comment-posting failures do not ask the user to reconnect Codex
- advisory/required/strict final policy mapping handles `skipped_outdated`,
  `posting_rate_limited`, `posting_location_failed`, and
  `posting_validation_failed`

### Spike AD: Local Credential Source Resolver Proof

Goal:

Prove the one-command local setup creates or reuses only the intended
file-backed dedicated Codex session, and never accidentally imports a user's
global Codex state, app state, keychain, browser cookies, or a non-canonical
account file.

Acceptance:

- fresh setup creates `$HOME/.reviewrouter/codex/<repo-id>` with restrictive
  permissions and `cli_auth_credentials_store = "file"`
- fresh setup uses device-code login when available and browser login fallback
  without sending device codes, callback data, or terminal output to SaaS
- existing same-repo dedicated session reuse validates safe local metadata,
  auth shape, account/workspace fingerprint, generation hash, and smoke before
  writing or confirming a GitHub secret
- keyring-only and `auto` credential modes that do not produce `auth.json` map
  to `fresh_login_required`, not to keychain scraping
- Codex app/IDE account files, app-server files, browser cookies, and arbitrary
  discovered `auth.json` files are rejected as credential sources
- optional global `~/.codex/auth.json` import, if implemented, requires an
  explicit flag and local warning, copies into the dedicated `CODEX_HOME`, and
  never uses the global file in place
- corporate CA variables are honored locally for login/smoke but certificate
  paths and PEM contents are not sent to SaaS
- deleting the local dedicated session while the GitHub secret remains active
  produces clear local reconnect guidance, not remote provider corruption

### Spike AE: Current-Code Migration and Legacy Compatibility Proof

Goal:

Prove the new rotating Codex OAuth mode can be added to the existing
ReviewRouter architecture without silently changing the behavior of current
`codex_subscription_oauth` repositories.

Acceptance:

- provider catalog exposes legacy `codex_subscription_oauth` and new
  `codex_chatgpt_oauth_rotating` as separate auth modes under provider kind
  `codex`
- legacy auth mode still maps to setup kind `codex_oauth`, runtime
  `codex-oauth`, and secret `CODEX_AUTH_JSON`
- rotating auth mode maps to setup kind `codex_oauth_rotating`, runtime
  `codex-oauth-proxy`, and secret `REVIEWROUTER_CODEX_AUTH_JSON`
- provider setup renders legacy static seeding copy for old mode and rotating
  dedicated-session copy for new mode
- old `scripts/seed-codex-auth.sh` output remains valid for static mode and is
  not presented as the rotating installer
- dashboard and policy editor labels never say auto-refresh for a config that
  still uses `codex_subscription_oauth`
- generated workflow for static mode still restores `CODEX_AUTH_JSON` exactly
  as before until a separate deprecation lands
- generated workflow for rotating mode refuses to restore `CODEX_AUTH_JSON` and
  uses only `REVIEWROUTER_CODEX_AUTH_JSON` in the proxy bootstrap step
- repository with both old and new secrets chooses the secret solely from
  selected auth mode plus workflow schema, not from whichever secret exists
- organization secret scopes from legacy static setup are not offered for
  rotating v1
- additive Prisma migration creates rotating state tables without changing or
  deleting old `ProviderSetupState` rows
- repo health reports static/manual, rotating/healthy, rotating/stale,
  rotating/blocked, and mixed-secret states without raw YAML or secret values
- action runtime rejects mismatched combinations of auth mode, workflow schema,
  runtime mode, and secret name before any OAuth secret is materialized
- rollback disables rotating mode while legacy static `CODEX_AUTH_JSON` remains
  usable
- setup and reconnect flows preserve the same resolver states across macOS,
  Linux desktop, and headless shells

## Test Plan

### Unit Tests

- auth JSON parser accepts canonical root `auth.json`
- auth JSON parser rejects duplicate object keys
- auth JSON canonicalizer preserves supported optional fields
- auth shape registry rejects non-canonical account/app-server state files as
  rotating secrets unless an explicit schema version enables them
- auth shape registry preserves supported optional fields and rejects unknown
  token-bearing fields for the pinned Codex version
- canonical auth serializer emits compact single-line JSON and stable bytes
- materialization hash detects appended newline, CRLF normalization, shell
  escaping, base64 envelope mismatch, and Unicode normalization changes
- generation fingerprint is stable across whitespace/key-order changes
- generation fingerprint changes when any token changes
- fingerprint key id mismatch is rejected
- installer detects newer account auth only as local compatibility source
- installer writes canonical root `auth.json` payload to GitHub secret
- installer credential source resolver rejects keyring-only, `auto` storage
  without file output, Codex app/IDE state, app-server files, browser cookies,
  and arbitrary discovered `auth.json` paths
- installer credential source resolver accepts same-repo dedicated
  ReviewRouter `CODEX_HOME` only when safe local metadata, auth shape, account
  fingerprint, generation hash, and smoke validation all pass
- optional global `~/.codex/auth.json` import path requires explicit flag,
  copies into dedicated `CODEX_HOME`, and never uses the global file in place
- installer setup-completion schema rejects plaintext auth fields, device codes,
  raw stdout, and full local filesystem paths
- installer network phase policy blocks executable downloads after auth
  materialization
- installer release manifest validator rejects mutable branches, raw `main`
  redirects, floating dist-tags, missing source commit, mismatched digest,
  blocked compatibility state, and wrong workflow schema
- setup session validator rejects installer version, release channel, or
  manifest digest mismatch before auth materialization
- setup intent validator rejects copied commands, stale intents, wrong repo id,
  wrong provider instance, wrong secret name, wrong installer digest, wrong
  workflow schema, and wrong setup origin before auth materialization
- non-interactive installer refuses local repo inference and requires a
  dashboard-issued setup intent
- interactive installer requires explicit confirmation when detected local repo
  differs from dashboard-bound repo id/full name
- setup completion idempotency accepts only same setup intent, same generation
  hash, same GitHub secret metadata, and same provider instance
- setup completion conflict rejects different generation hash, different secret
  metadata, wrong provider instance, expired intent, and replayed challenge
- installer maps post-secret-write completion failure to `seeded_unconfirmed`
- account/workspace fingerprint mismatch requires explicit replacement
  confirmation
- account entitlement/workspace policy classifier maps permanent failures to
  `account_required`
- account hash mismatch during writeback rejects stale overwrite
- account-session group resolver creates only safe non-reversible account
  groups and rejects missing/unstable account fingerprints for multi-repo
  rotating setup
- account-session isolation policy resets from `isolated` to `unknown` when
  Codex CLI version, auth shape version, account type, workspace policy, or
  compatibility tuple changes
- account-level lease fallback serializes refresh-needed runs across provider
  instances with the same account-session group
- account-session group state `interfering` blocks independent refresh and does
  not trigger reconnect loops
- org multi-repo rotating mode is blocked
- Codex CLI binary compatibility fixture rejects missing hardening flags,
  changed help output, unsupported config keys, version mismatches, missing
  package integrity, and disallowed npm dist-tags
- Codex CLI JSONL parser fixture rejects unknown event types, event shape
  drift, raw prompt/body events, and model output that bypasses sanitizer
- Codex CLI network fixture rejects unexpected egress, update checks, plugin
  warmups, `/models`, file APIs, MCP, hosted web search, feedback, telemetry,
  and nonce-less or prefix-stripped provider requests
- provider catalog maps `codex_subscription_oauth` to static `CODEX_AUTH_JSON`
  and `codex_chatgpt_oauth_rotating` to rotating
  `REVIEWROUTER_CODEX_AUTH_JSON`
- provider setup renders different commands, labels, scopes, warnings, and
  failure recovery for static vs rotating Codex OAuth
- action protocol v2 schema rejects missing workflow schema, action version,
  proxy version, provider auth mode, repository id, run id, run attempt,
  workflow ref/SHA, event, and OIDC audience
- restore grant repository tests enforce short TTL, single-use consumption,
  tuple binding, permission epoch binding, compatibility decision binding, and
  safe audit metadata without raw secrets
- lease acquire tests reject restore grants with wrong run id, run attempt,
  workflow SHA, reusable workflow SHA, provider instance, secret name,
  repository id, installation id, runner environment, feature scope, permission
  epoch, or compatibility decision
- bootstrap guard tests prove missing/expired/mismatched restore grant prevents
  auth parse, generation fingerprinting, proxy start, and refresh
- protocol v1 runtime config cannot include rotating OAuth fields
- static runtime config fallback is rejected for rotating OAuth before secret
  materialization
- action compatibility policy rejects rotating OAuth for old action refs and
  mismatched action/proxy/workflow-schema tuples
- release cohort resolver classifies legacy static, rotating internal, rotating
  canary, rotating GA exact, rotating GA moving, blocked, and suspended states
- compatibility registry resolves configured action ref plus exact SHA and does
  not treat moving `v1` as sufficient capability
- rollback policy tests prove exact-pinned rotating repos are unaffected by a
  moving `v1` rollback
- workflow scanner rejects a rotating auth mode with legacy static workflow
  schema or `CODEX_AUTH_JSON` restore step
- workflow provenance tuple validator rejects missing schema marker, missing
  template digest, wrong workflow path, wrong secret name, wrong provider auth
  mode, wrong release channel, wrong action ref/SHA, wrong reusable workflow
  SHA, missing runtime protocol, and stale setup intent
- workflow template digest generator is deterministic for generated rotating
  workflows and changes when executable YAML, secret materialization point,
  permissions, runtime refs, provider mode, schema, or feature-scope changes
- workflow template digest tests document whether allowed whitespace/comment
  changes are canonicalized or treated as a new generated template digest
- provisioning repository tests store per-file template digest, workflow schema,
  release channel, provider auth mode, secret name, setup intent id, and
  `workflow_pending_verification` without marking the provider active
- workflow state mapper tests keep `setup_pr_open`,
  `workflow_pending_verification`, `workflow_drift_detected`,
  `workflow_schema_mismatch`, `workflow_attestation_incomplete`,
  `rotating_protocol_unsupported`, `control_plane_version_unsupported`,
  `workflow_repair_required`, and `workflow_disabled_by_rollback` distinct
  from auth failure states
- workflow repair planner tests generate deterministic repair PR metadata with
  previous digest, candidate digest, expected schema, provider auth mode,
  secret name, release channel, and setup intent marker
- workflow runtime preflight tests reject digest mismatch, missing default-ref
  verification, wrong `workflow_sha`, wrong `job_workflow_sha`, and unsupported
  moving-channel compatibility before secret restore
- setup PR merge status tests prove `setup_pr_merged` is not equivalent to
  `configured` until runtime attestation succeeds from a trusted default ref
- workflow drift state tests map manual edits, PR-controlled workflow changes,
  setup branch drift, YAML syntax changes, and missing markers to repairable
  workflow states rather than reconnect or static fallback states
- workflow rollback tests leave old rotating rows inert and block secret
  restore when the rollback digest/schema disables the rotating capability
- dashboard copy tests assert old configs say manual refresh and new configs
  say auto-refresh only after workflow/schema verification
- Prisma migration tests prove old `ProviderSetupState` rows remain readable
  and new rotating tables enforce lease/writeback uniqueness
- Prisma migration tests prove rotating tables are additive, nullable/defaulted
  safely where needed, indexed for lease/writeback lookups, and reversible by
  disabling feature flags without dropping data
- rotating provider ledger tests enforce unique active provider identity,
  provider-instance tenant isolation, monotonic generation numbers, and exactly
  one latest confirmed generation
- setup intent repository tests enforce single-use challenge, expiry,
  idempotent same-payload completion, replay conflict, and no cross-repo or
  cross-provider completion
- lease repository tests enforce compare-and-set on provider id, generation
  hash, account-session group, run id, run attempt, and lease expiry
- writeback intent repository tests require durable intent before GitHub PUT
  and reject mismatched ciphertext hash, `key_id`, secret metadata, provider
  id, or generation hash for a reused idempotency key
- encrypted writeback custody tests store ciphertext hash and safe metadata by
  default, not raw ciphertext bodies
- encrypted retry queue tests require envelope encryption, TTL, KMS key id,
  bound lease/run/generation metadata, and purge on expiry or drift
- ciphertext replay tests reject older encrypted payloads after a newer
  generation is confirmed or an external reseed/drift is observed
- idempotency conflict tests map same key with different ciphertext or bound
  metadata to `security_invariant_failed`
- support projection tests prove raw ciphertext cannot be selected from safe
  views, support exports, audit bundles, telemetry snapshots, or incident
  bundles
- state transition tests reject unsafe jumps from `unknown_auth_state`,
  `reconcile_required`, `external_secret_drift`, `seeded_unconfirmed`,
  `permission_required`, `suspended`, and `needs_reconnect` to `active`
- support projection tests read only safe rotating-auth views and cannot select
  raw ciphertext bodies, raw claims, raw logs, token-looking values, or auth
  plaintext placeholders
- repo health tests classify static/manual, rotating/healthy, rotating/stale,
  mixed-secret, permission-required, and external-drift states
- secret name resolver selects `REVIEWROUTER_CODEX_AUTH_JSON`
- OIDC claim validator rejects wrong repo id
- OIDC claim validator rejects wrong workflow path
- OIDC claim validator rejects wrong audience and subject
- OIDC claim validator rejects fork event
- OIDC claim validator rejects re-run of originally untrusted event
- rotating OIDC claim contract rejects missing `repository_visibility`,
  missing/invalid `runner_environment`, unexpected `environment`, public
  repository visibility, missing reusable workflow `job_workflow_ref`, missing
  strict-channel `job_workflow_sha`, missing replay `jti`, and unresolved
  manual refs before secret restore
- `OidcTrustSnapshotV1` stores only normalized safe claim fields and hash
  prefixes, never raw JWT, raw claims object, Authorization header, actor email,
  token claims, or full exception detail
- OIDC claim drift fixture fails closed when GitHub adds required-shape changes,
  removes expected claims, changes `runner_environment` values, or changes
  reusable workflow claim behavior
- OIDC v2 validator is a separate unit from protocol v1
  `validateOidcClaimsAgainstRepository` and cannot accidentally accept the
  protocol v1 reusable workflow regex as sufficient secret-restore trust
- protocol v1 session tokens are rejected by v2 lease, public-key, proxy
  preflight, and writeback routes; v2 secret-bearing session tokens are
  rejected by legacy runtime-config, memory, and conflict-posting routes unless
  explicitly allowlisted
- OIDC v2 claim capability registry records fixture version, workflow shape,
  runner image, release channel, subject-shape id, required claims, optional
  claim gaps, and compatibility decision without raw JWTs or raw claim objects
- OIDC v2 validator rejects missing `workflow_sha`, missing `jti`, missing
  `repository_visibility`, missing/invalid `runner_environment`, wrong or mixed
  audience arrays, unknown `kid`, issuer mismatch, JWKS outage after retry
  budget, and replay store outage before secret restore
- subject-template diagnostics distinguish absent template, accepted
  ReviewRouter template, incompatible customer template, and post-setup
  template drift without treating subject string alone as the trust root
- re-run trust snapshot preserves the original event/ref/actor trust decision
  and ignores `triggering_actor` as an upgrade signal
- lease store enforces single active lease
- stale lease with refresh started becomes unknown
- lease records secret metadata updated_at
- lease acquire rejects stale queued generation
- lease rejects refresh when TTL safety margin is too low
- writeback schema rejects plaintext fields
- GitHub secret adapter sends only `encrypted_value` and `key_id`
- GitHub secret adapter sends the pinned GitHub REST API version header and
  fails closed on unexpected public-key or secret-update response shapes
- public-key provenance validator rejects SaaS-supplied keys, malformed keys,
  wrong owner/repo, wrong repository id, wrong installation id, wrong secret
  name, wrong API host, wrong API version, and `key_id` not bound to the key
  response used for encryption
- sealed-box envelope validator requires ciphertext hash, public-key hash,
  `key_id`, generation hash, lease id, idempotency key, repository id,
  installation id, and secret name before SaaS writeback
- writeback confirmation tests advance latest generation only after durable
  intent plus GitHub PUT `201`/`204` proof inside the confirming transaction
- metadata-only confirmation tests prove secret existence, `updated_at`,
  organization secret metadata, manual dashboard confirmation, and legacy
  `ProviderSetupState` cannot activate rotating OAuth or confirm generation
- GitHub secret adapter validates canonical plaintext byte budget, encrypted
  base64 byte budget, `key_id` binding, owner/repo binding, secret name, and
  repository id before writeback
- GitHub secret adapter maps 403, 404, validation errors, primary rate limits,
  secondary rate limits, and abuse throttling according to refresh phase
- GitHub App permission resolver distinguishes current `Secrets: read` profile,
  accepted `Secrets: write`, pending owner approval, selected-repository miss,
  installation removed, and permission removed after setup
- permission epoch resolver separates desired App permission profile, accepted
  installation permissions, selected-repository membership, and minted
  token-scope permissions
- manifest generator tests assert `standard` emits read-only secrets while
  `rotating-writeback` emits repository `Secrets: write`
- readiness smoke fails if a production rotating-writeback profile still has
  only `secrets: read`
- token issuer rejects missing `repository_ids`, missing `permissions`, and
  overbroad helper/writeback permissions
- typed installation-token issuer tests reject generic GitHub client call sites,
  unapproved caller services, wrong purpose, missing permission epoch,
  missing lease/writeback intent for `secret_writeback`, and any support/admin
  token-minting attempt
- GitHub SDK cache-isolation tests monkeypatch `@octokit/app` auth cache and
  reject broad, cross-repo, cross-purpose, expired, wrong-epoch, wrong-base-URL,
  wrong-issuer-key, and wrong-compatibility cached tokens before requester use
- token issuance ledger tests store only safe HMAC token fingerprint prefixes,
  permission hashes, repository-scope hashes, issuer key ids, caller ids,
  purpose, TTL, status, and safe reason codes
- token issuer emergency-pause tests map signer outage, KMS outage, App
  private-key compromise suspicion, overbroad GitHub response, and policy drift
  to `writeback_authority_paused`
- permission webhook handling increments the permission epoch and suspends or
  blocks the provider on permission removal, repo removal, App suspend, App
  uninstall, owner transfer, and org policy block
- setup and support flows never offer PAT fallback for App permission blockers
- webhook signature verifier uses the exact raw body, rejects missing
  `X-Hub-Signature-256`, rejects body/header mutation, and does not accept the
  legacy SHA-1 signature as sufficient
- webhook inbox stores delivery id, event/action, installation id, repository id
  when present, safe normalized event, payload hash, normalized event hash,
  status, retry count, and projection version without storing raw payload bodies
- webhook duplicate delivery id with matching payload hash is idempotent;
  matching delivery id with a different hash is rejected and audited
- out-of-order webhook projection cannot move a provider from suspended or
  permission-required back to active without a live GitHub API reconciliation
- webhook projection retry exhaustion dead-letters safely and dashboard/support
  show stale sync without Codex reconnect guidance
- generated workflow scanner rejects debug-enabled secret-backed runs,
  `set -x`/`bash -x`, verbose package-manager flags after secret restore, raw
  annotation writes, unsafe summary writes, broad artifact globs, artifact
  download-all, and job outputs carrying review payloads
- debug canary tests enable `ACTIONS_STEP_DEBUG`, `ACTIONS_RUNNER_DEBUG`, and
  rerun debug where possible, then inspect step logs, runner diagnostic logs,
  job summaries, annotations, and log archives for sentinel leaks
- sanitized artifact producer emits a fixed name, explicit `retention-days`,
  schema version, producer job id, run id, run attempt, head SHA, and artifact
  hash; consumer verifies all fields before posting
- artifact consumer downloads only the expected artifact name and rejects
  default-name `artifact`, duplicate names, missing digest/hash, digest warning,
  extracted symlink, hidden file, binary blob, path traversal, and unexpected
  file count
- workflow command wrapper tests use random stop-command tokens and prove raw
  model/tool text cannot emit `add-mask`, `warning`, `error`, `set-output`,
  `save-state`, summary Markdown, or env/output file writes
- reusable workflow scanner rejects `secrets: inherit`, undeclared
  `workflow_call` secrets, legacy static secret names in rotating mode, missing
  caller `permissions`, called workflow `environment:`, unsafe workflow outputs,
  and nested reusable workflow chains
- reusable workflow OIDC tests bind caller workflow identity and called
  workflow identity, reject wrong `job_workflow_ref`, missing strict-channel
  `job_workflow_sha`, branch-based called refs, and compatibility-disallowed
  resolved called workflow SHA
- reusable workflow permission tests prove the called workflow cannot elevate a
  missing caller `GITHUB_TOKEN` permission and maps it to `policy_blocked`, not
  reconnect
- reusable workflow E2E covers explicit generated workflow, reusable exact SHA,
  reusable release tag, reusable branch blocked, environment secret shadow
  blocked, `secrets: inherit` blocked, and nested workflow blocked
- GitHub App installation token handling treats helper/writeback tokens as
  opaque variable-length strings and never validates by old prefix, fixed
  length, or token internals
- external GitHub secret metadata drift blocks refresh
- writeback rejects external secret metadata changes
- writeback rejects secret deleted after lease acquisition
- writeback handles stale GitHub public key with one re-encrypt retry
- duplicate idempotent writeback succeeds only when generation and ciphertext
  hash match
- duplicate idempotent writeback rejects different ciphertext for same key
- HMAC key scope rejects wrong repository, provider, run, attempt, or lease
- reconciler blocks refresh until pending GitHub writeback state is resolved
- GitHub App webhook handler suspends provider on repo removal, app uninstall,
  missing permission, or public visibility change
- CLI compatibility contract fixture rejects missing hardening flags
- logs redact token-like strings
- sensitive-route registry rejects any rotating OAuth route without a privacy
  class, body policy, allowed log fields, trace fields, metric labels, and
  support-export policy
- log serializer and error serializer omit request/response bodies, raw URLs,
  headers, cookies, JWTs, helper tokens, setup/writeback tokens, HMAC material,
  nonce/proxy URLs, auth JSON, `encrypted_value`, raw prompt, raw diff, and raw
  model output for secret-backed routes
- access-log formatter records only method, route id, status, request id,
  body-size bucket, duration bucket, and safe reason for sensitive routes
- validation-error mapper returns stable safe codes without echoing Zod issue
  values, offending body fields, query values, or header values
- route schema tests reject plaintext-looking aliases such as `authJson`,
  `accessToken`, `refreshToken`, `idToken`, `deviceCode`, `authorization`,
  `cookie`, `nonce`, `proxyUrl`, and raw `claims`
- support export safe view excludes raw HTTP bodies, raw DB request payloads,
  raw ciphertext bodies, OIDC JWTs, auth-adjacent tokens, raw prompts, raw
  diffs, and raw model output
- metric label validator rejects sensitive-like, high-cardinality, token-like,
  URL-like, and raw error-message labels
- telemetry sink harness proves sentinel values are absent from test logger,
  trace exporter, metrics sink, error reporter, support export, DB row
  snapshots, artifact manifests, and job summary fixtures
- auth JSON size guard enforces GitHub secret limit headroom
- generated workflow scanner rejects non-allowlisted `uses:` actions after
  secret restore
- generated workflow scanner rejects sensitive `$GITHUB_STATE`,
  `$GITHUB_OUTPUT`, `$GITHUB_ENV`, summary, annotation, cache, and artifact
  writes
- package lifecycle policy rejects package-manager commands after secret
  restore and repo-controlled package-manager config in secret-backed steps
- proxy router exposes no control-plane/admin/status/debug/health/writeback
  routes on the Codex-visible listener
- proxy Responses firewall rejects hosted tools, remote file APIs, MCP,
  image/audio/realtime, attachments, vector stores, unexpected `include`,
  model override, method override, query strings, redirects, CORS preflight,
  request smuggling, duplicate content-length, encoded path traversal, and
  oversized JSON before upstream or refresh work
- direct valid data-plane calls are counted against per-run budget and labelled
  `direct_data_plane_call`
- process/procfs isolation tests prove `ps`, `/proc/*/environ`,
  `/proc/*/cmdline`, `/proc/*/fd`, `/proc/net/tcp*`, `lsof`, core-dump, and
  ptrace probes cannot see proxy auth/control material
- file descriptor tests prove sensitive bootstrap/proxy descriptors are
  close-on-exec and absent from Codex/model-controlled subprocesses
- runner compatibility tests map unsupported process isolation to
  `process_isolation_unsupported` before secret restore
- key registry rejects unknown `kid`, expired signing keys, revoked setup
  token signers, and wrong HMAC key scope
- database invariants enforce one active lease per auth stream and reject
  duplicate idempotency keys with different ciphertext hashes
- provider state transition tests prevent unsafe jumps from
  `unknown_auth_state`, `reconcile_required`, `external_secret_drift`, and
  `suspended` directly to `active`
- review input collector paginates PR files, detects truncation, classifies
  skipped files, and enforces file/byte/line/token budgets
- review input secret scanner redacts private keys, SSH keys, PEM-like blocks,
  JWTs, OAuth tokens, API keys, cloud credentials, database URLs, webhook
  secrets, HTTP auth headers, `.env` assignments, package-registry tokens, and
  GitHub tokens before model input
- secret redaction placeholders are stable within a run, non-reversible, and
  scoped by repository/run/class
- redaction policy handles low-confidence token-like strings, split lines, JSON
  escapes, URL encoding, base64-like chunks, Unicode normalization, binary
  files, and invalid-encoding files without leaking raw values
- redaction budget overflow maps to `review_scope_limited` or
  `security_scan_blocked` according to policy
- path normalizer rejects absolute paths, traversal, NUL bytes, drive prefixes,
  control characters, symlink escapes, and paths outside repository root
- sanitized snapshot builder copies only allowlisted regular tracked files and
  excludes `.git`, hooks, local git config, credential helpers, tokenized
  remotes, package-manager caches, dependency directories, core dumps, runner
  temp files, and control/proxy roots
- sanitized snapshot builder rejects or safely represents symlinks, hardlinks,
  nested git repositories, submodule entries, LFS pointers, absolute paths,
  traversal, NUL bytes, Windows drive prefixes, control characters, invalid
  encodings, huge files, binary files, and generated/vendor files
- checkout containment validator rejects raw checkout as Codex cwd,
  `CODEX_HOME`, artifact root, cache root, or proxy temp root
- checkout config scanner rejects tokenized remotes, credential helpers,
  unexpected local git config, submodule metadata, and LFS smudge/download state
- artifact/cache allowlist validator rejects raw checkout, `$GITHUB_WORKSPACE`,
  `$RUNNER_TEMP`, control root, proxy temp dirs, Codex home, parent directories,
  and broad recursive globs
- process output limiter caps stdout/stderr bytes, lines, invalid UTF-8,
  control characters, binary data, and long single lines before logging
- setup session token is repository/provider scoped and expires
- initial generation hash is recorded only after GitHub secret write succeeds
- retention TTL scheduler purges expired setup tokens, writeback tokens, HMAC
  runner material, and transient encrypted retry payloads
- support admin permissions cannot read raw ciphertext bodies or token-like
  operational material
- support admin cannot mark generation confirmed without GitHub PUT success or
  reconciler proof
- GitHub App private key rotation and compromise runbooks block writeback
  without forcing Codex reconnect unless plaintext auth is affected
- setup PR generator is idempotent for repeated runs
- workflow template merger preserves unrelated config or returns explicit
  conflict diagnostics
- workflow capability analyzer distinguishes review auto-refresh, interaction
  unsupported, conflict unsupported, reusable trusted, and legacy static modes
- repo-health reports per-path auto-refresh compatibility instead of one global
  provider healthy bit
- actor/ref policy classifier rejects fork, Dependabot, blocked same-repo
  actor, unresolved manual ref, and maintainer re-run of originally untrusted
  event without changing auth state
- writeback intent is durably recorded before GitHub PUT starts
- latest confirmed generation is not advanced from GitHub `updated_at` alone
- writeback reconciler differentiates no-response, response-recorded,
  DB-commit-lost, external drift, and lease-expired cases
- review artifact sanitizer strips raw HTML, images, external links, hidden
  comments, workflow-command-shaped text, and unsafe mentions/autolinks
- review artifact validator rejects invalid repository paths, invalid diff
  positions, oversized findings, and token-looking text
- sanitized artifact identity validator rejects missing or mismatched repo id,
  PR number, base SHA, head SHA, run id, run attempt, workflow SHA, scope hash,
  artifact hash, or posting key
- comment marker parser accepts only ReviewRouter-owned safe metadata and
  rejects model-supplied hidden markers
- comment dedupe key is stable for identical path/line/head/finding hash and
  changes when the head SHA or finding content changes
- comment posting state mapper separates `skipped_outdated`,
  `skipped_merge_group`, `posting_rate_limited`, `posting_location_failed`,
  and `posting_validation_failed`
- sanitized artifact schema rejects hidden files, symlinks, binary blobs,
  screenshots, workspace archives, raw shell output, and oversized payloads
- compatibility registry blocks disallowed installer/proxy/Codex/workflow
  version combinations
- quota classifier maps upstream/GitHub/ReviewRouter rate limits to
  `quota_limited`, `skipped_retryable`, or `unknown_auth_state` according to
  refresh ambiguity
- same-named environment secret detection blocks secret-backed mode
- policy check mapper produces deliberate conclusions for advisory, required,
  and strict modes
- required-check conclusion table covers every provider state
- org/repo policy preflight maps Actions disabled, action not allowlisted,
  reusable workflow blocked, selected repo missing, and permission pending to
  precise states
- incident classifier separates plaintext auth leak, ciphertext leak, HMAC
  material leak, helper token leak, and compromised artifact handling
- incident evidence bundle schema rejects raw logs, token-looking fields, and
  plaintext auth

### Proxy Tests

- stdin auth load
- env auth removal wrapper
- malformed auth rejected
- missing refresh token rejected
- pre-refresh threshold
- 401 refresh retry once
- writeback readiness preflight blocks refresh before public-key/SaaS readiness
- ambiguous refresh outcome maps to `unknown_auth_state`
- pre-refresh dependency failure maps to `skipped_retryable`
- runner clock skew maps to `skipped_retryable`
- refresh permanent failures map to `needs_reconnect`
- transient refresh failures map to retryable failure when no rotation happened
- writeback failure after rotation maps to `unknown_auth_state`
- endpoint allowlist denies unknown paths
- nonce path prefix required
- request body limit enforced before proxying upstream
- prompt/model input budget enforced before upstream request
- process output overflow cannot cause unbounded logs, artifacts, memory
  writes, or SaaS ingestion
- streaming SSE pass-through has idle, duration, event, and byte limits
- model request is not retried after body write or stream start
- 401 retry is allowed only before response creation or stream start
- Codex cancellation closes upstream stream
- non-Responses paths such as `/backend-api/plugins/featured` are denied or
  return a safe empty response without egress
- inbound Authorization stripped
- upstream Authorization injected
- max request limit enforced
- max runtime enforced
- max tool turn limit enforced
- upstream 429 before refresh does not trigger reconnect guidance
- budget hard limit stops more upstream requests in the same run
- public-key read token never reaches Codex runtime env
- writeback/session token never reaches Codex runtime env
- OIDC request env, `GITHUB_TOKEN`, file-command paths, artifact/cache service
  tokens, package registry tokens, and ReviewRouter helper/HMAC material never
  reach Codex runtime env, args, files, or proxy child env
- child process env allowlist contains only documented safe variables and is
  constructed without inheriting `process.env`
- persistent history is disabled or temp history is deleted
- no shutdown endpoint
- repo package scripts are not executed in secret-backed mode
- direct shell network is blocked or budget-limited according to the selected
  policy
- comment token, GitHub posting token, and GitHub write token are absent from
  Codex runtime env, args, files, and proxy process env
- raw model output is transformed to structured review artifact before any
  GitHub comment posting path

### Workflow Template Tests

- no global secret env
- raw `REVIEWROUTER_CODEX_AUTH_JSON` appears only in proxy bootstrap step
- secret presence booleans are derived without placing raw auth in job-level env
- no `pull_request_target`
- no `workflow_run` privilege trampoline
- fork guard before secret steps
- `permissions: {}` at top or equivalent strict permissions
- review job has `id-token: write`
- review job does not have `pull-requests: write`, `issues: write`, or
  `contents: write`
- review job does not set `environment:`
- final `reviewrouter-codex-policy` job uses `if: always()` and stable unique
  name
- final policy job depends on review/comment jobs and reports deterministic
  success/neutral/failure
- generated workflow does not use workflow-level path/branch/commit-message
  skips for the required ReviewRouter check
- merge queue repositories include `merge_group` trigger when required-check
  mode is enabled
- comment job is separate from review job and starts only after Codex exits
- comment job does not receive Codex auth, proxy URL, helper token, writeback
  token, HMAC key material, raw prompt, raw diff, or raw model output
- job runs only on GitHub-hosted Linux for this mode
- `actions/checkout` uses `persist-credentials: false`, `lfs: false`,
  `submodules: false`, and bounded fetch depth
- raw checkout, trusted control, sanitized review, artifact staging, and Codex
  home roots are separate paths under `$RUNNER_TEMP`
- Codex runtime `cwd` is the sanitized review root, not the raw checkout root
  or `$GITHUB_WORKSPACE`
- Codex runtime cannot see `.git`, hooks, local git config, credential helpers,
  tokenized remotes, proxy temp files, auth files, helper tokens, OIDC tokens,
  HMAC material, or writeback state
- sanitized snapshot root is read-only or mutation-checked, and any writable
  scratch path is outside artifact/cache allowlists
- manual workflow dispatch never checks out an arbitrary user-supplied ref
- no cache restore/save after secret restore
- no artifact download from untrusted runs
- no mutable `latest` references in secret-backed steps
- no non-allowlisted `uses:` actions after secret restore
- no `$GITHUB_STATE` writes containing auth-derived or proxy/control-plane
  material
- no package-manager lifecycle scripts or project package-manager config after
  secret restore
- no repo dependency install after secret restore
- no `cancel-in-progress: true` on the secret-backed refresh job
- untrusted diagnostic output is wrapped with `stop-commands`
- no `$GITHUB_OUTPUT`, `$GITHUB_ENV`, or step-summary writes containing
  auth-derived material
- proxy bootstrap receives auth secret
- Codex runtime does not receive auth secret
- PR/issue write permissions exist only in the downstream comment job, not in
  the Codex review job
- workflow setup PR is generated from a pinned template and does not require
  SaaS contents-write permission in the default path
- generated rotating workflow includes ReviewRouter schema marker, template
  digest, provider auth mode, release channel, secret name, setup intent id,
  setup generation marker, and exact runtime refs according to channel policy
- repeated workflow provisioning updates the same setup PR idempotently
- setup PR merge leaves rotating provider in pending verification until the
  no-secret runtime attestation proves the default-branch workflow digest
- workflow template merger uses structured YAML or bounded patch operations
  and returns conflict diagnostics for unsupported customization instead of
  broad string replacement
- generated workflow references satisfy configured org allowed-actions policy
  or setup reports `policy_blocked`
- generated rotating workflow has a no-secret permission preflight that blocks
  before `REVIEWROUTER_CODEX_AUTH_JSON` is referenced when the App installation
  lacks accepted `Secrets: write` on the selected repository
- workflow never receives a GitHub token with `Secrets: write`; only SaaS uses
  server-side App installation credentials for secret mutation
- generated rotating workflow installs only an allowlisted exact Codex CLI
  version with package integrity/lock evidence and never installs `latest`,
  alpha/beta/native dist-tags, or a CLI version missing compatibility approval
- sanitized artifact upload uses explicit file allowlist, minimal retention,
  fixed artifact name, and no workspace-wide paths
- sanitized artifact allowlist cannot include raw checkout, `$GITHUB_WORKSPACE`,
  `$RUNNER_TEMP`, control root, proxy temp dirs, Codex home, parent directories,
  or broad recursive globs
- sanitized artifact transfer uses artifact download, not job outputs for raw
  review payloads
- comment job re-fetches current PR head before posting and refuses stale
  artifacts
- comment job uses ReviewRouter-owned safe markers and dedupe keys, not
  model-supplied hidden comments
- merge-group runs do not post PR comments unless safe PR mapping is proven
- SaaS-side comment posting step sends only sanitized structured review
  artifacts, not raw model streams, prompts, diffs, or proxy diagnostics
- Codex runtime ignores repo user config and rules
- Codex runtime disables plugins, apps, tool suggestions, and hosted web search
- Codex runtime disables persistent history and feedback where supported
- Codex runtime routes `chatgpt_base_url` to the local proxy/sink
- Codex custom provider base URL includes nonce path prefix
- static model catalog config is rendered
- reusable workflow caller passes new secret explicitly
- interaction/discussion workflow does not receive the rotating OAuth secret
  unless a separate schema version enables it
- conflict-review workflow and `repository_dispatch` payload do not receive the
  rotating OAuth secret
- memory runtime env and endpoints do not receive auth, proxy URL, nonce, HMAC
  material, helper token, raw prompt, raw diff, or raw model output

### E2E Tests

Use existing disposable repo hygiene rules. Reuse disposable repos where
possible and clean up after the batch.

Scenarios:

- legacy static `codex_subscription_oauth` repository continues to review with
  `CODEX_AUTH_JSON` and is labelled manual refresh
- rotating setup on the same disposable repository creates a distinct setup PR,
  secret, workflow schema, and provider health state
- repository with both old and new Codex secrets uses only the secret selected
  by provider auth mode and workflow schema
- rotating installer refuses digest mismatch, blocked manifest, missing release
  asset, version mismatch, and raw-main redirect before reading auth
- advanced installer verification path verifies GitHub release asset or
  attestation metadata where available, and fails closed when unsupported
- old action ref plus rotating config fails before secret restore with
  `rotating_protocol_unsupported`
- rotating workflow with `REVIEWROUTER_STATIC_CONFIG_FALLBACK=true` fails
  before secret restore and does not fall back to legacy static config
- no-secret preflight grant expires before bootstrap; workflow skips before
  parsing auth bytes and reports retryable restore-grant expiry
- copied restore grant from run A/run attempt 1 into run B/run attempt 2 is
  rejected by lease acquire before proxy start
- permission epoch or compatibility decision changes between preflight and
  bootstrap invalidate the restore grant even if the workflow step has already
  materialized the GitHub secret
- malicious same-user procfs probe cannot read proxy env, cmdline, FDs,
  control-root files, server-info internals, or token-like sentinel material
- runner image with unsupported procfs/ptrace/sandbox behavior maps to
  `process_isolation_unsupported` before OAuth secret restore
- canary exact-pin repo, GA exact-pin repo, moving-`v1` repo, and legacy static
  repo all behave according to their cohort in the same workspace
- blocking one exact rotating action/proxy version prevents secret restore for
  that cohort without breaking legacy static reviews
- moving `v1` rollback drill leaves exact-pinned rotating repos unchanged
- private repo first setup
- first setup creates or updates workflow setup PR without sending plaintext
  auth to SaaS
- local setup creates a dedicated file-backed Codex session instead of reusing
  the user's global Codex CLI/app session
- keyring-only global Codex login causes dedicated login guidance, not keychain
  scraping
- explicit global auth import, if enabled, copies into dedicated `CODEX_HOME`
  and validates before writing the GitHub secret
- deleted local dedicated session plus existing remote secret produces clear
  local reconnect guidance
- setup -> GitHub secret -> workflow bootstrap preserves canonical auth bytes
  exactly and matches generation hash
- very large PR with paginated file list produces explicit scope-limited review
  instead of pretending complete coverage
- binary/generated/vendored/symlink/submodule/LFS/rename/delete fixtures produce
  deterministic skip or review behavior with safe scope metadata
- malicious command emits huge, binary, invalid-UTF8, ANSI/control-character,
  and workflow-command-shaped output without reaching logs/artifacts/comments
- trailing newline, CRLF, multiline, and shell-metacharacter auth fixtures do
  not leak and either canonicalize or fail before storage
- installer crash after GitHub secret write before setup completion enters
  `seeded_unconfirmed` and rerun completes
- repeated installer run updates same workflow setup PR without duplicate blocks
- setup PR merged but no trusted default-branch run yet remains
  `workflow_pending_verification` and cannot restore the rotating OAuth secret
- setup PR open state displays `setup_pr_open` and never claims auto-refresh is
  active from secret existence alone
- first trusted default-branch run advances workflow verification only after
  matching schema marker, template digest, workflow path, release channel,
  provider auth mode, secret name, runtime protocol, and action/reusable
  workflow SHA are attested
- no-secret OIDC diagnostic run captures direct workflow, exact-SHA reusable
  workflow, tag-based reusable workflow, PR, merge queue, and
  `workflow_dispatch` claim capability fixtures without storing raw JWTs
- protocol v1 runtime-config session cannot acquire a rotating OAuth lease, and
  protocol v2 secret-bearing session cannot call legacy memory or
  conflict-posting endpoints
- custom OIDC subject template absent/compatible/incompatible/drift scenarios
  map to hardening diagnostic, allowed, blocked, or repair-required states
- JWKS key rotation, unknown `kid`, wrong audience, mixed audience array,
  replayed `jti`, and replay-store outage all fail before secret restore
- manual edit to `.github/workflows/reviewrouter.yml` after setup produces
  `workflow_drift_detected`, blocks secret restore, and opens or recommends a
  repair setup PR
- wrong workflow schema/auth mode/secret name produces
  `workflow_schema_mismatch`, not `needs_reconnect`
- old action/proxy protocol produces `rotating_protocol_unsupported`, and SaaS
  emergency block produces `control_plane_version_unsupported`
- workflow repair PR merge returns to `workflow_pending_verification` until
  trusted no-secret runtime attestation succeeds
- PR modifies `.github/workflows/reviewrouter.yml` but the run still trusts
  only the default-branch workflow identity and reviews the PR workflow change
  as sanitized source text
- exact-pin and moving-`v1` release-channel repos prove different
  template-digest and SHA attestation behavior according to compatibility
  policy
- reusable workflow caller with wrong or missing `job_workflow_sha` blocks
  secret restore before proxy bootstrap
- rollback setup PR changes workflow schema/digest to an inert state and leaves
  secrets present but unused
- copied setup command from repo A to repo B fails before auth read
- non-interactive setup without a dashboard-issued setup intent cannot infer
  target from git remote or `gh repo view`
- interactive setup with detected repo mismatch requires explicit target
  confirmation and records safe mismatch reason only
- duplicate setup completion with matching generation is idempotent; duplicate
  completion with different generation or secret metadata is rejected
- migration smoke keeps an existing `codex_subscription_oauth` repository on
  static/manual refresh while a new repository in the same workspace uses
  rotating OAuth without shared state
- concurrent lease requests for the same provider and same account-session
  group produce one owner and deterministic skipped/retryable states for the
  rest
- SaaS DB timeout after durable writeback intent but before GitHub PUT can be
  retried without duplicate generation advancement
- ambiguous existing workflow merge produces explicit setup PR conflict guidance
- same-repo PR review
- same-named environment secret blocks secret-backed mode
- maintenance schedule delayed/dropped simulation surfaces stale-health state
- maintenance refresh quota/rate-limit suppresses future maintenance without
  reconnect guidance
- compatibility emergency block prevents secret restore before proxy start
- org Actions disabled / action allowlist / reusable workflow policy blockers
  produce `policy_blocked`
- App permission upgrade pending owner approval and selected-repo missing cases
  produce `permission_required` with owner/admin handoff
- account/workspace entitlement removed or changed produces `account_required`
  with reconnect guidance
- reconnect with different account hash requires explicit account replacement
  confirmation and is blocked during active lease
- plan downgrade/rate-limit loss maps to `quota_limited` when auth remains
  valid
- interaction/discussion path is disabled or legacy-static only when PR review
  auto-refresh is active
- conflict-review and `repository_dispatch` paths cannot consume the rotating
  OAuth secret
- memory-enabled review runs do not store or transmit auth, raw diff, raw
  prompt, raw model output, proxy URL, nonce, HMAC material, or helper tokens
- advisory/required/strict check modes produce expected merge-blocking behavior
- workflow-level skip does not leave required ReviewRouter check pending
- merge queue run reports required final policy check
- force-push after review artifact creation causes comment posting to skip
  stale inline findings
- re-run of the same head/artifact updates or skips existing ReviewRouter
  comments without duplicate summary or inline comments
- inline comment line-placement 422 downgrades to summary or skip without
  guessing a new line
- GitHub secondary rate limit during comment posting maps to
  `posting_rate_limited` without reconnect guidance
- fork PR skip
- strict same-repo actor policy skip
- workflow_dispatch with arbitrary ref is rejected before secret restore
- workflow_dispatch resolved PR/head SHA is bound into action session metadata
- forced stale refresh
- two simultaneous PRs
- two repositories using dedicated sessions from the same ChatGPT account
- two refresh-needed repositories with the same account hash serialize, skip,
  or prove independent success according to the account-session isolation
  policy
- account-session isolation status resets to `unknown` after Codex CLI/auth
  shape/account type changes and blocks unsafe independent refresh until
  revalidated
- manual local reseed while a lease is active
- workflow cancellation before proxy
- workflow cancellation after refresh started
- workflow cancellation during upstream stream before refresh
- upstream stream disconnect after first event
- upstream model request disconnect before body write
- upstream model request disconnect after body write
- GitHub App permission missing
- GitHub App `Secrets: read` helper token unavailable
- existing installation with current read-only secrets profile maps to
  `permission_required` and continues legacy static behavior
- App permission upgrade accepted by owner/admin enables rotating lease only
  after selected-repository membership and actual granted permissions are
  reverified
- App permission accepted but not yet synced or lease-preflight verified remains
  `app_permission_accepted_unverified` and cannot restore the secret
- selected-repository installation with the target repo removed blocks before
  public-key fetch, secret restore, and writeback
- token request without explicit `repository_ids` or explicit `permissions`
  fails in the adapter and never reaches GitHub
- token response with broader, narrower, or missing permission/repository scope
  blocks lease activation and increments permission-epoch diagnostics
- permission removed after refresh starts maps to `unknown_auth_state` or
  `reconcile_required` according to whether GitHub PUT proof exists
- optional separate writeback App path, if implemented, rejects mixed App ids
  and mixed installation ids for one rotating provider
- old and new GitHub App installation token formats both work because tokens
  are treated as opaque bearer strings
- installation-token minting with omitted `repository_ids`, omitted
  `permissions`, wrong purpose, unapproved caller, or overbroad GitHub response
  maps to `writeback_authority_paused`
- rotating OAuth E2E with poisoned Octokit/App auth cache cannot reuse a
  comment/setup/dashboard/repo-health token for public-key read or secret
  writeback
- support/admin/webhook/dashboard paths attempting to mint `Secrets: write`
  tokens are rejected and audited without returning token material
- GitHub App signer/KMS emergency pause blocks helper-token minting and
  writeback before refresh, without deleting customer secrets
- near-limit and above-limit `auth.json` fixtures prove safe raw and encrypted
  size handling without plaintext reaching SaaS
- Codex CLI `0.125.0` and candidate latest/staged version fixtures run through
  the same compatibility suite before any version is allowlisted
- Codex CLI package/version/help/config/JSONL/network drift blocks secret
  restore before proxy start
- GitHub public key rotation or stale key retry
- public key supplied by SaaS, wrong repository public key, wrong `key_id`,
  wrong public-key hash, and wrong GitHub API host each block before encryption
  or writeback
- GitHub PUT create/update success proves generation only for `201`/`204`;
  unexpected status, lost response, crash after PUT, and metadata-only
  verification produce `reconcile_required` or retryable states as documented
- stale `encrypted_value` replay after a newer confirmed generation is rejected
  before GitHub PUT and maps to `security_invariant_failed`
- encrypted retry queue expiry before retry purges the payload and blocks
  ciphertext replay without changing latest confirmed generation
- KMS outage/decrypt failure for the retry queue does not expose ciphertext and
  maps to the documented pre-refresh or post-refresh state
- ciphertext leak incident drill purges retry payloads, blocks stale
  idempotency keys, and does not force reconnect unless plaintext or current
  auth state is affected
- support export, audit bundle, and DB debug snapshot attempts to include raw
  `encrypted_value` fail sentinel tests
- legacy provider setup manual confirmation and GitHub secret metadata
  verification cannot mark rotating OAuth active
- secret deleted manually while lease is active
- secret edited manually in GitHub outside setup/writeback
- queued run with stale secret generation
- repository renamed after setup
- repository transferred or App installation removed
- duplicate GitHub App webhook redelivery with same delivery id and payload
  hash creates no duplicate sync or provider transition
- duplicate GitHub App webhook delivery id with a different payload hash is
  rejected as suspicious and cannot mutate provider state
- out-of-order webhook sequence where `deleted`/repo-removed/public arrives
  before stale `created`/repo-added/permission-accepted remains blocked until
  GitHub API source-of-truth reconciliation proves current access
- webhook route invalid signature, missing signature, body mutation after
  signing, malformed JSON, oversized payload, and unsupported event all avoid
  raw payload persistence and unsafe provider mutation
- webhook worker dead-letter and delivery backlog surface stale sync state while
  lease preflight continues to block unsafe secret restore
- secret-backed run with `ACTIONS_STEP_DEBUG`, `ACTIONS_RUNNER_DEBUG`,
  `runner.debug`, shell xtrace, or verbose package-manager flags blocks before
  auth restore or passes the internal sentinel-only canary path
- debug rerun produces downloadable runner diagnostic logs, step logs, and log
  archive; sentinel auth/token/proxy/HMAC values are absent
- job summaries and annotations created before and after the review step contain
  only safe bounded copy and no model-controlled Markdown, links, images,
  workflow commands, or token-looking values
- artifact upload with default name, duplicate name, missing `retention-days`,
  broad path, symlink, hidden file, binary blob, digest mismatch, or path
  traversal is rejected before comment posting
- comment job attempts `download-artifact` without exact artifact name or tries
  to download all artifacts and is rejected by workflow scanner/tests
- reusable workflow caller uses `secrets: inherit` and is blocked before auth
  restore
- reusable workflow caller omits explicit `permissions` or required
  `id-token: write` and is blocked as policy/config, not Codex auth failure
- malicious env-dump review in a job with `id-token: write` cannot see OIDC
  request env, `GITHUB_TOKEN`, file-command paths, cache/artifact service
  tokens, package registry tokens, or ReviewRouter helper/writeback/HMAC
  material
- reusable workflow called job defines `environment:` with same-named secret and
  is blocked before repository secret restore
- reusable workflow exact SHA succeeds only when `workflow_ref`,
  `workflow_sha`, `job_workflow_ref`, `job_workflow_sha`, template digest, and
  compatibility registry agree
- reusable workflow release tag succeeds only after resolved called workflow SHA
  is allowlisted; branch ref such as `main` is blocked for production
- nested reusable workflow chain attempts to forward
  `REVIEWROUTER_CODEX_AUTH_JSON` and is blocked unless a later explicit
  multi-hop contract is approved
- workflow file modified in same PR
- `.gitmodules` and Git LFS pointer abuse do not trigger submodule/LFS network
  fetches in the secret-backed job
- malicious repository with symlinks, hardlinks, nested git directories,
  `.npmrc`, package hooks, fake workflow commands, oversized generated files,
  and binary files builds a sanitized read-only snapshot without leaking
  control/proxy/auth material
- raw checkout, sanitized review root, control root, Codex home, and artifact
  staging stay disjoint throughout the run, and broad artifact/cache globs are
  rejected before secret restore
- `workflow_run` attempt blocked
- re-run of originally untrusted fork/Dependabot context blocked
- OIDC fixture matrix covers direct workflow, reusable workflow, strict
  reusable SHA pin, tag-based approved channel, missing `repository_visibility`,
  public repository, self-hosted runner, unexpected environment claim, missing
  `jti`, missing `job_workflow_ref`, and changed claim shape
- `workflow_dispatch` with PR number resolves exact base/head SHA and stores
  an `OidcTrustSnapshotV1`; arbitrary branch, tag, SHA, or unresolved PR input
  is rejected before checkout and secret restore
- maintainer re-run of a blocked same-repo actor and maintainer re-run of an
  originally untrusted fork/Dependabot event both remain blocked, while a clean
  trusted same-repo re-run keeps the same original trust snapshot and
  idempotency keys
- same ChatGPT account with multiple repos, account-level fallback if needed
- GitHub concurrency pending cancellation does not corrupt auth state
- action/cache poisoning attempt
- post-action/`GITHUB_STATE` secret persistence attempt
- package lifecycle script execution attempt after secret restore
- temp-file cleanup failure and hard-kill before cleanup
- artifact poisoning attempt
- step output or summary leakage attempt
- workflow command injection attempt with `::warning::`, `::add-mask::`, and
  `::set-output` shaped text
- malicious review output attempts raw HTML, images, external links, mentions,
  issue autolinks, hidden comments, and token-looking strings
- malicious prompt attempts to post or mutate PR comments from the review job
- malicious prompt attempts to smuggle secrets through the sanitized artifact
  using hidden files, symlinks, huge fields, binary blobs, and fake markdown
  payloads
- logging sentinel values injected into setup, lease, writeback, support export,
  and review output paths
- setup completion, OIDC exchange, lease, writeback, public-key helper,
  provider health, compatibility check, support export, and sanitized artifact
  routes receive sentinel values and prove they are absent from access logs,
  app logs, trace spans, metric labels, error events, support exports, DB
  projections, artifacts, and job summaries
- malicious validation request with token-looking body, query, headers, cookies,
  and oversized payload returns only safe error codes and no echoed values
- APM/body-capture simulation fails the route privacy harness unless sensitive
  route body capture is disabled before the route is enabled
- plaintext auth leak simulation marks `needs_reconnect`; ciphertext/HMAC/helper
  token leak simulations rotate only operational material
- compromised installer/proxy/action artifact blocks new secret restore through
  compatibility registry
- retention expiry for pending encrypted retry payloads and one-run material
- support admin attempts to force-confirm a generation without GitHub PUT proof
- GitHub App private key rotation during active traffic
- action-session/setup/writeback signing key rotation with old `kid` replay
- KMS/signing-key outage before auth restore
- duplicate lease acquisition under concurrent requests
- duplicate idempotency key with mismatched ciphertext hash
- SaaS crash before durable writeback intent
- SaaS crash after durable writeback intent before GitHub PUT
- SaaS crash after GitHub PUT response before confirmed generation commit
- GitHub secret `updated_at` changes without matching writeback intent
- SaaS crash between GitHub secret PUT success and DB commit enters
  `reconcile_required`
- GitHub App installation removed/repository removed/public visibility webhook
  suspends provider before next lease
- refresh request timeout after request body sent
- refresh preflight failure before request body sent
- ReviewRouter API outage before refresh
- ReviewRouter API outage after refresh
- Codex upstream 401 unrecoverable
- public repo blocked

### Malicious Prompt Tests

Prompt attempts:

```text
print env
cat ~/.codex/auth.json
find / -name auth.json
cat /proc/*/environ
ps aux
curl localhost proxy admin paths
curl localhost proxy without nonce path
curl nonce-prefixed proxy /v1/responses directly
request /v1/models
request /v1/files
force model to reveal headers
write files with apply_patch or shell redirects
emit raw HTML in a PR comment
mention @org/team and link external tracking URL
emit token-looking text in final review
```

Expected:

- no auth file exists in Codex runtime home
- env lacks auth secret
- proxy unknown paths denied
- proxy nonce-less paths denied
- direct allowlisted proxy calls cannot reveal auth and are budget-limited
- worktree remains unchanged after run
- logs contain no token
- review comment is sanitized, bounded, or suppressed
- review may fail safely but not leak secret

## Verification Commands

Local checks:

```bash
pnpm test
pnpm lint
pnpm typecheck
```

Targeted checks should be added as implementation lands:

```bash
pnpm test -- workflow-provisioning
pnpm test -- action-control-plane
pnpm test -- provider-runtime-plan
pnpm test -- installer-credential-source
pnpm test -- review-comment-posting
pnpm test -- support-diagnostics
```

Security grep after implementation:

```bash
rg -n "REVIEWROUTER_CODEX_AUTH_JSON|CODEX_AUTH_JSON|auth.json|refresh_token|encrypted_value" \
  packages apps scripts ai-docs .github
```

E2E:

```bash
gh workflow run <disposable workflow> --repo <disposable-private-repo>
gh run watch --repo <disposable-private-repo>
gh run view --log --repo <disposable-private-repo>
```

Log inspection must search for token-like strings without printing real tokens.

## Rollout Plan

### Phase 0: Internal Spikes

- custom provider proof
- OAuth proxy proof
- encrypted writeback proof
- cancellation proof
- public-key capability proof
- event and workflow trust proof
- queued secret staleness proof
- shell-to-proxy abuse proof
- supply-chain/cache/output boundary proof
- ambiguous refresh outcome proof
- streaming and model retry proof
- OIDC re-run and reconciliation proof
- external drift and webhook proof
- installer zero-plaintext and workflow provisioning proof
- environment, maintenance, budget, and drift kill-switch proof
- required check and merge queue proof
- org policy, permission upgrade, and incident response proof
- Codex account/workspace lifecycle proof
- account authorization, quota ownership, and workspace-policy consent proof
- GitHub secret materialization and masking proof
- GitHub public-key provenance and writeback confirmation proof
- GitHub App permission epoch and installation approval proof
- GitHub webhook inbox, ordering, and reconciliation proof
- GitHub Actions debug, summary, log-archive, and artifact channel proof
- reusable workflow secret contract and caller/callee proof
- GitHub runner implicit credential and child env firewall proof
- SaaS writeback authority and installation-token issuer boundary proof
- product feature interaction proof
- PR actor/ref and checkout trust proof
- action lifecycle, package script, and cleanup proof
- pre-model secret redaction and disclosure proof
- result freshness and comment idempotency proof
- local credential source resolver proof

No customer-facing release.

### Phase 1: Feature Flag

Add feature flag:

```text
REVIEW_ROUTER_CODEX_OAUTH_REFRESH_MODE=github_hosted_proxy
```

Enable only for internal disposable repos.

### Phase 2: Private Beta

Enable per repository from dashboard for selected users.

Requirements:

- GitHub App permission update accepted
- repo is private
- repo secret mode only
- workflow schema version supports lease and proxy
- reconnect UX present
- CLI compatibility contract tests green for the pinned Codex version
- safe telemetry and redaction tests green
- stale queued secret behavior verified in disposable repo
- direct shell-to-proxy behavior is either blocked or budget-limited without
  leaking credentials
- ambiguous refresh tests prove no unsafe retry after possible rotation
- streaming/retry tests prove no accepted model request is replayed silently
- OIDC custom-audience/re-run tests and reconciliation drill pass
- OIDC v2 claim capability fixtures, subject-template diagnostics, JWKS/audience
  failure handling, and protocol-v1 separation tests pass
- public-key provenance, sealed-box envelope validation, GitHub PUT proof, and
  metadata-only confirmation rejection tests pass
- App permission epoch, owner approval, selected-repository membership, and
  explicit installation-token scope tests pass
- webhook inbox, delivery dedupe, out-of-order projection, dead-letter, and
  source-of-truth reconciliation tests pass
- debug logging, runner diagnostic logs, job summaries, annotations,
  output/env/state files, artifacts, and log-archive canary tests pass
- reusable workflow explicit-secret mapping, caller permissions,
  `job_workflow_ref`/`job_workflow_sha`, environment shadowing, nested
  workflow, and moving-ref tests pass
- external secret drift and GitHub App webhook suspension tests pass
- installer zero-plaintext tests and workflow setup PR idempotency pass
- workflow provenance, template digest, default-ref runtime attestation, and
  repair PR drift tests pass
- no-environment-secret policy, quota classification, maintenance stale-health,
  and compatibility emergency-block tests pass
- advisory/required/strict final-check semantics and merge-queue tests pass
- org policy preflight, App permission handoff, and incident response drill pass
- account/workspace fingerprint, `account_required`, account replacement, and
  Enterprise access-token provider-separation tests pass
- account-auth CI consent, `account_authorization_required`, quota-ownership,
  and feature-scope reauthorization tests pass
- exact auth-byte materialization and masking tests pass
- interaction, conflict-review, reusable-workflow, and memory paths have tested
  allow/deny behavior for this provider mode
- PR actor/ref trust, manual dispatch resolution, and checkout hardening tests
  pass
- post-action, `$GITHUB_STATE`, package lifecycle, and cleanup-failure tests
  pass
- control-plane key rotation, signing-key `kid`, KMS outage, DB uniqueness, and
  idempotency invariant tests pass
- review input scope, large diff handling, path normalization, and process
  output backpressure tests pass
- pre-model secret redaction, safe disclosure copy, and GitHub secret scanning
  metadata enrichment tests pass
- result freshness, stale-artifact skip, comment dedupe, and posting
  backpressure tests pass
- local credential source resolver tests pass for fresh dedicated login,
  same-repo dedicated reuse, keyring-only global state, explicit global import,
  app/IDE state rejection, deleted local session, and corporate CA login

### Phase 3: Default for New Codex OAuth Setups

New Codex subscription setup defaults to:

```text
github_hosted_proxy
```

Legacy static `CODEX_AUTH_JSON` remains supported but marked:

```text
Manual refresh required
```

### Phase 4: Legacy Deprecation

After stable adoption:

- warn when static OAuth secret is older than threshold
- offer one-click setup PR plus local command
- keep self-hosted runner docs as advanced path
- do not automatically delete old secrets

## Rollback Plan

Rollback levers:

- disable feature flag globally
- disable per-repo provider mode
- leave `REVIEWROUTER_CODEX_AUTH_JSON` unused
- restore legacy `CODEX_AUTH_JSON` static mode if present
- tell user to rerun local setup if auth entered unknown state
- revert GitHub App permission copy later only after no repos use writeback

Rollback must not:

- delete user secrets automatically
- attempt to decrypt secrets
- overwrite legacy `CODEX_AUTH_JSON`
- keep retrying a known bad refresh token

## Open Questions

Must answer during spikes:

1. Does the current pinned Codex CLI make only `/responses` calls with static
   `model_catalog_json` in the ReviewRouter review path?
2. Is `/responses/compact` required for long reviews, and does custom provider
   fallback avoid remote compaction reliably?
3. Which exact ChatGPT Codex upstream headers are required for all supported
   account types?
4. Can we reuse Codex refresh logic directly as a library or should the proxy
   carry a small independent implementation?
5. Can the helper GitHub App token be scoped to exactly `Secrets: read` for
   public-key fetch while the SaaS write token remains server-only?
6. What is the safest Linux hardening strategy for GitHub-hosted runners when
   combining proxy and Codex CLI?
7. How should we handle teams that insist on org-level secrets?
8. Do multiple dedicated per-repo Codex logins under the same ChatGPT account
   produce independent refresh token streams, or do they invalidate each other
   under some account/workspace policies?
9. Does the selected Codex CLI version support every hardening flag in the
   generated invocation, especially history, feedback, plugins, apps,
   tool-suggest, and web-search settings?
10. Does Codex preserve path prefixes in custom provider `base_url` for every
    request, so nonce-in-path enforcement works reliably?
11. How often should ReviewRouter run an optional scheduled maintenance refresh
    for low-activity repositories, balancing reliability against user quota?
12. Can the pinned Codex sandbox reliably block shell network access to
    localhost proxy while still allowing Codex's own model provider HTTP
    traffic?
13. What is the exact release/signature/checksum mechanism for the installer,
    proxy package, and pinned Codex CLI package?
14. If OpenAI changes ChatGPT Codex backend auth shape, what automated signal
    disables this mode before users hit repeated reconnect loops?
15. What minimum lease TTL and safety margin prevent refresh from starting too
    close to job cancellation or lease expiry?
16. Does the pinned Codex CLI use SSE streaming, and what exact event sequence
    proves response creation before proxy retry decisions?
17. Does the ChatGPT Codex upstream provide any idempotency key or response
    recovery contract for accepted `/responses` requests? If not, proxy replay
    after request-body write remains blocked.
18. Which OIDC `sub` shape and custom audience should be treated as the stable
    ReviewRouter trust contract across direct and reusable workflows?
19. What reconciler signal is strong enough to resolve GitHub PUT succeeded /
    SaaS DB commit unknown without plaintext auth?
20. How aggressively should external secret metadata drift pause the provider
    if GitHub's `updated_at` precision or delayed metadata propagation causes
    ambiguous comparisons?
21. Which customers need SaaS-side comment posting instead of the preferred
    two-job runner posting, and what retention/visibility settings should apply
    to their sanitized artifacts?
22. Which production APM/logging vendors and middleware are enabled in
    ReviewRouter today, and how do we prove route-level body capture is disabled
    in production and staging?
23. Which safe account/workspace fields are stable enough to fingerprint across
    Codex versions without storing raw account ids or user emails?
24. How should Business/Enterprise customers choose between this OAuth
    `auth.json` mode and a separate Codex access-token provider when admins
    allow access tokens?
25. Does GitHub preserve compact canonical auth JSON byte-for-byte from
    `gh secret set` through workflow materialization into proxy stdin for all
    token shapes we support?
26. Which existing ReviewRouter side paths must be disabled for auto-refresh
    v1: interaction replies, conflict review, memory, or reusable workflows?
27. Should strict enterprise installs pin reusable workflows by immutable commit
    SHA instead of release tag for this secret-backed mode?
28. Should old-head ReviewRouter comments be left untouched, marked superseded,
    or collapsed in a single summary comment for each repository policy?
29. What exact GitHub secondary rate-limit signals should stop comment posting
    immediately instead of retrying and risking noisy PR spam?
30. Should advanced global `~/.codex/auth.json` import ship at all, or should
    v1 require only fresh dedicated login to avoid shared refresh-token streams?
31. Which local platforms need first-class credential-source UX: macOS desktop,
    Linux desktop, headless SSH, GitHub Codespaces, WSL, and corporate TLS
    environments?
32. Should the exact new auth mode name be
    `codex_chatgpt_oauth_rotating`, `codex_subscription_oauth_rotating`, or
    another user-neutral internal name?
33. How many existing repositories use `codex_subscription_oauth` with
    organization-level `CODEX_AUTH_JSON`, and what migration copy keeps those
    users on manual refresh until they opt into rotating mode?
34. Should the old static auth mode later be renamed in UI only, or kept as
    `codex_subscription_oauth` internally forever for config compatibility?
35. Which bootstrap verification level should be required before public launch:
    dashboard digest only, GitHub release attestation verification, or an
    offline signing-key workflow for enterprise customers?
36. Can the pinned Codex CLI preserve all required custom provider behavior
    without exposing enough request variance that the Responses firewall blocks
    legitimate review traffic?
37. Is a single-process proxy with no HTTP control-plane sufficient after Spike
    AG, or do high-security customers require a separate auth broker process?
38. What exact action runtime protocol version number should ship for rotating
    OAuth, and should it be global `protocolVersion: 2` or a provider-scoped
    capability such as `codexOauthProtocolVersion: 1`?
39. How long should protocol v1 static fallback remain supported after rotating
    OAuth becomes the default for new Codex subscription setups?
40. What soak duration and success thresholds are required before rotating OAuth
    setup PRs may default from exact pins to moving `v1`?
41. Should strict enterprise workspaces permanently require exact pins/full SHAs
    for rotating OAuth, even after `v1` is approved for normal workspaces?
42. Should the first production review mode always run Codex from a sanitized
    read-only snapshot, or can trusted same-repo PRs ever use raw checkout as
    the Codex cwd?
43. Should `.github/workflows/**` be included in review input as normal files
    while still being forbidden as trusted workflow source for the run?
44. What conservative raw `auth.json` byte limit should production enforce
    below GitHub's 48 KB Actions secret limit: 16 KB, 24 KB, or 32 KB?
45. Should rotating OAuth upgrade the standard GitHub App profile to
    `Secrets: write`, or introduce a separate high-trust App/profile for
    customers who opt into encrypted writeback?
46. If account-session isolation is unknown, should production default to
    account-level serialization or one-active-repo blocking for the same safe
    account hash?
47. Should the first production channel stay on Codex CLI `0.125.0` until the
    full rotating OAuth harness passes on `0.133.0`, or should `0.133.0` become
    the first candidate after Spike AL?
48. Should workflow template digest be strict byte-level canonical generated
    YAML, AST-canonical YAML, or a signed template manifest with per-section
    hashes for future user customization?
49. Should rotating OAuth require an organization/repository OIDC subject
    template that includes `repository_id` and `job_workflow_ref`, or keep it
    as hardening because personal repos and non-admin users may not be able to
    configure it?
50. Can the GitHub-hosted runner fetch the repository Actions public key
    directly with a helper capability that cannot write secrets, and can the
    local setup path avoid trusting SaaS-provided public keys entirely?

Initial answers:

- org multi-repo rotating mode should be blocked
- public repos should be blocked
- self-hosted persistent runner remains fallback
- API key remains separate provider path
- stale queued runs should skip and rerun, not attempt refresh
- mutable installer/proxy/Codex artifacts should block production rollout
- refresh preflight failures should be retryable; ambiguous refresh outcomes
  should pause automation
- model request failures after upstream acceptance should fail review, not
  replay silently
- OIDC re-runs inherit original event trust, so maintainer re-run is not enough
  to trust a fork/Dependabot/public event
- rotating OAuth should use a separate claim contract and
  `OidcTrustSnapshotV1`; direct workflow and reusable workflow trust must bind
  repository id, visibility, workflow identity, reusable workflow identity,
  runner environment, run attempt, event, actor id when present, and replay id
- SaaS writeback split-brain should pause as `reconcile_required`, not continue
  refreshing
- external GitHub secret edits should pause as `external_secret_drift`; only a
  local setup validation can make the new value trusted
- environment secrets for Codex OAuth are blocked in v1 because they override
  repository secrets and have different read timing
- maintenance refresh is optional best-effort, not a guarantee
- quota/rate-limit states should not be presented as login/session loss
- compatibility drift should emergency-block secret restore before unsafe
  versions run with auth
- account/workspace lifecycle failures should map to `account_required`, not
  generic reconnect, quota, GitHub policy, or external drift
- Enterprise Codex access-token automation should remain a separate provider
  mode from Plus/Pro OAuth `auth.json` auto-refresh
- compact canonical JSON is the v1 secret format; base64/enveloped formats need
  a separate auth-shape version
- interaction/discussion and conflict-review paths should be blocked or left on
  legacy static behavior until their own auto-refresh safety design exists
- comment posting must re-check PR head SHA and skip stale inline comments;
  required-check freshness alone is not enough because PR comments are timeline
  artifacts
- local setup should create or reuse only a dedicated file-backed
  ReviewRouter `CODEX_HOME`; keyrings, app/IDE stores, browser cookies, and
  arbitrary account files are not credential sources for v1
- rotating Codex OAuth should be a separate auth mode under the existing
  `codex` provider; legacy `codex_subscription_oauth` remains static/manual
  until an explicit migration is selected
- rotating setup needs a signed setup intent and idempotent completion state
  machine; legacy `/install/codex` and static `CODEX_AUTH_JSON` confirmation
  are not a safe production setup protocol for auto-refresh
- rotating auth state needs additive ledger tables with transactional CAS;
  `ProviderSetupState` and action health reports stay coarse status surfaces,
  not the canonical auth ledger
- dashboard-provided installer digest is necessary but not an independent root
  of trust when the same ReviewRouter control plane serves the command and the
  digest; high-security users need a GitHub release/attestation verification
  path
- the proxy URL/nonce must be treated as visible to prompts and tools; the
  boundary is no control-plane HTTP surface plus strict Responses firewall and
  budgets, not secrecy of the nonce
- rotating OAuth should use a new runtime protocol handshake and forbid static
  runtime config fallback; protocol v1 remains legacy static/manual only
- first public rotating OAuth releases should default to exact pins/full SHAs;
  moving `v1` is a later promotion after canary metrics and rollback drills
- rotating setup PR merge is not enough to mark a provider configured; the
  first trusted default-branch run must prove workflow schema, template digest,
  runtime protocol, release channel, provider mode, secret name, and action or
  reusable workflow SHA before secret restore
- protocol v1 OIDC sessions remain metadata-only; rotating OAuth uses a
  separate OIDC v2 session audience, validator, claim capability registry, and
  replay requirement before any lease/writeback endpoint is reachable
- custom OIDC subject templates are recommended hardening but not a universal
  v1 requirement; the standard claims must still be strict enough to prove
  repo id, visibility, workflow identity, runner type, run identity, replay id,
  and reusable workflow SHA where applicable
- public-key provenance is part of the no-plaintext boundary: runner-side
  encryption must use a GitHub-fetched repository public key, not a key supplied
  by ReviewRouter SaaS, and generation confirmation requires GitHub PUT proof,
  not secret metadata or dashboard manual confirmation
- first production mode should run Codex from a sanitized read-only review
  snapshot, not the raw checkout root
- `.github/workflows/**` can be reviewable source text, but the running
  workflow schema must come from a trusted branch/ref and never from PR changes
- start with a conservative 24 KB raw canonical auth JSON limit until the real
  GitHub public-key/encrypted-value spike proves a larger safe envelope
- rotating OAuth should upgrade the existing App only with clear permission UX;
  a separate App can be reconsidered if enterprise customers reject broader
  default App permissions
- before multi-repo isolation is proven, default to account-level serialization
  for private beta and first production; use one-active-repo blocking only as
  an emergency compatibility fallback
- do not upgrade the production rotating workflow from Codex CLI `0.125.0` to
  `0.133.0` solely because npm `latest` changed; make `0.133.0` the next
  candidate only after Spike AL passes

## Acceptance Criteria

The production feature is ready only when all are true:

- User can run one local setup command and no VPS is required.
- GitHub-hosted private repo PR review succeeds with Codex subscription auth.
- First release runs this mode only on GitHub-hosted Linux.
- A stale session refreshes automatically.
- The updated auth state is available to the next run.
- ReviewRouter SaaS never receives plaintext auth.
- Local setup uses an expiring repo/provider-scoped setup session token.
- Setup intent binds repo id, provider instance, secret name, installer digest,
  release channel, workflow schema, and one-time challenge before auth read.
- Copied, stale, replayed, mismatched, or non-interactive inferred setup
  commands fail before local Codex auth is read.
- Installer has an enforced zero-plaintext network contract after reading
  `auth.json`; setup completion sends safe metadata only.
- Installer credential-source resolver creates or reuses only a dedicated
  file-backed ReviewRouter `CODEX_HOME` by default; keyrings, app/IDE state,
  browser cookies, global auth files, and account/app-server files are not
  silently imported.
- Dashboard setup command uses pinned installer artifacts and checksum/signature
  verification where practical.
- Rotating setup does not use mutable `/install/codex` -> raw `main`,
  floating npm tags, or PR-produced artifacts; production installer commands
  bind version, digest, release channel, repo target, and setup session.
- Advanced installer verification path can validate GitHub release artifact or
  attestation metadata where available, and fails closed before auth is read.
- Workflow provisioning defaults to a local-`gh` setup PR, not silent SaaS
  workflow mutation, and repeated installer runs are idempotent.
- Workflow setup PR merge is followed by default-ref runtime attestation; the
  provider cannot become active from setup PR status, action ref markers, or
  GitHub `updated_at` alone.
- Workflow drift, manual edits, wrong reusable workflow SHA, missing template
  digest, wrong secret name, and wrong provider auth mode block secret restore
  with repair guidance instead of reconnect guidance.
- Repository/organization policy preflight classifies Actions disabled,
  allowed-actions, selected-repository App access, and App permission upgrade
  blockers without PAT workarounds.
- Current read-only GitHub App installations cannot run rotating OAuth until
  `Secrets: write` is approved and revalidated for the selected repository.
- GitHub App installation/helper tokens are treated as opaque variable-length
  bearer tokens; no fixed prefix, length, or old token format is part of any
  security check.
- `seeded_unconfirmed` is handled by idempotent local setup rerun without
  trusting GitHub `updated_at` alone.
- Initial generation hash is recorded only after GitHub secret write succeeds.
- Canonical auth bytes survive local setup, GitHub secret storage, workflow
  materialization, and proxy stdin without newline or encoding mutation.
- Codex runtime process cannot read `auth.json` because it is not present.
- Codex runtime runs from a sanitized read-only review snapshot, not raw
  checkout or `$GITHUB_WORKSPACE`.
- Trusted control root, raw checkout root, sanitized review root, artifact
  staging root, proxy temp root, and Codex home are separate paths and cannot
  be descendants of each other in unsafe directions.
- Sanitized review snapshot contains no `.git`, hooks, local git config,
  credential helpers, tokenized remotes, auth files, proxy temp files, helper
  tokens, OIDC tokens, HMAC material, or writeback state.
- Snapshot builder rejects or safely represents symlinks, hardlinks, nested git
  repositories, submodules, LFS pointers, traversal, absolute paths, NUL bytes,
  Windows drive prefixes, invalid encodings, binary files, and oversized files.
- Workflow does not contain a PAT or token with `Secrets: write`.
- Public-key read token, writeback session token, OIDC token, and GitHub tokens
  are not passed to `codex exec`.
- Runner encrypts only against a GitHub-fetched repository Actions public key;
  SaaS-supplied keys, wrong repo keys, wrong `key_id`, and key/secret metadata
  mismatches block before writeback.
- Latest rotating generation is confirmed only after durable writeback intent
  and GitHub secret PUT `201`/`204`; GitHub secret metadata or dashboard manual
  confirmation cannot mark rotating auth active.
- Encrypted writeback payloads cannot be replayed after a newer generation,
  drift, reseed, permission epoch change, workflow schema drift, or TTL expiry;
  raw ciphertext is retained only in an encrypted short-TTL retry queue.
- Raw `REVIEWROUTER_CODEX_AUTH_JSON` appears only in the proxy bootstrap step;
  job-level env contains only presence booleans.
- No non-allowlisted `uses:` action, hidden post action, `$GITHUB_STATE`
  transfer, or package lifecycle script can observe auth after secret restore.
- Control-plane key rotation and compromise handling is tested for GitHub App
  private keys, action-session signers, setup/writeback token signers, HMAC
  keys, and encrypted retry queue keys.
- Codex review job has no PR/issue write permission; PR comments are posted by
  a downstream comment job from a revalidated sanitized artifact, or by SaaS
  from sanitized artifacts only.
- Interaction/discussion and conflict-review paths are disabled, legacy-static,
  or separately redesigned before they can use auto-refresh OAuth.
- Memory runtime cannot receive auth, raw prompt, raw diff, raw model output,
  proxy URL, nonce, HMAC material, helper token, or writeback token.
- Final `reviewrouter-codex-policy` check has stable name, deterministic
  conclusion, and explicit advisory/required/strict policy semantics.
- Required-check setup does not leave PRs pending due to workflow-level skips,
  and merge-queue repos have tested `merge_group` behavior.
- OIDC uses a ReviewRouter custom audience and rejects wrong audience, wrong
  subject shape, and re-runs of originally untrusted events.
- Rotating OAuth records an `OidcTrustSnapshotV1` with normalized safe claim
  fields before secret restore and rejects public visibility, self-hosted
  runner environment, unexpected environment claims, unresolved manual refs,
  missing mandatory claims, and claim-drift fixtures.
- OIDC v2 is separate from protocol v1; legacy action sessions cannot reach
  rotating lease/writeback routes, and rotating secret-bearing sessions cannot
  be consumed by legacy runtime-config, memory, or conflict-posting routes by
  accident.
- OIDC claim capability diagnostics prove required GitHub-hosted claims for
  direct and reusable workflows before setup becomes active; missing required
  claims block as `oidc_claim_contract_unsupported`, not reconnect.
- A workflow queued before a newer secret writeback is detected by generation
  mismatch and does not attempt refresh.
- Refresh is attempted only after writeback readiness preflight passes.
- Ambiguous refresh outcomes enter `unknown_auth_state`; pre-refresh failures
  before request send enter `skipped_retryable`.
- Codex runs with repo config/rules ignored unless ReviewRouter injects a
  bounded sanitized instruction packet.
- Codex plugin/app/tool-suggest remote warmup is disabled or routed to a local
  deny sink.
- Codex hosted `web_search` is disabled for this mode unless ReviewRouter adds
  a separate explicit web-search design.
- Codex persistent history and feedback surfaces are disabled or proven absent
  in the pinned CLI.
- Codex custom provider sends no auth header and no `/models` request in the
  pinned invocation.
- Codex CLI version, package integrity, help snapshots, config keys, JSONL
  event schema, and network egress fixtures match an allowlisted compatibility
  tuple before `REVIEWROUTER_CODEX_AUTH_JSON` is materialized.
- Codex CLI is never installed from `latest`, alpha/beta/native dist-tags, or a
  version that has not passed Spike AL for the selected release channel.
- Streaming Responses traffic is proxied without raw body logging.
- Accepted model requests are not replayed silently after request body write or
  stream start.
- Raw model output is never posted directly to GitHub and is not retained.
- PR comments are generated from a validated structured artifact with bounded
  length, safe paths, valid diff lines, allowlisted Markdown, neutralized
  mentions/autolinks, and final redaction.
- PR comment posting re-fetches the current PR head SHA, refuses stale inline
  findings, deduplicates repeated re-runs with ReviewRouter-owned safe markers,
  and degrades GitHub line-placement/rate-limit failures without reconnect
  guidance.
- Codex custom provider preserves nonce path prefix and nonce-less requests are
  rejected.
- Codex tool-call loop works through the local proxy with read-only sandboxing.
- Direct shell calls to the proxy are either blocked by sandbox/network policy
  or constrained to a safe budget with no credential disclosure.
- Codex-visible proxy listener has no refresh, writeback, public-key, lease,
  health, metrics, status, shutdown, debug, admin, config, model-list, or file
  endpoints.
- Responses firewall rejects unsupported hosted tools, remote files, MCP,
  image/audio/realtime, unexpected include fields, attachments, model overrides,
  request smuggling, redirects, CORS preflight, and oversized JSON before
  upstream or control-plane work.
- Worktree remains unchanged after Codex runtime execution.
- No repo package scripts, dependency installs, cache restores/saves, or
  untrusted artifact downloads run after secret restore.
- Artifact/cache allowlists cannot include raw checkout, `$GITHUB_WORKSPACE`,
  `$RUNNER_TEMP`, control root, proxy temp dirs, Codex home, parent
  directories, or broad recursive globs.
- Secret-backed Codex review job does not use `environment:` and same-named
  environment secrets block v1 mode.
- Maintenance refresh is optional/best-effort, has jitter/backoff/stale-health
  reporting, and is not treated as a guarantee.
- Quota/rate-limit failures are classified as `quota_limited`,
  `skipped_retryable`, or `unknown_auth_state` according to refresh ambiguity,
  not as automatic reconnect.
- Account/workspace/entitlement failures are classified as `account_required`,
  not as GitHub policy, external secret drift, quota, or generic reconnect
  unless a separate permanent token failure is proven.
- Account and workspace identifiers are stored only as safe non-reversible
  fingerprints, never raw account ids, emails, workspace names, or token
  claims.
- Missing/stale account-auth CI consent is classified as
  `account_authorization_required`, not as broken Codex auth, and support/admin
  cannot force-clear it.
- Multi-repo rotating setup for the same safe account/workspace fingerprint is
  either proven isolated by Spike E, serialized by account-session group lease,
  or blocked; independent refresh races are never allowed by assumption.
- Reconnecting with a different account/workspace requires explicit account
  replacement confirmation and is blocked while a lease is active.
- Enterprise Codex access-token automation remains a separate provider mode
  from Plus/Pro OAuth `auth.json` auto-refresh.
- Compatibility registry can block unsafe installer/proxy/Codex/workflow
  versions before secrets are restored.
- GitHub concurrency does not use `cancel-in-progress: true` on the
  secret-backed refresh job.
- No secret-derived values are written to `$GITHUB_OUTPUT`, `$GITHUB_ENV`,
  `$GITHUB_STATE`, `$GITHUB_STEP_SUMMARY`, annotations, artifacts, cache, or
  job summaries.
- Untrusted output cannot execute GitHub workflow commands because
  `stop-commands` or equivalent containment is used.
- Installer, proxy package, and Codex CLI are pinned and integrity-checked.
- Server lease prevents concurrent refresh writers.
- Database constraints and transactional compare-and-set enforce single active
  leases, idempotent writeback, generation monotonicity, and repository/tenant
  isolation.
- Rotating auth persistence uses additive ledger tables and safe projections;
  legacy `ProviderSetupState` and static `CODEX_AUTH_JSON` rows remain readable
  and are never rewritten into auto-refresh state by migration/backfill.
- Review input collection is bounded and honest: large/truncated PRs, binary
  files, generated/vendor files, symlinks, submodules, LFS pointers, and path
  anomalies produce explicit scope metadata instead of silent full-review
  claims.
- Review input is scanned before model requests, and secret-looking values from
  PR diffs are replaced with stable non-reversible placeholders before they can
  reach Codex/OpenAI, ReviewRouter SaaS, logs, artifacts, comments, memory, or
  support exports.
- Dashboard/setup copy clearly states that bounded review input is sent from
  the customer runner to the customer's Codex/OpenAI account under their
  workspace policy, while ReviewRouter SaaS still does not receive raw diffs,
  raw prompts, raw model output, or Codex auth plaintext.
- GitHub secret scanning is treated only as optional metadata enrichment; the
  v1 safety boundary does not depend on repository secret scanning or push
  protection being enabled.
- Subprocess stdout/stderr and model/tool outputs are bounded, redacted, and
  backpressured before logs, artifacts, memory endpoints, comments, or SaaS
  ingestion.
- SaaS split-brain after GitHub secret write enters `reconcile_required` and
  blocks refresh until metadata-only reconciliation completes.
- External GitHub secret changes outside setup/writeback enter
  `external_secret_drift` and require local setup validation before refresh.
- GitHub App webhooks suspend providers on repository removal, installation
  removal, permission loss, and public visibility changes, with lease acquire
  revalidating the same state.
- If per-repo sessions under one ChatGPT account interfere, account-level
  serialization fallback is implemented or multi-repo auto-refresh is blocked.
- External manual reseed during a lease cannot be overwritten by a stale run.
- Duplicate writeback retries are idempotent.
- Secret deletion during a lease is treated as manual intervention, not as a
  reason to recreate the secret.
- Cancellation after refresh marks `unknown_auth_state`.
- Permanent refresh failures mark `needs_reconnect`.
- Fork PRs, Dependabot PRs, public repos, `pull_request_target`, and
  `workflow_run` trampoline flows do not run secret-backed OAuth mode.
- Logs, artifacts, health reports, support diagnostics, and audit events contain
  no secrets, tokens, raw prompts, raw diffs, or raw model output.
- Every auth-sensitive API route is declared in the sensitive-route registry
  with route privacy class, body policy, safe logging fields, trace attributes,
  metric labels, error policy, support-export policy, and sentinel tests.
- API gateway, framework, APM, tracing, error reporting, metrics, and support
  export paths cannot capture sensitive request/response bodies.
- Setup tokens, writeback tokens, HMAC runner material, helper tokens, and
  transient encrypted retry payloads have enforced TTLs and purge jobs.
- Incident response distinguishes plaintext auth exposure from ciphertext,
  HMAC, helper-token, telemetry-sentinel, and artifact compromise cases.
- Support/admin tooling cannot view auth, decrypt ciphertext, bypass trust
  checks, or confirm a generation without GitHub PUT success or reconciler
  proof.
- Auth JSON size stays safely under GitHub's 48 KB secret limit.
- Canonical raw auth bytes and encrypted `encrypted_value` bytes are measured
  separately, with a conservative raw budget and distinct
  `auth_secret_too_large` handling.
- Dashboard explains reconnect and permission-update states clearly.
- Legacy `CODEX_AUTH_JSON` users are not broken during rollout.
- Legacy static `codex_subscription_oauth` remains manual-refresh behavior and
  is never labelled auto-refresh by dashboard, repo health, policy editor, or
  support diagnostics.
- Rotating auto-refresh cannot be enabled unless the new provider auth mode,
  setup kind, workflow schema, runtime mode, and secret name all match.
- Rotating auto-refresh cannot be enabled through action runtime protocol v1,
  static runtime fallback, old action refs, or old workflow schemas.
- No-secret compatibility preflight passes before any rotating OAuth secret is
  materialized in a GitHub Actions step.
- First public rotating OAuth setup PRs use exact action/proxy/installer
  versions or full SHAs until promotion criteria allow moving `v1`.
- Emergency rollback can block exact bad versions before secret restore without
  deleting customer GitHub secrets or breaking legacy static `CODEX_AUTH_JSON`
  reviews.
- A repository with both old and new Codex secrets selects the secret only from
  auth mode plus workflow schema and never from secret existence alone.
- Additive DB migrations can be rolled back without deleting or corrupting
  legacy `ProviderSetupState` or static `CODEX_AUTH_JSON` workflows.

## Summary

The reliable no-VPS path is not "refresh the old secret harder". The correct
model is to treat Codex `auth.json` as rotating state with a single writer.

The recommended production architecture is:

```text
dedicated per-repo Codex session
+ repo-scoped GitHub secret
+ trusted OAuth proxy
+ encrypted writeback
+ ReviewRouter App Secrets: write
+ OIDC-bound server lease
```

This preserves the product's privacy boundary while giving users the convenient
GitHub-hosted workflow they want.
