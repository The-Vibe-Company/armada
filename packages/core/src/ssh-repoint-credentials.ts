import type { Harness } from "./contract.ts";
import type { Provider } from "./provider.ts";
import { type SshExecDeps, sshPrivateSkillCommand } from "./ssh-executor.ts";

/** Private fixed-path handoff. Values and old redaction leaves use SSH stdin/stdout only. */
export async function sshRepointCredentials(
  provider: Provider,
  sandboxId: string,
  configuration: {
    harness: Harness;
    env: Record<string, string>;
    revision: string;
    credentialId: string;
    credentialVersion: number;
    nativeAccountId?: string;
    sandboxId: string;
    native?: boolean;
    nativeMode?: "none" | "file" | "broker";
    phase: "sample" | "capture" | "install";
  },
  deps: SshExecDeps = {},
): Promise<string[]> {
  const text = await sshPrivateSkillCommand(
    provider,
    { sandboxId, key: JSON.stringify(configuration), script: INSTALL },
    deps,
  );
  try {
    const values: unknown = JSON.parse(text);
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string") || Buffer.byteLength(text) > 1048576)
      throw Error();
    return values;
  } catch {
    throw Error("Private account handoff failed.");
  }
}

// The preceding fixed exec captures only model environment values; it never emits them.
export const CAPTURE_MODEL_ENVIRONMENT = `python3 -I -c 'import os,json,pwd
p="/home/user/.armada-repoint-environment.json"
h=os.lstat("/home/user")
assert not os.path.islink("/home/user")
f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
try:
 os.fchmod(f,0o600); os.fchown(f,h.st_uid,h.st_gid)
 os.write(f,json.dumps([os.environ[k] for k in ("OPENAI_API_KEY","ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","ARMADA_CODEX_AUTH_JSON") if os.environ.get(k)]).encode())
finally: os.close(f)'`;

const INSTALL = `set +x
mkdir -p /home/user/.armada && test ! -L /home/user/.armada && test ! -L /home/user/.armada/credential-handoff.lock
exec 8>/home/user/.armada/credential-handoff.lock && flock -x -w 30 8
node <<'ARMADA_REPOINT'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const values=new Set();
const leaves=v=>{if(typeof v==='string'&&v.length>=8)values.add(v);else if(v&&typeof v==='object')Object.values(v).forEach(leaves);};
let input;
try{
 input=JSON.parse(process.env.ARMADA_GIT_TOKEN);delete process.env.ARMADA_GIT_TOKEN;
 if(!['codex','claude'].includes(input.harness)||!input.env||typeof input.env!=='object')throw Error();
 const allowed=['OPENAI_API_KEY','ARMADA_CODEX_ENDPOINT','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'];
 if(Object.entries(input.env).some(([k,v])=>!allowed.includes(k)||typeof v!=='string'))throw Error();
 const home='/home/user',owner=fs.lstatSync(home);if(owner.isSymbolicLink()||!owner.isDirectory())throw Error();
 function directory(p){try{const s=fs.lstatSync(p);if(s.isSymbolicLink()||!s.isDirectory())throw Error();}catch(e){if(e.code!=='ENOENT')throw e;fs.mkdirSync(p,{mode:0o700});fs.chownSync(p,owner.uid,owner.gid);}}
 function read(p,environment=false){try{const f=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(f);if(!s.isFile()||s.size>262144)throw Error();const raw=fs.readFileSync(f,'utf8');leaves(raw);try{const v=JSON.parse(raw);if(environment){const entries=Array.isArray(v)?v:Object.entries(v.env??{}).filter(([k])=>['OPENAI_API_KEY','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','ARMADA_CODEX_AUTH_JSON'].includes(k)).map(([,x])=>x);for(const x of entries)if(typeof x==='string'&&x){values.add(x);try{leaves(JSON.parse(x));}catch{}}}else leaves(v);}catch{}}finally{fs.closeSync(f);}}catch(e){if(e.code!=='ENOENT')throw e;}}
 function write(p,v){directory(path.dirname(p));const t=p+'.'+crypto.randomUUID();const f=fs.openSync(t,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(f,v);fs.fsyncSync(f);fs.fchownSync(f,owner.uid,owner.gid);}finally{fs.closeSync(f);}fs.renameSync(t,p);}
 directory(home+'/.armada');directory(home+'/.codex');directory(home+'/.claude');
 const fence=home+'/.armada/credential-revision',prior=fs.existsSync(fence)?fs.readFileSync(fence,'utf8').trim():'0';if(!/^[0-9]+$/.test(prior)||BigInt(input.revision)<BigInt(prior))throw Error();
 if(input.phase!=='sample')write(fence,input.revision);
 if(input.phase==='capture'||input.phase==='sample'){
  read(home+'/.armada-repoint-environment.json',true);read(home+'/.armada/model-credentials.json',true);read(home+'/.armada/model-access.json');read(home+'/.codex/auth.json');read(home+'/.claude/.credentials.json');
  fs.rmSync(home+'/.armada-repoint-environment.json',{force:true});
  if(input.phase==='capture')for(const p of [home+'/.codex/auth.json',home+'/.codex/.armada-managed-native',home+'/.armada/model-access.json'])fs.rmSync(p,{force:true});
 }else if(input.phase==='install'){
  const old=home+'/.armada/model-credentials.json';
  if(fs.existsSync(old)){const current=JSON.parse(fs.readFileSync(old,'utf8'));if(BigInt(current.revision??'0')>BigInt(input.revision))throw Error();}
  if(!input.native){
   if(input.harness==='codex')for(const p of ['auth.json','.armada-managed-native'])fs.rmSync(home+'/.codex/'+p,{force:true});
   else fs.rmSync(home+'/.claude/.credentials.json',{force:true});
   fs.rmSync(home+'/.armada/model-access.json',{force:true});
  }
  write(old,JSON.stringify({harness:input.harness,env:input.env,revision:input.revision,native:input.native===true,nativeMode:input.nativeMode,credentialId:input.credentialId,credentialVersion:input.credentialVersion,sandboxId:input.sandboxId,nativeAccountId:input.nativeAccountId}));
 }else throw Error();
 const result=JSON.stringify([...values]);if(Buffer.byteLength(result)>1048576)throw Error();process.stdout.write(result);
}catch{process.exitCode=1;}finally{
 const pub=process.env.ARMADA_SSH_PUBLIC_KEY;if(pub)for(const home of ['/home/user','/root'])try{const file=home+'/.ssh/authorized_keys',s=fs.lstatSync(file);if(!s.isSymbolicLink()&&s.isFile())fs.writeFileSync(file,fs.readFileSync(file,'utf8').split('\\n').filter(x=>x.trim()!==pub.trim()).join('\\n'),{mode:0o600});}catch{}
}
ARMADA_REPOINT`;
