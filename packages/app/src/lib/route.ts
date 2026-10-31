// Where the app is: the address's hash, because the daemon serves one
// index.html at its root. `#/projects/<id>` is a project's room (THE-1996),
// `?panel=agents|prs|rules|log` the tab its panel shows (THE-2085; the old
// rules page, `#/projects/<id>/rules`, is replaced by its Rules tab), `&agent=<ticket>`
// the agent whose page takes the chat's place in the room (THE-2089), `#/settings/<section>`
// a section of the settings (THE-2069: `#/settings` opens the coordinator's,
// the old `#/plugins` is replaced by the providers'), `#/settings/<section>/<card>`
// one card's detail open (THE-2075: an agent under providers, linear, github
// or armada under connections; the old `#/settings/account` is replaced by
// the Armada card's); anything else, and off a
// browser (a test's static render), the hangar (the home, THE-2025). A
// session's page, `#/sessions/<ticket>`, has its own route (src/session/route.ts).
import { useEffect, useSyncExternalStore } from "react";

/** The settings' sections, in the nav's order; the first is `#/settings`. */
export const SETTINGS_SECTIONS = ["coordinator", "providers", "connections", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
/** The cards of Settings › Connections (THE-2075), in the nav's order. */
export const CONNECTIONS = ["linear", "github", "armada"] as const;
export type Connection = (typeof CONNECTIONS)[number];

/** The room's panel's tabs (THE-2085), in their order: `⌘1` to `⌘4`. */
export const PANEL_TABS = ["agents", "prs", "rules", "log"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export type Route =
  | { kind: "home" }
  | { kind: "project"; id: string; panel?: PanelTab; agent?: string }
  | { kind: "rules"; id: string; redirect: string }
  | { kind: "settings"; section: SettingsSection; detail?: string; redirect?: string };

/** Where a section of the settings is, with one card's detail open. */
export const settingsHref = (section: SettingsSection, detail?: string) =>
  `#/settings/${section}${detail ? `/${encodeURIComponent(detail)}` : ""}`;

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    // A malformed address returns to the hangar.
    return null;
  }
};

/** The screen a hash names. */
export function routeOf(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#?\/?/, "").split("?");
  const [kind, id, more, ...rest] = path.split("/");
  // The Plugins screen became the providers' section: its old address is replaced, once.
  if (kind === "plugins" && !id) return { kind: "settings", section: "providers", redirect: settingsHref("providers") };
  // Settings' Account became the Armada card of Connections: its old address is replaced, once.
  if (kind === "settings" && id === "account" && more === undefined)
    return {
      kind: "settings",
      section: "connections",
      detail: "armada",
      redirect: settingsHref("connections", "armada"),
    };
  if (kind === "settings" && !rest.length) {
    const section = SETTINGS_SECTIONS.find((s) => s === id) ?? "coordinator";
    const detail = more && (section === "providers" || section === "connections") ? decode(more) : null;
    if (more !== undefined && more !== "" && !detail) return { kind: "home" };
    if (!detail) return { kind: "settings", section };
    if (section === "connections" && !CONNECTIONS.some((c) => c === detail)) return { kind: "settings", section };
    return { kind: "settings", section, detail };
  }
  const value = id && !rest.length ? decode(id) : null;
  if (!value) return { kind: "home" };
  if (kind === "projects" && more === undefined) {
    const panel = panelOf(query);
    const agent = agentOf(query);
    return { kind: "project", id: value, ...(panel ? { panel } : {}), ...(agent ? { agent } : {}) };
  }
  // The rules page became the room's Rules tab: its old address is replaced, once.
  if (kind === "projects" && more === "rules") return { kind: "rules", id: value, redirect: roomHref(value, "rules") };
  return { kind: "home" };
}

/** The panel's tab a hash's query names, if it names one. */
export function panelOf(query: string): PanelTab | undefined {
  const tab = new URLSearchParams(query).get("panel");
  return PANEL_TABS.find((t) => t === tab);
}

/** The agent a hash's query shows in the room's lane, if it names one. */
export function agentOf(query: string): string | undefined {
  return new URLSearchParams(query).get("agent")?.trim() || undefined;
}

/** Where a project's sidebar line leads: its room. */
export const projectHref = (id: string) => `#/projects/${encodeURIComponent(id)}`;
/**
 * A project's room with its panel on a tab (the hangar's squadrons open it on
 * Agents), and an agent's page in its lane in place of the chat.
 */
export const roomHref = (id: string, panel?: PanelTab, agent?: string) => {
  const query = new URLSearchParams({ ...(panel ? { panel } : {}), ...(agent ? { agent } : {}) }).toString();
  return `${projectHref(id)}${query ? `?${query}` : ""}`;
};

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const current = () => window.location.hash;
const server = () => "#/";

/** The address a route is replaced by, if any. */
const redirectOf = (route: Route) => (route.kind === "settings" || route.kind === "rules" ? route.redirect : undefined);

/** The last address outside the settings: where their close button returns (THE-2075). */
let outside = "#/";
export const settingsReturn = () => outside;

/** The current route, re-rendered when the hash changes; the hangar on the server. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, current, server);
  const route = routeOf(hash);
  const redirect = redirectOf(route);
  useEffect(() => {
    if (route.kind !== "settings") outside = hash || "#/";
  }, [route.kind, hash]);
  useEffect(() => {
    // Replaced, not pushed: Back never returns to the old address. Every caller
    // of useRoute sees the redirect: the first replaces it, the others find it done.
    if (redirect && redirectOf(routeOf(window.location.hash))) window.location.replace(redirect);
  }, [redirect]);
  return route;
}
