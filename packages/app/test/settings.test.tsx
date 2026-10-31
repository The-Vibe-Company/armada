import { describe, expect, test } from "bun:test";
import { type ClientMessage, type Plugin, PROTOCOL_VERSION } from "@armada/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { routeOf, type SettingsSection } from "../src/lib/route";
import { configFields, configValue } from "../src/plugins/schema";
import { createDaemonClient, NO_PLUGINS, type SocketLike, UNCONFIRMED } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";
import { Settings } from "../src/screens/Settings";

// The Settings page (THE-2069) on a synthetic catalog, as the daemon lists it
// over a fake socket: its route table and nav, then Providers (the Plugins
// screen of THE-2019 moved in): the groups, the switches, the folded config
// forms, a switch's message, the restart notice, and the list after a fake restart.

const V = PROTOCOL_VERSION;

class FakeSocket implements SocketLike {
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ version: V, ...message }) });
  }
  /** The last request of this type the client sent. */
  last(type: ClientMessage["type"]) {
    return this.sent.filter((m) => m.type === type).at(-1) as ClientMessage & Record<string, unknown>;
  }
}

const runtime: Plugin = {
  id: "skiff",
  version: "1.4.0",
  description: "Runs workers in the skiff CLI",
  enabled: true,
  loaded: true,
  restartRequired: false,
  contributions: [
    {
      seam: "runtime",
      kind: "skiff",
      description: "A worker in a terminal",
      schema: {
        type: "object",
        required: ["binary"],
        properties: {
          binary: { type: "string", title: "Binary", description: "Where the CLI is" },
          model: { enum: ["swift", "deep"] },
          turns: { type: "integer", default: 40 },
          verbose: { type: "boolean" },
        },
      },
      config: { binary: "/usr/local/bin/skiff", model: "deep" },
      secrets: [{ name: "SKIFF_TOKEN", set: false }],
    },
  ],
};
const tracker: Plugin = {
  id: "ledger",
  version: "0.3.0",
  description: "Reads tickets from the ledger",
  enabled: true,
  loaded: false,
  error: "pluginApi ^9.0.0 excludes daemon Plugin API 0.1.0",
  restartRequired: false,
  contributions: [
    { seam: "tracker", kind: "ledger", schema: true, config: {}, secrets: [{ name: "LEDGER_KEY", set: true }] },
  ],
};
const node: Plugin = {
  id: "dinghy",
  version: "0.1.0",
  description: "Sessions in a dinghy VM",
  enabled: false,
  loaded: false,
  restartRequired: false,
  contributions: [{ seam: "node", kind: "dinghy", schema: { type: "object" }, config: {}, secrets: [] }],
};
const hello: Plugin = {
  id: "hello",
  version: "0.1.0",
  description: "Proves the boot path",
  enabled: true,
  loaded: true,
  restartRequired: false,
  contributions: [],
};
const model: Plugin = {
  id: "oracle",
  version: "2.0.0",
  description: "Thinks with the oracle's models",
  enabled: true,
  loaded: true,
  restartRequired: false,
  // A plugin is listed once, under the first group it provides to.
  contributions: [
    { seam: "runtime", kind: "oracle-cli", schema: true, config: {}, secrets: [] },
    { seam: "model", kind: "oracle", schema: true, config: {}, secrets: [] },
  ],
};
const catalog = [hello, node, tracker, runtime, model];

function setup(minor: number = V.minor) {
  const sockets: FakeSocket[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const client = createDaemonClient({
    url: "ws://127.0.0.1:4824/",
    open: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: (run, ms) => {
      timers.push({ run, ms });
      return () => {};
    },
  });
  client.start();
  const socket = () => sockets.at(-1) as FakeSocket;
  const connect = () => {
    socket().onopen?.();
    socket().receive({ type: "projects.result", version: { ...V, minor }, id: "r1", projects: [] });
  };
  connect();
  const render = (section: SettingsSection = "providers") =>
    renderToStaticMarkup(
      <DaemonProvider client={client}>
        <Settings section={section} address="ws://127.0.0.1:4824/" onReload={() => {}} />
      </DaemonProvider>,
    );
  return { client, socket, connect, timers, render };
}

/** The list as it reads: each group's header, then each row's plugin, state on its dot and switch. */
function rows(html: string) {
  return html
    .split(/(?=<h2\b|<div data-plugin=)/)
    .slice(1)
    .map((block) => {
      if (block.startsWith("<h2")) {
        const [, label, count] = block.match(/<span>([^<]+)<\/span><span[^>]*>(\d+)<\/span>/) ?? [];
        return `${label} (${count})`;
      }
      const id = block.match(/data-plugin="([^"]+)"/)?.[1];
      const state = block.match(
        /data-state="true"(?: title="[^"]*")? class="[^"]* (text-[a-z0-9-]+)"><span aria-hidden="true" class="[^"]* (bg-[a-z0-9-]+)"><\/span><span>([^<]*)</,
      );
      const on = block.match(/role="switch"[^>]*aria-checked="(true|false)"/)?.[1];
      return `  ${id} | ${state?.[3]} ${state?.[1]} ${state?.[2]} | ${on === "true" ? "on" : "off"}`;
    });
}

/** The nav's links: each section's address, and whether it is the current one. */
const nav = (html: string) =>
  [...(html.match(/<nav aria-label="Settings sections".*?<\/nav>/)?.[0] ?? "").matchAll(/<a\b[^>]*>/g)].map((a) => {
    const href = a[0].match(/href="([^"]+)"/)?.[1];
    return `${href}${a[0].includes('aria-current="page"') ? " (current)" : ""}`;
  });

test("the address names a section of the settings; the Plugins screen's old one lands on Providers", () => {
  expect(routeOf("#/settings")).toEqual({ kind: "settings", section: "coordinator" });
  expect(routeOf("#/settings/")).toEqual({ kind: "settings", section: "coordinator" });
  for (const section of ["coordinator", "providers", "account", "about"] as const)
    expect(routeOf(`#/settings/${section}`)).toEqual({ kind: "settings", section });
  expect(routeOf("#/settings/elsewhere")).toEqual({ kind: "settings", section: "coordinator" });
  expect(routeOf("#/settings/providers/more")).toEqual({ kind: "home" });
  // One `location.replace` (useRoute) to the providers' address; providers until it lands.
  expect(routeOf("#/plugins")).toEqual({ kind: "settings", section: "providers", redirect: "#/settings/providers" });
});

test("the nav lists every section and marks the one shown, beside its content, under one title", () => {
  const { socket, render } = setup();
  socket().receive({
    type: "plugins.result",
    id: socket().last("plugins.list").id,
    plugins: catalog,
    restartable: true,
  });
  for (const section of ["coordinator", "providers", "account", "about"] as const) {
    const html = render(section);
    expect(nav(html)).toEqual(
      ["coordinator", "providers", "account", "about"].map(
        (s) => `#/settings/${s}${s === section ? " (current)" : ""}`,
      ),
    );
    // Only the current section is a tab stop: the arrow keys move between the others.
    expect(html.match(/<a\b[^>]*tabindex="0"[^>]*>/g)).toHaveLength(1);
    expect(html.match(/<h1\b[^>]*>(.*?)<\/h1>/g)).toEqual([expect.stringContaining(">Settings</h1>")]);
  }
  expect(render("account")).toMatch(/Account.*Reading the sign-in….*<button[^>]*disabled=""[^>]*>Sign in<\/button>/);
  const about = render("about");
  expect(about).toContain("ws://127.0.0.1:4824/");
  expect(about).toMatch(/data-protocol[^>]*>.*>1\.\d+<.*daemon.*>1\.\d+</);
});

test("Providers lists the catalog by seam, with each plugin's switch, state on a dot and folded settings", () => {
  const { socket, render } = setup();
  expect(socket().last("plugins.list")).toBeDefined();
  socket().receive({
    type: "plugins.result",
    id: socket().last("plugins.list").id,
    plugins: catalog,
    restartable: true,
  });
  const html = render();
  expect(rows(html)).toEqual([
    "Models (1)",
    "  oracle | Loaded text-green bg-green | on",
    "Runtimes (1)",
    "  skiff | Loaded text-green bg-green | on",
    "Trackers (1)",
    "  ledger | Refused text-red bg-red | on",
    "Nodes (1)",
    "  dinghy | Off text-text-3 bg-text-3 | off",
    "Other (1)",
    "  hello | Loaded text-green bg-green | on",
  ]);
  expect(html).toContain("5 plugins");
  expect(html).toContain("1 refused");
  expect(html).toContain("pluginApi ^9.0.0 excludes daemon Plugin API 0.1.0");
  // The anatomy: one h1, the title, under the facts line.
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toMatch(/<header[^>]*>(?:(?!<\/header>).)*5 plugins(?:(?!<\/header>).)*<h1[^>]*>Settings<\/h1>/);
  // Skiff's form, from its schema, folded below its row until opened: each field labelled, typed and filled with the saved value or the default.
  const skiff = html.split('data-plugin="skiff"')[1]?.split("data-plugin=")[0] ?? "";
  expect(skiff).toMatch(
    /<button type="button" aria-expanded="false" aria-controls="([^"]+)"[^>]*>.*Settings<\/button><div id="\1" hidden=""/,
  );
  const labels = [...skiff.matchAll(/<label [^>]*>(.*?)<\/label>/g)].map((m) => m[1]?.replace(/<[^>]+>/g, ""));
  expect(labels).toEqual(["Binary", "model (optional)", "turns (optional)", "verbose (optional)"]);
  const input = (name: string) => skiff.match(new RegExp(`<input[^>]*name="config:${name}"[^>]*>`))?.[0] ?? "";
  expect(input("binary")).toContain('value="/usr/local/bin/skiff"');
  expect(input("binary")).toContain('required=""');
  expect(input("turns")).toContain('type="number"');
  expect(input("turns")).toContain('value="40"');
  expect(skiff).toMatch(/<select[^>]*name="config:model"[^>]*>.*<option value="deep" selected="">deep<\/option>/);
  expect(skiff).toMatch(/<select[^>]*name="config:verbose"[^>]*>.*<option value="true">Yes<\/option>/);
  expect(skiff).toContain("Where the CLI is");
  // Its declared secret: missing, with the way to set it. Ledger's is set; dinghy takes nothing.
  expect(skiff).toMatch(/SKIFF_TOKEN<\/span><span class="[^"]*text-amber">Missing<\/span>.*>Set<\/button>/);
  expect(html).toMatch(/LEDGER_KEY<\/span><span class="[^"]*text-green">Set<\/span>.*>Replace<\/button>/);
  expect(html.split('data-plugin="dinghy"')[1]?.split("data-plugin=")[0]).not.toContain("aria-expanded");
  expect(html).not.toContain("data-restart-notice");
});

test("a switch sends its message and says to restart; a setting is saved; after the restart the row reads loaded", async () => {
  const { client, socket, connect, timers, render } = setup();
  socket().receive({
    type: "plugins.result",
    id: socket().last("plugins.list").id,
    plugins: catalog,
    restartable: true,
  });

  const switched = client.setPluginEnabled("dinghy", true);
  const asked = socket().last("plugins.enable");
  expect(asked).toMatchObject({ type: "plugins.enable", plugin: "dinghy", version: V });
  const changed = catalog.map((p) => (p.id === "dinghy" ? { ...p, enabled: true, restartRequired: true } : p));
  socket().receive({ type: "plugins.result", id: asked.id, plugins: changed, restartable: true });
  await switched;
  let html = render();
  expect(rows(html)).toContain("  dinghy | Restart to apply text-amber bg-amber | on");
  expect(html).toMatch(/data-restart-notice[^>]*>.*Restart to apply\..*One plugin changed since the daemon started\./);
  expect(html).toMatch(/data-restart-notice.*>Restart<\/button>/);

  // A config is sent as the form's values say; the daemon's refusal comes back as the promise's.
  const fields = configFields(runtime.contributions[0]?.schema, runtime.contributions[0]?.config);
  const value = configValue(
    fields,
    runtime.contributions[0]?.config,
    (n) => ({ binary: "/opt/skiff", turns: "12" })[n] ?? "",
  );
  expect(value).toEqual({ config: { binary: "/opt/skiff", turns: 12 } });
  const configured = client.configurePlugin("skiff", "runtime", "skiff", "config" in value ? value.config : {});
  const configure = socket().last("plugins.configure");
  expect(configure).toMatchObject({
    plugin: "skiff",
    seam: "runtime",
    kind: "skiff",
    config: { binary: "/opt/skiff", turns: 12 },
  });
  socket().receive({
    type: "error",
    id: configure.id,
    code: "invalid-message",
    message: "config runtime.skiff: config/turns must be <= 10",
  });
  await expect(configured).rejects.toThrow("config runtime.skiff: config/turns must be <= 10");

  // Restart: the daemon confirms, closes, and the client reconnects as after any drop.
  const restarted = client.restartDaemon();
  socket().receive({ type: "daemon.restarting", id: socket().last("daemon.restart").id });
  await restarted;
  expect(render()).toContain("Restarting the daemon.");
  const unconfirmed = client.setPluginEnabled("hello", false);
  socket().onclose?.();
  await expect(unconfirmed).rejects.toThrow(UNCONFIRMED);
  // The reconnect's wait, not a request's ten-second deadline.
  timers.findLast((t) => t.ms < 10000)?.run();
  connect();
  // Back, but not yet listed: still restarting, never a stale Restart button.
  expect(render()).toContain("Restarting the daemon.");
  const loaded = changed.map((p) => (p.id === "dinghy" ? { ...p, loaded: true, restartRequired: false } : p));
  socket().receive({
    type: "plugins.result",
    id: socket().last("plugins.list").id,
    plugins: loaded,
    restartable: true,
  });
  html = render();
  expect(rows(html)).toContain("  dinghy | Loaded text-green bg-green | on");
  expect(html).not.toContain("data-restart-notice");
});

test("a daemon that cannot restart itself says to quit and reopen; an older one has no plugins", () => {
  const { socket, render } = setup();
  const pending = catalog.map((p) => (p.id === "hello" ? { ...p, enabled: false, restartRequired: true } : p));
  socket().receive({
    type: "plugins.result",
    id: socket().last("plugins.list").id,
    plugins: pending,
    restartable: false,
  });
  const html = render();
  expect(html).toContain("Quit and reopen Armada to apply them.");
  expect(html).not.toMatch(/>Restart<\/button>/);

  const older = setup(1);
  expect(older.socket().last("plugins.list")).toBeUndefined();
  expect(older.render()).toContain(NO_PLUGINS);
});

test("a reply past its deadline still updates the list, and a late refusal is not the fleet's problem", async () => {
  const { client, socket, timers } = setup();
  socket().receive({
    type: "plugins.result",
    id: socket().last("plugins.list").id,
    plugins: catalog,
    restartable: true,
  });
  const late = client.setPluginEnabled("hello", false);
  const asked = socket().last("plugins.disable");
  timers.findLast((t) => t.ms === 10000)?.run();
  await expect(late).rejects.toThrow(UNCONFIRMED);
  const off = catalog.map((p) => (p.id === "hello" ? { ...p, enabled: false, restartRequired: true } : p));
  socket().receive({ type: "plugins.result", id: asked.id, plugins: off, restartable: true });
  expect(client.getState().plugins?.plugins.find((p) => p.id === "hello")?.enabled).toBe(false);

  const refused = client.configurePlugin("hello", "runtime", "x", {});
  const configure = socket().last("plugins.configure");
  timers.findLast((t) => t.ms === 10000)?.run();
  await expect(refused).rejects.toThrow(UNCONFIRMED);
  socket().receive({ type: "error", id: configure.id, code: "not-found", message: "Plugin hello has no contribution" });
  expect(client.getState().problem).toBeNull();
});

describe("a contribution's config form from its JSON Schema", () => {
  test("gives no field to a schema that takes nothing, and one JSON field to a schema that is not an object", () => {
    expect(configFields(true, {})).toEqual([]);
    expect(configFields({}, {})).toEqual([]);
    expect(configFields({ type: "object" }, {})).toEqual([]);
    expect(configFields({ type: "array" }, ["a"])).toEqual([
      { name: "", label: "Config", kind: "json", required: true, value: '["a"]' },
    ]);
    expect(configValue(configFields({ type: "array" }, []), [], () => '["b", 2]')).toEqual({ config: ["b", 2] });
  });

  test("reads each kind back, keeps what the form does not show and names a field that does not parse", () => {
    const schema = {
      type: "object",
      properties: {
        port: { type: "integer" },
        ratio: { type: "number" },
        level: { enum: [1, 2, 3] },
        on: { type: "boolean" },
        tags: { type: "array" },
        name: { type: "string" },
      },
    };
    const fields = configFields(schema, {});
    expect(fields.map((f) => f.kind)).toEqual(["integer", "number", "choice", "boolean", "json", "text"]);
    const form = { port: "8080", ratio: "0.5", level: "2", on: "false", tags: '["x"]', name: "" };
    expect(configValue(fields, { name: "old", kept: true }, (n) => form[n as keyof typeof form] ?? "")).toEqual({
      config: { port: 8080, ratio: 0.5, level: 2, on: false, tags: ["x"], kept: true },
    });
    expect(configValue(fields, {}, (n) => ({ ...form, port: "80.5" })[n as keyof typeof form] ?? "")).toEqual({
      problem: "port must be a whole number",
    });
    expect(configValue(fields, {}, (n) => ({ ...form, tags: "[x" })[n as keyof typeof form] ?? "")).toEqual({
      problem: "tags must be JSON",
    });
  });
});

test("About adds this hour's Linear requests across projects and ignores an older hour", () => {
  const { client, socket, render } = setup();
  const instant = new Date();
  instant.setUTCMinutes(0, 0, 0);
  const hour = instant.toISOString();
  for (const [project, requests, at] of [
    ["alpha", 17, hour],
    ["beta", 8, hour],
    ["old", 99, new Date(instant.getTime() - 3_600_000).toISOString()],
  ] as const)
    socket().receive({
      type: "project.subscribed",
      id: `subscribe-${project}`,
      subscriptionId: `sub-${project}`,
      project,
      after: 0,
      snapshot: { seq: 0, state: { readers: { linear: { hour: at, requests, pausedUntil: null } } } },
    });
  expect(render("about")).toContain("Linear: 25 requests this hour");
  client.stop();
});
