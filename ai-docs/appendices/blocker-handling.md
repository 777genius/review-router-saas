# Blocker Handling

This guide tells implementation agents what to do when blocked.

## Principle

Do not stop work unless the next action truly requires the user or an external account owner.

If one task is blocked, switch to the highest-value unblocked task in the same iteration. If the whole iteration is blocked, work on tests, docs, mocks, contracts, or fixtures that make the blocked task easier to finish later.

## When To Ask The User

Ask the user only when:

- a real secret, token, private key, or account action is required
- GitHub org ownership or App installation requires the user's approval
- a paid/external service must be created or changed
- the implementation would violate a non-negotiable boundary
- an open question blocks the current task and no safe default exists

When asking, include:

- what is blocked
- why it is blocked
- the exact action needed from the user
- what you will work on while waiting

## Default Fallback Order

When blocked, choose the first useful unblocked item:

1. Add or improve unit tests for the current feature.
2. Add contract/schema tests.
3. Add mocked adapter tests.
4. Implement domain/application layer without the external adapter.
5. Implement UI with mocked data.
6. Add fixtures and factories.
7. Improve user-facing error handling.
8. Improve docs for the area being implemented.
9. Move to the next independent task in the current iteration.
10. Move to a low-risk foundation task from Iteration 01.

Do not jump to future product scope such as billing, cloud execution, enterprise SSO, or managed review workers.

## GitHub Blockers

Blocked by missing GitHub App installation:

- implement domain/application policies
- implement Octokit adapter with mocked responses
- implement webhook signature tests using fixture payloads
- implement dashboard screens with mocked installation state
- document exact user action needed

Blocked by missing `workflows: write` permission:

- implement deterministic workflow renderer
- implement YAML snapshot tests
- implement permission error classification
- implement UI copy explaining the permission
- keep real PR creation as pending E2E

Blocked by missing test organization:

- run mocked integration tests
- create a local fake GitHub adapter
- prepare an E2E checklist
- do not use an existing production org unless explicitly approved

## Auth/Secret Blockers

Blocked by missing Codex OAuth file:

- implement secret setup command renderer
- implement validation logic with fixture `auth.json`
- implement stale/missing auth user-facing errors
- do not ask the SaaS to receive `auth.json`

Blocked by missing provider API key:

- implement provider setup UI with mocked state
- implement secret name validation
- implement docs and command output
- avoid real provider calls

## OIDC Blockers

Blocked by inability to run GitHub Actions:

- implement OIDC verifier with recorded/sample claims
- implement JWKS cache tests with mocked keys
- implement action-session token tests
- implement strict payload validation tests
- leave real OIDC exchange as a gated smoke test

## Database Blockers

Blocked by unavailable local Postgres:

- implement domain/application tests with in-memory fakes
- implement Prisma schema
- implement migration SQL review
- add Docker Compose or document startup command
- defer migration execution until DB is available

## Frontend Blockers

Blocked by missing API endpoint:

- create typed mock view models
- build feature UI against application-facing hooks
- add component tests
- add loading/error/empty states
- avoid hardcoding future transport shapes

Blocked by unresolved visual detail:

- use tokens from [Visual Direction](../product/08-visual-direction.md)
- keep component APIs stable
- prefer accessible default styling over decorative polish

## Dependency Blockers

Before adding a dependency:

- verify the current stable version
- verify maintenance activity
- explain why existing stack cannot cover the need
- add it only in the correct package

If dependency choice is uncertain:

- isolate behind a port/wrapper
- add a tiny spike
- continue with a minimal local implementation only if reversible

## What Not To Do While Blocked

Do not:

- wait silently
- invent credentials
- commit secrets
- broaden GitHub permissions without ADR/update
- switch architecture stack
- skip tests because E2E is blocked
- implement cloud review execution
- store code/diffs/prompts in SaaS
- use `pull_request_target` as a shortcut

## Blocked Work Log

When leaving blocked work behind, add a short note in the relevant issue/doc/test comment:

```text
Blocked: real GitHub App installation needed.
Reason: mocked adapter tests pass, but E2E PR creation needs org owner approval.
Next: after install, run the workflow provisioning smoke path from IMPLEMENTATION_PLAYBOOK.
Meanwhile completed: renderer, snapshots, permission error mapping.
```
