# ADR-013: Auth.js Behind Auth Ports

## Status

Accepted for beta scaffold.

## Decision

Start dashboard authentication with Auth.js for GitHub OAuth, but keep it behind application ports so the product is not coupled to Auth.js internals.

Auth.js is an infrastructure/interface adapter, not a domain dependency.

## Required Ports

```text
AuthSessionReaderPort
  getCurrentSession(requestContext)

OAuthIdentityPort
  getGitHubIdentity(session)

SessionRevocationPort
  revokeSession(sessionId)
  revokeAllUserSessions(userId)

CsrfProtectionPort
  assertValidCsrf(requestContext)
```

Application services receive authenticated user identity and authorization context from these ports. They do not import Auth.js, Next.js, cookies, JWT helpers, or provider-specific session types.

## Rationale

Auth.js is a pragmatic fastest path for:

- GitHub OAuth
- OAuth state handling
- session integration with Next.js
- battle-tested provider plumbing

But auth is a high-risk dependency boundary. We need the ability to replace Auth.js with custom OAuth, Better Auth, Clerk, WorkOS, or enterprise SSO later without rewriting domain/application logic.

Auth.js official docs show direct Next.js integration through `NextAuth`, `auth()`, and route handlers, which is useful at the interface layer but should not leak inward.

Reference: [Auth.js](https://authjs.dev/)

## Boundary Rule

Allowed imports:

```text
apps/web/**
features/auth/infrastructure/authjs/**
features/auth/interface/**
```

Forbidden imports:

```text
features/*/domain/** -> Auth.js
features/*/application/** -> Auth.js
features/*/domain/** -> Next.js
features/*/application/** -> Next.js
```

## Session Strategy

Default beta recommendation:

```text
server-side persisted sessions + secure httpOnly cookie
```

Auth.js may manage session issuance, but the application layer stores and reads normalized internal records:

```text
User
GitHubExternalIdentity
WorkspaceMember
SessionAuditEvent
```

## Authorization Still Lives in Application Layer

Authentication answers:

```text
who is this user?
```

Authorization answers:

```text
can this user perform this action in this workspace/repo?
```

Every mutation must call policies such as:

```text
canManageWorkspace
canManageRepository
canInstallWorkflow
canUpdateReviewConfig
canViewAuditLog
```

Auth.js must not become the authorization layer.

## Risks

- Auth.js v5 ecosystem/documentation can be confusing around App Router and session callbacks.
- Callback customization can become a dumping ground if not contained.
- Session data shape can leak into UI/domain unless normalized early.

Mitigations:

- one adapter module owns Auth.js config
- one mapper converts Auth.js session to internal `AuthenticatedPrincipal`
- tests cover callback state, account linking, logout, and CSRF
- dependency boundary lint forbids Auth.js outside adapter/interface folders

## Consequences

Positive:

- fastest path to GitHub OAuth
- replaceable later
- clean application service testing
- easier future enterprise auth

Negative:

- extra port/adapters code in v1
- must avoid duplicating Auth.js functionality badly
- session edge cases need explicit tests
