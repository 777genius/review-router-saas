# Onboarding UX

## Goal

A user should be able to connect one repository in under 5 minutes without understanding all internals.

## Ideal Flow

```text
1. Sign in with GitHub.
2. Install ReviewRouter GitHub App.
3. Select org/repository.
4. Choose execution mode: GitHub Actions in your repo.
5. Choose provider setup: Codex OAuth / OpenAI API / OpenRouter / later other.
6. Choose preset: safe default / strict security / minimal.
7. ReviewRouter creates setup PR.
8. User merges setup PR.
9. Dashboard shows health status.
```

## Provider Setup UX

### Codex OAuth

Show:

- what file is needed
- where it will be stored
- why SaaS does not receive it
- org selected-repo secrets recommended for teams
- self-hosted runner persistent `CODEX_HOME` option

### API Key Providers

Show:

- repo secret setup
- org selected-repo secret setup
- warning for fork PR behavior

## Identity UX

Explain bot identity clearly:

```text
GitHub App bot - cleaner identity and audit
GitHub Actions bot - simpler fallback, generic avatar/name
```

In SaaS mode, prefer shared ReviewRouter GitHub App identity.

## Health UX

Dashboard should show:

- App installed
- repo selected
- workflow present
- OIDC runtime config sync enabled/disabled
- action version
- config version
- provider setup state
- last review/check status if reported
- security warnings

## Error UX

Errors should be actionable:

Bad:

```text
Codex failed.
```

Good:

```text
Codex auth appears stale or missing. Re-seed CODEX_AUTH_JSON or use a trusted self-hosted runner with persistent CODEX_HOME.
```
