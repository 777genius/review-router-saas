# Data Retention and Privacy

## Privacy Promise

ReviewRouter SaaS v1 stores metadata, not customer code. The default legacy
repository-owned provider mode also does not transport raw review bodies through
SaaS.

Do not store:

- repository source code
- pull request diffs
- raw model prompts
- raw model responses
- Codex OAuth files
- provider API keys

Opt-in hosted workspace account pool exception:

- SaaS stores envelope-encrypted Codex session credentials, never plaintext
  credential columns;
- prompts, tool outputs, and Responses events pass through the invocation-scoped
  relay transiently but must not be durably stored in databases, queues, logs,
  traces, support tooling, or backups;
- credentials never leave SaaS, while the Action receives only a bounded run
  grant;
- safe relay metadata may be retained under the normal operational retention
  policy: invocation/account opaque IDs, counts, latency, outcome, failure class,
  and redaction counters;
- disabling hosted mode does not export credentials into the legacy mode.

See [ADR-029](../decisions/029-opt-in-hosted-workspace-account-pool.md).

## Stored Metadata

Allowed metadata:

- GitHub account/repo identifiers
- repository visibility and default branch
- installation status
- configuration versions
- workflow provisioning status
- provider setup state
- safe health report summaries
- audit events
- entitlements

Balanced Memory exception:

- ReviewRouter may store user-approved distilled memory bodies and pending memory suggestion bodies.
- Memory input must be a bounded distilled fact/preference, not raw code, diffs, prompts, model responses, or conversation threads.
- Action memory endpoints reject raw payload fields and store only candidate body plus safe metadata.
- Memory audit, outbox, and usage telemetry must not contain memory body, source text, prompts, model output, code, or diffs.
- `forget/delete` removes the memory from runtime bundles immediately, deletes the search-index document, and tombstones the stored body/source for the item and its confirmed origin suggestion.

## Retention Defaults

Initial defaults:

```text
Audit events: 180 days during beta, configurable later
Webhook deliveries: 30 days
Job execution records: 30 days
Health reports: 90 days
Memory usage telemetry: 180 days
Pending memory suggestions: 14 days for repository/workspace, 30 days for user_prefs
Config versions: retained while workspace exists
Deleted workspace data: hard-delete async within 30 days unless legal hold later
```

## User-Facing Delete

Workspace deletion should:

- revoke or mark installations disconnected where possible
- delete ReviewRouter metadata
- schedule hard deletion
- keep minimal legal/security logs only if required later

## Telemetry Rules

Telemetry must be metadata-only.

Safe:

```text
review completed
provider type
duration bucket
error category
config version
comment count
finding severity counts
```

Unsafe:

```text
file contents
code snippets
diff patches
prompt text
model raw output
secret values
```

## Privacy Review Trigger

## Review v2 Retention Order

Prune only after downstream references expire: publication effects/operations and
completion processes, snapshot receipts/snapshots, execution observation refs and
leases, then observations and authorizations. Restrictive foreign keys and
reference-aware predicates protect live evidence. Tombstones retain compact IDs,
hashes, outcomes and timestamps only. No source, diff, prompt, credential, cookie,
raw provider response or raw finding prose is added to operational telemetry.
Any change that sends data from customer CI to SaaS must answer:

1. Does it include code or diff?
2. Does it include secrets or environment data?
3. Is it needed for dashboard value?
4. Can it be aggregated or categorized instead?
5. Is retention defined?

Hosted relay changes must additionally prove that infrastructure body capture is
off, retry/queue paths do not persist bodies, bounded grants are enforced, and a
kill-switch test terminates new traffic safely.
