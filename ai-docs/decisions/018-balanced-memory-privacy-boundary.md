# ADR-018: Balanced Memory Privacy Boundary

## Status

Accepted.

## Decision

Balanced Memory stores only confirmed, distilled memory records. It must not
store raw source comments, review threads, code, diffs, stack traces, prompts,
model responses, secrets or full source excerpts.

Action runtimes may send bounded candidate envelopes to the SaaS API. Those
envelopes contain normalized metadata, a distilled candidate body, source ids,
hashes and short redacted excerpts only.

## Rationale

ReviewRouter's privacy position depends on the SaaS not becoming a shadow copy
of customer code or AI conversation history. Memory is useful only if it is
small, explicit and auditable. Raw discussion storage would create unnecessary
security, legal and trust risk.

## Rules

- Runtime bundle endpoints return confirmed memory snippets only.
- Candidate endpoints reject raw fields such as comment body, diff, code,
  prompt, model response and conversation transcript.
- Audit and outbox metadata use ids, hashes, versions, counts and safe reason
  codes.
- Deleted memory is removed from runtime immediately and redacted before
  terminal retention prune.
- Pending suggestions are never used in runtime context.

## Consequences

Positive:

- privacy story stays simple and defensible
- memory poisoning has a smaller blast radius
- exports and support diagnostics can stay metadata-safe

Negative:

- debugging a bad memory requires source ids and GitHub context, not stored raw
  text
- users may need to re-state details when a candidate was blocked before save
