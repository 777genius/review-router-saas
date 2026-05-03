# Glossary

## Control Plane

The SaaS part of ReviewRouter: dashboard, config, GitHub App integration, workflow provisioning, audit, and health.

## Execution Plane

The customer's CI/CD environment where ReviewRouter Action actually runs review providers.

## Workspace

A ReviewRouter tenant, usually mapped to a GitHub user account or organization.

## GitHub Installation

An installation of the ReviewRouter GitHub App on a GitHub user/org account.

## Repository Connection

A repository accessible through a GitHub App installation and represented in ReviewRouter.

## Provider Setup State

Metadata describing whether Codex/OpenAI/OpenRouter credentials appear configured and where the customer is expected to store them.

## Workflow Provisioning

Creating or updating the GitHub Actions workflow that runs ReviewRouter Action in a customer repository.

## Outbox

A database-backed table of events written in the same transaction as state changes, later processed by workers.

## Distributed Lock

A lock that works across multiple API/worker instances, implemented through a Postgres lease table with owner-token release and TTL.

## `/rr skip`

Maintainer command to mark a ReviewRouter finding as accepted/ignored. Should be permission-checked and recorded in a signed ledger.
