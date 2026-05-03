# Support and Admin Access

## Principle

Support tooling must help debug without exposing secrets, code, or diffs.

## Support Roles

Internal roles:

```text
support_viewer - read safe metadata only
support_admin - can trigger safe resync/retry actions
security_admin - can rotate/disable sensitive integrations
```

## Support View Allowed Data

Allowed:

- workspace id/name
- GitHub installation id/account login
- repository names and visibility
- workflow provisioning status
- health report safe summaries
- webhook delivery status
- job status
- audit events
- config version metadata

Forbidden:

- provider secret values
- Codex auth contents
- repository code
- PR diffs
- raw prompts/model responses
- GitHub App private key

## Support Actions

Allowed with audit:

- resync installation
- rerun health check
- retry failed provisioning job
- mark stale error as acknowledged
- disable problematic feature flag for workspace if designed

Forbidden without explicit customer/admin action:

- change review config
- create workflow PR
- disconnect installation
- access provider credentials

## Audit

Every support access/action should record:

```text
supportUserId
workspaceId
repoId optional
action
reason
createdAt
```

## Customer Trust

Dashboard should eventually show support access history to workspace owners.
