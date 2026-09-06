# Hosted pool operator (bounded lane; Production HOLD)

This CLI extends the existing ReviewRouter operator profile and credential transport.
Use the normal native Codex login locally; import its private auth file once. ReviewRouter
then owns its encrypted generations. Do not copy provider credentials into GitHub Secrets
or keep synchronizing the native file back into ReviewRouter.

Server configuration is disabled by default. Set `REVIEW_ROUTER_HOSTED_POOL_OPERATOR_ENABLED=1`,
`REVIEW_ROUTER_HOSTED_POOL_OPERATOR_WORKSPACE_ID`, and
`REVIEW_ROUTER_HOSTED_POOL_OPERATOR_OWNER_GITHUB_USER_ID` only in trusted configuration.
The last value is the numeric GitHub user ID, not a login. The existing
`REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL_SHA256` authenticates the
`reviewrouter-operator` principal. Every request checks current owner/admin membership
and the Hosted pool entitlement. Existing custody readiness and encryption settings
remain required. Never give this service credential to unrelated tenants.

After the normal application build, use the existing operator profile:

```sh
corepack pnpm reviewrouter pool status --workspace WORKSPACE
corepack pnpm reviewrouter pool accounts import --workspace WORKSPACE --label primary --auth-file /private/native/auth.json
corepack pnpm reviewrouter pool accounts import --workspace WORKSPACE --label backup --auth-file /private/second/auth.json
corepack pnpm reviewrouter pool repositories connect --workspace WORKSPACE --all --dry-run
corepack pnpm reviewrouter pool repositories connect --workspace WORKSPACE --all
corepack pnpm reviewrouter pool repositories connect --workspace WORKSPACE --repo OWNER/NEW_REPO
```

Auth files are local client inputs, limited to 1 MiB. HTTP accepts bounded bytes, never
server file paths. Status is read-only. A duplicate import returns the existing account
and current ReviewRouter generation. After `reconcile_required`, inspect the returned
status; do not blindly import or replace again. A reused label for another identity conflicts.

Read current versions from status before administrative mutations:

```sh
corepack pnpm reviewrouter pool accounts pause --workspace WORKSPACE --account-id ACCOUNT --expected-health-version HEALTH_VERSION
corepack pnpm reviewrouter pool accounts replace --workspace WORKSPACE --account-id ACCOUNT --expected-generation GENERATION --expected-health-version HEALTH_VERSION --auth-file /private/relogin/auth.json
corepack pnpm reviewrouter pool accounts resume --workspace WORKSPACE --account-id ACCOUNT --expected-health-version NEW_HEALTH_VERSION
```

Replace requires a paused account and the same native provider subject. It uses the
existing short credential mutation fence, preserves pause and increments generation
and healthVersion. Resume is explicit. A pause originating from an invalid/quarantined
account records a safe generation marker in the existing audit ledger; resume requires
a newer generation. Version conflicts require a status reread. No inference-wide lock is added.

Connect reports each selected repository independently. Active bindings retain their
revision. Pending bindings retain their identity and resume the same setup branch/PR.
Accept the App-authored setup PR normally; only the existing canonical default-branch
verifier may activate the binding. Connect can recover a missing activation; status cannot.
`partial_failure` is not a successful batch; conflicts and failures are reported separately and exit nonzero. Retry after resolving the individual failures.
For `hosted_pool_github_app_permissions_required`, check the App installation has Contents, Workflows and Pull requests write permissions.
Review model, effort, language and limits are not changed by ensure/connect.

The normal API composition wires connect through the existing PostgresLeaseLock,
GitHub App installation client, current authorization/entitlement checks and shared
canonical workflow activation verifier. Test consumers may override the connect
adapter; production does not require an injected test callback. Missing deployment
configuration or GitHub App permissions fails closed.

Public, private and internal repositories use the same ownership, selected/archived,
installation, workflow and binding checks. Migration 000096 updates the two existing
SQL authority functions; deploy requires the matching qualified catalog/transition.

Production HOLD remains until the reviewed release and disposable provider canary.
Focused unit tests do not establish PostgreSQL role permissions, provider execution
or production readiness. The disposable PostgreSQL harness includes operator relogin
and refresh/pause cases using the actual API role; retain its pass/fail receipt for
exact source before treating those scenarios as verified.

## Disposable verification

Build the API and its workspace dependencies with the pinned package manager, then
run the existing ESM rewrite. The dedicated operator phase executes the compiled
CLI against the normal API composition and a disposable PostgreSQL API role:

```sh
corepack pnpm exec turbo run build --filter=@reviewrouter/api... --concurrency=2
node scripts/rewrite-dist-esm-imports.mjs
node --import tsx scripts/run-hosted-pool-postgres-e2e.mjs --operator-only
```

This phase checks two fake accounts in one pool, duplicate import, pause/replace/resume,
foreign workspace denial and revoked owner membership. It never calls a provider or
GitHub. The default and `--postgres-only` modes retain the existing PostgreSQL suites;
operator-only evidence does not replace them or the live disposable review canary.
