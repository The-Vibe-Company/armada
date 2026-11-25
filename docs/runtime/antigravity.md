# Antigravity runtime

Armada pins the Google Antigravity CLI **1.5.13** Linux glibc tarballs for x64 and arm64.
On Modal and Docker, the runtime downloads the tarball directly from the Google
release URL in the pin when it first prepares Antigravity. Cold starts need
HTTPS access to `storage.googleapis.com`. The runtime checks the tarball's SHA-256
and length before extracting it, then verifies the executable on every cache hit.
The official sandbox image and Armada runtime artifact store omit these tarballs.

## Launch on Modal or Docker

Use a Gemini Developer API key from hidden input, stdin or a private file. The
account command prints no credential material. Use the ID shown by
`armada account ls --json`.

```sh
armada account add antigravity --name gemini --file /private/gemini-key
armada new starter --provider modal --agent antigravity --credential-id "$account_id" --model default 'Reply with armada-antigravity-ok'
armada new 'Reply with armada-antigravity-ok' --provider docker --host workstation --agent antigravity --credential-id "$account_id" --model default
```

To import a native Google login, use
`armada account import antigravity --name google --file /private/antigravity-oauth-token`.
The token file contains a `token` object with `access_token`, `refresh_token` and
optional ISO 8601 `expiry`. Keep key and token values out of command arguments.

Use model `default` to accept the account's selection, or pick one of the
verified Antigravity `1.5.13` Gemini 4 model IDs (`gemini-4-neon-{low,medium,high,xhigh}`,
`gemini-4-hydrogen-{low,medium,high,xhigh}`, `gemini-4-argon-{low,medium,high}`,
`gemini-4-carbon-{low,medium,high}`) with `reasoningEffort: "default"`. Armada
has no prices for them.
Boat refuses Antigravity before provider access. The server seals the selected
credential for private runtime enrollment. Follow-ups work in a running
sandbox. Conversation restore after stopping the sandbox is unsupported.

## Coordinator staging check

With a Gemini API-key account and model `default`, repeat on Modal and the
owner's Docker host. Check the first reply, a follow-up in the same conversation,
interrupt, and an Armada MCP tool call. The pinned CLI advertises no
`mcpCapabilities`, so verify delivery with an actual tool call. Confirm the
account secret is absent from logs, events, and exec output.

## Bump the pin

1. Read Google's updater manifests at
   [linux_amd64.json](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json)
   and [linux_arm64.json](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_arm64.json).
2. Download each manifest URL and compare the tarball's SHA-512 with the manifest
   using `sha512sum`. Use `sha256sum` and `wc -c` on each archive and its extracted
   `antigravity` member. Update the version, URLs, hashes and byte lengths in
   `packages/agent-runtime/src/antigravity-artifact.ts`.
3. Repeat the offline-auth ACP spike below with the new binary. Keep the pinned
   binary and temporary profile out of Git.

## ACP spike

On Linux x64, using the verified 1.5.13 binary and a fresh empty profile:

```sh
AGY_CLI_DISABLE_AUTO_UPDATE=1 TMPDIR="$tmp/scratch" \
  ./antigravity acp --gemini-dir "$tmp/profile" --app-data-dir antigravity-acp
```

Sent one JSON-RPC line on stdin:
`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}`.
The reply arrived **0.112 s** after process start. The extracted executable was
270,103,240 bytes and the unpack directory used 270,110,720 bytes on disk
(`du -sB1`). The dedicated `TMPDIR` used 4,096 bytes at initialize, the size of
the empty scratch directory. That measurement covers startup through initialize.

```json
{
  "jsonrpc": "2.0",
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "load_session": true,
      "promptCapabilities": {
        "image": true,
        "audio": false,
        "embeddedContext": true
      },
      "sessionCapabilities": {
        "resume": {},
        "close": {},
        "load": {},
        "list": {},
        "additionalDirectories": {}
      },
      "session_capabilities": {
        "resume": {},
        "close": {},
        "load": {},
        "list": {},
        "additionalDirectories": {}
      },
      "auth": {
        "logout": {}
      },
      "_meta": {
        "antigravity": {
          "tier": true,
          "systemPrompt": {
            "append": true
          }
        }
      }
    },
    "agentInfo": {
      "name": "Antigravity ACP Server",
      "version": "1.5.13"
    },
    "authMethods": [
      {
        "id": "oauth-personal",
        "name": "Log in with Google",
        "description": "Log in with your Google account"
      },
      {
        "id": "oauth-business",
        "name": "Log in with Gemini Enterprise",
        "description": "Log in with your Gemini Enterprise account"
      },
      {
        "id": "gemini-api-key",
        "name": "Gemini API key",
        "description": "Use an API key with Gemini Developer API"
      },
      {
        "id": "agent-platform",
        "name": "Gemini Enterprise Agent Platform",
        "description": "Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials"
      }
    ]
  },
  "id": 1
}
```

`session/new` with an empty MCP server list and the temporary working directory
returned `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Authentication required"},"id":2}`.
No sign-in was attempted.

## Connect Antigravity

Run `armada account login antigravity --name google`. Open the Google link in any
browser, then paste the code or callback URL into the terminal within five minutes.
Armada runs the pinned login executable on the server and prints the saved account's
metadata. For an organization-owned account, add `--org <name>` as an org admin.
To replace an account, use `--id <id> --expected-version <version>` in place of
`--name`. If the session expires or reaches a different server instance, start
sign-in again.
