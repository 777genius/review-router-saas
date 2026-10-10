# Private run-access HTTP adapter checkpoint

Base: runtime-pin checkpoint184c052e, stacked beneath PR496.
Transport only: server-owned immutable Prepare intent and configured private
Gateway run-control credential. SDK contracts validate the envelope; returned
operation, admission, account/epoch/deadline and all five limits must match.
Execution bearer remains inside the existing SDK client's closure, with safe
prepared projection only. No SQL/API/CI/logger bearer field is exposed.
Redirects, invalid envelopes and lost acknowledgments never trigger hidden replay.
Policy, original Prepare/result persistence and actual relay/action are next lane.

Interrupted worker c067 raw patch retained separately. Primary corrected only
adapter/test filenames and their import, then supplied the private current SDK.
Isolated API typecheck PASS; actual loopback HTTP checks37/37PASS, zero skips.
No real provider/agent or full product E2E claimed. Private source-pinned SDK tarball sha256 b6a4b79a1e026e585a23118c6661dd995fa124b061de86f2c0ca18ad71bf74a9; no publication.
Registry recheck: Core/Assembly0.2.0 and zod4.6.5 are latest public versions.
Minimal lock adds only four package snapshots and API dependency; unrelated pins retained.
Pinned pnpm10.33.0 frozen offline lock validation PASS; formatted current API
typecheck PASS and actual HTTP37/37PASS zeroSkip. Independent current-source
review and final CI remain pending; no deploy/release.
Full D-final/S/E/F/G remain, H sharing is deferred. Refs #490.
