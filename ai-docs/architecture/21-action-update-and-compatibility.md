# Action Update and Compatibility

## Problem

Customers install ReviewRouter workflows into their repositories. If workflows pin old action versions forever, users miss fixes. If workflows track `main`, users may receive breaking changes unexpectedly.

## Channels

```text
stable - SaaS UI choice that resolves to an explicit vetted release tag in generated workflow
release - explicit pinned tag selected by user, safest for conservative teams
main - live development channel, opt-in only
```

## SaaS Default

Production default: use `stable` in SaaS UI, but write an explicit vetted
release tag into the generated workflow. Do not rely on a mutable `stable` tag
by default.

Local/private beta default: use `777genius/review-router@main` until the runtime
release process is stable. This is an explicit beta tradeoff, not the production
supply-chain policy.

`main` should remain visible as an opt-in choice for internal/test repos after
public launch.

## Compatibility Contract

Action and SaaS protocol both carry versions:

```text
actionVersion
protocolVersion
configSchemaVersion
```

Runtime config may include:

```text
actionMinVersion
actionMaxVersion
upgradeRecommended
blockedActionVersions
```

## Blocklist and Kill Switch

SaaS needs a safety mechanism:

- block known-bad action versions from runtime config fetch
- recommend update PR
- optionally force static safe fallback
- disable OIDC config fetch through feature flag

## Implemented Beta Baseline

Runtime config fetch accepts `x-reviewrouter-action-version` from the installed
Action. The control plane can reject exact known-bad versions through
`REVIEW_ROUTER_BLOCKED_ACTION_VERSIONS`, a comma-separated server-side list.

When a blocked version asks for config, versioned endpoints return:

```text
HTTP 426
error.code = action_version_blocked
retryable = false
```

This is intentionally exact-match only in the local beta. Semantic version
ranges and automatic update PRs remain a later layer because they need a vetted
release channel and migration policy.

## Update PR Flow

Dashboard should support:

```text
1. resolve stable to explicit latest vetted release tag
2. detect installed action/workflow version
3. compare with desired channel/version
4. create update branch
5. open update PR
6. never force-push over user changes without explicit action
```

## Backward Compatibility Rules

Safe:

- add optional config fields
- add new provider settings with defaults
- add metadata-only health fields

Breaking:

- removing required config fields
- changing severity/blocking semantics
- changing auth/session protocol
- changing secret env expectations

Breaking changes require new action major version or protocol version.

## Tests

- old action receives compatible config
- incompatible action gets clear update-required error
- blocked action version cannot fetch runtime config silently
- update PR does not overwrite user workflow customizations without warning
