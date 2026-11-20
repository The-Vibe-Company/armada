# Antigravity runtime artifact

Armada pins the Google Antigravity CLI **1.5.13** Linux glibc tarballs for x64 and arm64.
Both archives are published by SHA-256 to the Armada runtime artifact store.
Docker and Modal prewarm their shared cache from a separate manifest
projection. Antigravity is served on demand and omitted from that projection.
Preparation verifies the archive before extracting the executable and checks the
executable's own SHA-256 and length on every cache hit. Launch integration is
tracked in #3674.

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
