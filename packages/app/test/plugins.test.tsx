import { describe, expect, test } from "bun:test";
import { type ClientMessage, type Plugin, PROTOCOL_VERSION } from "@armada/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { configFields, configValue } from "../src/plugins/schema";
import { createDaemonClient, NO_PLUGINS, type SocketLike, UNCONFIRMED } from "../src/protocol/client";
import { DaemonProvider } from "../src/protocol/store";
import { Plugins } from "../src/screens/Plugins";

// The Plugins screen (THE-2019) on a synthetic catalog, as the daemon lists it
// over a fake socket: the groups, the switches, the config forms, a switch's
// message, the restart notice, and the list after a fake restart.

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
const catalog = [hello, node, tracker, runtime];

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
  const render = () =>
    renderToStaticMarkup(
      <DaemonProvider client={client}>
        <Plugins />
      </DaemonProvider>,
    );
  return { client, socket, connect, timers, render };
}

/** The list as it reads: each group's header, then each row's plugin, state and switch. */
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
      const state = block.match(/data-state="true" class="[^"]* (text-[a-z0-9-]+)"[^>]*>([^<]*)</);
      const on = block.match(/role="switch"[^>]*aria-checked="(true|false)"/)?.[1];
      return `  ${id} | ${state?.[2]} ${state?.[1]} | ${on === "true" ? "on" : "off"}`;
    });
}

test("lists the catalog by seam, with each plugin's switch, state and config form", () => {
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
    "Runtimes (1)",
    "  skiff | Loaded text-green | on",
    "Trackers (1)",
    "  ledger | Refused text-red | on",
    "Nodes (1)",
    "  dinghy | Off text-text-3 | off",
    "Other (1)",
    "  hello | Loaded text-green | on",
  ]);
  expect(html).toContain("4 plugins");
  expect(html).toContain("1 refused");
  expect(html).toContain("pluginApi ^9.0.0 excludes daemon Plugin API 0.1.0");
  // The anatomy: one h1, the title, under the facts line.
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toMatch(/<header[^>]*>(?:(?!<\/header>).)*4 plugins(?:(?!<\/header>).)*<h1[^>]*>Plugins<\/h1>/);
  // Skiff's form, from its schema: each field labelled, typed and filled with the saved value or the default.
  const skiff = html.split('data-plugin="skiff"')[1]?.split("data-plugin=")[0] ?? "";
  expect(skiff).toContain("Configure");
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
  expect(html.split('data-plugin="dinghy"')[1]?.split("data-plugin=")[0]).not.toContain("Configure");
  expect(html).not.toContain("data-restart-notice");
});

test("a switch sends its message and says to restart; after the restart the row reads loaded", async () => {
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
  expect(rows(html)).toContain("  dinghy | Restart to apply text-amber | on");
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
  const loaded = changed.map((p) => (p.id === "dinghy" ? { ...p, loaded: true, restartRequired: false } : p));
  socket().receive({
    type: "plugins.result",
    id: socket().last("plugins.list").id,
    plugins: loaded,
    restartable: true,
  });
  html = render();
  expect(rows(html)).toContain("  dinghy | Loaded text-green | on");
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
