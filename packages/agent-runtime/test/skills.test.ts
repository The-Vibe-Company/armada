import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, Runner, type RunnerRequest } from "../src/index.ts";

const key = `cmp_pat_${"a".repeat(48)}`,
  workspace = "11111111-1111-4111-8111-111111111111";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-skills-")),
    bin = join(root, "bin"),
    repo = join(root, "repo");
  await mkdir(bin);
  await mkdir(repo);
  const git = Bun.spawnSync(["/usr/lib/git-core/git", "init", repo]);
  if (git.exitCode) throw Error("Git fixture unavailable");
  const cli = `#!/usr/bin/node
const fs=require('fs'),path=require('path');const args=process.argv.slice(2),get=n=>args[args.indexOf(n)+1];
const key=process.env.SKILLPACK_API_KEY,expected=${JSON.stringify(key)},workspace=${JSON.stringify(workspace)};
if(JSON.stringify(args).includes(expected)||process.env.OPENAI_API_KEY||get('--api-url')!=='https://skillpack.app/v1')process.exit(97);
fs.appendFileSync(path.join(process.env.HOME,'cli-calls'),args[0]+'\\n');
if(args[0]==='auth'){if(key!==expected){process.stderr.write(key||'');process.exit(3);}console.log(JSON.stringify({workspace:{id:workspace}}));process.exit(0);}
const ref=args[1],version=get('--version'),tool=get('--tools'),cwd=get('--project');
if((ref!=='catalog/public-skill'||version!=='1.2.3'||key)&&(ref!=='private-skill'||version!=='2.3.4'||key!==expected))process.exit(98);
if(tool!=='codex'||get('--scope')!=='project'||!args.includes('--pin')||!args.includes('--yes'))process.exit(99);
const slug=ref.split('/').at(-1),folder=path.join(cwd,'.agents/skills',slug);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'SKILL.md'),ref.includes('/')?'Public skill behavior':'Private skill behavior');
const lockpath=path.join(cwd,'.companion/skills.lock.json');fs.mkdirSync(path.dirname(lockpath),{recursive:true});let lock={lockfileVersion:3,workspaces:{}};try{lock=JSON.parse(fs.readFileSync(lockpath,'utf8'));}catch{}
const id=ref.includes('/')?'catalog:catalog':workspace;lock.workspaces[id]??={apiUrl:'https://skillpack.app/v1',skills:{}};
lock.workspaces[id].skills[slug]={version,pinned:version,...(ref.includes('/')?{catalogReference:ref}:{}),skillId:'22222222-2222-4222-8222-222222222222',checksum:'sha256:'+'b'.repeat(64),targets:[{tool,version,packageChecksum:'sha256:'+'b'.repeat(64)}]};fs.writeFileSync(lockpath,JSON.stringify(lock));console.log(JSON.stringify({installed:true}));
`;
  await writeFile(join(bin, "skillpack"), cli, { mode: 0o755 });
  const journal = new Journal(join(root, "journal"), (v) => v),
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

test("runtime installs public/private pinned skills without credential argv, validates receipts and excludes only skill artifacts", async () => {
  const f = await fixture();
  try {
    const response = await f.install(),
      value = (await response.json()) as { result: { receipts: { reference: string; workspaceId?: string }[] } };
    expect(response.status).toBe(200);
    expect(value.result.receipts.map((r) => r.reference)).toEqual([
      "catalog/public-skill@1.2.3",
      "private-skill@2.3.4",
    ]);
    expect(value.result.receipts[1]?.workspaceId).toBe(workspace);
    expect(f.starts()).toBe(0);
    expect(await readFile(join(f.repo, ".agents/skills/public-skill/SKILL.md"), "utf8")).toBe("Public skill behavior");
    expect(await readFile(join(f.repo, ".agents/skills/private-skill/SKILL.md"), "utf8")).toBe(
      "Private skill behavior",
    );
    const status = Bun.spawnSync(["/usr/lib/git-core/git", "-C", f.repo, "status", "--porcelain"]);
    expect(status.stdout.toString()).toBe("");
    expect(JSON.stringify(value).includes(key)).toBe(false);
    expect(f.journal.redact(key).includes(key)).toBe(false);
    const callsBeforeReplay = await readFile(join(f.root, "cli-calls"), "utf8");
    expect((await f.install()).status).toBe(200); // durable guest replay does not spawn/reinstall
    expect(await readFile(join(f.root, "cli-calls"), "utf8")).toBe(callsBeforeReplay);
    expect(f.starts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("runtime returns only closed private-key failures; no CLI diagnostic enters receipt or WAL", async () => {
  const f = await fixture(),
    bad = `cmp_pat_${"c".repeat(48)}`;
  try {
    const response = await f.install(bad),
      value = await response.json();
    expect(value).toMatchObject({ result: { failure: { reason: "skillpack_credential_refused" } } });
    expect(JSON.stringify(value).includes(bad)).toBe(false);
    expect(JSON.stringify(f.journal.db.query("select * from requests").all()).includes(bad)).toBe(false);
    expect(f.starts()).toBe(0);
  } finally {
    await f.close();
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
    `#!/usr/bin/node
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
    pids = await ready.promise;
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
