import { expect, test } from "bun:test";
import { type ChildProcess, type spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import type { Provider } from "../src/provider.ts";
import type { SshExecDeps } from "../src/ssh-executor.ts";
import { GITHUB_TOKEN_CLIENT, GITHUB_TOKEN_INSTALLER, sshHydrateGitHubToken } from "../src/ssh-github-token.ts";

// Authoring gate: own the validation, private transport, and executable Python security/lifecycle
// contracts. Existing SSH tests never exercise this artifact. Only OS boundaries are mocked;
// production code decides whether to execute, override credentials, or refuse an unsafe path.
test("private GitHub hydration rejects unsupported providers and invalid credentials before SSH", async () => {
  let sshCalls = 0;
  const provider = {
    id: "boat",
    sshKey: async () => {
      sshCalls++;
      throw Error("Unexpected SSH");
    },
  } as unknown as Provider;
  const future = new Date(Date.now() + 60_000);
  for (const [id, token, expiresAt] of [
    ["modal", "synthetic-token", future],
    ["boat", "", future],
    ["boat", "token\nline", future],
    ["boat", "x".repeat(16385), future],
    ["boat", "synthetic-token", new Date(0)],
    ["boat", "synthetic-token", new Date(Number.NaN)],
  ] as const) {
    await expect(sshHydrateGitHubToken({ ...provider, id }, "bx-test", token, expiresAt)).rejects.toThrow(
      "Invalid private GitHub token hydration.",
    );
  }
  expect(sshCalls).toBe(0);
});

test("hydration sends credentials only through pinned SSH stdin, never exec, argv, or local files", async () => {
  const token = "synthetic-private-refresh-token";
  const expiresAt = new Date(Date.now() + 60_000);
  const commands: { file: string; args: string[]; options?: unknown; stdin?: string }[] = [];
  const writes: unknown[] = [];
  let execCalls = 0;
  let removed = false;
  const provider = {
    id: "boat",
    sshKey: async () => ({ sshEndpoint: "ssh.test:2222", hostKey: "ssh-ed25519 AAAAPINNED" }),
    exec: async () => {
      execCalls++;
      throw Error("Public exec forbidden");
    },
  } as unknown as Provider;
  const spawnImpl = ((file: string, args: string[], options: unknown) => {
    const record = { file, args, options, stdin: "" };
    commands.push(record);
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdin: {
        end: (stdin: string) => {
          record.stdin = stdin;
          queueMicrotask(() => child.emit("close", 0));
        },
      },
      stderr: new EventEmitter(),
    });
    return child;
  }) as typeof spawn;
  const deps: SshExecDeps = {
    spawn: spawnImpl,
    chmod: async () => {},
    writeFile: (async (...args: unknown[]) => {
      writes.push(args);
    }) as NonNullable<SshExecDeps["writeFile"]>,
    rm: async (path, options) => {
      await rm(path, options);
      removed = true;
    },
    readPublicKey: async () => "ssh-ed25519 PUBLIC",
  };
  await sshHydrateGitHubToken(provider, "bx-test", token, expiresAt, deps);
  expect(execCalls).toBe(0);
  expect(commands.map(({ file }) => file)).toEqual(["ssh-keygen", "ssh"]);
  const ssh = commands.find(({ file }) => file === "ssh");
  if (!ssh?.stdin) throw Error("Missing SSH input");
  expect(ssh.args).toContain("StrictHostKeyChecking=yes");
  expect(JSON.stringify(commands.map(({ args, options }) => ({ args, options })))).not.toContain(token);
  expect(JSON.stringify(writes)).not.toContain(token);
  expect(JSON.parse(ssh.stdin.split("\n")[0] ?? "")).toEqual({ token, expiresAt: expiresAt.getTime() });
  expect(removed).toBe(true);
});

// Execute the actual installed artifact without root, network, filesystem mutation, or test-only
// production path flags. execve is intercepted only at the final OS boundary.
const CLIENT_HARNESS = `import os,sys,json,stat,io,time
from types import SimpleNamespace
from unittest.mock import patch
from contextlib import ExitStack
p=json.load(sys.stdin)
class Executed(BaseException): pass
result={}
def info(mode,uid=0):
    return SimpleNamespace(st_mode=mode,st_uid=uid,st_nlink=1,st_size=1024)
def lstat(path):
    if path=='/run/armada-github' and p['state']=='missing-directory': raise FileNotFoundError()
    if path in ('/run','/run/armada-github'):
        if p['state']=='unsafe-directory' and path=='/run/armada-github': return info(stat.S_IFLNK|0o777)
        return info(stat.S_IFDIR|0o755)
    return info(stat.S_IFREG|0o755)
def opened(path,flags):
    if p['state']=='missing': raise FileNotFoundError()
    if p['state']=='symlink' and flags&os.O_NOFOLLOW: raise OSError('refuse symlink')
    return 99
def execute(path,args,env):
    result.update(action='exec',path=path,args=args,env=env)
    raise Executed()
expiry=1 if p['state']=='expired' else 200000
record=json.dumps({'token':'renewed-test-token','expiresAt':expiry}).encode()
mode=stat.S_IFREG|(0o644 if p['state']=='unsafe-mode' else 0o600)
uid=0 if p['state']=='unsafe-owner' else 1000
out=io.StringIO();err=io.StringIO()
with ExitStack() as stack:
    for target,value in [
      ('os.lstat',lstat),('os.open',opened),('os.fstat',lambda fd: info(mode,uid)),
      ('os.read',lambda *args: record),('os.close',lambda fd: None),('os.execve',execute),
      ('time.time',lambda: 100),('sys.argv',['client',p['tool'],'get' if p['tool']=='credential' else 'status']),
      ('sys.stdin',io.StringIO(p.get('request',''))),
      ('sys.stdout',out),('sys.stderr',err)]:
        stack.enter_context(patch(target,value))
    stack.enter_context(patch.dict(os.environ,p['env'],clear=True))
    try: exec(compile(p['script'],'client','exec'),{'__name__':'__main__'})
    except Executed: pass
    except SystemExit as error: result.update(action='exit',code=error.code)
result.update(stdout=out.getvalue(),stderr=err.getvalue())
print(json.dumps(result))
`;

interface PythonResult {
  action: string;
  path?: string;
  args?: string[];
  env?: Record<string, string>;
  code?: number;
  stdout?: string;
  stderr?: string;
  seen?: string[];
  mutations?: unknown[];
}

function python(harness: string, input: unknown): PythonResult {
  const result = spawnSync("/usr/bin/python3", ["-I", "-c", harness], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

for (const tool of ["git", "gh"]) {
  test(`${tool} overrides stale auth but preserves inherited auth when ephemeral state is missing or expired`, () => {
    const env = { GH_TOKEN: "inherited-test-token", GITHUB_TOKEN: "other-inherited-token", GH_HOST: "github.com" };
    for (const state of ["valid", "missing", "missing-directory", "expired"]) {
      const result = python(CLIENT_HARNESS, {
        script: GITHUB_TOKEN_CLIENT.replace("__TOKEN_UID__", "1000"),
        state,
        tool,
        env,
      });
      expect(result.action).toBe("exec");
      expect(result.path).toBe(`/usr/bin/${tool}.armada-original`);
      expect(result.args).toEqual([`/usr/bin/${tool}.armada-original`, "status"]);
      expect(result.stderr).toBe("");
      if (state === "valid") {
        const renewed = result.env ?? {};
        expect(renewed.GH_TOKEN).toBe("renewed-test-token");
        expect(renewed.GITHUB_TOKEN).toBe("renewed-test-token");
        if (tool === "git") {
          expect(renewed.GIT_CONFIG_COUNT).toBe("2");
          expect(renewed.GIT_CONFIG_VALUE_0).toBe("");
          expect(renewed.GIT_CONFIG_VALUE_1).toContain("armada-github-legacy.py credential");
        }
      } else expect(result.env).toEqual(env);
    }
    const result = python(CLIENT_HARNESS, {
      script: GITHUB_TOKEN_CLIENT.replace("__TOKEN_UID__", "1000"),
      state: "missing",
      tool,
      env: {},
    });
    expect(result.action).toBe("exec");
    expect(result.env).toEqual({});
  });

  test(`${tool} refuses insecure state instead of downgrading to inherited credentials`, () => {
    for (const state of ["symlink", "unsafe-mode", "unsafe-owner", "unsafe-directory"]) {
      const result = python(CLIENT_HARNESS, {
        script: GITHUB_TOKEN_CLIENT.replace("__TOKEN_UID__", "1000"),
        state,
        tool,
        env: { GH_TOKEN: "inherited-test-token" },
      });
      expect(result.action).toBe("exit");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Legacy GitHub credentials unavailable.\n");
    }
  });
}

test("Git helper emits only the freshest available GitHub credential on the credential protocol", () => {
  for (const state of ["valid", "missing", "expired"]) {
    for (const host of ["github.com", "other.example"]) {
      const result = python(CLIENT_HARNESS, {
        script: GITHUB_TOKEN_CLIENT.replace("__TOKEN_UID__", "1000"),
        state,
        tool: "credential",
        env: { GITHUB_TOKEN: "inherited-test-token" },
        request: `protocol=https\nhost=${host}\n\n`,
      });
      expect(result.action).toBe("exit");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const token = state === "valid" ? "renewed-test-token" : "inherited-test-token";
      expect(result.stdout).toBe(host === "github.com" ? `username=x-access-token\npassword=${token}\n\n` : "");
    }
  }
});

const INSTALLER_HARNESS = `import os,sys,json,stat,io,tempfile,fcntl,time
from types import SimpleNamespace
from unittest.mock import patch
from contextlib import ExitStack
p=json.load(sys.stdin)
class InstallationStarted(BaseException): pass
seen=[];mutations=[];result={}
def info(mode,uid=0):
    return SimpleNamespace(st_mode=mode,st_uid=uid,st_gid=uid,st_nlink=1,st_size=1024)
def lstat(path):
    seen.append(path)
    if path==p.get('target'):
        if p['violation']=='symlink': return info(stat.S_IFLNK|0o777)
        if path=='/usr/local/lib': return info(stat.S_IFDIR|0o755,2000)
        return info(stat.S_IFREG|(0o600 if path.endswith('token.json') else 0o755),2000)
    if path=='/home/user': return info(stat.S_IFDIR|0o755,1000)
    if path=='/usr/bin/git': return info(stat.S_IFREG|0o755)
    if path=='/run/armada-github/token.json': return info(stat.S_IFREG|0o600,1000)
    if path in ['/run','/usr','/usr/bin','/usr/local','/usr/local/bin','/usr/local/lib','/run/armada-github','/home']:
        return info(stat.S_IFDIR|0o755)
    raise FileNotFoundError()
def begin(*args,**kwargs): raise InstallationStarted()
def mutation(*args,**kwargs): mutations.append(args)
payload=json.dumps({'token':'synthetic-install-token','expiresAt':200000}).encode()
with ExitStack() as stack:
    for target,value in [
      ('os.getuid',lambda: 0),('os.lstat',lstat),('os.open',lambda *args: 99),
      ('os.chmod',lambda *args: None),('fcntl.flock',lambda *args: None),
      ('tempfile.mkstemp',begin),('os.rename',mutation),('os.replace',mutation),
      ('time.time',lambda: 100),('sys.stdin',io.TextIOWrapper(io.BytesIO(payload)))]:
        stack.enter_context(patch(target,value))
    try: exec(compile(p['script'],'installer','exec'),{'__name__':'__main__'})
    except InstallationStarted: result['action']='install'
    except SystemExit as error: result.update(action='exit',code=error.code)
result.update(seen=seen,mutations=mutations)
print(json.dumps(result))
`;

test("installer refuses symlink and non-root-owned code paths before replacing any executable", () => {
  // Positive control proves safe metadata reaches the real first atomic write.
  expect(python(INSTALLER_HARNESS, { script: GITHUB_TOKEN_INSTALLER }).action).toBe("install");
  for (const target of [
    "/usr/local/lib",
    "/usr/bin/git",
    "/usr/bin/git.armada-original",
    "/usr/local/bin/git",
    "/usr/local/lib/armada-github-legacy.py",
    "/run/armada-github/token.json",
  ]) {
    for (const violation of ["symlink", "ownership"]) {
      const result = python(INSTALLER_HARNESS, { script: GITHUB_TOKEN_INSTALLER, target, violation });
      expect(result.seen).toContain(target);
      expect(result.action).toBe("exit");
      expect(result.code).toBe(1);
      expect(result.mutations).toEqual([]);
    }
  }
});
