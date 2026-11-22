import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILLPACK_RUNTIME } from "../../core/src/skillpack-runtime.ts";
import { Journal, Runner, type RunnerRequest } from "../src/index.ts";
import { executeWithReceipt } from "../src/request-receipts.ts";
import { installPinnedSkills, installRuntimeSkills, skillInstallResult } from "../src/skills.ts";

const key = `cmp_pat_${"a".repeat(48)}`,
  workspace = "11111111-1111-4111-8111-111111111111";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-skills-")),
    bin = join(root, "bin"),
    repo = join(root, "repo");
  await mkdir(bin);
  await mkdir(repo);
  const journal = new Journal(":memory:", (v) => v),
    grant = { sandboxId: "skills", generation: "1", token: "a".repeat(32), expiresAt: Date.now() + 60000 };
  let starts = 0;
  const runner = new Runner(
    journal,
    grant,
    {
      codex: {
        start() {
          starts++;
          return { done: Promise.resolve("finished"), async interrupt() {}, async steer() {} };
        },
        async close() {},
      },
    },
    undefined,
    undefined,
    undefined,
    { execEnv: { HOME: root, PATH: `${bin}:/usr/bin:/bin` } },
  );
  const call = async (request: RunnerRequest, signal?: AbortSignal) =>
    runner.handle(
      new Request("http://runtime/v1", {
        method: "POST",
        headers: { "x-armada-runner-grant": grant.token },
        body: JSON.stringify(request),
        ...(signal ? { signal } : {}),
      }),
    );
  const install = (privateKey: string = key, signal?: AbortSignal) =>
    call(
      {
        version: 1,
        sandboxId: grant.sandboxId,
        requestId: "install",
        op: "installSkills",
        input: {
          harness: "codex",
          references: ["catalog/public-skill@1.2.3", "private-skill@2.3.4"],
          cwd: repo,
          key: privateKey,
        },
      },
      signal,
    );
  return {
    root,
    repo,
    bin,
    journal,
    grant,
    runner,
    call,
    install,
    starts: () => starts,
    async close() {
      journal.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("pinned skill installation uses credentials only for private commands and validates lockfile receipts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "runtime-skill-lock-"));
  const references = ["catalog/public-skill@1.2.3", "private-skill@2.3.4"];
  const checksum = `sha256:${"b".repeat(64)}`;
  const entry = (version: string) => ({
    version,
    pinned: version,
    skillId: "22222222-2222-4222-8222-222222222222",
    checksum,
    targets: [{ tool: "codex", version, packageChecksum: checksum }],
  });
  const commands: Array<{ command: string; credential?: string | undefined }> = [];
  try {
    await mkdir(join(cwd, ".companion"));
    const workspaces: Record<
      string,
      { apiUrl: string; skills: Record<string, ReturnType<typeof entry> & { catalogReference?: string }> }
    > = {};
    const receipts = await installPinnedSkills(
      { harness: "codex", references, cwd, key },
      new AbortController().signal,
      async (command, credential) => {
        commands.push({ command, credential });
        const apiUrl = "https://skillpack.app/v1";
        if (/skillpack install .*catalog\/public-skill.* --version .*1\.2\.3/.test(command)) {
          workspaces["catalog:catalog"] = {
            apiUrl,
            skills: { "public-skill": { ...entry("1.2.3"), catalogReference: "catalog/public-skill" } },
          };
        } else if (/skillpack install .*private-skill.* --version .*2\.3\.4/.test(command)) {
          workspaces[workspace] = { apiUrl, skills: { "private-skill": entry("2.3.4") } };
        } else {
          return { code: 0, stdout: JSON.stringify({ workspace: { id: workspace } }) };
        }
        await writeFile(join(cwd, ".companion/skills.lock.json"), JSON.stringify({ lockfileVersion: 3, workspaces }));
        return { code: 0, stdout: "" };
      },
    );
    expect(receipts.map(({ reference }) => reference)).toEqual(references);
    expect(receipts[1]?.workspaceId).toBe(workspace);
    expect(commands.map(({ credential }) => credential)).toEqual([key, undefined, key, undefined]);
    const scripts = commands.map(({ command }) => command);
    expect(scripts[0]).toContain("skillpack auth status");
    for (const script of scripts.slice(0, 3)) {
      expect(script).toContain("--api-url https://skillpack.app/v1");
      expect(script).toContain("--json");
    }
    for (const script of scripts.slice(1, 3)) {
      expect(script).toContain(`--scope project --project '${cwd}' --tools codex --pin --yes`);
    }
    expect(scripts[3]).toContain("/.agents/skills/public-skill/");
    expect(scripts[3]).toContain("/.agents/skills/private-skill/");
    expect(scripts.join("\n")).not.toContain(key);
    expect(JSON.stringify(receipts)).not.toContain(key);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("refused private authorization persists only the closed failure and replays without running commands", async () => {
  const journal = new Journal(":memory:", (value) => value);
  const request: RunnerRequest = {
    version: 1,
    sandboxId: "skills",
    requestId: "refused",
    op: "installSkills",
    input: { harness: "codex", references: ["private-skill@2.3.4"], cwd: "/unused", key },
  };
  let calls = 0;
  const dispatch = () =>
    skillInstallResult(
      installPinnedSkills(request.input, new AbortController().signal, async () => {
        calls++;
        return { code: 3, stdout: `invalid credential: ${key}` };
      }),
    );
  try {
    const response = await executeWithReceipt(journal, request, dispatch);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      version: 1,
      requestId: request.requestId,
      result: { failure: { reason: "skillpack_credential_refused" } },
    });
    expect(journal.db.query("SELECT body FROM requests WHERE id = ?").get(request.requestId)).toEqual({ body });
    expect(await (await executeWithReceipt(journal, request, dispatch)).text()).toBe(body);
    expect(calls).toBe(1);
  } finally {
    journal.close();
  }
});

test("aborting private installation terminates its owned process group before returning", async () => {
  const f = await fixture(),
    abort = new AbortController(),
    ready = Promise.withResolvers<{ pid: number; child: number }>();
  const server = createServer((socket) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => ready.resolve(JSON.parse(data)));
  });
  await new Promise<void>((resolve) => server.listen(join(f.root, "ready.sock"), resolve));
  await writeFile(
    join(f.bin, "skillpack"),
    `#!${process.execPath}
const {spawn}=require('child_process'),net=require('net'),path=require('path');
const child=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:['ignore',1,2]});
const socket=net.connect(path.join(process.env.HOME,'ready.sock'),()=>socket.end(JSON.stringify({pid:process.pid,child:child.pid})));
setInterval(()=>{},10000);
`,
    { mode: 0o755 },
  );
  let pids: { pid: number; child: number } | undefined;
  try {
    const pending = f.install(key, abort.signal);
    pids = await Promise.race([
      ready.promise,
      pending.then(() => {
        throw Error("Installer exited before child readiness");
      }),
    ]);
    expect(
      await (
        await f.call({
          version: 1,
          sandboxId: f.grant.sandboxId,
          requestId: "no-inference-during-install",
          op: "prompt",
          input: { sandboxId: f.grant.sandboxId, harness: "codex", text: "must not start", cwd: f.repo },
        })
      ).json(),
    ).toMatchObject({ error: "skills_install_in_progress" });
    expect(f.starts()).toBe(0);
    abort.abort();
    const result = await (await pending).json();
    expect(result).toMatchObject({
      result: { failure: { reason: expect.stringMatching(/^skillpack_(timeout|process_failed)$/) } },
    });
    for (const pid of [pids.pid, pids.child]) {
      const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
      expect(state.exitCode !== 0 || state.stdout.toString().trim().startsWith("Z")).toBe(true);
    }
    expect(f.starts()).toBe(0);
  } finally {
    abort.abort();
    for (const pid of pids ? [pids.pid, pids.child] : [])
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))(
  "missing Skillpack CLI enters pinned credential-free preparation and refuses corrupted release bytes",
  async () => {
    const f = await fixture();
    let fetched = 0;
    try {
      await expect(
        installRuntimeSkills(
          { harness: "codex", references: ["catalog/public-skill@1.2.3"], cwd: f.repo, key },
          f.journal,
          { HOME: f.root, PATH: join(f.root, "absent") },
          new AbortController().signal,
          async (url, options) => {
            fetched++;
            expect(url.origin).toBe("https://github.com");
            expect(url.pathname).toContain("/The-Vibe-Company/skillpack/releases/download/runtime-v");
            expect(options.credentials).toBe("omit");
            expect(JSON.stringify(options)).not.toContain(key);
            let remaining = SKILLPACK_RUNTIME.archives[process.arch as "x64" | "arm64"].bytes;
            const zeros = new Uint8Array(65536);
            return new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    if (!remaining) return controller.close();
                    const size = Math.min(remaining, zeros.byteLength);
                    remaining -= size;
                    controller.enqueue(zeros.subarray(0, size));
                  },
                },
                { highWaterMark: 0 },
              ),
            );
          },
        ),
      ).rejects.toThrow("skillpack_download_unavailable");
      expect(fetched).toBe(1);
      expect(f.starts()).toBe(0);
    } finally {
      await f.close();
    }
  },
);
