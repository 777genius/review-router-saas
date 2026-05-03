# Free Plan and Monetization Path

## v1 Plan

Launch without payments. Use a free beta plan.

The product should still include a billing-entitlements bounded context so paid features can be added without rewriting core flows.

## Why Free First

- reduce adoption friction
- validate GitHub App install flow
- validate workflow provisioning
- validate dashboard value
- collect feedback on review quality/configuration
- avoid premature billing complexity

## Future Paid Value

Potential paid features:

- multiple workspaces/repos above free limits
- advanced org policies
- policy inheritance and rollout
- audit retention
- override ledger UI and exports
- Slack/Linear/Jira integrations
- managed workflow update campaigns
- team permissions
- compliance reports
- priority support
- optional managed cloud execution later
- self-hosted control plane for enterprise

## Pricing Hypothesis Later

Options to test:

```text
per developer/month
per repository/month
workspace base fee + repo tiers
enterprise custom
```

For v1 beta, avoid hard commitment.

## Important Product Boundary

Free beta should not imply unlimited cloud model usage because model execution is not in our cloud. This is a key advantage: we can offer a generous free control plane while customers pay their own CI/provider costs.
