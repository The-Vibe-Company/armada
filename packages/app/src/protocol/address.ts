/** The fake daemon's port in development (`bun run fake-daemon`, reserved for THE-1990). */
export const DEV_DAEMON_URL = "ws://127.0.0.1:4824";

/**
 * Where the daemon listens: `?daemon=ws://…` in the page's address first (the
 * desktop shell can open the app on any daemon), then the build's
 * `VITE_ARMADA_DAEMON_URL`, else the page's own origin, as when the daemon
 * serves the app itself.
 */
export function daemonUrl(location: { search: string; protocol: string; host: string }, configured?: string): string {
  const asked = new URLSearchParams(location.search).get("daemon");
  if (asked) return asked;
  if (configured) return configured;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`;
}
