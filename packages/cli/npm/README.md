# @the-vibe-company/armada

The `armada` command line: launch coding agents (Claude Code, Codex) on [boat.dev](https://boat.dev) sandboxes from a golden snapshot, and drive them through Armada's remote MCP server.

```sh
npx @the-vibe-company/armada --help
bun x @the-vibe-company/armada --help
npm install --global @the-vibe-company/armada && armada --help
```

The package ships a prebuilt binary for linux and macOS, x64 and arm64, as an optional dependency per platform (`@the-vibe-company/armada-<os>-<arch>`). Node 18 or later, or Bun, runs the small launcher; the binary needs neither. Do not install with `--omit=optional`.

Documentation: [github.com/The-Vibe-Company/armada](https://github.com/The-Vibe-Company/armada#readme).
