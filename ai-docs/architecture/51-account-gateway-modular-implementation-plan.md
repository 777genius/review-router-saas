# Account Gateway: Modular Implementation Plan

Date: 2026-10-03. Delivery order for accepted owner vision; product acceptance
is incomplete. [Contract 53](./53-account-gateway-implementation-contract.md)
is the sole normative implementation authority and goes in every worker packet.
[Vision 50](./50-reusable-account-gateway-and-personal-pool.md) retains all owner
and personal-sharing intent; [52](./52-account-gateway-first-slice-contract.md)
keeps Opus dispositions/scenarios and NONNORMATIVE source history.

Writers use explicit `gpt-6.1-sol/high/default`, independent reviewers
`gpt-6.1-sol/xhigh/default`; NO FAST. These are required profiles, not an
independently observed worker-model receipt. Coherent component PRs target
approximately 2000 changed LOC; security boundaries remain intact.

## Checkpoints and bounded ownership

| Checkpoint/component                            | Deliverable/owner boundary                                                                         | Dependencies and nearest qualification                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A accepted foundation                           | Separate reusable TS SDK/static optional Get Modular seam; gateway repo                            | Existing exact artifact/two outside consumer evidence only; 53 §§1–2                                                                            |
| B2 accepted kernel; B2a accepted additive proof | Private kernel account-global occupancy and exact native proof/non-entry settlement                | Kernel PR4 `ded15302`; B2a PR5 `5f3e93ba`; exact-source review and CI accepted, assembled native dispatch still pending; 53 §§3–4               |
| W5 accepted native checkpoint                   | Private native identity and Responses compatibility; fork PR2                                      | Accepted `16d621c2`; source review/CI and focused transport evidence only, no private bootstrap/provider acceptance                             |
| B3a                                             | Gateway TS management adapter, encrypted transient intent and exact mapping                        | Accepted A/kernel; 53 §§2,7; real native create/readback/lost ACK                                                                               |
| B3b                                             | Fork Go opt-in bootstrap/cancel-wait registry + minimal protected inherited-lock launcher          | Accepted W5+B2; 53 §§3–4; actual dual POST/callback/restart/ACK-loss and Linux closure                                                          |
| B3c                                             | Gateway authenticated HTTP composition/recovery/stream/cleanup                                     | B3a+b; separate additive kernel/SDK rejected-before-dispatch support before dispatch acceptance; 53 §§2–4,7                                     |
| C1 accepted foundation                          | RR PR488 owner/connection/binding persistence                                                      | Accepted root `8645c40a`, migration117/catalog and independent source review/CI; local revocation does not prove remote fencing                 |
| C2                                              | RR adapter/config/system admission/OIDC relay/binding fence delivery                               | Accepted A+B+C1; 53 §§5–6; actual config/FK/CAS, source classification, X/Y fence and bounded wait                                              |
| C3 (parallel)                                   | Our Accounts and Models/repository batch UI                                                        | A+B+C1; C2 authority composition; 53 §6; two disposable repos, truthful partial CAS/readback                                                    |
| D-min                                           | First real Codex/MiMo tools + final parsed review + approved-head App publication                  | B+C1+C2; same authoritative connection/binding/admission use cases via disposable fixture/operator command before full UI; 53 §8                |
| D-final                                         | Complete first slice including our UI batch, measured enforced bounds/cleanup/memory and long OIDC | D-min+C3; all 10 scenarios in 52, capacity/retention facts per 53 §8                                                                            |
| S                                               | Operator shared pool explicit grants after D; separate RR use case                                 | D-final; dedicated operator workspace/XOR, granted vs paid/ungranted, global capacity/fence; 53 §§1,5,8                                         |
| E                                               | OpenRouter selected real profile + tools/final/publication                                         | D-final; profile-specific unknown/cap/usage/auth gates; remains mandatory                                                                       |
| F                                               | Protected Codex OAuth connect/engine refresh/CLI and all custody paths                             | B+D-final; 53 §§2,7–8; actual OAuth identity/refresh/reconnect, one writer, dump/restore/rotation                                               |
| G                                               | Breaking replacement; no old-pool migration or persistent coexistence                              | D-final+E+F and release checks; 53 §8; exact stale grants/workflows/refresh denial and retained effects                                         |
| H                                               | Canonical personal owner/personal+multi-org use follow-up                                          | Stable base and deletion/fence policy; retained vision 50, 53 §§1,5; personal+X+Y, third denied, rename/reconnect/detach/role loss/shared quota |

D-min resolves the historical tools-without-final-answer failure early. C3 UI may
proceed alongside C2/D-min; D-final includes it. Additional Claude BYOK may be
qualified alongside E/F, but is not evidence of Claude subscription OAuth.
No product scenario is marked PASS by these dependency assignments.

The reusable gateway and native fork keep repository-local component PR bases;
RR children target `feat/account-gateway-integration` under root PR490, not main.
The orchestrator integrates exact accepted service/SDK/engine identities and verifies
author and committer `iliya <iliyazelenkog@gmail.com>` before each ordinary commit.
Individual worker packets define their owned paths; this plan is not a docs-only
restriction on implementation workers.

## Lean delivery scope and next executable outcome

The independent 2026-10-03 scope critique prioritizes **D-min**, which contract53
already permits. First assemble one private engine/facade with the existing SQL
kernel, then one RR workspace/binding/repository through actual T0/OIDC admission,
then real Codex/MiMo tools, final parsed review and GitHub App publication on the
same approved head. A green workflow without that final result fails acceptance.
C3 UI may proceed in parallel; its completion is not a prerequisite of D-min.

Immediate candidate repairs are bounded: PR6 raw numeric native-ID validation,
SQL004 parent-scope guards and management-suite CI selection; PR3 launcher
context deadlines, trusted root-path validation, pidfd test cleanup and canonical
UUID incarnation agreement with the kernel. Native custody and C2a pending patches
require their own qualification/review. Existing component passes are reused;
actual native create/dispatch/callback/closure and RR assembly remain unproved.

D-min retains baseline enforced bounds/deadlines, backend custody, tenant/run/head
checks, single durable admission, unknown without replay and exact physical closure.
Full UI/batch, sustained memory/retention/cleanup measurements and long OIDC are
D-final gates. Full OAuth custody/refresh qualification belongs to F before G.
Broad RR Docs Protocol/Foundation corpus adoption is a separate bounded follow-up,
not a D-min prerequisite. Keep accepted SDK tooling and existing checks intact.

OUT of the current implementation: H personal-to-multi-organization sharing,
a generic DI/plugin/scheduler/vault platform, additional agent/auth profiles
without qualification, credential/history migration and automatic legacy fallback.
OpenRouter E, protected Codex OAuth F, operator grants S and breaking retirement G
remain required final deliverables; this ordering does not remove them from scope.

## Implementation packet and verification

Include full contract 53 + digest, supplied base and observed HEAD separately, owned paths,
accepted dependency SHAs, installed toolchain/image, disposable fixture, nearest
observable/security test command and receipt destination. Never infer a native
capability from route prose. A missing dependent patch is an explicit gate.
One nearest test owner per invariant; real HTTP/DB/Linux/CLI where required,
no implementation-mirror/mock-only/source-string tests or prose regression suite.
Reuse unchanged accepted A/kernel proofs; requalify changed or newly assembled
boundaries and run final exact-head CI/review. Every product receipt binds exact
candidate, scenario, identity, command and actual evidence as required by 53 §8.

## NONNORMATIVE forecast and historical evidence

Estimates are remaining work, not measured diffs/completion percentages. The
2026-10-03 independent scope review forecasts D-min at 1400–2800 production and
1200–2400 test/helper lines (confidence 4/10); cumulative D-final at 3000–5500 /
2400–4600 (4/10); D-final plus S/E/F/G at 5950–12350 / 5100–10600 (3/10).
These are advisory ranges, not ceilings. The following older Opus/component
forecasts remain historical and are superseded for current remaining-work reporting:

| Remaining scope | Production LOC |  Test LOC | Config LOC / qualification risk                        |
| --------------- | -------------: | --------: | ------------------------------------------------------ |
| Through D-final |      3000–6000 | 3000–5000 | 400–1000; real final answer/closure/memory             |
| S               |        300–600 |   300–500 | Unpriced; grant/fence reuse                            |
| E               |       400–1000 |  400–1000 | Unpriced; actual selected profile                      |
| F               |      2500–5000 | 2000–4000 | Unpriced; protected refresh/cache/restore and identity |
| G net cleanup   |        300–800 |   300–600 | Unpriced; retirement proof                             |
| H and deletion  |      1700–3200 | 1800–3300 | Unpriced; canonical multi-use lifetime                 |

B3 report component estimates (production/test separately): B3a 350–450/180–250,
B3b 400–550/250–350, B3c 300–400/180–250, with generated Wire/config delta measured
separately. Additive kernel/SDK settlement is a dependency, not hidden inside an
accepted B2/W5 patch. Split by cohesive ownership near 2000 total changed LOC;
these ranges overlap the through-D forecast, not additional charges.

Historical artifact/tooling observations and qualification requirements below
retain original hashes/history. They cannot override 53 or certify current
installation, repository-wide adoption, service dispatch, release or OAuth.

### Current tooling facts and adoption

Checked through `gh` against RR main
`99f5e97c16b7bce47b4cfe196c1d8e462c92f6d3`:

- `@agent-teams/engineering-foundation@1.6.0` is already a dev dependency of
  `packages/features/sdk-growth-authority`; this is limited feature adoption,
  not proof of a repository-wide Foundation profile.
- No Docs Protocol dependency, profile or workflow invocation was found in the
  inspected dependency/config/CI sources. Existing `protocol:*` commands concern
  Review Action wire protocols, not Docs Protocol. Get Modular is not adopted.
- Get Modular itself already uses Engineering Foundation and Docs Protocol as
  development dependencies. Installing them does not activate consumer rules.

Public npm metadata checked on 2026-10-02: Core/Assembly `0.2.0`, Foundation
`1.7.1`, Docs Protocol `0.6.2`. Core/Assembly are pre-1.0 and have candidate
dist-tags; some source guides still show older pins. These are available
candidate coordinates, not evidence that our consumer has qualified them.
Before installing, recheck exact published artifacts, supported public APIs,
release qualification and integrity. Commit exact approved versions and one
native lockfile; do not install from a floating Git branch or `latest`.

Current Core/Assembly engines require Node `>=24.18 <25` or `>=26.10 <27`;
current Foundation/Docs Protocol require Node `^24.18 || ^26` and pnpm
`>=11.17 <12`. RR declares pnpm `10.33.0`. Run the new repository on a qualified
toolchain; qualify any RR tooling upgrade as a bounded change before adding these
current dev tools there. Do not silently rewrite RR's package manager to copy a
template. Check Node capability against deployed RR/CI and the packaged client.

Foundation belongs only in dev dependencies: declare actual source boundaries,
curated public API and dev-only prohibition, then run its checks. No Foundation
runtime/types may leak into shipped clients or the product. Get Modular types
are allowed only in the optional composition surface.

Docs Protocol adoption starts in the new library repository with a portable
profile. RR adoption is a bounded tooling change preserving `ai-docs` and its
existing authorities: inspect the exact installed CLI, preview create-absent and
reviewed exact-preimage operations (including any marker-bounded AGENTS edit),
review paths/preimages and apply only the matching plan. Never force bootstrap
over this dirty checkout or generate a competing documentation tree. Commit the
profile, ownership/reachability rules, scripts and CI check together. Adoption
in the new gateway repository is qualified for docs and package READMEs; its root
README remains outside the supported catalog. RR adoption remains pending;
writing these Markdown documents does not constitute adoption. This broad RR
adoption is outside the D-min critical path; it must not delay the first actual
provider/tools/final/App proof.

#### Scoped composition and artifact acceptance

Checkpoint A records the selected combinations in one small capability matrix:

| Component     | Initial candidate / explicit scope                                                       | Required installed evidence                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Get Modular   | Core/Assembly 0.2.0; static package-client construction and RR outer adapter composition | Exact archives/SRI, exported APIs, ESM mode and supported TS with `skipLibCheck: false`; actual positive/rejecting consumer wiring |
| Foundation    | 1.7.1; source-dependencies v2, curated public-API and dev-only checks                    | Installed supported schemas/CLI on actual local profiles; real prohibited imports including type-only imports must fail            |
| Docs Protocol | 0.6.2; portable profile v4, Document Authoring profile v3                                | Installed init/check/new preview and stale-preimage rejection; explicit data-only blocker vocabulary and reachability              |
| Toolchain     | Node 24 >=24.18 within its supported major, pnpm 11.20 candidate lane                    | Actual installed version/build outcomes; RR upgrades qualify separately                                                            |

Foundation source-dependencies v3 is not required for this slice; its source
README still marks qualification pending. Avoid that extra axis. If a selected
artifact does not support the stated minimal capability, resolve that exact
mismatch before activation; do not replace it with a source-only check or claim
that older 0.1.0/0.4.0 guide receipts qualify new archives. Portable v4 does not
silently migrate an existing v3 profile; authoring v3 is a separate identity.

Maintain two bounded consumer profiles: package composition and the newly
adopted RR seam. Record accepted local decision, organization authority pin,
central contract commit/full-document digest, exact package/archive identity,
roots/owner, materialized entrypoint, declarations/profile/factories and actual
blocking fast/full commands. Their existing boundaries inventory explicitly
marks untouched scopes not-adopted with an owner/review trigger, without blanket
exceptions or a claim of repository-wide conformance. Discover and reject new
unknown boundaries; enforce policy through the existing source-policy mechanism,
not another import parser. No second direct production assembly is retained in
the adopted seam; the independent wiring oracle is test-only.

Central contract candidate: Get Modular `common-assembly.md` at source pin below,
full-byte SHA-256 `33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`.
It references organization Feature Module Standard v1, Git blob
`d0bfff2033faf544fe65268c1dcdfd524d093015`; retain and verify that authority before
activating the local profiles. These source pins are not installed evidence.
Its authority source is `agent-teams-ai/.github` commit
`eef92e7fd40f538b4e9ba03e01bbd4e2d23f12f2`, path
`docs/architecture/feature-module-standard/v1.md`, SHA-256
`851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa`;
the full bytes were retained and verified in this planning turn. Reuse the
retained authority as evidence, without presenting a copy as a new standard.

Test owners are distinct: archive/export closure; typed and behavioral wiring
parity with zero construction on invalid preparation; actual source-policy
rejection; portable docs stale-preimage/corpus checks; and two consumer fixtures
reusing the base facade harness for transport/isolation. Do not implement an
extra source classifier or repeat all service security tests in each fixture.

RR Docs Protocol mapping must inventory existing `ai-docs` Markdown collections,
sidecar metadata for documents without frontmatter, owners/templates, indexes,
relations/reachability and blocker vocabulary before activation. Preserve
accepted document content/IDs. Verify the mapping on a disposable copy: valid
existing documents remain reachable, a broken relation/invalid metadata is
rejected and a changed apply preimage causes zero mutation. New-repository
bootstrap does not qualify RR's historical corpus or rewrite it automatically.

### Budget interpretation and open risks

The earlier 4–9k production /3.3–7k tests estimate covers MiMo/OpenRouter BYOK,
private facade, own UI and CI integration. It already includes HTTP client,
schemas, ports and isolation: moving them into a package is not another full
implementation. A hosted bounded review estimated the packaging/modular increment:

| Increment                                          |  Production |         Tests |      Config |
| -------------------------------------------------- | ----------: | ------------: | ----------: |
| Pack/export/build existing client/contracts        |      90–180 |       180–320 |      70–120 |
| Static module and consumer composition glue        |     170–330 |       260–460 |       50–90 |
| Minimal Foundation profile/gates                   |           0 |       100–180 |     110–190 |
| New repository Docs Protocol profile/workflow      |           0 |        60–120 |      70–130 |
| Two disposable installed consumers, shared harness |           0 |       180–320 |       40–70 |
| **Increment only**                                 | **260–510** | **780–1,400** | **340–600** |

Confidence 6/10. Handwritten additions beyond the base; relocated unchanged
source, generated outputs/lockfile churn and prose are excluded. RR-wide
toolchain adoption and historical corpus mapping remain unpriced unknowns; no
new total ceiling is asserted. Each invariant has one primary test owner.

Prior new Codex/Claude subscription estimate +2–4k production /+2–4k tests remains
conditional. Protected OAuth storage and provider repairs are not a proven
ceiling. Do not drop those gates to fit the earlier number. Old-pool migration
and coexistence are removed from scope, not assigned an invented savings figure.
Owner/use preparation (+200–400 production) is a subset of the sharing follow-up,
not an additional fee on top of full sharing. No external GitHub membership sync
is included in default sharing scope.

Open: exact consumer qualification for Get Modular, RR toolchain compatibility,
Sub2API strict memory bounds, long-run authority/cleanup and live OAuth custody.
All implementation checkpoint receipts remain NOT RUN. Existing sandbox E2E
receipts establish only their tested engine/agent/profile candidates.

Hosted plan review `rr-gateway-spike-20260930-modular-plan-review-w1` completed
with gpt-6.1-sol/medium/fast, verdict ACCEPT_WITH_FIXES. Main incorporated its
four design findings: authorization handoff/fencing, scoped modular adoption,
artifact/capability matrix and existing-docs mapping. This is a source review,
not a subsequent independent review of the revised plan or implementation.

### Source pins

- [Get Modular public boundary](https://github.com/agent-teams-ai/get-modular/blob/4b56072ec6ca269fb16e3fdf131d31423af804bd/README.md)
  and [consumer construction](https://github.com/agent-teams-ai/get-modular/blob/4b56072ec6ca269fb16e3fdf131d31423af804bd/docs/guides/consumer-quickstart.md).
- [Foundation development-only boundary](https://github.com/agent-teams-ai/engineering-foundation/blob/9843822e6c10c4b805cf2bb95fc0f43e5211edeb/README.md)
  and [portable Docs Protocol](https://github.com/agent-teams-ai/engineering-foundation/blob/9843822e6c10c4b805cf2bb95fc0f43e5211edeb/docs/reference/open-source-docs-protocol.md).
- [RR Foundation feature dependency](https://github.com/777genius/review-router-ai/blob/99f5e97c16b7bce47b4cfe196c1d8e462c92f6d3/packages/features/sdk-growth-authority/package.json)
  and [explicit workspace membership](https://github.com/777genius/review-router-ai/blob/99f5e97c16b7bce47b4cfe196c1d8e462c92f6d3/ai-docs/architecture/29-workspace-membership-lifecycle.md).

Source files were fetched through `gh` and checked against Git blob IDs. Registry
metadata is a separate observation, not a release/capability acceptance receipt.
