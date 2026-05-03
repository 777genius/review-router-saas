# Incident Response

## Incident Classes

### Security Critical

- GitHub App private key leaked
- SaaS accepts invalid webhook/OIDC token
- tenant isolation bypass
- secret or code accidentally logged/stored
- generated workflow exposes secrets to untrusted PR code

### Reliability High

- setup PR creation broken globally
- webhook processing down
- queue stuck
- config fetch down
- bad action release

## Immediate Actions

For security critical:

1. pause affected workers if needed
2. disable affected feature flag
3. rotate compromised keys/tokens
4. preserve audit/log evidence without exposing secrets
5. notify affected users if customer data risk exists
6. add regression test before re-enable

For bad action release:

1. mark version blocked in SaaS
2. stop promoting stable channel
3. publish fixed release
4. create update PRs or show dashboard CTA
5. write incident note

## Feature Kill Switches

Must exist before public beta:

```text
ENABLE_ACTION_OIDC_CONFIG
ENABLE_WORKFLOW_PROVISIONING
ENABLE_HEALTH_REPORTS
ENABLE_APP_BOT_TOKEN_IN_WORKFLOW
ENABLE_RUNTIME_CONFIG_FOR_FORKS
```

Security-sensitive flags fail closed.

## Communication

Beta minimum:

- status page or status section in dashboard
- support email/contact
- incident log for significant outages/security events

## Post-Incident Requirements

- root cause written
- affected scope identified
- test added
- docs/runbook updated
- risk register updated if new class discovered
