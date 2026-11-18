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
function machine(lifecycle = true) {
  const files = new Map<string, { directory: boolean; file: boolean; symlink: boolean }>();
  for (const path of ["/", "/home", home]) files.set(path, { directory: true, file: false, symlink: false });
  const calls: { program: string; args: string[]; stdin?: string }[] = [];
  const requests: string[] = [];
  let current = unregistered as typeof unregistered & { hostId?: string };
  let inputReads = 0;
  let claimed = false;
  let now = 0;
  let out = "";
  let err = "";
  const native: LocalHostIo = {
    readServer: async () => "https://armada.example",
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
      if (url.endsWith("install.json"))
        return Response.json(
          { version: "2.27.0", x64: digest, arm64: digest },
          {
            headers: lifecycle ? { "x-armada-docker-host-lifecycle": "1" } : {},
          },
        );
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
    async claim(_directory, work) {
      if (claimed) throw new Error("nested lifecycle claim");
      claimed = true;
      try {
        return await work();
      } finally {
        claimed = false;
      }
    },
    copyExecutable: async (from, to) => {
      const source = files.get(from);
      if (!claimed || !source || files.has(to)) throw new Error("unsafe executable pin");
      files.set(to, { ...source });
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
      if (args[0] === "uninstall") {
        if ("lifecycle" in current && current.lifecycle === true) {
          if (claimed || program === binary || args.at(-1) !== current.hostId) return { code: 1, stdout: "" };
        } else if (!claimed) return { code: 1, stdout: "" };
      }
      if (args[0] === "install") {
        const i = args.indexOf("--instance");
        const destination = i < 0 ? binary : `${binary}@${args[i + 1]}`;
        const verified = files.get(program);
        if (!verified) throw new Error("missing temporary artifact");
        if (!lifecycle && (program !== destination || !claimed)) return { code: 1, stdout: "" };
        files.set(destination, { ...verified });
        current = registered;
      }
      if (!lifecycle && args[0] === "upgrade" && (args.includes("--restart") || !claimed))
        return { code: 1, stdout: "" };
      if (!lifecycle && program === "systemctl" && args.includes("restart")) {
        if (!claimed) return { code: 1, stdout: "" };
        current = registered;
      }
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

test("local host leaf help is focused and avoids all native or account I/O", async () => {
  const forbidden = () => {
    throw new Error("Help attempted native or account I/O");
  };
  for (const command of ["install", "status", "uninstall"]) {
    for (const option of ["--help", "-h"]) {
      let out = "";
      let err = "";
      const code = await run(
        ["--profile", "new-user", "host", command, option],
        {
          out: (text) => {
            out += text;
          },
          err: (text) => {
            err += text;
          },
        },
        {
          localHost: new Proxy({} as LocalHostIo, { get: forbidden }),
          get auth(): never {
            return forbidden();
          },
        },
      );
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(out).toContain(`Usage: armada host ${command}`);
      expect(out).toContain(`Example: armada host ${command}`);
    }
  }
});

test("host install is login-free, passes verified temporary bytes to the native installer, with token only on stdin", async () => {
  const m = machine();
  const result = await m.capture();
  expect(result.code).toBe(0);
  expect(m.requests).toEqual([
    "https://armada.example/api/docker-host/install.json",
    `https://armada.example/api/runtime/artifacts/${digest}`,
  ]);
  expect(m.files.get(binary)?.file).toBe(true);
  expect(m.calls[0]).toEqual({
    program: expect.stringMatching(/armada-docker-host\..*\.tmp$/),
    args: ["install", "--server", "https://armada.example"],
    stdin: `${token}\n`,
  });
  expect(m.calls.flatMap((call) => call.args).join(" ")).not.toContain(token);
  expect(result.out).toContain("connected");
  expect(result.out + result.err).not.toContain(token);
  expect(result.out).not.toContain("privateCredential");
});

test.each(["fresh install", "offline upgrade"])(
  "a preceding server's installer artifact supports a legacy %s",
  async (action) => {
    const m = machine(false);
    if (action === "offline upgrade") m.existing({ ...registered, connected: false });
    const result = await m.capture();
    expect(result.code).toBe(0);
    expect(result.out).toContain("Docker host connected.");
    expect(result.inputReads).toBe(1);
  },
);

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
        if (args.includes("--restart")) m.existing(registered);
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
        program: expect.stringMatching(/armada-docker-host\..*\.tmp$/),
        args: ["upgrade", "--server", "https://armada.example", "--restart"],
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

test.each([
  ["status", []],
  ["uninstall", []],
  ["status", ["--profile", "staging"]],
  ["uninstall", ["--profile=staging"]],
] as const)(
  "host %s delegates locally without login or leaking subprocess output (global flags %j)",
  async (operation, prefix) => {
    const m = machine();
    m.existing(registered);
    const result = await m.capture([...prefix, "host", operation]);
    expect(result.code).toBe(0);
    expect(result.inputReads).toBe(0);
    expect(m.requests).toEqual([]);
    expect(m.calls.at(-1)?.args).toEqual([operation]);
    expect(result.out + result.err).not.toContain("privateCredential");
  },
);

test.each([false, true])("uninstall uses one lifecycle owner with a lifecycle-aware binary=%s", async (lifecycle) => {
  const m = machine();
  m.existing(lifecycle ? Object.assign({}, registered, { lifecycle: true }) : registered);
  const result = await m.capture(["host", "uninstall"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("Uninstalled Armada Docker host.");
  expect(m.calls.at(-1)?.args).toEqual(lifecycle ? ["uninstall", "--expect-host", hostId] : ["uninstall"]);
});

test("another server installs independently; ambiguous uninstall lists without removing either instance", async () => {
  const m = machine();
  m.existing(registered);
  const other = "https://production.example";
  const suffix = createHash("sha256").update(other).digest("hex");
  m.native.listInstances = async () => [];
  expect((await m.capture(["host", "install", "--server", other])).code).toBe(0);
  const install = m.calls.find((c) => c.args[0] === "install");
  expect(install?.program).toStartWith(`${binary}@${suffix}.`);
  expect(install?.args).toEqual(["install", "--server", other, "--instance", suffix]);
  expect(m.calls.some((c) => c.args[0] === "upgrade")).toBe(false);
  m.native.listInstances = async () => [`armada-docker-host@${suffix}`];
  m.native.readServer = async (path) => (path.includes("@") ? other : "https://armada.example");
  const listed = await m.capture(["host", "uninstall"]);
  expect(listed.code).toBe(0);
  expect(m.calls.some((c) => c.args[0] === "uninstall")).toBe(false);
  expect((await m.capture(["host", "uninstall", "--server", other])).code).toBe(0);
  expect(m.calls.find((c) => c.args[0] === "uninstall")?.program).toBe(`${binary}@${suffix}`);
});

test("unknown existing origin refuses before reading or exchanging the token", async () => {
  const m = machine();
  m.existing(registered);
  m.native.readServer = async () => undefined;
  const result = await m.capture();
  expect(result.code).toBe(1);
  expect(m.requests).toEqual([]);
  expect(result.err).not.toContain("run armada doctor");
});
