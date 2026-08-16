# Hosted pool disposable E2E

This suite uses only loopback HTTP servers, synthetic repository identities,
fake GitHub OIDC, fake GitHub comment tokens, and a fake Responses SSE stream.
It must never be pointed at a real repository, browser/provider session, or
production database.

Run the focused transport test:

```sh
pnpm hosted-pool:e2e
```

Run the complete hosted-pool acceptance gate, including denial, failover,
binding/CAS, encrypted custody, and Action-proxy suites:

```sh
pnpm hosted-pool:verify
```

Run the production-adapter gate on a fresh disposable PostgreSQL 17 container:

```sh
pnpm hosted-pool:e2e:postgres
```

The test covers the complete local wire path from grant issuance through the
Action nonce proxy and Fastify relay, two streamed turns, narrow comment-token
refresh, concurrent same-account inference, refresh-generation CAS races, and
credential-leak sentinels. The no-database service-seam matrix also proves that
cross-tenant, cross-repository, stale-binding, expired, replayed, request-budget,
and byte-budget requests never reach the upstream port.

The PostgreSQL gate creates a uniquely named loopback-only database, applies
every migration, and removes the exact container when the run finishes. It
exercises real Prisma enrollment, encrypted envelopes, grants, concurrent relay
admission, SSE completion, comment refresh, mutation leases, generation CAS,
identity constraints, replay rejection, and the response-start failover fence.
The test also refuses any non-loopback or incorrectly named database URL.
