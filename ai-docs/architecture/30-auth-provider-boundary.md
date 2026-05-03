# Auth Provider Boundary

## Goal

Use Auth.js to move quickly without letting Auth.js define the product architecture.

Auth provider code belongs at the edge. Domain/application code should only see ReviewRouter-owned types.

## Internal Types

Application services should work with normalized types:

```text
AuthenticatedPrincipal
  userId
  githubUserId
  primaryEmail optional
  loginSnapshot
  sessionId

WorkspaceActor
  userId
  workspaceId
  role
```

Do not pass raw Auth.js session objects into application services.

## Feature Placement

```text
features/auth/
  domain/
    User.ts
    GitHubExternalIdentity.ts
    UserSession.ts
  application/
    ports/
      AuthSessionReaderPort.ts
      OAuthIdentityPort.ts
      SessionRevocationPort.ts
      CsrfProtectionPort.ts
    use-cases/
      GetCurrentPrincipal.ts
      LinkGitHubIdentity.ts
      RevokeSession.ts
  infrastructure/
    authjs/
      AuthJsConfig.ts
      AuthJsSessionReaderAdapter.ts
      AuthJsCsrfAdapter.ts
    prisma/
      PrismaUserRepository.ts
  interface/
    next/
      auth-routes.ts
    trpc/
      auth-router.ts
```

## Dependency Direction

```text
interface/authjs adapter -> application ports -> domain
```

Never reverse it.

## GitHub OAuth Identity Rules

Use immutable GitHub ids for account linking:

```text
githubUserId
```

Do not use GitHub login as primary identity because users can rename accounts.

Store login only as a snapshot/display field.

## CSRF and State

Auth provider must handle OAuth callback state. Dashboard state-changing routes still need application-level CSRF or equivalent same-site protections.

Important actions:

- create workspace
- install or connect GitHub App
- create workflow setup PR
- update repository config
- invite/remove member
- change role
- dismiss security-sensitive finding later

## Tests

- invalid OAuth state fails
- account rename does not create a second user
- raw Auth.js session does not cross application boundary
- missing CSRF rejects mutations
- session cookie settings are secure in production
- sign out revokes server-side session
