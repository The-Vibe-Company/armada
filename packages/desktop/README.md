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

The app's icon is `resources/icon.svg`, the mark on its tile, rendered as
`icon.png` (1024 px, set on the dock and the window at launch) and `icon.icns`
for a packaged build; `test/icon.test.ts` holds the three together.

`bun run desktop` builds the existing app, bundles the main process and daemon,
then launches Electron. Run it again after source edits. `bun run build:desktop`
builds without opening a window.

## Building the macOS app (THE-2229)

On an Apple Silicon Mac, from the repository root:

```sh
bun run build:desktop:dmg
```

(the same as `bun run --cwd packages/desktop dist`: the build above, then
`electron-builder --mac --publish never`). It writes, under
`packages/desktop/release/` (gitignored):

- `Armada-<version>-arm64.dmg`, the installer: open it and drag Armada to
  Applications;
- `Armada-<version>-arm64-mac.zip`, the same app zipped (the update feed's
  format, THE-2231), with `latest-mac.yml`;
- `mac-arm64/Armada.app`, the bundle itself, runnable in place.

The version is the package's (`packages/desktop/package.json`, set by hand to
the repository's release version until THE-2230 has release-please bump it);
the About panel shows it. The rules are `src/packaging.ts`,
read by electron-builder through `electron-builder.ts`: app id
`co.thevibecompany.armada`, dmg and zip for arm64, `resources/icon.icns`, the
main output in an asar with `out/main` (the daemon entry and the chunks it
imports) and the `@napi-rs/keyring` binding unpacked beside it, and the built
room (`packages/app/dist`) and `resources/icon.png` as extra resources under
`Contents/Resources`. The main process resolves those three paths through
`src/paths.ts`: under `process.resourcesPath` when `app.isPackaged`, under the
checkout otherwise (`test/packaging.test.ts` holds both). The daemon's data stays
under `app.getPath("userData")` either way, so an installed app opens the same
fleet as `bun run desktop`. A packaged build publishes nothing: the release
workflow is THE-2230.

The DMG is **unsigned** unless a certificate is named: setting `CSC_LINK`,
`CSC_NAME`, `APPLE_ID` or `APPLE_TEAM_ID` turns electron-builder's signing on
(hardened runtime, `resources/entitlements.mac.plist`: a network client, no
sandbox); without them `identity` is `null` and no certificate is looked for.
macOS quarantines an unsigned app downloaded from the web. To open one, remove
the quarantine once after copying it to Applications:

```sh
xattr -dr com.apple.quarantine /Applications/Armada.app
```

### Smoke-testing a build without touching the desktop (THE-2234)

A worker or CI never opens the app on the owner's screen: no `open -a`, no
`osascript`, no `screencapture`. The shell honours `ARMADA_DESKTOP_HEADLESS=1`
instead: it creates no window, hides its dock icon (`app.dock.hide()`), keeps
Electron's own user data in a disposable directory removed at quit, and takes
only the catalog and log it is given. Without `ARMADA_DESKTOP_PROJECTS` and
`ARMADA_DESKTOP_DATABASE` it exits with code 1 naming them: it never opens the
fleet of the account it runs under. Once its daemon is ready it prints one JSON
line on stdout, `{"headless":true,"url":…,"wsUrl":…,"windows":0,"dockVisible":false}`,
and waits for SIGTERM or SIGINT, which stop the daemon and exit with code 0.
Assertions go through the daemon's HTTP and WebSocket addresses on that line.
For a packaged build:

```sh
ARMADA_DESKTOP_HEADLESS=1 \
ARMADA_DESKTOP_PROJECTS=/tmp/smoke/projects.json \
ARMADA_DESKTOP_DATABASE=/tmp/smoke/fleet.sqlite \
packages/desktop/release/mac-arm64/Armada.app/Contents/MacOS/Armada
```

`test/bundled-daemon.test.ts` boots the built shell this way under the
development Electron and asserts the readiness line reports no window and no
dock icon, the app answers on its addresses, and SIGTERM leaves no daemon. On
Linux without a display the shell selects Chromium's headless Ozone platform,
so CI needs no X server for it. The rules are `src/headless.ts`. Everything that
needs eyes on the window (the fleet it shows, Cmd+Q) stays in the acceptance
pass below, run by the owner or the coordinator.

Only do this for a build you made or trust. A DMG built locally and opened in
place is not quarantined. An app started from the Finder has the login shell's
minimal `PATH`: a local worker runtime found through `PATH` in a terminal may
not be found from the installed app (a follow-up, not covered here).

The shell spawns its own Electron executable in Node mode to run the bundled
armadad entry (including the daemon's dependencies), so it needs no separate
Node installation. It passes `--port 0`: the OS chooses a free loopback port,
without a reserve/release race. A sandboxed, isolated window opens immediately on a local startup page. The daemon
first prints `{"starting":true}`, then a progress line with its event count, and
finally a readiness JSON line with both addresses. The window shows
“Starting the daemon…” and “Reading <n> events” until it can load the built app
served by that daemon, with `?daemon=ws://127.0.0.1:<allocated-port>/`.
The renderer has no Node access. Its one preload (`src/preload.ts`, built as
CommonJS for the sandbox) exposes two calls as `window.armadaShell`, for the
app's notifications (THE-2055): `reveal()` shows, restores and focuses the
window when the owner clicks a notification, and `setBadge(count)` sets the
dock's badge (`app.setBadgeCount`, 99 at most, cleared when the window takes
the focus). The main process answers them only from the app's own window
(`src/bridge.ts`). The window's one allowed permission is notifications. New
windows and cross-origin navigation are refused. The one exception is a
`conductor://` link (a V1 session's workspace, from the session page's Open the
session). It is handed to the OS to open in Conductor and never loads in the window.

Closing the last window, choosing Quit, or receiving SIGINT/SIGTERM stops the
child before exiting Electron, on macOS too. Startup failure exits with a short
console error naming the cause (startup timeout, child exit code/signal, or failed
page URL). The 15-second startup deadline covers the first starting/readiness
message. Once the daemon announces it is starting, the shell waits for readiness
until the daemon exits or the owner quits. Shutdown first sends SIGTERM
for the daemon to close its sockets and SQLite, then escalates to SIGKILL after
five seconds if needed. An unexpected daemon exit closes the shell with a
failure code. A hard OS kill cannot run quit handlers.

The shell starts armadad with `--restartable`. The app's Restart (in Settings >
Providers) makes the daemon close and exit with code 75 (`RESTART_EXIT_CODE`), and
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

Boot timing is included in the readiness line (module loading, SQLite setup,
plugins, model selection, worker setup, server/coordinator setup, and total).
Initial provider reads start after readiness. A standalone synthetic 10 MB boot
benchmark runs after the daemon suite, outside parallel cold-process contention,
and checks startup within one second and readiness within three seconds even
when the first provider reads hang.
