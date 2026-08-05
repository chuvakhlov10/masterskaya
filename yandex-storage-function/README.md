# Yandex Cloud Function: GitHub App storage gateway

This standalone function removes the permanent GitHub PAT from the workshop browser application and supports one-time pairing of new devices.

Security properties:

- accepts browser requests only from `https://chuvakhlov10.github.io`;
- uses a GitHub App installed only on `masterskaya-data`;
- requests one-hour installation tokens limited to repository `masterskaya-data` and `contents: write`;
- permits browser data access only to `data/*.json`, `photos/**/*.txt`, and read-only `status.json` on `data-backups`;
- stores the device registry and hashed one-time pairing records in internal `auth/*.json` files that browser data requests cannot address;
- issues signed 30-day device sessions;
- creates 12-character pairing codes with about 60 bits of entropy, valid for ten minutes and consumed once;
- checks the device registry before renewal and every data request; revoked devices are denied;
- exposes an authenticated `session-check` action so the separate Ably function can deny revoked devices before issuing a Live token;
- keeps the legacy PAT bootstrap action only as a temporary rollback path during migration;
- never returns or logs the GitHub App private key, installation token, session secret, bootstrap PAT, or raw pairing code after creation;
- has no external npm dependencies.

## Yandex Cloud settings

Use the existing function named `masterskaya-storage-gateway`.

- Runtime: Node.js 22
- Entry point: `device-index.handler`
- Memory: 128 MB
- Timeout: 30 seconds
- Service account: not required
- Public function: enabled
- Upload: ZIP archive with `index.js`, `pairing-index.js`, `device-index.js`, and `device-auth.js` at the archive root
- Do not use `?integration=raw`

## Environment variables

Keep the existing four variables unchanged:

- `GITHUB_APP_ID=4488480`
- `GITHUB_APP_PRIVATE_KEY_B64=<base64 of the downloaded .pem file>`
- `MASTERSKAYA_SESSION_SECRET=<the same shared secret used by the Ably function>`
- `MASTERSKAYA_SESSION_VERSION=2`

Do not send secret values in chat and do not commit them to GitHub.

## Browser protocol

All calls use `POST` with standard Yandex HTTPS integration.

Unauthenticated new-device request:

- action `pairing-redeem`;
- body includes the one-time `code`, new `clientId`, and device name.

Authenticated requests use header `X-Masterskaya-Session` and support:

- `renew` — rotate the 30-day session;
- `github` — restricted data read/write;
- `session-check` — confirm that the device is still active;
- `devices` — list connected and revoked devices;
- `pairing-create` — create a ten-minute one-time pairing code;
- `device-rename` — rename a device;
- `device-revoke` — revoke another device.

The transitional `bootstrap` action still accepts `X-Masterskaya-GitHub-Token`, but the final browser client does not need a PAT. The function URL is public by design; CORS is an additional boundary, not authentication.
