# ADR-024: Balanced Memory Search Capability Contract

## Status

Accepted.

## Decision

Memory retrieval uses `MemorySearchIndexPort` with explicit capabilities:
lexical, full text, semantic vector and hybrid. Runtime retrieval can use any
supported capability, but all results must be canonicalized through
`MemoryItemRepositoryPort` before inclusion in an action bundle.

## Rationale

Search implementation will evolve. A capability contract lets ReviewRouter
start with a safe lexical adapter and later add pgvector or external vector
stores without leaking provider details into application use cases.

## Rules

- Unsupported capability means canonical fallback, not hard failure.
- Search input is bounded and normalized.
- Search documents may be deleted or stale; canonical memory status wins.
- Indexing happens through outbox handlers.
- Search adapters must not emit memory body to audit or outbox metadata.

## Consequences

Positive:

- search can improve without rewriting runtime policy
- stale vector hits cannot bypass tenant/scope checks
- external vector database adoption remains optional

Negative:

- adapters must expose honest capability metadata
- hybrid ranking needs separate quality tests before broad rollout
