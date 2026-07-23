# Review mutation authority operator control

`ReviewMutationAuthority` is changed only through
`ManageReviewMutationAuthority`. Operator transports must use
`AuthenticatedReviewMutationAuthorityOperatorService` from
`@reviewrouter/features-review-run-control/composition`; they must not call domain
transition functions directly.

## Proof flow

1. Call `preflight` for the intended operation.
2. For `direct_v2_initialize`, `abort_drain`, `activate`, and `resume`, retain
   the returned immutable proof reference (`proofVersion`, digest, authority
   version, and expiry).
3. Submit that reference with the command before its short expiry.
4. The application service reads current facts through the operation-specific
   query port, rebuilds the canonical proof, compares its digest, applies the
   domain transition, and persists it with authority-version CAS.

The command surface never accepts readiness booleans or caller-provided proof
hashes. Direct V2 initialization additionally requires authority version `0`,
fresh V2-only provisioning, no previously issued legacy capability, and an
enabled server safety decision. A changed fact, changed
facts version, stale proof, scope mismatch, unavailable facts adapter, or CAS
conflict fails closed. Retrying the same completed command with the same proof
is idempotent when the persisted authority contains the same activation facts.

## Production adapters

Production composition must provide all four segregated query ports:

- `ReviewMutationDirectV2InitializationProofFactsQueryPort`
- `ReviewMutationAbortProofFactsQueryPort`
- `ReviewMutationActivationProofFactsQueryPort`
- `ReviewMutationResumeProofFactsQueryPort`

Each adapter must compute its facts from server-owned data and return a stable
`factsVersion` that changes whenever any contributing fact changes. Reads
should come from one consistent database snapshot. Omitting the adapters keeps
the composition available for non-mutating behavior, but every proofed
operator command fails closed.

`ReviewMutationAuthorityInitializationPolicyPort` is also server-owned. Its
default composition selects V1. Selecting direct V2 only chooses the desired
initialization lane; the direct-V2 facts proof is still mandatory and is
evaluated immediately before immutable authority creation.

Operator credentials are supplied only to the authentication adapter. Store
SHA-256 credential digests, grant
`control_mutation_authority` explicitly, and never log the raw credential or
the full command input.
