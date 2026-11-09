import { createHash } from "node:crypto";
import type { GitHubRuntimeConfiguration, Provider } from "@armada/core/server";
import { sshStdinCheckout } from "@armada/core/server";
import bundlePath from "../../agent-runtime/dist/github-boat-main.js" with { type: "file" };

/** Existing pinned SSH/stdin transport only. No Provider.exec, token argv or command journal. */
export async function configureBoatGitHub(
  provider: Provider,
  sandboxId: string,
  configuration: GitHubRuntimeConfiguration | null,
): Promise<{ acknowledged: boolean }> {
  // Scrub is also fenced server-side; no token is sent on the scrub path.
  const bundle = await Bun.file(bundlePath).text();
  if (Buffer.byteLength(bundle) > 65536) throw Error("github_broker_artifact_too_large");
  const payload = JSON.stringify({
    configuration,
    bundle,
    root: configuration
      ? `/home/user/.armada/github-${createHash("sha256").update(configuration.generation).digest("hex").slice(0, 16)}`
      : null,
  });
  if (Buffer.byteLength(payload) > 100000) throw Error("github_private_bootstrap_payload_too_large");
  try {
    await sshStdinCheckout(provider, { sandboxId, token: payload, script: BOOTSTRAP });
    return { acknowledged: true };
  } catch {
    throw Error("GitHub private bootstrap failed.");
  }
}

// All credential bytes are received on private stdin. The privileged child inherits no token env.
const BOOTSTRAP = `set +x
cleanup_github_bootstrap() {
  unset ARMADA_GIT_TOKEN
  if [ -n "\${ARMADA_SSH_PUBLIC_KEY:-}" ] && [ -f "$HOME/.ssh/authorized_keys" ] && [ ! -L "$HOME/.ssh/authorized_keys" ]; then
    (
      flock -x 8 || exit 96
      grep -Fvx "$ARMADA_SSH_PUBLIC_KEY" "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.github.$$"
      result=$?
      if [ "$result" -gt 1 ]; then rm -f "$HOME/.ssh/authorized_keys.github.$$"; exit 96; fi
      chmod --reference="$HOME/.ssh/authorized_keys" "$HOME/.ssh/authorized_keys.github.$$"
      if [ "$(id -u)" -eq 0 ]; then chown --reference="$HOME/.ssh/authorized_keys" "$HOME/.ssh/authorized_keys.github.$$"; fi
      mv "$HOME/.ssh/authorized_keys.github.$$" "$HOME/.ssh/authorized_keys"
    ) 8>"$HOME/.ssh/.github-key-cleanup.lock"
  fi
  unset ARMADA_SSH_PUBLIC_KEY
}
trap cleanup_github_bootstrap EXIT
node <<'ARMADA_GITHUB_BOOTSTRAP'
const {spawn}=require('node:child_process');
const payload=process.env.ARMADA_GIT_TOKEN;
delete process.env.ARMADA_GIT_TOKEN;
const script=${JSON.stringify(`
const fs=require('node:fs'), path=require('node:path'), http=require('node:http'), cp=require('node:child_process');
(async()=>{
 const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
 const input=JSON.parse(Buffer.concat(chunks));
 if(!input.configuration) return;
 const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
 if(input.configuration.generation!==boot) throw Error('denied');
 const tombstone='/home/user/.armada/github-install-revision';
 const prior=fs.existsSync(tombstone)?fs.readFileSync(tombstone,'utf8').trim():'0';
 if(!/^[0-9]{1,19}$/.test(prior) || BigInt(input.configuration.revision)<=BigInt(prior)) throw Error('denied');
 fs.writeFileSync(tombstone,input.configuration.revision,{mode:0o600}); // Server capability fence is authoritative; old private broker denies acquisition.
 const root=input.root;
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const owner=fs.statSync('/home/user'); fs.chownSync(root,owner.uid,owner.gid);
 const info=fs.lstatSync(root);
 if(info.isSymbolicLink() || !info.isDirectory() || info.mode&0o077) throw Error('denied');
 const socket=path.join(root,'credentials.sock');
 const update=()=>new Promise((resolve,reject)=>{
  const request=http.request({socketPath:socket,path:'/configure',method:'POST',headers:{'content-type':'application/json'}},response=>{
   response.resume();response.on('end',()=>response.statusCode===200?resolve():reject(Error('denied')));
  });request.setTimeout(15000,()=>request.destroy(Error('denied')));request.on('error',reject);request.end(JSON.stringify(input.configuration));
 });
 try { await update(); return; } catch(error) { if(!['ENOENT','ECONNREFUSED'].includes(error.code)) throw Error('denied'); }
 if(fs.existsSync(socket)) { const before=fs.lstatSync(socket); if(!before.isSocket()) throw Error('denied'); fs.unlinkSync(socket); }
 const redaction=path.join(root,'redact.sock');if(fs.existsSync(redaction)){if(!fs.lstatSync(redaction).isSocket()) throw Error('denied');fs.unlinkSync(redaction);}
 const file=path.join(root,'broker.js');
 const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0o755);
 fs.writeFileSync(fd,input.bundle);fs.closeSync(fd);
 const bun=cp.execFileSync('sh',['-c','command -v bun || { if [ -x /home/user/.bun/bin/bun ]; then echo /home/user/.bun/bin/bun; elif [ -x /opt/armada/runtime-bun/bun ]; then echo /opt/armada/runtime-bun/bun; fi; }'],{encoding:'utf8'}).trim();
 if(!bun) throw Error('denied');
 const child=cp.spawn('sudo',['-n','-u','user',bun,file],{detached:true,stdio:['pipe','pipe','ignore']});
 const ready=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(Error('denied'));},15000);
  let received='';child.stdout.on('data',value=>{received+=value;if(received.includes('github_broker_ready\\n')) {clearTimeout(timer);resolve();}else if(received.length>1024){clearTimeout(timer);reject(Error('denied'));}});
  child.once('exit',()=>{clearTimeout(timer);reject(Error('denied'));});child.once('error',reject);
 });
 child.stdin.end(JSON.stringify({root,configuration:input.configuration,homes:['/home/user'],tools:{gh:'/usr/bin/gh',git:'/usr/bin/git',ghWrapper:'/usr/local/bin/gh',gitWrapper:'/usr/local/bin/git'}}));
 await ready;child.stdout.destroy();child.unref();
})().catch(()=>process.exitCode=1);
`)};
require('node:fs').mkdirSync('/home/user/.armada',{recursive:true,mode:0o700});
const lock='/home/user/.armada/github-install.lock';
const child=spawn(process.getuid()===0?'flock':'sudo',process.getuid()===0?['-w','30',lock,'node','-e',script]:['-n','flock','-w','30',lock,'node','-e',script],{stdio:['pipe','ignore','ignore'],env:{PATH:process.env.PATH,HOME:'/home/user'}});
child.stdin.end(payload);child.on('error',()=>process.exitCode=1);child.on('exit',code=>process.exitCode=code===0?0:1);
ARMADA_GITHUB_BOOTSTRAP
`;
