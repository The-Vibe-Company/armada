import { spawn } from "node:child_process";
import type { Provider } from "./provider.ts";
import { type SshExecDeps, sshStdinCheckout } from "./ssh-executor.ts";

export interface PrivateOrchestratorSshReceipt {
  physicalGeneration: string;
  acknowledged: boolean;
  port?: number;
  epoch?: string;
  authorityInstalled?: boolean;
}
/** Only a bounded, fixed-shape NONSECRET receipt may cross stdout. The private payload
 * continues to use the existing pinned stdin SSH transport, never Provider.exec/argv.
 * Other stdout/stderr is discarded and must never become an exception/log cause. */
export async function sshOrchestratorReceipt(
  provider: Provider,
  input: { sandboxId: string; token: string; script: string },
  deps: SshExecDeps = {},
): Promise<PrivateOrchestratorSshReceipt> {
  let receipt: PrivateOrchestratorSshReceipt | undefined,
    bad = false,
    pending = "",
    total = 0;
  const run = deps.spawn ?? spawn;
  const wrapped: typeof spawn = ((file: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    if (file !== "ssh") return run(file, args, options);
    const child = run(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > 8192) {
        bad = true;
        return;
      }
      pending += String(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^ARMADA_ORCHESTRATOR_RECEIPT ([A-Za-z0-9_-]{1,4096})$/.exec(line);
        if (!match) continue;
        try {
          const value = JSON.parse(
            Buffer.from(match[1] ?? "", "base64url").toString(),
          ) as PrivateOrchestratorSshReceipt;
          if (
            receipt ||
            !value ||
            Object.keys(value).some(
              (key) => !["physicalGeneration", "acknowledged", "port", "epoch", "authorityInstalled"].includes(key),
            ) ||
            typeof value.physicalGeneration !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(value.physicalGeneration) ||
            typeof value.acknowledged !== "boolean" ||
            (value.authorityInstalled !== undefined && typeof value.authorityInstalled !== "boolean") ||
            (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)) ||
            (value.epoch !== undefined && !/^[0-9]{1,19}$/.test(value.epoch))
          ) {
            bad = true;
            continue;
          }
          receipt = value;
        } catch {
          bad = true;
        }
      }
    });
    return child;
  }) as typeof spawn;
  try {
    await sshStdinCheckout(provider, { ...input, script: cleanupGuestKey + input.script }, { ...deps, spawn: wrapped });
  } catch {
    throw Error("orchestrator_private_ssh_unavailable");
  }
  if (bad || !receipt) throw Error("orchestrator_private_ssh_unavailable");
  return receipt;
}

/** Remove the authorization before executing guest code: an error/exit/daemon launch
 * cannot skip cleanup. Root SSH registration may target /root even when HOME is
 * /home/user. The exact line alone is removed, preserving metadata/unrelated keys. */
const cleanupGuestKey = String.raw`set +x
set -e
for armada_key_home in "$HOME" $(if [ "$(id -u)" = 0 ] && [ "$HOME" != /root ]; then printf /root; fi); do
  [ ! -L "$armada_key_home/.ssh" ] || exit 96
  [ -d "$armada_key_home/.ssh" ] || continue
  [ ! -L "$armada_key_home/.ssh/authorized_keys.armada.lock" ] || exit 96
  ARMADA_KEY_HOME="$armada_key_home" flock -x "$armada_key_home/.ssh/authorized_keys.armada.lock" node <<'ARMADA_PRIVATE_KEY_CLEANUP'
const fs=require('node:fs'),path=require('node:path');
try {
 const p=path.join(process.env.ARMADA_KEY_HOME,'.ssh','authorized_keys'),key=process.env.ARMADA_SSH_PUBLIC_KEY;
 if(!key||key.includes('\n'))process.exit(96);
 let stat;try{stat=fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')process.exit(0);throw e;}
 if(!stat.isFile()||stat.isSymbolicLink())process.exit(96);
 const text=fs.readFileSync(p,'utf8'),lines=text.split('\n');
 if(!lines.includes(key))process.exit(0);
 const tmp=p+'.armada-'+process.pid;
 try {
  const fd=fs.openSync(tmp,'wx',stat.mode&0o777);
  try {if(process.getuid()===0)fs.fchownSync(fd,stat.uid,stat.gid);fs.writeFileSync(fd,lines.filter(line=>line!==key).join('\n'));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,p);
 }finally{fs.rmSync(tmp,{force:true});}
}catch{process.exit(96);}
ARMADA_PRIVATE_KEY_CLEANUP
done
unset ARMADA_SSH_PUBLIC_KEY
`;
