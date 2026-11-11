import type { Harness } from "./contract.ts";
import type { Provider } from "./provider.ts";
import { validateReadableVariables } from "./readable-variables.ts";
import { sshStdinCheckout } from "./ssh-executor.ts";

/** Fixed stdin-only bootstrap outside checkouts; readable, NOT a secret transport guarantee. */
export async function sshReadableVariables(
  provider: Provider,
  sandboxId: string,
  harness: Harness,
  input: Record<string, string>,
): Promise<void> {
  const variables = validateReadableVariables(input);
  if (provider.id !== "boat" || !["claude", "codex"].includes(harness))
    throw Error("Readable variable bootstrap unavailable.");
  await sshStdinCheckout(provider, {
    sandboxId,
    token: JSON.stringify({ harness, variables }),
    timeoutMs: 60000,
    script: `set +x
python3 -I <<'ARMADA_READABLE_BOOTSTRAP'
import os,sys,subprocess
payload=os.environ.pop('ARMADA_GIT_TOKEN')
command=['python3','-I','-c',${JSON.stringify(INSTALLER)}]
if os.getuid()!=0: command=['sudo','-n']+command
try:
 result=subprocess.run(command,input=payload.encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={'PATH':'/usr/local/bin:/usr/bin:/bin'},timeout=45)
 status=0 if result.returncode==0 else 1
except Exception: status=1
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
sys.exit(status)
ARMADA_READABLE_BOOTSTRAP
`,
  });
}

const INSTALLER =
  'import os,sys,json,stat,tempfile\nr=json.load(sys.stdin)\nassert r["harness"] in ("claude","codex")\np="/run/armada-readable-variables"\ntry: os.mkdir(p,0o755)\nexcept FileExistsError: pass\ns=os.lstat(p)\nassert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022\nfd,tmp=tempfile.mkstemp(dir=p)\ntry:\n os.fchmod(fd,0o644)\n with os.fdopen(fd,"w") as f: json.dump(r["variables"],f)\n os.replace(tmp,p+"/"+r["harness"]+".json")\nfinally:\n if os.path.exists(tmp): os.unlink(tmp)\n';
