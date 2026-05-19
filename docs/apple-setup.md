# Apple Developer setup

What to register at [developer.apple.com](https://developer.apple.com) to enable Sign in with Apple
for macroscape-proxy, and which pieces are currently consumed by the proxy vs. deferred.

## Currently required

The proxy verifies id_tokens issued to the **native iOS app** by Apple's native Sign in with Apple
flow. The only registration required for current proxy operation is on the iOS side:

- **App ID** for `app.macroscape.MacroScape` with the **Sign in with Apple** capability enabled
  (configured in the Xcode project + at developer.apple.com → Identifiers → App IDs).

That's the entire required set. The `aud` claim in the resulting id_token matches the App ID's
Bundle ID; the proxy verifies against `APPLE_AUD = "app.macroscape.MacroScape"` (set in
`lib/macroscape-proxy-stack.ts`). If the iOS Bundle ID is ever changed, `APPLE_AUD` must change in
lockstep.

## Deferred (recommended pre-launch prep)

For _future_ proxy features — token revocation (when a user deletes their MacroScape account),
server-initiated refresh, accepting web-flow tokens — the proxy will need to sign a `client_secret`
JWT against Apple's `/auth/token` and `/auth/revoke` endpoints. That requires three additional
values plus a private key. Register them now so deploys aren't blocked when those features land.

### Team ID

10-character string. Find it at developer.apple.com → **Membership** → "Team ID."

### Services ID

A separate identifier from your App ID, used as the `client_id` when calling Apple's server
endpoints. Typical convention: `<bundle>.signin` (e.g., `app.macroscape.MacroScape.signin`).

1. developer.apple.com → Identifiers → "+" → **Services IDs**
2. Description: e.g., "MacroScape Sign in with Apple"
3. Identifier: e.g., `app.macroscape.MacroScape.signin`
4. Enable **Sign in with Apple**, configure the primary App ID, set Return URLs (use
   `https://api.macroscape.app/v1/anthropic/auth/return` as a placeholder; will be wired when
   web-flow lands)

### Key (the `.p8` file)

The private key the proxy uses to sign `client_secret` JWTs that authenticate it to Apple.

1. developer.apple.com → **Keys** → "+"
2. Key Name: e.g., "MacroScape Sign in with Apple Key"
3. Enable **Sign in with Apple**, select the primary App ID
4. Download the `.p8` file (**one-time only** — Apple won't let you re-download)
5. Note the **Key ID** (10-character string shown on the key's detail page)

### Storing the key

Upload the full `.p8` file contents (the entire `-----BEGIN PRIVATE KEY-----` block, newlines
included) to the existing Secrets Manager entry:

```sh
aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id macroscape-proxy/apple-signin-private-key \
  --secret-string "$(cat AuthKey_XXXXXXXXXX.p8)"
```

(Where `XXXXXXXXXX` is the Key ID.)

The Lambda already has `secretsmanager:GetSecretValue` permission on this ARN (MSP005 + MSP021); no
redeploy needed after population.

### When the three IDs become env vars

`APPLE_TEAM_ID`, `APPLE_SERVICES_ID`, and `APPLE_KEY_ID` will be plumbed through
`lib/macroscape-proxy-stack.ts` when the first code path that needs them lands — likely with token
revocation. Until then, the registrations above are one-time prep work; no proxy redeploy is
required.

## Notes

- The current proxy `aud` check (`app.macroscape.MacroScape`) is for the **iOS native** flow only.
  Web-flow tokens have `aud = <Services ID>`, so when web-flow is added, the verifier will need to
  accept both audiences (or branch on context).
- The `.p8` file is **single-download**. If lost, generate a new key at developer.apple.com (no
  other harm done) and overwrite the Secrets Manager entry.
- Keep the `.p8` file off disk after upload — it's now in Secrets Manager and shouldn't live in your
  home directory.
