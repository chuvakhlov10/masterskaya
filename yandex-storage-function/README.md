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
- Upload: generated `dist/yandex-functions/storage/index.js`
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
