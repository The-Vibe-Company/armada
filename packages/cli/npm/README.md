# @thevibecompany/armada

The `armada` command line: launch coding agents (Claude Code, Codex) on [boat.dev](https://boat.dev) sandboxes from a golden snapshot, and drive them through Armada's remote MCP server.

```sh
npx @thevibecompany/armada@next --help
bun x @thevibecompany/armada@next --help
npm install --global @thevibecompany/armada@next && armada --help
```

The package ships a prebuilt binary for linux and macOS, x64 and arm64, as an optional dependency per platform (`@thevibecompany/armada-<os>-<arch>`). Node 18 or later, or Bun, runs the small launcher; the binary needs neither. Do not install with `--omit=optional`.

Documentation: [github.com/The-Vibe-Company/armada](https://github.com/The-Vibe-Company/armada#readme).
