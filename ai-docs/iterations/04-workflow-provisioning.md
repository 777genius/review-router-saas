# Iteration 04 - Workflow Provisioning

## Goal

Create a setup pull request that installs ReviewRouter workflow into selected repo.

## Scope

- WorkflowProvisioning aggregate
- action version choice: stable/release/main
- workflow YAML renderer
- generated workflow security policy
- same-repository PR trust warning and workflow hardening
- GitHub contents/branch/PR adapters
- setup PR creation
- existing PR detection
- provisioning status in dashboard

## Concurrency

Use lock:

```text
repo:{repoId}:workflow-provision
```

## Safety

- create PR by default
- do not push directly to default branch
- do not overwrite existing workflow without explicit update
- do not use `pull_request_target` for default review execution
- skip secret-backed provider execution for fork PRs by default
- show permissions failure clearly
- in production, do not create setup PRs unless the public ReviewRouter API URL
  is explicitly configured and safe

## Tests

- workflow YAML snapshot tests
- generated workflow security tests: no `pull_request_target`, fork guard, minimal permissions, `persist-credentials: false`
- setup PR creation with mocked GitHub API
- duplicate click does not create duplicate PR
- permission error is persisted and shown
- production API URL resolver rejects missing/unsafe URLs before workflow
  rendering

## Done When

- user clicks Install
- ReviewRouter creates setup PR in target repo
- dashboard shows PR link and status
