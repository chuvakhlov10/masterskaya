# Yandex Cloud Function: storage gateway

The storage gateway is the only component that communicates with the private data repository. Browsers use signed device sessions and cannot send repository credentials.

Security properties:

- accepts browser requests only from `https://chuvakhlov10.github.io`;
- uses a GitHub App installed only on `masterskaya-data`;
- requests short-lived installation tokens limited to repository contents;
- permits application data access only to `data/*.json`, `photos/**/*.txt`, and read-only `status.json` on `data-backups`;
- keeps device, pairing and recovery state in protected `auth/*.json` files;
- stores only hashes of pairing and recovery codes;
- verifies the device registry before renewal and every data request;
- rotates a recovery code after every successful redemption;
- never returns or logs the GitHub App private key, installation token or session secret.

## Yandex Cloud settings

- Runtime: Node.js 22
- Entry point: `index.handler` from the generated single-file bundle
- Memory: 128 MB
- Timeout: 30 seconds
- Public function: enabled
- Upload: generated `dist/yandex/storage/index.js`
- Do not use `?integration=raw`

Environment variables:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY_B64`
- `MASTERSKAYA_SESSION_SECRET` (the same value as in the Ably function)
- `MASTERSKAYA_SESSION_VERSION=2`

Do not send secret values in chat or commit them to the repository.

## Browser protocol

Unauthenticated actions:

- `pairing-redeem` — exchange a ten-minute pairing code for a device session;
- `recovery-redeem` — restore access and atomically receive a replacement recovery code.

Authenticated actions use `X-Masterskaya-Session`:

- `renew` — rotate the 30-day session;
- `github` — restricted data read/write;
- `session-check` — verify that the device remains active;
- `devices` — list devices;
- `pairing-create` — create a one-time pairing code;
- `recovery-rotate` — create or replace the offline recovery code;
- `device-rename` and `device-revoke` — manage registered devices.

The function URL is public by design. Authentication is enforced by signed sessions or one-time codes; CORS is an additional browser boundary.

## Large journal responses (gateway 1.5.5)

Successful JSON responses of at least 128 KiB are gzip-compressed when this
reduces their size, then returned using `isBase64Encoded: true` and
`Content-Encoding: gzip`. Cloud Functions decodes the outer base64 envelope;
HTTP clients decompress gzip before parsing the unchanged JSON. Existing PWA
clients, signed device sessions, protocol 4, epoch and GitHub SHA remain valid.
Small responses, errors and CORS preflight retain their previous format.

This avoids the 3.5 MiB invocation-response ceiling, including JSON escaping
of GitHub's base64 line breaks. Request/upload limits are unchanged. Monthly
archive planning remains necessary as the hot journal continues to grow.

Gateway 1.5.6 reads the active journal from the raw GitHub Contents endpoint.
The response retains the same base64 format. The gateway computes the Git blob
SHA from the exact file bytes so clients can still use it for conditional writes.

Build with Node.js 22 using `npm run build:functions && npm run verify:functions`.
Upload **only** `dist/yandex/storage/index.js` (or a ZIP containing just `index.js`)
as a new version of the existing storage function. Keep Node.js 22,
`index.handler`, memory, timeout, environment variable bindings, service account
and access settings from the active version. Do not generate new session secrets,
change session version/epoch, or upload the Ably bundle for this fix. After deploy,
health must report storage version 1.5.6. An existing paired device must read the
journal and drain its outbox; health alone does not establish successful sync.

For repeatable deployment without browser login, configure the
[GitHub Actions deployment workflow](../docs/YANDEX_STORAGE_DEPLOY.md) once.
Its secret is `YC_SA_JSON_CREDENTIALS` in GitHub Actions, not a device session or
an application GitHub App key. Production deployment remains explicitly invoked.
