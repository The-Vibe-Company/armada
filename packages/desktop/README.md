# Armada desktop shell

`@armada/desktop` is a private Electron shell built with electron-vite. The root
`packages/*` workspace includes it. Electron is a dev dependency here only; it
never enters the published CLI. The browser app and daemon have no Electron
imports and can still run together in a browser.

From the repository root, after `bun install`:

```sh
ARMADA_DESKTOP_PROJECTS=/absolute/path/projects.json bun run desktop
```

The catalog is armadad's existing JSON array, for example:

```json
[{ "id": "orchard", "name": "Orchard", "repository": "example/orchard" }]
```

Use the same project IDs and existing event database as your local readers to
see the real fleet. Set `ARMADA_DESKTOP_DATABASE=/absolute/path/fleet.sqlite`
to open that log. Without overrides, the catalog is `projects.json` and the log
is `fleet.sqlite` under Electron's `app.getPath("userData")` for Armada
(`~/Library/Application Support/Armada` on macOS). The catalog must already
exist; project onboarding belongs to the app. An empty array opens an empty
fleet. The shell does not seed synthetic data or poll external services.

`bun run desktop` builds the existing app, bundles the main process and daemon,
then launches Electron. Run it again after source edits. `bun run build:desktop`
builds without opening a window. This is a source checkout launcher, not an
installer or auto-updater.

The shell spawns its own Electron executable in Node mode to run the bundled
armadad entry (including the daemon's dependencies), so it needs no separate
Node installation. It passes `--port 0`: the OS chooses a free loopback port,
without a reserve/release race. The daemon's one readiness JSON line supplies
both addresses. Only then does one sandboxed, isolated window open on the
built app served by that daemon, with `?daemon=ws://127.0.0.1:<allocated-port>/`.
There is no preload or IPC bridge. New windows and cross-origin navigation
are refused; the renderer has no Node access.

Closing the last window, choosing Quit, or receiving SIGINT/SIGTERM stops the
child before exiting Electron, on macOS too. Startup failure exits with a short
console error. Startup is bounded to 15 seconds; shutdown first sends SIGTERM
for the daemon to close its sockets and SQLite, then escalates to SIGKILL after
five seconds if needed. An unexpected daemon exit closes the shell with a
failure code. A hard OS kill cannot run quit handlers.

The shell starts armadad with `--restartable`. The app's Restart (on the Plugins
screen) makes the daemon close and exit with code 75 (`RESTART_EXIT_CODE`), and
the shell starts it again on the same port, so the app's socket reconnects and
resumes as after any drop. If that port was taken in the meantime, the daemon
starts on a new one and the window reopens at its address (`restartDaemon`).

`bun run test:desktop` runs Node lifecycle tests against the real daemon in
temporary directories, checking readiness and static serving, graceful shutdown
and process disappearance, a restart on the same port (or another when it is
taken), failed startup, quit during startup, and deadline
cleanup of an unresponsive child. Root `bun run verify` includes these Node
tests through `test:daemon`; the Bun suite also discovers them. The root
TypeScript gate includes this package and its electron-vite configuration.

For a macOS acceptance pass: point the command above at your real catalog/log,
confirm the window shows that fleet, then press Cmd+Q. The daemon's PID must no
longer exist. Linux CI verifies the child lifecycle; macOS window behavior needs
a Mac.
