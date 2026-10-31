import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { on, once } from "node:events";
import fs, { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { machinePaths, readCredentialStore, resolveCredentials, updateCredentialStore } from "@armada/core/account";
import { PROTOCOL_VERSION, type ServerMessage, serverMessageSchema } from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { ARMADA_URL, fakeArmada } from "../../core/test/support.node.js";
import { Keychain } from "../src/keychain.ts";
import { Account } from "../src/server/account.ts";
import { startServer } from "../src/server/index.ts";
import { EventStore } from "../src/store.ts";
import { FakeKeychain } from "./support/keychain.ts";
import { nodeExecutable } from "./support/node.ts";
import { readerRegistry } from "./support/reader-plugins.ts";
import { issue, page, project } from "./support/reader-recordings.ts";

async function setup(t: import("node:test").TestContext, polls = ["approve"]) {
  const directory = await mkdtemp(join(tmpdir(), "armada-account-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = randomBytes(24).toString("hex");
  const linear = randomBytes(24).toString("hex");
  const github = randomBytes(24).toString("hex");
  let time = new Date("2026-10-01T12:00:00Z");
  const env: Record<string, string | undefined> = { XDG_CONFIG_HOME: directory, ARMADA_API_URL: ARMADA_URL };
  const vault = {
    linear: { apiKey: linear, scope: "organization" as const },
    github,
    projects: {} as Record<string, string>,
    now: () => time,
  };
  const fake = fakeArmada({
    token,
    polls,
    vault,
  });
  const output: ServerMessage[] = [];
  const log: string[] = [];
  const sleepers: (() => void)[] = [];
  let offline = false;
  const keychain = new Keychain(new FakeKeychain());
  const account = new Account({
    env,
    keychain,
    fetch: (url, init) => {
      if (offline) throw new Error(token);
      return fake.fetch(url, init);
    },
    now: () => time,
    sleep: () => new Promise<void>((resolve) => sleepers.push(resolve)),
    log: (line) => log.push(line),
  });
  t.after(() => account.close());
  await account.refresh();
  const send = (message: ServerMessage) => output.push(message);
  const request = (type: "account.status" | "account.login" | "account.logout", id: string = type) =>
    account.dispatch({ type, id, version: PROTOCOL_VERSION }, send);
  const tick = async () => {
    for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const approve = async () => {
    await tick();
    assert.equal(sleepers.length, 1);
    sleepers.shift()?.();
    await tick();
  };
  return {
    account,
    directory,
    keychain,
    setOffline: () => {
      offline = true;
    },
    fake,
    vault,
    env,
    token,
    linear,
    github,
    output,
    log,
    request,
    tick,
    approve,
    advance: () => {
      time = new Date(time.getTime() + 300_001);
    },
  };
}

test("device login shares one code, broadcasts identity, stores the CLI sign-in, and logout revokes it without leaking secrets", async (t) => {
  const s = await setup(t);
  const changes: unknown[] = [];
  s.account.subscribe((state) => changes.push(state));
  await s.request("account.status");
  assert.deepEqual(s.output[0], {
    type: "account.result",
    version: PROTOCOL_VERSION,
    id: "account.status",
    signedIn: false,
    apiUrl: ARMADA_URL,
  });
  const first = s.request("account.login", "first");
  const second = s.request("account.login", "second");
  await s.tick();
  const devices = s.output.filter((message) => message.type === "account.device");
  assert.equal(devices.length, 2);
  assert.equal(devices[0]?.type === "account.device" && devices[0].code, "WDJB-MJHT");
  assert.equal(s.fake.calls.filter((call) => call.path === "device/code").length, 1);
  await s.approve();
  await Promise.all([first, second]);
  const signedIn = s.output.findLast((message) => message.type === "account.result");
  assert.equal(signedIn?.type === "account.result" && signedIn.signedIn, true);
  assert.equal(changes.length, 1);
  const paths = machinePaths(s.env);
  assert.ok(paths);
  const stored = await readCredentialStore(paths.credentials);
  const cli = resolveCredentials({ env: s.env, store: stored.values });
  assert.equal(cli.armadaSignIn?.kind, "session");
  assert.equal(cli.armadaSignIn?.kind === "session" && cli.armadaSignIn.token === s.token, true);
  await updateCredentialStore(paths, { ARMADA_TURSO_TOKEN: "retired-test-secret" });
  assert.equal((await readCredentialStore(paths.credentials)).values.ARMADA_TURSO_TOKEN, "retired-test-secret");
  await s.request("account.logout");
  assert.equal((await readCredentialStore(paths.credentials)).values.ARMADA_TURSO_TOKEN, undefined);
  assert.equal(s.fake.sessions.has(s.token), false);
  assert.equal((await readCredentialStore(paths.credentials)).values.ARMADA_SESSION_TOKEN, undefined);
  assert.equal(changes.length, 2);
  assert.equal((s.output.at(-1) as { signedIn: boolean }).signedIn, false);
  const visible = JSON.stringify([s.output, s.log, changes]);
  for (const secret of [s.token, s.linear, s.github]) assert.equal(visible.includes(secret), false);
});

test("a denied device code returns the denied error and does not create a sign-in", async (t) => {
  const s = await setup(t, ["access_denied"]);
  const login = s.request("account.login");
  await s.approve();
  await login;
  assert.equal(s.output[0]?.type, "account.device");
  assert.equal((s.output.at(-1) as { code: string }).code, "denied");
  await s.request("account.status");
  assert.equal((s.output.at(-1) as { signedIn: boolean }).signedIn, false);
});

test("plugin secrets become available after login, cache and refresh scoped keys, then disappear on logout", async (t) => {
  const s = await setup(t);
  const scoped = randomBytes(24).toString("hex");
  s.vault.projects.widgets = scoped;
  assert.equal(await s.account.secrets.get("LINEAR_API_KEY", "widgets"), null);
  const login = s.request("account.login");
  await s.approve();
  await login;
  assert.equal((await s.account.secrets.get("LINEAR_API_KEY", "widgets")) === scoped, true);
  assert.equal((await s.account.secrets.get("GITHUB_TOKEN", "widgets")) === s.github, true);
  const calls = () => s.fake.calls.filter((call) => call.path === "credentials");
  const count = calls().length;
  const last = calls().at(-1);
  assert.ok(last);
  assert.equal((last.body as { purpose: { project: string } }).purpose.project, "widgets");
  await s.account.secrets.get("LINEAR_API_KEY", "widgets");
  assert.equal(calls().length, count);
  s.advance();
  await s.account.secrets.get("LINEAR_API_KEY", "widgets");
  assert.ok(calls().length > count);
  s.env.LINEAR_API_KEY = "environment-wins";
  assert.equal(await s.account.secrets.get("LINEAR_API_KEY", "widgets"), "environment-wins");
  delete s.env.LINEAR_API_KEY;
  await s.request("account.logout");
  assert.equal(await s.account.secrets.get("LINEAR_API_KEY", "widgets"), null);
});

test("an expired device code returns expired without a session", async (t) => {
  const s = await setup(t, ["expired_token"]);
  const login = s.request("account.login");
  await s.approve();
  await login;
  assert.equal(s.output[0]?.type, "account.device");
  assert.equal((s.output.at(-1) as { code: string }).code, "expired");
  assert.equal(s.fake.sessions.size, 0);
});

test("logout cancels a pending login so a later browser approval cannot restore the session", async (t) => {
  const s = await setup(t);
  const login = s.request("account.login");
  await s.tick();
  assert.equal(s.output[0]?.type, "account.device");
  await s.request("account.logout");
  await login;
  await s.approve();
  assert.equal(s.fake.calls.filter((call) => call.path === "device/token").length, 0);
  const paths = machinePaths(s.env);
  assert.ok(paths);
  assert.equal((await readCredentialStore(paths.credentials)).values.ARMADA_SESSION_TOKEN, undefined);
});

test("an unreachable Armada uses keychain fallback, logs no server text, and offline login returns a fixed error", async (t) => {
  const s = await setup(t);
  const login = s.request("account.login");
  await s.approve();
  await login;
  assert.equal(await s.account.secrets.get("LINEAR_API_KEY"), s.linear);
  const local = randomBytes(24).toString("hex");
  await s.keychain.write("plugin", "LINEAR_API_KEY", local);
  s.setOffline();
  s.advance();
  assert.equal(await s.account.secrets.get("LINEAR_API_KEY"), local);
  assert.ok(s.log.length > 0);
  await s.request("account.login");
  assert.equal((s.output.at(-1) as { code: string }).code, "offline");
  for (const secret of [s.token, s.linear, s.github, local])
    assert.equal(JSON.stringify([s.log, s.output]).includes(secret), false);
});

test("account changes reach every compatible socket beside fleet wakes and never append secrets to the event store", {
  timeout: 5000,
}, async (t) => {
  const s = await setup(t);
  const store = new EventStore(join(s.directory, "fleet.sqlite"));
  const faux = fauxProvider({ models: [{ id: "room" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let started!: () => void;
  const wakeStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finishWake!: () => void;
  const finish = new Promise<void>((resolve) => {
    finishWake = resolve;
  });
  faux.setResponses([
    async () => {
      started();
      await finish;
      return fauxAssistantMessage("");
    },
  ]);
  let fireWake: (() => void) | undefined;
  const server = await startServer({
    store,
    projects: [{ id: "orchard", name: "Orchard", repository: "example/orchard" }],
    account: s.account,
    coordinators: [
      {
        project: "orchard",
        models,
        model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
        wakeClock: {
          now: Date.now,
          setTimer(callback, delay) {
            if (delay === 10000) fireWake = callback;
            return () => {
              if (fireWake === callback) fireWake = undefined;
            };
          },
        },
      },
    ],
  });
  const clients = [new WebSocket(server.wsUrl), new WebSocket(server.wsUrl), new WebSocket(server.wsUrl)];
  const frames: ServerMessage[][] = [[], [], []];
  for (const [i, ws] of clients.entries()) ws.on("message", (data) => frames[i]?.push(JSON.parse(String(data))));
  t.after(async () => {
    finishWake();
    for (const ws of clients) ws.terminate();
    await server.close();
    store.close();
  });
  // TCP delivery has no fixed event-loop-tick bound. Observe the matching frame,
  // allowing account pushes, replay batches and chat frames to arrive together.
  const until = (ws: WebSocket, accept: (frame: ServerMessage) => boolean) => {
    const messages = on(ws, "message", { signal: t.signal, close: ["close"] });
    return (async () => {
      for await (const [data] of messages) {
        const frame = serverMessageSchema.parse(JSON.parse(String(data)));
        if (accept(frame)) return frame;
      }
      throw new Error("Socket closed before the expected frame");
    })();
  };
  const minors = [8, 11, 7];
  await Promise.all(clients.map((ws) => once(ws, "open")));
  await Promise.all(
    clients.map(async (ws, i) => {
      const id = `subscribe-${i}`;
      const subscribed = until(ws, (m) => m.type === "project.subscribed" && m.id === id);
      ws.send(
        JSON.stringify({
          type: "project.subscribe",
          project: "orchard",
          after: 0,
          id,
          version: { major: 1, minor: minors[i] },
        }),
      );
      await subscribed;
    }),
  );
  store.append({
    project: "orchard",
    kind: "inbox.opened",
    at: new Date().toISOString(),
    actor: "worker",
    payload: { id: "hand-back", ticket: "ORC-1", kind: "hand-back", body: "Ready for review" },
  });
  assert.ok(fireWake);
  fireWake();
  await wakeStarted;
  const signedIn = Promise.all(
    clients.slice(0, 2).map((ws) => until(ws, (m) => m.type === "account.result" && m.signedIn)),
  );
  // A slow compatible recipient must eventually get the broadcast as well.
  clients[1]?.pause();
  const login = s.request("account.login");
  await s.approve();
  await login;
  clients[1]?.resume();
  await signedIn;
  for (const messages of frames.slice(0, 2)) assert.ok(messages.some((m) => m.type === "account.result" && m.signedIn));
  const readRooms = () =>
    Promise.all(
      clients.map(async (ws, i) => {
        const id = `read-${i}`;
        const reading = until(ws, (m) => m.type === "chat.result" && m.id === id);
        ws.send(JSON.stringify({ type: "chat.read", project: "orchard", id, version: { major: 1, minor: minors[i] } }));
        const reply = await reading;
        assert.ok(reply.type === "chat.result");
        assert.equal(
          reply.items.some((item) => item.kind === "wake"),
          i === 1,
        );
      }),
    );
  // These replies also fence the older socket's stream after the broadcast.
  await readRooms();
  assert.equal(
    frames[2]?.some((m) => m.type === "account.result"),
    false,
  );
  const ws = clients[0];
  assert.ok(ws);
  const signedOut = Promise.all(
    clients.slice(0, 2).map((client) => until(client, (m) => m.type === "account.result" && !m.signedIn)),
  );
  const loggedOut = until(ws, (m) => m.type === "account.result" && m.id === "logout");
  ws.send(JSON.stringify({ type: "account.logout", id: "logout", version: { major: 1, minor: 8 } }));
  await Promise.all([loggedOut, signedOut]);
  assert.ok(frames[1]?.some((m) => m.type === "account.result" && !m.signedIn));
  await readRooms();
  assert.equal(
    frames[2]?.some((m) => m.type === "account.result"),
    false,
  );
  finishWake();
  await server.coordinators.get("orchard")?.harness.waitForIdle(context);
  assert.ok(store.readSince(0).some((event) => event.kind === "coordinator.wakeup"));
  for (const secret of [s.token, s.linear, s.github])
    assert.equal(JSON.stringify([frames, s.log, store.readSince(0)]).includes(secret), false);
});

test("the bundled Linear tracker reads using the live project secret after sign-in without reactivation", async (t) => {
  const s = await setup(t);
  const store = new EventStore(join(s.directory, "tracker.sqlite"));
  t.after(() => store.close());
  const registry = await readerRegistry(store, [project], s.account.secrets);
  const tracker = registry.get("tracker", "linear");
  assert.ok(tracker);
  const headers: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    headers.push(new Headers(init.headers).get("authorization") ?? "");
    const query = JSON.parse(String(init.body)).query as string;
    if (query.includes("query Root")) return Response.json({ data: { issue: issue("SEED-1") } });
    if (query.includes("query Children")) return Response.json({ data: { issues: page([]) } });
    if (query.includes("query Comments"))
      return Response.json({ data: { issues: { nodes: [{ identifier: "SEED-1", comments: page([]) }] } } });
    throw new Error("Unexpected tracker request");
  });
  await assert.rejects(tracker.read({ project: project.id }));
  assert.equal(headers.length, 0);
  const login = s.request("account.login");
  await s.approve();
  await login;
  await tracker.read({ project: project.id });
  assert.ok(headers.length > 0);
  assert.ok(headers.every((header) => header === s.linear));
});

test("a stored session bound to another API is never sent to this daemon's API", async (t) => {
  const s = await setup(t);
  const login = s.request("account.login");
  await s.approve();
  await login;
  assert.equal(await s.account.secrets.get("LINEAR_API_KEY"), s.linear);
  const paths = machinePaths(s.env);
  assert.ok(paths);
  await updateCredentialStore(paths, { ARMADA_SIGNED_IN_TO: "https://another-armada.example" });
  const before = s.fake.calls.length;
  await s.request("account.status");
  assert.equal((s.output.at(-1) as { signedIn: boolean }).signedIn, false);
  assert.equal(await s.account.secrets.get("LINEAR_API_KEY"), null);
  assert.equal(s.fake.calls.length, before);
});

test("logout revokes its stored web session even when an environment API key wins for the CLI", async (t) => {
  const s = await setup(t);
  const login = s.request("account.login");
  await s.approve();
  await login;
  assert.equal(s.fake.sessions.has(s.token), true);
  s.env.ARMADA_API_KEY = randomBytes(24).toString("hex");
  const paths = machinePaths(s.env);
  assert.ok(paths);
  await s.request("account.logout");
  assert.equal(s.fake.sessions.has(s.token), false);
  const store = await readCredentialStore(paths.credentials);
  assert.equal(store.values.ARMADA_SESSION_TOKEN, undefined);
});

test("logout revokes a session at its recorded issuer after the configured API changes", async (t) => {
  const s = await setup(t);
  const login = s.request("account.login");
  await s.approve();
  await login;
  assert.equal(s.fake.sessions.has(s.token), true);
  await s.account.close();
  const moved = new Account({
    env: { ...s.env, ARMADA_API_URL: "https://another-armada.example" },
    fetch: s.fake.fetch,
  });
  t.after(() => moved.close());
  await moved.dispatch({ type: "account.logout", id: "logout", version: PROTOCOL_VERSION }, () => {});
  assert.equal(s.fake.sessions.has(s.token), false);
  assert.equal(s.fake.calls.at(-1)?.path, "session");
  assert.equal(s.fake.calls.at(-1)?.method, "DELETE");
});

test("invalid account configuration preserves local credentials and returns a safe offline error", async (t) => {
  const s = await setup(t);
  await s.keychain.write("plugin", "LINEAR_API_KEY", s.linear);
  const messages: ServerMessage[] = [];
  const warnings: string[] = [];
  const account = new Account({
    env: { ...s.env, ARMADA_API_URL: "invalid-url" },
    keychain: s.keychain,
    log: (line) => warnings.push(line),
  });
  t.after(() => account.close());
  await account.refresh();
  assert.equal(await account.secrets.get("LINEAR_API_KEY"), s.linear);
  await account.dispatch({ type: "account.login", id: "login", version: PROTOCOL_VERSION }, (m) => messages.push(m));
  assert.equal((messages.at(-1) as { code: string }).code, "offline");
  assert.ok(warnings.length > 0);
  assert.equal(JSON.stringify([messages, warnings]).includes(s.linear), false);
});

test("shutdown during the credential commit revokes the new session and leaves no late sign-in", {
  timeout: 5000,
}, async (t) => {
  if (process.versions.bun) {
    // Node's live builtin export instrumentation is unavailable in Bun. Run
    // this same race against the production Node runtime, without skipping it.
    const child = spawn(
      nodeExecutable,
      ["--test", "--test-name-pattern=shutdown during the credential commit", fileURLToPath(import.meta.url)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    const [code] = await once(child, "exit");
    assert.equal(code, 0, Buffer.concat(output).toString());
    return;
  }
  const s = await setup(t);
  const paths = machinePaths(s.env);
  assert.ok(paths);
  const previousKey = randomBytes(24).toString("hex");
  await updateCredentialStore(paths, { ARMADA_API_KEY: previousKey, ARMADA_SIGNED_IN_TO: ARMADA_URL });
  assert.equal(
    resolveCredentials({ env: s.env, store: (await readCredentialStore(paths.credentials)).values }).armadaSignIn?.kind,
    "api-key",
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === paths.credentials) {
      entered.resolve();
      await release.promise;
    }
    return rename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.after(() => release.resolve());
  const login = s.request("account.login");
  await s.approve();
  await entered.promise;
  const closing = s.account.close();
  release.resolve();
  await login;
  await closing;
  assert.equal(s.fake.sessions.has(s.token), false);
  assert.equal((await readCredentialStore(paths.credentials)).values.ARMADA_SESSION_TOKEN, undefined);
  const restored = resolveCredentials({
    env: s.env,
    store: (await readCredentialStore(paths.credentials)).values,
  }).armadaSignIn;
  assert.equal(restored?.kind, "api-key");
  assert.equal(restored?.kind === "api-key" && restored.key === previousKey, true);
});

test("daemon startup serves local clients while its saved account API is unavailable", { timeout: 8000 }, async (t) => {
  const s = await setup(t);
  const login = s.request("account.login");
  await s.approve();
  await login;
  await s.account.close();
  const projects = join(s.directory, "projects.json");
  await writeFile(projects, "[]");
  const entry = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
  const preload = `globalThis.fetch = async () => { console.log(JSON.stringify({ accountRequestStarted: true })); return new Promise(() => {}); };`;
  const child = spawn(
    nodeExecutable,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      entry,
      "--database",
      join(s.directory, "boot.sqlite"),
      "--projects",
      projects,
    ],
    {
      env: { ...process.env, ...s.env, ARMADA_APP_CONFIG: join(s.directory, "config.json") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const exited = once(child, "exit");
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.accountRequestStarted) entered.resolve();
    if (value.url) ready.resolve();
  });
  await Promise.race([
    Promise.all([ready.promise, entered.promise]),
    exited.then(() => {
      throw new Error(`Daemon exited before readiness: ${errors}`);
    }),
  ]);
  assert.equal(child.exitCode, null);
});
