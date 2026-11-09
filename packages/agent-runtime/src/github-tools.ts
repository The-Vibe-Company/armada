import { chmod, chown, lstat, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Private local installer. Only paths and a one-use activation key cross stdin; never argv. */
export async function prepareGitHubTools(input: Parameters<typeof installGitHubTools>[0]): Promise<void> {
  if (process.getuid?.() === 0) return installGitHubTools(input);
  const artifact = process.argv[1];
  if (!artifact) throw Error("github_tools_denied");
  const child = Bun.spawn(["sudo", "-n", process.execPath, artifact, "github-install"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/user" },
  });
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();
  const receipt = await new Response(child.stdout).text();
  if ((await child.exited) || receipt !== "github_tools_installed\n") throw Error("github_tools_denied");
}
export async function runGitHubInstallMode(): Promise<void> {
  await installGitHubTools(JSON.parse(await Bun.stdin.text()) as Parameters<typeof installGitHubTools>[0]);
  process.stdout.write("github_tools_installed\n");
}

/** Code and socket address only. Credential bytes arrive exclusively on owner-private IPC. */
export async function installGitHubTools(input: {
  root: string;
  activation: string;
  socket: string;
  gh: string;
  git: string;
  ghWrapper: string;
  gitWrapper: string;
  homes: readonly string[];
}): Promise<void> {
  if (process.getuid?.() !== 0) throw Error("github_tools_privilege_required");
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  const directory = await lstat(input.root);
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    (directory.uid !== process.getuid?.() && process.getuid?.() !== 0) ||
    directory.mode & 0o077
  )
    throw Error("github_tools_denied");
  async function preserve(path: string): Promise<string> {
    const original = `${path}.armada-original`;
    const saved = await lstat(original).catch(() => undefined);
    if (saved) {
      if (saved.isSymbolicLink() || !saved.isFile()) throw Error("github_tools_denied");
      return original;
    }
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile()) throw Error("github_tools_denied");
    await rename(path, original);
    return original;
  }
  const ghInfo = await lstat(input.gh).catch(() => undefined);
  const ghOriginal = ghInfo ? await preserve(input.gh) : undefined;
  const gitOriginal = await preserve(input.git);
  const client = join(input.root, "client.py");
  const clientInfo = await lstat(client).catch(() => undefined);
  if (clientInfo && (clientInfo.isSymbolicLink() || !clientInfo.isFile() || clientInfo.uid !== process.getuid?.()))
    throw Error("github_tools_denied");
  const temporary = `${client}.${crypto.randomUUID()}`;
  await writeFile(temporary, `GIT_EXECUTABLE=${JSON.stringify(gitOriginal)}\n${GITHUB_CLIENT}`, {
    mode: 0o755,
    flag: "wx",
  });
  await rename(temporary, client);
  const privileged = "/usr/bin/sudo -n --preserve-env /usr/bin/python3 -I";
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
  if (ghOriginal) {
    const wrapper = `#!/bin/sh\nexec ${privileged} ${q(client)} gh ${q(input.socket)} ${q(ghOriginal)} "$@"\n`;
    const info = await lstat(input.ghWrapper).catch(() => undefined);
    if (info?.isSymbolicLink() || (info && !info.isFile())) throw Error("github_tools_denied");
    await writeFile(input.ghWrapper, wrapper, { mode: 0o755 });
    await chmod(input.ghWrapper, 0o755);
    if (input.gh !== input.ghWrapper) {
      await writeFile(input.gh, wrapper, { mode: 0o755 });
      await chmod(input.gh, 0o755);
    }
  }
  const gitInfo = await lstat(input.gitWrapper).catch(() => undefined);
  if (gitInfo?.isSymbolicLink() || (gitInfo && !gitInfo.isFile())) throw Error("github_tools_denied");
  await writeFile(
    input.gitWrapper,
    `#!/bin/sh\nexec ${privileged} ${q(client)} git-run ${q(input.socket)} ${q(gitOriginal)} "$@"\n`,
    { mode: 0o755 },
  );
  await chmod(input.gitWrapper, 0o755);
  if (input.git !== input.gitWrapper) {
    await writeFile(
      input.git,
      `#!/bin/sh\nexec ${privileged} ${q(client)} git-run ${q(input.socket)} ${q(gitOriginal)} "$@"\n`,
      { mode: 0o755 },
    );
    await chmod(input.git, 0o755);
  }
  for (const home of input.homes) {
    const env = { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
    const helper = `!${privileged} ${q(client)} git ${q(input.socket)}`;
    for (const args of [
      ["--replace-all", "credential.https://github.com.helper", ""],
      ["--add", "credential.https://github.com.helper", helper],
      ["credential.https://github.com.useHttpPath", "true"],
    ]) {
      const owner = (await stat(home)).uid;
      const commandArgs = [gitOriginal, "config", "--file", join(home, ".gitconfig"), ...args];
      const command = Bun.spawn(
        process.getuid?.() === 0 && owner !== 0 ? ["sudo", "-n", "-u", `#${owner}`, ...commandArgs] : commandArgs,
        {
          env,
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      if (await command.exited) throw Error("github_tools_denied");
    }
  }
  await chown(input.socket, 0, 0);
  await chmod(input.socket, 0o600);
  const response = await fetch("http://private/activate", {
    unix: input.socket,
    method: "POST",
    body: JSON.stringify({ key: input.activation }),
  });
  if (!response.ok) throw Error("github_tools_denied");
  const locator = join(input.root, "..", "github-socket");
  await writeFile(locator, join(input.root, "redact.sock"), { mode: 0o600 });
  const homeOwner = (await stat(input.homes[0] ?? input.root)).uid;
  await chown(locator, homeOwner, homeOwner);
  const proxy = join(input.root, "..", "github-native-proxy");
  await writeFile(
    proxy,
    `#!/bin/sh\nexec /usr/bin/python3 -I ${q(client)} native ${q(join(input.root, "redact.sock"))} "$@"\n`,
    { mode: 0o755 },
  );
  await chmod(proxy, 0o755);
}

export const GITHUB_CLIENT = `import os,sys,json,socket,http.client,subprocess,re,threading,pwd,signal
local_secrets=set(value.encode() for key,value in os.environ.items() if key in ("GH_TOKEN","GITHUB_TOKEN") and value)
class Connection(http.client.HTTPConnection):
    def __init__(self,name,path=None):
        super().__init__(name)
        self.path=path or sys.argv[2]
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(20)
        self.sock.connect(self.path)
def repository(value):
    value=value.strip()
    for prefix in ('https://github.com/','ssh://git@github.com/','git@github.com:'):
        if value.startswith(prefix): value=value[len(prefix):]; break
    if value.endswith('.git'): value=value[:-4]
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',value): raise ValueError()
    return value
def safe(line,stream=False):
    redaction=os.path.join(os.path.dirname(sys.argv[2]),'redact.sock')
    connection=Connection('private',redaction)
    connection.request('POST','/redact',line,{'Content-Type':'application/octet-stream','X-Armada-Stream':'1' if stream else '0'})
    response=connection.getresponse()
    raw=response.read(262145)
    if response.status!=200 or len(raw)>262144: raise ValueError()
    consumed=int(response.getheader('X-Armada-Consumed',str(len(line))))
    if consumed<0 or consumed>len(line): raise ValueError()
    connection.close()
    return raw,consumed
def execute(executable,args,env):
    uid=int(os.environ.get('SUDO_UID',os.getuid()))
    gid=int(os.environ.get('SUDO_GID',os.getgid()))
    def demote():
        if os.getuid()==0 and uid!=0:
            os.initgroups(pwd.getpwuid(uid).pw_name,gid);os.setgid(gid);os.setuid(uid)
    env={key:value for key,value in env.items() if not key.startswith('SUDO_')}
    child=subprocess.Popen([executable]+args,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,preexec_fn=demote)
    failed=[]
    def forward(source,target):
        try:
            pending=b''
            while True:
                chunk=source.read1(65536)
                if not chunk: break
                pending+=chunk
                line,consumed=safe(pending,True)
                pending=pending[consumed:]
                target.write(line); target.flush()
            if pending:
                line,_=safe(pending)
                target.write(line); target.flush()
        except Exception:
            failed.append(True)
            child.terminate()
    threads=[threading.Thread(target=forward,args=(child.stdout,sys.stdout.buffer)),threading.Thread(target=forward,args=(child.stderr,sys.stderr.buffer))]
    def forward_signal(sig,frame):
        try: child.send_signal(sig)
        except ProcessLookupError: pass
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(sig,forward_signal)
    try:
        for thread in threads: thread.start()
        status=child.wait()
    finally:
        if child.poll() is None:
            child.terminate()
            try: child.wait(timeout=3)
            except subprocess.TimeoutExpired: child.kill();child.wait()
        for thread in threads: thread.join()
    if not failed and status<0:
        if -status not in (signal.SIGKILL,signal.SIGSTOP): signal.signal(-status,signal.SIG_DFL)
        os.kill(os.getpid(),-status)
    sys.exit(1 if failed else status)
try:
    if local_secrets:
        registration=Connection('private',os.path.join(os.path.dirname(sys.argv[2]),'redact.sock'))
        registration.request('POST','/register',json.dumps([value.decode() for value in local_secrets]),{'Content-Type':'application/json'})
        reply=registration.getresponse();reply.read()
        if reply.status!=200: raise ValueError()
        registration.close()
    mode=sys.argv[1]
    if mode=='native':
        execute(sys.argv[3],sys.argv[4:],dict(os.environ))
    if mode=='git-run':
        env=dict(os.environ)
        env.pop('GH_TOKEN',None); env.pop('GITHUB_TOKEN',None)
        execute(sys.argv[3],sys.argv[4:],env)
    if mode=='git':
        if len(sys.argv)<4 or sys.argv[3]!='get': sys.exit(0)
        fields=dict(line.rstrip('\\n').split('=',1) for line in sys.stdin if '=' in line)
        if fields.get('protocol')!='https' or fields.get('host')!='github.com': sys.exit(0)
        repo=repository(fields.get('path',''))
    elif mode=='gh':
        args=sys.argv[4:]
        for i,arg in enumerate(args):
            if arg=='--hostname' and (i+1>=len(args) or args[i+1].lower()!='github.com'): raise ValueError()
            if arg.startswith('--hostname=') and arg.split('=',1)[1].lower()!='github.com': raise ValueError()
            if arg.startswith(('http://','https://')) and not arg.startswith(('https://github.com/','https://api.github.com/')): raise ValueError()
        repo=os.environ.get('GH_REPO','')
        for i,arg in enumerate(args):
            if arg in ('-R','--repo') and i+1<len(args): repo=args[i+1]
            if arg.startswith('--repo='): repo=arg.split('=',1)[1]
        if not repo:
            result=subprocess.run([GIT_EXECUTABLE,'config','--get','remote.origin.url'],capture_output=True,text=True)
            if result.returncode: raise ValueError()
            repo=result.stdout
        repo=repository(repo)
        for arg in args:
            if arg.startswith('https://github.com/'):
                selected=re.match(r'^https://github.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:/|$)',arg)
                if not selected or repository(selected.group(1)).lower()!=repo.lower(): raise ValueError()
        if args and args[0]=='api':
            for arg in args[1:]:
                endpoint=arg.removeprefix('https://api.github.com/').lstrip('/')
                if endpoint=='graphql': raise ValueError()
                match=re.match(r'^repos/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:/|$)',endpoint)
                if match: repo=repository(match.group(1))
    else: raise ValueError()
    connection=Connection('private')
    connection.request('POST','/',json.dumps({'repository':repo,'operation':mode}),{'Content-Type':'application/json'})
    response=connection.getresponse()
    if response.status!=200: raise ValueError()
    raw=response.read(16385)
    if len(raw)>16384: raise ValueError()
    token=json.loads(raw)['token']
    if not isinstance(token,str) or not token or any(ord(c)<33 or ord(c)>126 for c in token): raise ValueError()
    connection.close()
    local_secrets.add(token.encode())
    if mode=='git':
        sys.stdout.write('username=x-access-token\\npassword='+token+'\\n')
    else:
        env=dict(os.environ)
        env.pop('GH_TOKEN',None); env.pop('GITHUB_TOKEN',None)
        env['GH_TOKEN']=token; env['GITHUB_TOKEN']=token
        env['GH_HOST']='github.com'
        env.pop('GH_ENTERPRISE_TOKEN',None); env.pop('GITHUB_ENTERPRISE_TOKEN',None)
        execute(sys.argv[3],args,env)
except Exception:
    sys.stderr.write('Managed GitHub credentials unavailable.\\n')
    sys.exit(1)
`;
