# First-admission runtime snapshot checkpoint

Base: `4540552fe5d18f888de9c3ef2f04b17548bd24e0`, same accepted `daf0141b` tree.
Contract53 remains unchanged, SHA256 `66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0`.

## Implemented

- Actual verified OIDC admission captures strict repository/workspace configuration
  and the original live C1 account binding on the existing authorization row.
- Serializable admission rereads configuration and binding under parent locks;
  row/outbox atomicity and existing admission policy remain authoritative.
- Same owned run/attempt replays the original snapshot, deadline and operation IDs.
  Changed head/offer, revoked original binding, foreign workspace or expiry denies.
- Private canonical snapshot is bounded, immutable in SQL and absent from public
  token claims, authorization facts and outbox payloads. Legacy rows remain NULL.
- Catalog admits exact SQL120 while preserving managed92/historical96 identities.
  There are119 physical SQL files; ordinal120 is not a file count.

## Qualification

Primary used an isolated source/dependency copy on workers-fsn1-01:
Prisma generation, Run Control and API typechecks passed. Fresh PostgreSQL17.10
applied all119 SQL files; the actual nearest OIDC/DB runtime-pin scenario passed1/1,
zero skips. Existing catalog/historical/transaction checks passed164/164, zero skips.
Two synthetic fixture errors were corrected: conflict head must differ from original;
immutable ownership rejects attempted transfer, and foreign workspace reads deny.
Worker NOT_RUN receipts remain retained; they are superseded by primary qualification.
Source approval and final exact-head CI are still required before merge.

## Next integration boundary

The original full Gateway Prepare/result, all five approved limits, selected account,
executionRef and authorizationEpoch must be attached from the same preparation.
No bearer belongs in SQL/API/CI/logs. C1 metadata revision is not Gateway auth epoch.
Private SDK HTTP access, actual relay/action composition and kernel dispatch fences
remain next work. This checkpoint does not claim real agent/provider or product E2E.
D-final/S/E/F/G remain mandatory; H sharing is deferred. No release authorization.

Refs #490
