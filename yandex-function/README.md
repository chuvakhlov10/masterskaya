# Yandex Cloud Function: Ably authentication

This function issues short-lived Ably JWTs for the workshop application hosted at:

`https://chuvakhlov10.github.io/masterskaya/`

Security properties:

- accepts browser requests only from `https://chuvakhlov10.github.io`;
- verifies that the supplied GitHub token has write access to the private `masterskaya-data` repository;
- reads the permanent Ably key only from the server-side `ABLY_API_KEY` environment variable;
- issues a one-hour JWT limited to `publish` and `subscribe` on `masterskaya-sync`;
- does not log or return the GitHub token or Ably key;
- has no external npm dependencies.

## Yandex Cloud settings

- Runtime: Node.js 22
- Entry point: `index.handler`
- Memory: 128 MB
- Timeout: 10 seconds
- Service account: not required
- Environment variable: `ABLY_API_KEY=<full Ably API key>`
- Public function: enabled

Upload a ZIP archive with `index.js` at the archive root. Do not use `?integration=raw`; the function relies on the standard HTTPS event and response format.

The client must send:

- `Origin: https://chuvakhlov10.github.io` (set automatically by the browser);
- `X-Masterskaya-GitHub-Token: <GitHub token>`;
- JSON body: `{ "clientId": "<device client id>" }`.

Yandex Cloud Functions removes the standard inbound `Authorization` header for direct HTTPS invocation, so the function deliberately uses a narrowly named custom header.
