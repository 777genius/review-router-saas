# Reusable Account Gateway and Personal Pool

Owner vision accepted 2026-10-02; DOC PLAN corrections accepted 2026-10-03.
This document preserves vision, including deferred personal sharing; it is not
an independently editable implementation contract. Runtime/lifecycle authority
is solely [normative contract 53](./53-account-gateway-implementation-contract.md).
[Plan 51](./51-account-gateway-modular-implementation-plan.md) owns sequence;
[evidence 52](./52-account-gateway-first-slice-contract.md) records dispositions
and historical receipts; [ADR-030](../decisions/030-reusable-account-gateway-and-ownership.md)
records the architectural decision. No product scenario is qualified here.

## 1. Owner vision, preserved explicitly

The owner wants:

1. Sub2API as an independent service reused by multiple products, rather than
   code entangled with Review Router or one agent.
2. Our own account-management frontend. Each product controls users,
   workspaces, organizations and repository/model settings.
3. A user enters an OpenRouter API key, MiMo Token Plan key or future supported
   provider credential once. The upstream credential stays in our server-side
   custody; CI makes authorized requests through the gateway.
4. Codex reviews working through Sub2API, with Claude and other agents possible
   after explicit compatibility checks. Agents/tools/checkout still execute in
   CI; the gateway serves model traffic and account lifecycle.
5. One personal account catalog/pool per stable user account. Selected accounts
   can be used in the user's personal workspace and multiple organizations.
6. An organization can select several of those personal accounts or connect
   separate accounts owned by the organization.
7. A personal account attached to an organization is a reference to that same
   account. Rename or reauthorization updates the source; the organization view
   and future authorized requests use that source. No copied accounts or copied
   credentials that require synchronization.
8. CI/CD review uses the accounts allowed by its workspace and repository/model
   policy. Connecting an account is distinct from choosing where to use it.
9. Prepare ownership/use boundaries now, then ship the full sharing feature as
   a follow-up. Keep the first integration small and reusable.
10. Build a separate reusable package immediately, using Get Modular for
    composition and Engineering Foundation for development checks. The owner
    confirms at least two intended products; the second product is not named.
11. A breaking replacement is acceptable: disable the old subscription pool,
    require account reconnection and spend no effort migrating its credentials
    or history. The owner states there are no users needing compatibility.

Owner acceptance does not implement personal sharing or qualify runtime behavior.
Contract 53 is the only normative implementation source; the following is the
retained product intent and H follow-up, not another runtime specification.

## 2. One service, clear product responsibility

```text
Our UI -> Product backend
          users, memberships, workspaces, repo/model policy
          application ports -> HTTP adapter/client
                               |
                               v private server API
                      Account Gateway service unit
                      narrow control/execution adapter
                      consumer-scoped account mappings
                               |
                               v private engine API
                         pinned Sub2API fork
                         routing, provider auth/refresh
                               |
                               v
                       approved upstream providers

CI agent -> Product public relay -> Gateway execution API -> Sub2API -> upstream
checkout/tools/loop stay in CI
```

The service unit may contain a small facade process alongside the engine. A
deployment unit is not a requirement to merge their databases or expose an
engine admin panel. Keep that facade small and use existing native engine
transport; do not implement a second agent or protocol-conversion engine.

| Responsibility                                                         | Owner                           |
| ---------------------------------------------------------------------- | ------------------------------- |
| Product login, personal/organization roles, repo/model/batch policy    | Product backend                 |
| GitHub OIDC, workflow/run/repo authority, review permission/publishing | RR                              |
| Credential owner and allowed workspace use records                     | RR for RR accounts              |
| Opaque consumer/owner/account mappings, operation status and isolation | Gateway                         |
| Native provider routing, account auth/refresh, provider health         | Sub2API through gateway adapter |
| Bounded execution permission and per-request transport limits          | Gateway                         |
| Account-global provider request limits/health                          | Engine/gateway, one authority   |
| Workspace entitlements, usage attribution and review budgets           | Product                         |
| Agent loop, checkout, tools and findings parsing                       | Existing CI runtime             |

Another product supplies its own authorization/identity adapter and business
policy; it need not implement GitHub OIDC. The gateway sees a trusted consumer
and opaque owner/execution references. All consumer calls still require service
authentication. An opaque string supplied by a user is not proof of ownership.

`account-gateway` is distinct from the existing subscription-runtime library
and hosted worker orchestration. It serves model/account access; it does not
assign tasks, provision terminals or run checkout/tool loops. Product tenant
workspace references are also distinct from an agent's filesystem directory.

## 3. Personal pool follow-up (H): retained full owner vision

### Canonical identity and data

```text
Stable User.id
  -> canonical personal ProviderAccount A, B, C
       -> explicit binding in personal workspace
       -> selected binding in organization X
       -> selected binding in organization Y

Organization X
  -> its own ProviderAccount D
```

- One canonical account name, credential reference/generation, provider profile
  and health. No organization-specific copied credential or copied account.
- Workspace binding owns local priority, active/revoked state and revision.
- Unique workspace/account relation; new personal accounts are not
  automatically exposed to existing organization bindings.
- Account-global provider quota/request concurrency/cooldown; usage and review
  budgets attributed to the consuming workspace. Do not multiply capacity per
  binding. No full-agent-run mutex or `executionSlotsPerAccount` setting.
- A personal pool is the user's catalog; an organization's runtime pool is a
  policy-filtered selected set, not ownership of the user's credentials.
- Current provider-derived personal workspace slugs are not the stable user
  account ID. Establish the user/personal-scope relation deliberately; don't
  infer ownership from a slug or mutable GitHub login.

### Accepted follow-up policy intent; implementation in contract 53

- An owner/admin of the organization may attach their own personal account.
  Attach requires both personal ownership and organization authority.
- Personal master name/auth/global disable is controlled by its owner. Org
  admins may detach or change local use priority but not reauthorize it.
- Org-owned accounts are administered by org owner/admin and initially stay
  within that organization. No ownership transfer or org-to-org sharing.
- Canonical rename is reflected on the next authorized read/refetch. Reconnect
  updates credential revision and invalidates old execution authority; active
  sharing relations persist if their permissions remain valid.
- Routine engine OAuth refresh is distinct from owner reconnect; it has one
  writer and must not revoke all organization bindings on each token refresh.
- Initially the donor keeps required owner/admin authority. Losing that role or
  membership revokes their personal share in that organization. Rejoin does not
  automatically restore it. Offer/approve sharing by ordinary members is a
  later policy/UX extension, not an implicit commitment from the owner.
- Follow the existing explicit RR workspace-membership policy in architecture 29. Live RR membership/role and binding revisions authorize admission; removal
  or downgrade invalidates its authority. GitHub App installation or GitHub org
  membership alone does not grant access. External GitHub membership sync is a
  separate optional policy, not a prerequisite or a new baseline scope request.
- Detach X preserves personal/Y. Global disable/tombstone denies new dispatch
  everywhere and preserves audit history. Already accepted upstream effects
  cannot be undone by revocation.
- UI shows origin, canonical name, safe connection status and editable actions.
  It does not reveal another organization's prompts, repositories or usage.

### UI ownership

**Accounts:** personal and org-owned connections, connect/reconnect/disable,
attach/detach selected personal accounts, safe status and ownership indicators.

Own MiMo/OpenRouter BYOK connections do not require a discretionary grant to the
operator's shared pool. Workspace role and normal product entitlement checks
still apply. Access to an operator-managed shared pool remains explicitly granted
to selected workspaces; personal BYOK does not make that pool public.

**Models/repositories:** account/profile/default/override selection and applying
settings to selected repositories with partial-failure status. The new mode
changes server-side bindings/config; it does not batch-copy upstream keys into
GitHub secrets.

Reuse shared controls and the existing repository-selection/batch components.
Use server-side authorization/first paint and React Query only for interactive
cached reads/mutations. Secrets and permission checks stay server-side.

## 4. Mandatory provider delivery and replacement

Codex-through-Sub2API is mandatory: real MiMo CLI/tools/final/publication at
D-min, full UI and lifecycle at D-final, then protected Codex OAuth F.
OpenRouter E stays required before G. S delivers operator shared grants after D;
it is separate from own BYOK and H personal sharing. Claude and other agents
retain explicit qualification rather than a universal compatibility promise.

The owner permits breaking replacement without old credentials/history/grants
migration or a coexistence adapter. The retirement/refresh/effect/custody gates
are [contract 53 sections 7–8](./53-account-gateway-implementation-contract.md#7-custody-and-account-lifecycle).
Keep existing tenant FKs/AAD while legacy code exists. Old authority is retired
only after D/E/F and release receipts; no automatic revival on rollback.

Implementation boundary, API/state, refresh/birth identity, replay/fencing and
CI trust are [contract 53](./53-account-gateway-implementation-contract.md).
The former illustrative interfaces and independently editable runtime rules
have been removed. Product-owned cohesive ports and optional static SDK
composition remain the accepted design, with no generic platform prerequisite.

## 5. NONNORMATIVE estimates and provenance

Historical estimates below describe their original scope; they are not a budget
ceiling or evidence of implementation. Plan 51 records the revised forecast.
All source verification statements below are earlier authors' observations,
not a Git/remote observation in this isolated linked worktree. Historical fast
receipts are retained; subsequent work uses default tier, NO FAST.

### Historical effort and scope boundaries

The earlier 4–9k production /3.3–7k tests budget already included the private
service, narrow control adapter, own Accounts/Models/repository/batch UI and RR
CI integration for MiMo/OpenRouter BYOK. HTTP isolation/client/ports are part of
that service/adapter work, not a second platform added on top.

- Sharing follow-up: the prior worker estimated +1.5–2.8k production and
  +1.6–3k tests at the bounded initial policy. The subsequently suggested
  external GitHub membership adapter is not part of the default scope: current
  RR membership is explicit. Preparation is a subset, not an extra sharing fee.
- New Codex/Claude subscription profiles: prior estimate +2–4k production and
  +2–4k tests is conditional on qualification. Protected engine OAuth custody
  work and unresolved provider repairs are not an already-proven ceiling.
- Migration of existing Codex state/history and a coexistence layer are excluded
  by the owner. New connections, retirement of old authority and genuine
  Codex-through-Sub2API still need proof.
- Packaging/Get Modular adoption and dev-tool profile wiring add bounded work;
  do not count the existing HTTP client/schema/ports twice. The concrete plan
  separates this increment from the prior service/UI/CI estimate. A fresh npm
  version does not prove a consumer has qualified its artifact or toolchain.

Do not build a universal scheduler, protocol translator, multi-language SDK
family, per-org engine instance/admin, plugin platform, generic governance or
cross-product credential sharing before a real use case requires it.

### Historical sources and provenance

Current main was verified as `99f5e97c16b7bce47b4cfe196c1d8e462c92f6d3`.
Existing local checkout is older and has unrelated changes; this document does
not assert that main's hosted account module is present in that checkout.

- ADR-029 and account plan 49 at that main establish hosted custody and legacy
  boundaries; ADR-005 establishes application-owned ports.
- Main `schema.prisma:1657–1687`, `account-pool.ts:148–167` and
  `credential-envelope-vault.ts:428–445` show existing Codex tenant/crypto fences.
- Prior Sub2API candidate: v0.2.11 commit
  `96f4c115c9749078f90cbf210a01d39baf3f53b6`; profile support and stock private
  storage behavior were inspected against that candidate. This is a pin for
  evidence, not a promise to deploy an outdated release without requalification.
- The bounded personal-pool audit completed in hosted runtime with
  gpt-6.1-sol/high/fast. Its estimates are engineering ranges, not measured future
  diffs. This specification extends it with the owner's accepted service target
  and explicit custody/cutover requirements.
- Main architecture 29 establishes explicit RR workspace membership after
  initial owner setup; external GitHub membership synchronization is future work.
- Get Modular main `4b56072ec6ca269fb16e3fdf131d31423af804bd` separates Core,
  optional Assembly and Host responsibilities. Engineering Foundation main
  `9843822e6c10c4b805cf2bb95fc0f43e5211edeb` separates dev tooling from product
  runtime. Exact package versions and docs-protocol status are recorded in the
  implementation plan; no dependencies are installed by this document.
