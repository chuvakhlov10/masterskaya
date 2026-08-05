# Yandex Cloud Function: Ably authentication

This function issues one-hour Ably JWTs for the workshop application. Every request must contain a valid signed device session, and the function confirms the device against the storage gateway before issuing a Live token.

Security properties:

- accepts browser requests only from `https://chuvakhlov10.github.io`;
- accepts only `X-Masterskaya-Session` as the authorization credential;
- reads the permanent Ably key only from server environment variables;
- limits JWT capabilities to `publish` and `subscribe` on `masterskaya-sync`;
- fails closed if the registry cannot be checked or the device is revoked;
- does not log or return the session secret or Ably key.

## Yandex Cloud settings

- Runtime: Node.js 22
- Entry point: `index.handler` from the generated single-file bundle
- Memory: 128 MB
- Timeout: 10 seconds
- Public function: enabled
- Upload: generated `dist/yandex-functions/ably/index.js`
- Do not use `?integration=raw`

Environment variables:

- `ABLY_API_KEY`
- `MASTERSKAYA_SESSION_SECRET` (the same value as in the storage gateway)
- `MASTERSKAYA_SESSION_VERSION=2`
- optional `MASTERSKAYA_STORAGE_GATEWAY_URL`

The browser sends its normal `Origin`, `X-Masterskaya-Session`, and JSON body `{ "clientId": "<device client id>" }`.
