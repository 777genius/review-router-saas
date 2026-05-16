# Data Retention and Privacy

## Privacy Promise

ReviewRouter SaaS v1 stores metadata, not customer code.

Do not store:

- repository source code
- pull request diffs
- raw model prompts
- raw model responses
- Codex OAuth files
- provider API keys

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

Any change that sends data from customer CI to SaaS must answer:

1. Does it include code or diff?
2. Does it include secrets or environment data?
3. Is it needed for dashboard value?
4. Can it be aggregated or categorized instead?
5. Is retention defined?
