# Iteration 03 - Repository Sync and Workspace Dashboard

## Goal

Sync repositories from GitHub installations and show selectable repos in dashboard.

## Scope

- RepositoryConnection aggregate
- installation repository sync job
- repository selection state
- dashboard repo list
- repo details page
- authorization policies

## Concurrency

Use lock:

```text
installation:{installationId}:sync
```

## Tests

- sync creates repos
- sync updates repo metadata
- deleted/unselected repos handled safely
- duplicate sync jobs do not create duplicates
- user cannot view repo outside workspace

## Done When

- user can select a repository for ReviewRouter setup
- dashboard shows repo visibility/default branch/status skeleton
