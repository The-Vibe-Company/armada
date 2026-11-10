import type { Sandbox } from "modal";
import { refusal } from "./errors.ts";

// Public runtime bytes only, before credentials/private bootstrap. Saved golden
// images contain the runtime from their build date, not this server's artifact.
const install = `
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
if(process.getuid()!==0)throw Error('runtime_install_denied');
function checked(p,directory=false){const s=fs.lstatSync(p);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0||(directory?!s.isDirectory():!s.isFile()))throw Error('runtime_path_conflict');return s;}
function directory(p){try{checked(p,true);}catch(e){if(e.code!=='ENOENT')throw e;fs.mkdirSync(p,{mode:0o755});checked(p,true);}}
function atomic(p,bytes,mode){try{checked(p);}catch(e){if(e.code!=='ENOENT')throw e;}const tmp=p+'.install-'+process.pid;let owned=false;try{fs.writeFileSync(tmp,bytes,{mode,flag:'wx'});owned=true;fs.chmodSync(tmp,mode);fs.renameSync(tmp,p);}finally{if(owned)fs.rmSync(tmp,{force:true});}}
function version(p){checked(p);const r=cp.spawnSync(p,['--version'],{env:{PATH:'/usr/local/bin:/usr/bin:/bin'},encoding:'utf8',timeout:10000});if(r.status!==0||r.stdout.trim()!=='1.4.2')throw Error('runtime_bun_unavailable');}
checked('/opt',true);directory('/opt/armada');directory('/opt/armada/runtime-bun');
const bun='/opt/armada/runtime-bun/bun';
try{version(bun);}catch(e){if(e.code!=='ENOENT')throw e;const source='/usr/local/lib/node_modules/bun/bin/bun.exe';version(source);atomic(bun,fs.readFileSync(source),0o555);version(bun);}
const bytes=Buffer.from(input.bundle,'base64');if(!/^[a-f0-9]{64}$/.test(input.sha256)||crypto.createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw Error('runtime_digest_mismatch');
atomic('/opt/armada/main.js',bytes,0o644);
console.log('ARMADA_RUNTIME_INSTALLED '+input.sha256);
`;

/** Refresh only a new logical incarnation. Never edit a restored checkpoint's
 * native state/journal or silently replace its code during no-text resume. */
export async function prepareRuntimeArtifact(
  sandbox: Sandbox,
  artifact: { bundle: Uint8Array; sha256: string },
): Promise<void> {
  const child = await sandbox.exec(["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "node", "-e", install], {
    env: {},
    secrets: [],
    timeoutMs: 30_000,
    stdout: "pipe",
    stderr: "ignore",
  });
  await child.stdin.writeText(
    JSON.stringify({ bundle: Buffer.from(artifact.bundle).toString("base64"), sha256: artifact.sha256 }),
  );
  await child.stdin.close();
  const [exit, output] = await Promise.all([child.wait(), child.stdout.readText()]);
  if (exit !== 0 || output.trim() !== `ARMADA_RUNTIME_INSTALLED ${artifact.sha256}`)
    throw refusal("conflict", "Pinned runtime artifact could not be installed; physical source retained.");
}
