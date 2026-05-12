# ADR-020: Balanced Memory Storage and Search Strategy

## Status

Accepted.

## Decision

PostgreSQL is the canonical Balanced Memory store. Search indexes, lexical
documents, embeddings, pgvector or external vector databases are derived indexes
behind `MemorySearchIndexPort`; they are never the authority for memory
existence, status, scope or tenant access.

The first production path uses canonical Postgres records plus lexical search.
Vector and hybrid search can be added through adapter capabilities after the
canonical lifecycle is stable.

## Rationale

Vector search is useful for relevance, but it is a poor authority boundary.
Approximate indexes can be stale, cross-tenant filtering is easy to get wrong
and provider costs can change. Canonical rehydration keeps correctness in the
database model we already control.

## Rules

- Search hits must be reloaded from canonical memory records before runtime use.
- Canonical reload must check workspace, repository, user, status, scope and
  index state.
- If search is unavailable or stale, runtime degrades to canonical fallback.
- Search adapters expose capabilities: lexical, full text, semantic vector or
  hybrid.
- Vector index migrations require a rollback plan and benchmark evidence.

## Consequences

Positive:

- no vendor lock-in to one vector database
- stale indexes cannot grant access to hidden memory
- pgvector can be introduced without changing use cases

Negative:

- relevance quality starts simpler than full semantic search
- canonical fallback can be less precise for large workspaces
