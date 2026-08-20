# Repository Review Investigation Rollout

Use the operator API to enable or roll back Review Investigation flags for one
repository. The API copies the latest effective review configuration into a new
immutable repository version and changes only the six rollout flags. It never
changes a workspace or global configuration.

The operator credential, repository selection, rate limits, and audit behavior
are the same as the Review Configuration operator API. Do not edit the database
directly.

## Read Current State

```bash
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer $REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL" \
  "https://api.reviewrouter.example.com/api/operator/v1/review-config?repo=OWNER/REPOSITORY"
```

Keep `result.repositoryVersion` and `result.investigationRollout` for the next
write and possible rollback. `repositoryVersion` is `null` when the effective
configuration is inherited from the workspace or default.

## Enable A Disposable Canary

This example enables recording, shadow execution, and the context critic while
leaving verified-clean, replay, and production effects disabled. It proves the
critic path without allowing investigation output to affect the published
review:

```bash
curl --fail-with-body --silent --show-error \
  --request PUT \
  --header "Authorization: Bearer $REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL" \
  --header "Content-Type: application/json" \
  --data '{
    "repository": "OWNER/REPOSITORY",
    "expectedCurrentVersion": null,
    "investigationRollout": {
      "recordingEnabled": true,
      "shadowEnabled": true,
      "contextCriticEnabled": true,
      "verifiedCleanEnabled": false,
      "crossRevisionReplayEnabled": false,
      "productionEffectsEnabled": false
    },
    "reason": "disposable canary"
  }' \
  "https://api.reviewrouter.example.com/api/operator/v1/review-config/investigation-rollout"
```

Replace `expectedCurrentVersion` with the exact repository version returned by
the preceding read. A stale value returns `configuration_changed` and writes
neither a configuration version nor an audit event.

Read the state again after the write and verify the repository, version, and all
six flags before starting the canary.

## Roll Back

Send the six flags captured before enablement and use the repository version
returned by the enable response as `expectedCurrentVersion`. Rollback uses the
same endpoint and creates another immutable, audited repository version.

The dependency lattice is enforced on both enable and rollback:

- shadow requires recording
- critic requires shadow
- production effects require shadow and critic
- verified clean requires critic and production effects
- cross-revision replay requires shadow

API responses use `Cache-Control: no-store`. Never put the operator credential
in the URL, request body, reason, logs, or shell history.
