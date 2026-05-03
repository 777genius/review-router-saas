# Iteration 02 - GitHub Identity and App Install

## Goal

Allow users to sign in and connect a GitHub App installation.

## Scope

- GitHub OAuth login
- session handling
- OAuth state/CSRF/session security baseline
- User entity
- Workspace entity
- WorkspaceMember role model
- owner safety rules and invite token model
- GitHubInstallation aggregate
- GitHub App installation webhook handling
- installation lifecycle states: active/suspended/removed/permission_error
- initial installation sync job skeleton

## Important Decisions

- GitHub OAuth authenticates users.
- GitHub App installations authorize repo access.
- User identity and installation identity are separate.

## Tests

- OAuth callback happy path
- invalid OAuth state rejected
- CSRF missing rejects mutation
- workspace creation
- last owner cannot be removed
- installation webhook signature verification
- duplicate installation webhook idempotency
- uninstall/suspend/repository removed events update state safely

## Done When

- user can log in
- dashboard shows connected GitHub account/workspace
- installing the GitHub App creates/updates installation record

## Implemented Baseline

- Dashboard exposes a GitHub sign-in CTA and a GitHub App install CTA when `GITHUB_APP_SLUG` is configured.
- The App install URL is generated from a strict slug-only helper to avoid unsafe external redirects.
- GitHub App installation webhooks create/update installation records and grant the installing sender owner access for the derived workspace.
