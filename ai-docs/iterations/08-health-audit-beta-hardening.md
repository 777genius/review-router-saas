# Iteration 08 - Health, Audit, and Beta Hardening

## Goal

Make the product understandable and supportable for beta users.

## Scope

- audit log feature
- repo health checks
- workflow presence/version checks
- provider setup health display
- error pages/messages
- internal support debug view
- support access audit
- incident response kill switches
- free beta abuse/quotas guardrails
- onboarding permission explanations
- security warnings for public repos/fork PRs

## Tests

- audit events emitted for install/config/provisioning
- health check detects missing workflow
- health check detects version mismatch
- no secrets logged in error paths

## Done When

- user can understand what is installed, what is missing, and what to do next
- support can debug without reading code or secrets
- support/admin access is audited
