# Ably auth: device revocation check

The Ably function validates every signed workshop session against the storage gateway device registry before issuing a new one-hour JWT.

Use the existing `masterskaya-ably-auth` function with:

- Runtime: Node.js 22
- Entry point: generated `index.handler`
- Memory: 128 MB
- Timeout: 10 seconds
- Public function: enabled

Keep these environment variables aligned with the storage gateway:

- `ABLY_API_KEY`
- `MASTERSKAYA_SESSION_SECRET`
- `MASTERSKAYA_SESSION_VERSION=2`

The function fails closed when the registry is unavailable, the session is invalid, or the device has been revoked. There is no secondary browser credential path.
