import { GitHubHydrationError } from "./api-failure.ts";
import type { Provider } from "./provider.ts";
import { type SshExecDeps, sshStdinCheckout } from "./ssh-executor.ts";

/** Private repair for a running legacy Boat sandbox, never a golden or a persisted credential. */
export async function sshHydrateGitHubToken(
  provider: Provider,
  sandboxId: string,
  token: string,
  expiresAt: Date,
  deps: SshExecDeps = {},
): Promise<void> {
  const expiry = expiresAt.getTime();
  if (
    provider.id !== "boat" ||
    !/^[\x21-\x7e]{1,16384}$/.test(token) ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now()
  )
    throw Error("Invalid private GitHub token hydration.");
  try {
    await sshStdinCheckout(
      provider,
      { sandboxId, token: JSON.stringify({ token, expiresAt: expiry }), script: BOOTSTRAP, timeoutMs: 60_000 },
      deps,
    );
  } catch (error) {
    if (error instanceof GitHubHydrationError) throw error;
    console.error(JSON.stringify({ event: "github_hydration_failed", sandboxId, phase: "ssh" }));
    throw new GitHubHydrationError();
  }
}

// Boat owns /usr/local as user; keep trusted code under root-owned /usr/lib instead.
// Root-owned code, with only the ephemeral owner-private file holding credential bytes.
export const GITHUB_TOKEN_CLIENT = `import os,sys,json,stat,time
TOKEN_UID=__TOKEN_UID__
def directory(path):
    st=os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022: raise ValueError()
def credential():
    try:
        directory('/run');directory('/run/armada-github')
        fd=os.open('/run/armada-github/token.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError: return None
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=TOKEN_UID or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=0o600 or st.st_size>32768: raise ValueError()
        value=json.loads(os.read(fd,32769))
    finally: os.close(fd)
    token=value['token'];expiry=value['expiresAt']
    if not isinstance(token,str) or not 1<=len(token)<=16384 or any(ord(c)<33 or ord(c)>126 for c in token): raise ValueError()
    if not isinstance(expiry,(int,float)) or not 0<expiry<float('inf'): raise ValueError()
    return token if time.time()*1000<expiry else None
try:
    mode=sys.argv[1]
    # Missing ephemeral state after resume is not an unsafe credential file.
    # Preserve inherited auth and normal local Git behavior until the next refresh.
    token=credential()
    if mode=='credential':
        if len(sys.argv)!=3 or sys.argv[2]!='get': sys.exit(0)
        fields={}
        for line in sys.stdin:
            if not line.strip(): break
            key,sep,value=line.rstrip('\\n').partition('=')
            if sep: fields[key]=value
        if token is None: token=os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
        if token and fields.get('protocol')=='https' and fields.get('host')=='github.com':
            sys.stdout.write('username=x-access-token\\npassword='+token+'\\n\\n')
        sys.exit(0)
    if mode not in ('git','gh'): raise ValueError()
    executable='/usr/bin/'+mode+'.armada-original'
    st=os.lstat(executable)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022: raise ValueError()
    env=dict(os.environ)
    env.pop('ARMADA_GIT_TOKEN',None)
    if token is not None:
        env['GH_TOKEN']=token;env['GITHUB_TOKEN']=token;env['GH_HOST']='github.com'
        env.pop('GH_ENTERPRISE_TOKEN',None);env.pop('GITHUB_ENTERPRISE_TOKEN',None)
    if mode=='git' and token is not None:
        count=int(env.get('GIT_CONFIG_COUNT','0'))
        if not 0<=count<=1024: raise ValueError()
        # Reset stale global credential helpers only for github.com, without changing HOME.
        for key,value in [('credential.https://github.com.helper',''),('credential.https://github.com.helper','!/usr/bin/python3 -I /usr/lib/armada-github-legacy.py credential')]:
            env['GIT_CONFIG_KEY_'+str(count)]=key;env['GIT_CONFIG_VALUE_'+str(count)]=value;count+=1
        env['GIT_CONFIG_COUNT']=str(count)
    os.execve(executable,[executable]+sys.argv[2:],env)
except Exception:
    sys.stderr.write('Legacy GitHub credentials unavailable.\\n')
    sys.exit(1)
`;

export const GITHUB_TOKEN_INSTALLER = `import os,sys,json,stat,time,tempfile,fcntl
CLIENT=${JSON.stringify(GITHUB_TOKEN_CLIENT)}
def directory(path,create=False):
    try: st=os.lstat(path)
    except FileNotFoundError:
        if not create: raise
        os.mkdir(path,0o755);st=os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022: raise ValueError()
def regular(path,optional=False):
    try: st=os.lstat(path)
    except FileNotFoundError:
        if optional: return None
        raise
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022 or st.st_nlink!=1: raise ValueError()
    return st
def atomic(path,data,mode,uid=0,gid=0):
    try:
        st=os.lstat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1: raise ValueError()
    except FileNotFoundError: pass
    fd,tmp=tempfile.mkstemp(prefix='.armada-github-',dir=os.path.dirname(path))
    try:
        os.fchmod(fd,mode);os.fchown(fd,uid,gid)
        with os.fdopen(fd,'wb') as file:
            file.write(data.encode());file.flush();os.fsync(file.fileno())
        os.replace(tmp,path)
        parent=os.open(os.path.dirname(path),os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass
phase='privilege'
try:
    if os.getuid()!=0: raise ValueError()
    phase='payload'
    raw=sys.stdin.buffer.read(32769)
    if len(raw)>32768: raise ValueError()
    value=json.loads(raw);token=value['token'];expiry=value['expiresAt']
    if not isinstance(token,str) or not 1<=len(token)<=16384 or any(ord(c)<33 or ord(c)>126 for c in token): raise ValueError()
    if not isinstance(expiry,(int,float)) or not time.time()*1000<expiry<float('inf'): raise ValueError()
    phase='directories'
    for path in ['/run','/usr','/usr/bin','/usr/lib']: directory(path)
    directory('/run/armada-github',True)
    os.chmod('/run/armada-github',0o755)
    phase='lock'
    lock='/run/armada-github/install.lock'
    regular(lock,True)
    fd=os.open(lock,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    deadline=time.monotonic()+5
    while True:
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            break
        except BlockingIOError:
            remaining=deadline-time.monotonic()
            if remaining<=0: raise
            time.sleep(min(0.05,remaining))
    # The lock remains open until process exit, including every atomic replacement.
    phase='executables'
    directory('/home')
    owner=os.lstat('/home/user')
    if not stat.S_ISDIR(owner.st_mode): raise ValueError()
    present=[]
    for tool in ['git','gh']:
        path='/usr/bin/'+tool;saved=path+'.armada-original'
        current=regular(path,True);original=regular(saved,True)
        if not current and not original:
            if tool=='git': raise ValueError()
            continue
        if not (original or current).st_mode&0o111: raise ValueError()
        present.append((tool,path,saved,original))
    regular('/usr/lib/armada-github-legacy.py',True)
    # Refuse symlink token targets even though atomic replacement would not follow them.
    target='/run/armada-github/token.json'
    try:
        st=os.lstat(target)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_uid!=owner.st_uid or stat.S_IMODE(st.st_mode)!=0o600: raise ValueError()
    except FileNotFoundError: pass
    phase='install'
    atomic('/usr/lib/armada-github-legacy.py',CLIENT.replace('__TOKEN_UID__',str(owner.st_uid)),0o755)
    for tool,path,saved,original in present:
        if original is None: os.rename(path,saved)
        wrapper='#!/bin/sh\\nexec /usr/bin/python3 -I /usr/lib/armada-github-legacy.py '+tool+' "$@"\\n'
        atomic(path,wrapper,0o755)
    phase='token_write'
    atomic(target,json.dumps(value),0o600,owner.st_uid,owner.st_gid)
except Exception:
    sys.stderr.write('ARMADA_GITHUB_FAILURE '+phase+'\\n')
    sys.exit(1)
`;

// Only constant code crosses sudo argv. Its environment contains no inherited credential values.
const BOOTSTRAP = `set +x
cleanup_github_token() {
  unset ARMADA_GIT_TOKEN
  for key_home in /home/user /root; do
    if [ -n "\${ARMADA_SSH_PUBLIC_KEY:-}" ] && [ -f "$key_home/.ssh/authorized_keys" ] && [ ! -L "$key_home/.ssh/authorized_keys" ]; then
      (
        flock -x 8 || exit 96
        grep -Fvx "$ARMADA_SSH_PUBLIC_KEY" "$key_home/.ssh/authorized_keys" > "$key_home/.ssh/authorized_keys.github.$$"
        result=$?
        if [ "$result" -gt 1 ]; then rm -f "$key_home/.ssh/authorized_keys.github.$$"; exit 96; fi
        chmod --reference="$key_home/.ssh/authorized_keys" "$key_home/.ssh/authorized_keys.github.$$"
        if [ "$(id -u)" -eq 0 ]; then chown --reference="$key_home/.ssh/authorized_keys" "$key_home/.ssh/authorized_keys.github.$$"; fi
        mv "$key_home/.ssh/authorized_keys.github.$$" "$key_home/.ssh/authorized_keys"
      ) 8>"$key_home/.ssh/.github-key-cleanup.lock"
    fi
  done
  unset ARMADA_SSH_PUBLIC_KEY
}
trap cleanup_github_token EXIT
/usr/bin/python3 -I <<'ARMADA_GITHUB_TOKEN'
import os,subprocess,sys
try:
    payload=os.environ.pop('ARMADA_GIT_TOKEN')
    command=['/usr/bin/python3','-I','-c',${JSON.stringify(GITHUB_TOKEN_INSTALLER)}]
    if os.getuid()!=0: command=['/usr/bin/sudo','-n']+command
    result=subprocess.run(command,input=payload.encode(),stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/home/user'},timeout=45)
    if result.returncode!=0:
        allowed=['privilege','payload','directories','lock','executables','install','token_write']
        reason=next((v for v in allowed if result.stderr==('ARMADA_GITHUB_FAILURE '+v+'\\n').encode()),'sudo')
        sys.stderr.write('ARMADA_GITHUB_FAILURE '+reason+'\\n')
    sys.exit(0 if result.returncode==0 else 1)
except Exception:
    sys.stderr.write('ARMADA_GITHUB_FAILURE bootstrap\\n')
    sys.exit(1)
ARMADA_GITHUB_TOKEN
`;
