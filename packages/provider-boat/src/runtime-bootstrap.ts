import type { Provider } from "@armada/core";
import { sshStdinCheckout } from "@armada/core/server";

/** Start-only transport. The caller must fence old work and issue a fresh ticket. */
export async function startBoatRuntime(
  provider: Provider,
  input: {
    sandboxId: string;
    serverUrl: string;
    enrolmentToken: string;
    cacheDir: string;
    artifact: { sha256: string; bytes: number };
  },
): Promise<void> {
  if (provider.id !== "boat") throw Error("boat_runtime_required");
  const server = new URL(input.serverUrl);
  if (
    server.protocol !== "https:" ||
    server.origin !== input.serverUrl.replace(/\/$/, "") ||
    !input.cacheDir.startsWith("/") ||
    input.cacheDir === "/" ||
    input.cacheDir.includes("\0") ||
    !/^[a-f0-9]{64}$/.test(input.artifact.sha256) ||
    !Number.isSafeInteger(input.artifact.bytes) ||
    input.artifact.bytes <= 0 ||
    input.artifact.bytes > 512 * 1024 * 1024 ||
    !/^armada_enrol_[a-f0-9]{64}$/.test(input.enrolmentToken)
  )
    throw Error("invalid_boat_runtime_bootstrap");
  try {
    await sshStdinCheckout(provider, {
      sandboxId: input.sandboxId,
      token: JSON.stringify({ serverUrl: server.origin, enrolmentToken: input.enrolmentToken }),
      script: boatRuntimeBootstrapScript(server.origin, input.artifact, input.cacheDir),
      timeoutMs: 150_000,
    });
  } catch {
    // Guest/transport failures must never surface private stdin or credentials.
    throw Error("boat_runtime_bootstrap_failed");
  }
}

/** Only public, validated artifact metadata is embedded in the remote command. */
export function boatRuntimeBootstrapScript(
  serverUrl: string,
  artifact: { sha256: string; bytes: number },
  cacheDir: string,
): string {
  return `set +x
umask 077
node <<'ARMADA_RUNTIME_BOOTSTRAP'
const fs=require('node:fs/promises'), crypto=require('node:crypto'), cp=require('node:child_process');
const origin=${JSON.stringify(serverUrl)}, artifact=${JSON.stringify(artifact)};
let report=async()=>{};
(async()=>{
 const ticket=JSON.parse(process.env.ARMADA_GIT_TOKEN); delete process.env.ARMADA_GIT_TOKEN;
 report=async(stage)=>{try{await fetch(origin+'/api/runtime/progress',{method:'POST',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(3000),headers:{authorization:'Bearer '+ticket.enrolmentToken,'content-type':'application/json'},body:JSON.stringify({stage})});}catch{}};
 await report('bootstrap_started');
 const home='/home/user', root=${JSON.stringify(cacheDir)};
 const owner=await fs.lstat(home);
 try{await fs.mkdir(root,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const dir=await fs.lstat(root);
 if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077))throw Error();
 const target=root+'/'+artifact.sha256;
 async function matches(){
  let file;
  try{
   const st=await fs.lstat(target);
   if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error('unsafe');
   if(st.size!==artifact.bytes)return false;
   file=await fs.open(target,'r');const hash=crypto.createHash('sha256');
   for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk);
   return hash.digest('hex')===artifact.sha256;
  }catch(e){if(e.code==='ENOENT')return false;throw e;}finally{await file?.close();}
 }
 if(!await matches()){
  const tmp=root+'/.'+crypto.randomUUID(); let file;
  try{
   const response=await fetch(origin+'/api/runtime/artifacts/'+artifact.sha256,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(120000)});
   if(response.status!==200||!response.body)throw Error();
   file=await fs.open(tmp,'wx',0o600);let bytes=0;const hash=crypto.createHash('sha256');
   for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>artifact.bytes)throw Error();hash.update(chunk);await file.writeFile(chunk);}
   if(bytes!==artifact.bytes||hash.digest('hex')!==artifact.sha256)throw Error();
   await file.chmod(0o700);await file.chown(owner.uid,owner.gid);await file.sync();await file.close();file=undefined;
   await fs.rename(tmp,target);
  }finally{await file?.close();await fs.rm(tmp,{force:true});}
 }
 await report('artifact_verified');
 await fs.chmod(target,0o700);await fs.chown(root,owner.uid,owner.gid);await fs.chown(target,owner.uid,owner.gid);
 const child=cp.spawn(target,['dialout'],{detached:true,uid:owner.uid,gid:owner.gid,cwd:home,env:{HOME:home,PATH:'/usr/bin:/bin'},stdio:['pipe','ignore','ignore']});
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve);});
 await new Promise((resolve,reject)=>{child.stdin.once('error',reject);child.stdin.end(JSON.stringify(ticket),resolve);});
 child.unref();
})().catch(async()=>{await report('bootstrap_failed');process.exitCode=1;});
ARMADA_RUNTIME_BOOTSTRAP
`;
}
