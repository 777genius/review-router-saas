# Product Positioning

## Core Positioning

ReviewRouter is a privacy-first AI code review control plane for teams that want multi-provider review without sending every review workload through a black-box SaaS.

## One-Liner

ReviewRouter installs and manages AI pull request review across your GitHub repositories while reviews run inside your own CI/CD.

## Differentiators

- review execution runs in customer CI/CD by default
- Codex CLI OAuth subscription support
- API-key provider support
- multi-provider routing path
- GitHub App bot identity
- signed human overrides with audit trail
- workflow provisioning and updates
- org-level policy management
- safer story for private repositories

## Main Customer Pain

Teams want AI review, but they worry about:

- private code leaving their environment
- model/API costs
- unmanaged bots spamming comments
- hard setup across many repositories
- inconsistent rules between teams
- no audit trail for ignored/blocking findings
- unclear CI failures
- reviewer updates going stale

ReviewRouter should solve operational trust, not just comment generation.

## Product Promise

```text
Install once, configure centrally, run reviews in your CI, keep control of your code and credentials.
```

## What ReviewRouter Is Not in v1

- not a cloud execution platform
- not a hosted code indexing service
- not a secret vault for Codex OAuth
- not a generic CI system
- not a replacement for human review

## Target Early Users

- small teams using GitHub Actions
- teams already experimenting with Codex CLI or OpenRouter
- maintainers who want AI review but dislike black-box SaaS custody
- teams with many repos and inconsistent review setup
- privacy-conscious startups

## Reddit/GitHub Launch Angle Later

A strong launch story:

```text
I built ReviewRouter because I wanted AI PR review with Codex subscription support, but without sending all private code through our servers. It installs as a GitHub App, manages policies and workflow updates, but the actual review runs inside your GitHub Actions.
```
