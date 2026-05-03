# Runbooks Draft

## GitHub Webhook Failing

Check:

1. webhook secret matches GitHub App settings
2. delivery exists in `GitHubWebhookDelivery`
3. signature verification error logs
4. event type supported
5. job enqueue result

## Setup PR Not Created

Check:

1. repo selected and installation active
2. GitHub App has contents/pull_requests permissions
3. default branch exists
4. existing setup PR already open
5. repo-level provisioning lock not stuck
6. `WorkflowProvisioning.errorSummary`

## Repo Missing From Dashboard

Check:

1. installation has access to repo
2. installation sync job ran
3. GitHub API rate limit
4. repository archived/deleted/renamed
5. workspace mapping correct

## Provider Setup Confusing

Check:

1. provider type selected in config
2. setup source shown correctly
3. docs link shown
4. workflow references expected secret names
5. fork PR warning shown for public repos

## Rotate GitHub App Private Key

Steps:

1. create new private key in GitHub App settings
2. update deployment secret
3. deploy/restart API/worker
4. verify installation token minting
5. revoke old private key
6. record audit/ops event
