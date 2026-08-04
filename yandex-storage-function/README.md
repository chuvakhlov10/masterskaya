# Yandex Cloud Function: GitHub App storage gateway

This standalone function removes the permanent GitHub PAT from the workshop browser application.

Security properties:

- accepts browser requests only from `https://chuvakhlov10.github.io`;
- uses a GitHub App installed only on `masterskaya-data`;
- requests one-hour installation tokens limited to repository `masterskaya-data` and `contents: write`;
- permits access only to `data/*.json`, `photos/**/*.txt`, and read-only `status.json` on `data-backups`;
- uses the current browser PAT only once to bootstrap a signed 30-day device session;
- supports session renewal without reusing the PAT;
- never returns or logs the GitHub App private key, installation token, session secret, or bootstrap PAT;
- has no external npm dependencies.

## Yandex Cloud settings

Create a separate function named `masterskaya-storage-gateway`.

- Runtime: Node.js 22
- Entry point: `index.handler`
- Memory: 128 MB
- Timeout: 30 seconds
- Service account: not required
- Public function: enabled
- Upload: ZIP archive with `index.js` at the archive root
- Do not use `?integration=raw`

## Environment variables

Set exactly these variables:

- `GITHUB_APP_ID=4488480`
- `GITHUB_APP_PRIVATE_KEY_B64=<base64 of the downloaded .pem file>`
- `MASTERSKAYA_SESSION_SECRET=<random 32-byte value encoded as base64>`
- `MASTERSKAYA_SESSION_VERSION=1`

Convert the private key to Base64 in Windows PowerShell without printing it:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\github-app-key.pem")) | Set-Clipboard
```

Generate the session secret and copy it to the clipboard:

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
[Convert]::ToBase64String($bytes) | Set-Clipboard
```

Do not send either value in chat and do not commit them to GitHub.

## Browser protocol

All calls use `POST` with standard Yandex HTTPS integration.

Bootstrap request:

- header `X-Masterskaya-GitHub-Token`: current browser PAT;
- body `{ "action": "bootstrap", "clientId": "<device id>" }`.

Authenticated requests:

- header `X-Masterskaya-Session`: signed device session;
- body action `renew` or `github`.

The function URL is public by design, but every non-bootstrap data request requires a valid signed device session. CORS is not treated as authentication.
