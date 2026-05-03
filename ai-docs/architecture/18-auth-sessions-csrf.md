# Web Auth, Sessions, and CSRF

## Authentication

Dashboard authentication uses GitHub OAuth.

Required protections:

- OAuth `state` parameter
- PKCE if supported by chosen auth library/provider mode
- secure callback URL allowlist
- account linking by immutable GitHub user id, not login string

## Sessions

Session options:

- signed, httpOnly, secure cookies with server-side session table
- or short-lived signed session with refresh stored server-side

Default recommendation for SaaS beta:

```text
server-side session table + secure httpOnly cookie
```

Cookie settings:

```text
httpOnly: true
secure: true in production
sameSite: lax
path: /
```

## CSRF

All state-changing dashboard mutations need CSRF protection unless the chosen framework/auth setup provides equivalent same-site protection and explicit validation.

Protect:

- config changes
- workflow provisioning requests
- member invites/removals
- repository selection changes
- entitlement/admin actions

## Authorization

Authentication is not authorization.

Every mutation must call application authorization policy:

```text
canManageWorkspace
canManageRepository
canInstallWorkflow
canUpdateReviewConfig
```

## Session Revocation

Support:

- sign out current session
- revoke all sessions for user later
- invalidate sessions after critical auth changes later

## Audit

Audit important auth/admin events:

- user login first seen
- workspace created
- member role changed
- workflow provisioning requested
- config changed

## Tests

- OAuth callback rejects invalid state
- user id mapping survives GitHub login rename
- viewer cannot mutate config
- CSRF token missing rejects mutation
- session cookie is httpOnly/secure in production config

## Auth.js Adapter Decision

Use Auth.js for GitHub OAuth in the beta scaffold, but only inside interface/infrastructure adapters. Domain and application layers depend on ReviewRouter-owned ports and normalized principal/session types.

Local/build behavior:

- Auth.js options stay import-safe for local builds even when OAuth env is
  missing.
- Dashboard mutations fail closed with `dashboard_auth_misconfigured` until
  `AUTH_SECRET`, `GITHUB_APP_CLIENT_ID`, and `GITHUB_APP_CLIENT_SECRET` are set.
- The dashboard must not show a misleading working sign-in flow when GitHub
  OAuth credentials are absent.

See:

- [Auth Provider Boundary](./30-auth-provider-boundary.md)
- [ADR-013: Auth.js Behind Auth Ports](../decisions/013-authjs-behind-auth-ports.md)

Core rule:

```text
Auth.js is replaceable infrastructure, not the auth domain model.
```
