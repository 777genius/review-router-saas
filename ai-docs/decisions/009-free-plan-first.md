# ADR-009: Free Plan First, Billing Boundary Now

## Status

Accepted.

## Decision

Launch the SaaS beta with a free plan and no payment collection, but design a billing/entitlement bounded context from day one.

## Rationale

The first goal is adoption, validation, and feedback. Payment can be added later. However, if entitlement boundaries are not modeled early, adding billing later will touch every feature.

## v1 Free Entitlement

```text
plan: free_beta
max workspaces per GitHub user: 3
max repositories per workspace sync: 250
setup PR attempts: 5 per repository per hour
installation syncs: 10 per installation per 15 minutes
review config saves: 60 per workspace per hour
cloud execution: unavailable
advanced audit/policies: available during beta, may become paid later
```

These values are centralized in `freeBetaLimits` from
`@reviewrouter/features-entitlements`. Product copy, dashboard mutation rate
limits, and entitlement defaults should read from that policy instead of
duplicating numbers.

## Future Paid Value

- multi-repo dashboard
- org policies
- workflow update automation
- audit retention
- team permissions
- Slack/Linear/Jira integrations
- compliance exports
- cloud execution optional tier
- enterprise support/self-hosted control plane

## Consequences

Positive:

- easy beta adoption
- no early billing complexity
- clear path to monetization

Negative:

- early users may expect paid features to remain free
- need careful messaging around beta terms
