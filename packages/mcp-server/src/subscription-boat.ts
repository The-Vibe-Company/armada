import type { Provider } from "@armada/core/server";
import { sshStdinCheckout } from "@armada/core/server";
import { installNativeCwdWrapper } from "@armada/provider-boat";
import type { SubscriptionConfiguration } from "./subscription-broker.ts";
/** Grant bytes travel on private stdin, never exec or shell arguments. */
export async function configureBoatSubscription(
  provider: Provider,
  sandboxId: string,
  configuration: SubscriptionConfiguration,
) {
  await installNativeCwdWrapper(
    async (request) => {
      const result = await provider.exec(request);
      if (result.detached || result.timedOut || result.exitCode !== 0)
        throw Error("Subscription native bridge installation failed.");
    },
    sandboxId,
    "codex",
  );
  await sshStdinCheckout(provider, {
    sandboxId,
    token: JSON.stringify(configuration),
    script: `set +x
python3 -I <<'ARMADA_MODEL_CONFIG'
import os,sys,subprocess
payload=os.environ.pop('ARMADA_GIT_TOKEN')
script=${JSON.stringify("import os,sys,json,tempfile,pwd,stat\nv=json.load(sys.stdin)\nh='/home/user/.armada'\nos.makedirs(h,mode=0o700,exist_ok=True)\nu=pwd.getpwnam('user')\ns=os.lstat(h)\nassert stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_uid in (0,u.pw_uid) and not s.st_mode&0o077\nos.chown(h,u.pw_uid,u.pw_gid)\nf,p=tempfile.mkstemp(dir=h)\nos.fchmod(f,0o600)\nos.fchown(f,u.pw_uid,u.pw_gid)\nwith os.fdopen(f,'w') as out: json.dump(v,out)\nos.replace(p,h+'/model-access.json')\ntry: os.unlink('/home/user/.codex/auth.json')\nexcept FileNotFoundError: pass\n")}
command=['python3','-I','-c',script]
if os.getuid()!=0: command=['sudo','-n']+command
try: result=subprocess.run(command,input=payload.encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
except Exception: sys.exit(1)
finally:
 public=os.environ.pop('ARMADA_SSH_PUBLIC_KEY','').strip()
 if public:
  for home in ['/home/user','/root']:
   try:
    path=home+'/.ssh/authorized_keys'
    if os.path.islink(path): continue
    with open(path) as f: lines=f.readlines()
    with open(path,'w') as f: f.writelines(line for line in lines if line.strip()!=public)
   except (FileNotFoundError,PermissionError): pass
sys.exit(0 if result.returncode==0 else 1)
ARMADA_MODEL_CONFIG
`,
  });
}
