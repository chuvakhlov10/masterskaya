# Storage deployment through GitHub Actions

`Deploy Yandex storage` installs the verified storage bundle into the existing
function `d4ep5fmjtp6t09f06tvt`. It runs only on an explicit `workflow_dispatch`
on `main`; pushing or opening a PR does not deploy the function. A dispatch is
a production release and requires the user's release authorization.

## One-time connection

1. In Yandex Cloud, create a service account for this deployment. Grant it
   `functions.editor` on the target function. If the function uses a runtime
   service account (including named service accounts), grant the deployer
   `iam.serviceAccounts.user` on those accounts so it can retain them when
   creating a version. Keep existing function settings and application secrets.
2. Create an **authorized key** (JSON) for the deployment service account. This
   is an IAM authorized key, not an Object Storage access key or an API key.
3. In `chuvakhlov10/masterskaya` open **Settings → Secrets and variables → Actions
   → New repository secret**. Set the name to `YC_SA_JSON_CREDENTIALS` and paste
   the JSON file's complete contents into the protected value field. Do not put
   it in chat, repository files, workflow inputs, or logs. Delete the downloaded
   key file from your computer after securely storing it if no longer needed.

The pinned `yc-actions/yc-iam-token` action obtains a short-lived IAM token for
each deployment and masks it. The workflow passes that token only to the deploy
step. A token in the Codex environment is not needed for this workflow. Revoke
or replace the service account key in Yandex Cloud to revoke or rotate access;
update the GitHub secret when replacing it.

## Release

Use the exact full SHA of the approved `main` commit:

```sh
gh workflow run deploy-yandex-storage.yml --ref main -f expected_commit=FULL_MAIN_SHA
gh run list --workflow deploy-yandex-storage.yml --limit 3
```

Alternatively select **Actions → Deploy Yandex storage → Run workflow**, choose
`main`, and enter that SHA. Codex can request this dispatch when its GitHub
connection has permission to run Actions. If GitHub denies Actions writes, a
repository administrator must grant that connection access or perform the
initial dispatch. Repository write access alone does not prove dispatch access.

The workflow checks out `main` and requires an exact SHA match, uses Node.js 22,
runs `npm ci` and `npm run check`, builds with commit metadata, verifies the
bundle manifest/checksum, then packages only `index.js`. Releases are serialized;
a running deployment is not cancelled by a later dispatch.

The script reads the current `$latest` version and retains runtime, entrypoint,
resources, timeout, environment variables, service accounts, concurrency,
networking, Lockbox bindings, logs, mounts, temporary storage, async invocation
and metadata settings. Unknown configuration fields stop the deployment. A
second read rejects a version changed during preflight. The API has no atomic
compare-and-swap here: avoid concurrent console deployments while this runs.

Creating a version moves `$latest` and therefore updates the existing public
function URL. Custom tags stay on their old versions. Function-level access
bindings and scaling policies are not changed. No data-repository files,
stock epoch, sessions, or device queues are edited. Active version settings and
API bodies are kept in memory and never logged or uploaded as artifacts.

## Verification and recovery

A successful run means the version-creation operation completed, `$latest`
points to the new active version, copied configuration matches, and the public
health response reports the approved build SHA, storage version and protocol.
Minimum storage protocol and stock epoch must match preflight. Repeating the
same commit does not create another version if it is already serving that build.

Unauthenticated health does not verify private repository access or device
synchronization. After release, check on an existing paired device that the
journal loads and pending stock operations drain without clearing its cache or
outbox. Keep passed code tests, deployment health, and device-sync verification
separate when reporting results.

If deployment verification fails, the workflow fails instead of claiming
success. It does not automatically roll back: a new version may already be live.
The previous version ID is printed before creating a version; use Yandex Cloud
version/tag controls to return `$latest` to it if needed, after checking current
state. Application secrets and API error payloads are never printed. Creation
requests are not automatically retried after a network failure because the API
may already have accepted them.

This workflow must pass its first real run after the key is connected before
unattended deployment can be considered verified. Local tests use mock API
responses and do not establish Yandex permissions or real deployment readiness.
