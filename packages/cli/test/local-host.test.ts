import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { LocalHostIo } from "../src/local-host.ts";
import { run } from "../src/run.ts";

const home = "/home/operator";
const binary = `${home}/.local/bin/armada-docker-host`;
const hostId = "22222222-2222-4222-8222-222222222222";
const token = "a".repeat(64);
const bytes = new TextEncoder().encode("verified host artifact");
const digest = createHash("sha256").update(bytes).digest("hex");
const unregistered = { registered: false, connected: false, version: "2.27.0" };
const registered = { registered: true, connected: true, hostId, version: "2.27.0" };
function machine() {
  const files = new Map<string, { directory: boolean; file: boolean; symlink: boolean }>();
  for (const path of ["/", "/home", home]) files.set(path, { directory: true, file: false, symlink: false });
  const calls: { program: string; args: string[]; stdin?: string }[] = [];
  const requests: string[] = [];
  let current = unregistered as typeof unregistered & { hostId?: string };
  let inputReads = 0;
  let now = 0;
  let out = "";
  let err = "";
  const native: LocalHostIo = {
    home,
    platform: "linux",
    arch: "x64",
    fetch: async (input, init) => {
      expect(init?.redirect).toBe("error");
      const url = String(input);
      requests.push(url);
      if (url.endsWith("reuse-registration")) {
        expect(init?.headers).toEqual({ authorization: `Bearer ${token}`, "content-type": "application/json" });
        expect(JSON.parse(String(init?.body))).toEqual({ hostId });
        return Response.json({ hostId, name: "owner-machine" });
      }
      if (url.endsWith("install.json")) return Response.json({ version: "2.27.0", x64: digest, arm64: digest });
      return new Response(bytes);
    },
    readStdin: async () => {
      inputReads++;
      return token;
    },
    stat: async (path) => files.get(path) ?? null,
    mkdir: async (path) => {
      files.set(path, { directory: true, file: false, symlink: false });
    },
    writeExclusive: async (path, data) => {
      expect(files.has(path)).toBe(false);
      expect(data).toEqual(bytes);
      files.set(path, { directory: false, file: true, symlink: false });
    },
    rename: async (from, to) => {
      const file = files.get(from);
      if (!file) throw new Error("missing temporary artifact");
      files.set(to, file);
      files.delete(from);
    },
    remove: async (path) => {
      files.delete(path);
    },
    execute: async (program, args, stdin) => {
      calls.push({ program, args, ...(stdin === undefined ? {} : { stdin }) });
      if (args[0] === "install") current = registered;
      return { code: 0, stdout: JSON.stringify({ ...current, privateCredential: "never-output" }) };
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  return {
    native,
    files,
    calls,
    requests,
    existing: (state = unregistered) => {
      for (const path of [`${home}/.local`, `${home}/.local/bin`])
        files.set(path, { directory: true, file: false, symlink: false });
      files.set(binary, { directory: false, file: true, symlink: false });
      current = state;
    },
    capture: async (args = ["host", "install", "--server", "https://armada.example"]) => {
      const code = await run(
        args,
        {
          out: (text) => {
            out += text;
          },
          err: (text) => {
            err += text;
          },
        },
        {
          localHost: native,
          get auth(): never {
            throw new Error("Local host command accessed login/org preferences");
          },
        },
      );
      return { code, out, err, inputReads, elapsed: now };
    },
  };
}

test("host install is login-free, verifies and atomically installs before execution, with token only on stdin", async () => {
  const m = machine();
  const result = await m.capture();
  expect(result.code).toBe(0);
  expect(m.requests).toEqual([
    "https://armada.example/api/docker-host/install.json",
    `https://armada.example/api/runtime/artifacts/${digest}`,
  ]);
  expect(m.files.get(binary)?.file).toBe(true);
  expect(m.calls[0]).toEqual({
    program: binary,
    args: ["install", "--server", "https://armada.example"],
    stdin: `${token}\n`,
  });
  expect(m.calls.flatMap((call) => call.args).join(" ")).not.toContain(token);
  expect(result.out).toContain("connected");
  expect(result.out + result.err).not.toContain(token);
  expect(result.out).not.toContain("privateCredential");
});

test("digest mismatch cannot replace or execute an unregistered existing binary", async () => {
  const m = machine();
  m.existing();
  const before = m.files.get(binary);
  m.native.fetch = async (input) =>
    String(input).endsWith("install.json")
      ? Response.json({ version: "2.27.0", x64: digest })
      : new Response("tampered");
  const result = await m.capture();
  expect(result.code).toBe(1);
  expect(result.err).toContain("digest mismatch");
  expect(m.files.get(binary)).toBe(before);
  expect(m.calls.map((call) => call.args)).toEqual([["status"]]);
});

test("a stale unregistered binary can be replaced without uninstalling or erasing state", async () => {
  const m = machine();
  m.existing();
  const before = m.files.get(binary);
  const result = await m.capture();
  expect(result.code).toBe(0);
  expect(m.files.get(binary)).not.toBe(before);
  expect(result.out).toContain("unregistered");
  expect(m.calls.some((call) => call.args[0] === "uninstall")).toBe(false);
});

test.each([true, false])(
  "registered host connected=%s upgrades safely, preserves registration and cancels the unused ticket",
  async (online) => {
    const m = machine();
    m.existing({ ...registered, connected: online });
    const before = m.files.get(binary);
    if (!online) {
      const execute = m.native.execute;
      m.native.execute = async (program, args, stdin) => {
        const result = await execute(program, args, stdin);
        if (args.includes("restart")) m.existing(registered);
        return result;
      };
    }
    const result = await m.capture();
    expect(result.code).toBe(0);
    // Upgrade uses only verified temporary bytes; no second machine registration.
    expect(m.requests).toEqual([
      "https://armada.example/api/docker-host/install.json",
      `https://armada.example/api/runtime/artifacts/${digest}`,
      "https://armada.example/api/docker-host/reuse-registration",
    ]);
    expect(result.inputReads).toBe(1);
    expect(result.out).toContain(hostId);
    expect(result.out).toContain("token was not exchanged");
    expect(result.out).toContain('already registered as "owner-machine"');
    if (online) expect(m.files.get(binary)).toBe(before);
    else
      expect(m.calls).toContainEqual({
        program: "systemctl",
        args: ["--user", "restart", "armada-docker-host.service"],
      });
    expect(m.calls.some((call) => call.args[0] === "install")).toBe(false);
  },
);

test("offline existing host wait ends at 60 seconds without consuming a replacement token", async () => {
  const m = machine();
  m.existing({ ...registered, connected: false });
  const result = await m.capture();
  expect(result.code).toBe(1);
  expect(result.elapsed).toBe(60_000);
  expect(result.inputReads).toBe(1);
  expect(result.err).toContain("registration preserved");
});

test.each([
  "https://armada.example/path",
  "http://armada.example",
  "https://user:password@armada.example",
  "https://armada.example?query",
  "https://armada.example#fragment",
])("rejects non-origin or insecure server URL %s before native execution", async (url) => {
  const m = machine();
  const result = await m.capture(["host", "install", "--server", url]);
  expect(result.code).toBe(2);
  expect(m.calls).toEqual([]);
  expect(m.requests).toEqual([]);
  expect(result.inputReads).toBe(0);
});

test("redirected artifacts are rejected even when the transport ignores redirect:error", async () => {
  const m = machine();
  m.native.fetch = async () => new Response(null, { status: 302, headers: { location: "https://other.example" } });
  const result = await m.capture();
  expect(result.code).toBe(1);
  expect(m.calls).toEqual([]);
  expect(m.files.has(binary)).toBe(false);
});

test("an ancestor symlink cannot redirect the binary installation", async () => {
  const m = machine();
  m.files.set(`${home}/.local`, { directory: false, file: false, symlink: true });
  const result = await m.capture();
  expect(result.code).toBe(1);
  expect(result.err).toContain("symbolic link");
  expect(m.calls).toEqual([]);
  expect(m.requests).toEqual([]);
});

test("unreadable status preserves registration instead of consuming another token or replacing the binary", async () => {
  const m = machine();
  m.existing();
  m.native.execute = async () => ({ code: 1, stdout: token });
  const result = await m.capture();
  expect(result.code).toBe(1);
  expect(result.inputReads).toBe(0);
  expect(m.requests).toEqual([]);
  expect(result.out + result.err).not.toContain(token);
});

test.each(["status", "uninstall"])(
  "host %s delegates locally without login or leaking subprocess output",
  async (operation) => {
    const m = machine();
    m.existing(registered);
    const result = await m.capture(["host", operation]);
    expect(result.code).toBe(0);
    expect(result.inputReads).toBe(0);
    expect(m.requests).toEqual([]);
    expect(m.calls.at(-1)?.args).toEqual([operation]);
    expect(result.out + result.err).not.toContain("privateCredential");
  },
);
