# CLI GitHub authorization through the registered dashboard callback

The CLI reuses the existing GitHub App callback **`https://armada.thevibecompany.co/github/callback`**. No additional backend callback registration or GitHub settings/sudo step is needed in production. The person still completes GitHub's normal sign-in/authorization consent; a returned URL alone is not a grant.

## Backend configuration

`ARMADA_DASHBOARD_URL` is an optional, separately administrator-configured **origin**, defaulting to `https://armada.thevibecompany.co`. It is independent of `ARMADA_PUBLIC_URL`/the MCP server origin. Self-hosting must explicitly set the dashboard's already-registered origin. Userinfo, paths, query strings and fragments are rejected. HTTPS is required; loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`) is permitted only with `NODE_ENV=development`.

The backend uses exactly `<validated dashboard origin>/github/callback` in **both** GitHub authorize and code exchange requests. It never trusts a request-body return/redirect URL. The normal dashboard GitHub flow, state cookie and installation policy are unchanged.

## CLI dialect and frontend relay contract

CLI-created high-entropy states begin with **`armada_cli_`** followed by two random UUIDs. Only their SHA-256 hashes are stored in the existing server-only `github_authorizations` table. The authenticated initiating account, expiration, one-use claim and serialized publication/disconnect fencing remain server-owned.

Opus522 owns the existing dashboard `/github/callback` route:

1. Only an `armada_cli_` state enters the CLI branch.
2. Relay `{state,code}` server-side to the configured `ARMADA_MCP_URL` origin's canonical endpoint below, with `Content-Type: application/json`. Do not forward cookies or an Armada bearer, and do not follow redirects.
3. Show a fixed “Return to the CLI” success page or fixed `/settings?github=connected` target on real success, otherwise a fixed failure. Do not echo state, code or upstream errors. A failed CLI relay must not fall through to normal web-cookie handling.
4. Non-prefixed states retain the original web state-cookie/session/installation policy. No public callback proxy allowlist entry is needed: this is a direct server-to-server relay.

```http
POST /api/v1/github/oauth/callback
Content-Type: application/json

{"state":"armada_cli_<private-flow-nonce>","code":"<one-time-GitHub-code>"}
```

The endpoint is public because the private, one-use, hash-matched state binds the account; it does not use API bearer/cookie authentication. It accepts only the two string fields in an at-most **8192-byte UTF-8 JSON body**, rejects duplicate/escaped-duplicate keys, unknown fields, query parameters, invalid media types/lengths and invalid state/code shapes. State must match the CLI dialect and a live pending database hash before code exchange. Unknown, expired, superseded and replayed callbacks do not claim a flow or exchange a code.

Success is fixed `200 {"ok":true,"status":"connected"}` after fenced encrypted-grant publication. Invalid or failed callbacks return fixed `400 {"ok":false,"status":"failed"}` without raw upstream/database errors, account identifiers or a redirect target. Responses are no-store/no-referrer. GET transport compatibility remains for exactly one `state` and `code` query parameter, with the same CLI-prefix/hash/expiry/one-use rules. Prior unprefixed in-flight CLI authorizations must restart; they are not mistaken for a normal dashboard flow.

The CLI continues polling its authenticated, owner-bound flow/status API. A browser handoff or relay failure is never fabricated as successful connection. Grants remain encrypted in the existing vault columns; codes and raw state are never stored or accepted on CLI argv.

## Regression ownership

`github-account-api.test.ts` uses the real HTTP handler, migrations/SQL and injected upstream HTTP. It covers the configured/default registered URI, authorize/exchange URI equality, ignored body return URLs, actor binding, public POST relay, malformed/duplicate/oversized input that does not consume a pending flow, exact-prefix fencing even for a seeded non-CLI pending hash, replay, supersession, expiry, GET compatibility, disconnect during exchange, encrypted grants and sanitized upstream failure. `config.test.ts` owns origin/default/development validation. The frontend relay/normal-web-flow regression remains owned by Opus522.

Backend validation: full verify passed (420 pass, 4 skip, 0 fail; 424 tests across 73 files). Standalone CLI/server builds, linux-x64 artifacts and npm/Bun tarball/bin smoke passed. The native repository cwd/metadata and CAS/org repairs were unchanged by this delta. Production one-URL acceptance still requires the independently owned frontend relay to be deployed; the backend does not pretend that opening an authorization URL completed user consent.
