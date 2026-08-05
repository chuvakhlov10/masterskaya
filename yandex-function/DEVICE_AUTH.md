# Ably auth: device revocation check

The Ably token function must validate the signed workshop session against the storage gateway device registry before issuing a new one-hour Ably JWT.

Use the existing `masterskaya-ably-auth` function with:

- Runtime: Node.js 22
- Entry point: `device-aware-index.handler`
- Memory: 128 MB
- Timeout: 10 seconds
- Public function: enabled
- Upload: ZIP archive with `index.js` and `device-aware-index.js` at the archive root

Keep the existing environment variables unchanged:

- `ABLY_API_KEY`
- `MASTERSKAYA_SESSION_SECRET`
- `MASTERSKAYA_SESSION_VERSION=2`

`device-aware-index.js` calls the public storage gateway `session-check` action with the supplied signed session. It fails closed if the registry is unavailable or the device has been revoked. The storage gateway URL has a project default and can optionally be overridden with `MASTERSKAYA_STORAGE_GATEWAY_URL`.

The legacy GitHub PAT path remains only as a temporary rollback path until the browser pairing flow is physically verified.
