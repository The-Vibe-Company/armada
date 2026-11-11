import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Owns actual guest script execution, command-local auth and receipt/error sanitization.
// Child process isolation keeps fake transport executables out of other suites' PATH.
// Fake SSH maps the provider's guest home to a temporary home, never the CI host's /home/user.
test.each([
  "ok",
  "launch ok",
  "launch refused",
  "launch missing key",
  "refused",
  "broad key",
  "missing",
  "missing read permission",
  "expired",
  "revoked",
  "wrong receipt",
  "cli unavailable",
  "missing executable",
  "auth unavailable",
  "protocol",
  "conflict",
  "rejected",
  "install usage",
  "unreadable key",
  "bad reference",
  "install nonzero",
  "unsafe lock",
])("private installer %s", (mode) => {
  const root = mkdtempSync(join(tmpdir(), "private-skill-"));
  const originalKeys = "# unrelated authorization\nssh-ed25519 AAAA existing\n";
  const homes = [root, join(root, ".root")];
  try {
    for (const home of homes) {
      mkdirSync(join(home, ".ssh"), { recursive: true });
      writeFileSync(join(home, ".ssh/authorized_keys"), originalKeys, { mode: 0o600 });
    }
    if (mode === "unsafe lock")
      symlinkSync(join(root, ".ssh/authorized_keys"), join(root, ".ssh/authorized_keys.armada.lock"));
    const fake = `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const kind=path.basename(process.argv[1]);
if(kind==='ssh-keygen'){const target=process.argv[process.argv.indexOf('-f')+1];fs.writeFileSync(target,'fake key');fs.writeFileSync(target+'.pub','ssh-ed25519 AAAA fake');process.exit(0);}
if(kind==='ssh'){const input=fs.readFileSync(0,'utf8').replaceAll("'/home/user'",JSON.stringify(process.env.HOME)).replaceAll("/home/user",process.env.HOME).replaceAll("/root",process.env.HOME+"/.root");const r=cp.spawnSync('bash',['-c','bash -c '+process.argv.at(-1)],{input,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);}
if(!process.env.SKILLPACK_API_KEY||process.env.ARMADA_GIT_TOKEN)process.exit(9);
if(process.env.MODE==='cli unavailable')process.exit(2);
if(process.env.MODE==='auth unavailable')process.exit(8);
if(process.env.MODE==='protocol'){process.stdout.write('not JSON');process.exit(0);}
if(['refused','expired','revoked'].includes(process.env.MODE))process.exit(3);
if(process.argv[2]==='auth'){process.stdout.write(JSON.stringify({workspace:{id:'11111111-1111-4111-8111-111111111111'},token:{scopes:process.env.MODE==='broad key'?['skills:read','secrets:read']:['skills:read']}}));process.exit(0);}
if(process.env.MODE==='missing read permission')process.exit(7);
if(process.env.MODE==='install usage')process.exit(2);
if(process.env.MODE==='install nonzero')process.exit(9);
if(process.env.MODE==='conflict')process.exit(6);
if(process.env.MODE==='rejected')process.exit(5);
if(process.env.MODE==='missing')process.exit(4);
const root=process.argv[process.argv.indexOf('--project')+1],checksum='sha256:'+'a'.repeat(64);
fs.mkdirSync(root+'/.companion',{recursive:true});
fs.writeFileSync(root+'/.companion/skills.lock.json',JSON.stringify({lockfileVersion:2,workspaces:{'11111111-1111-4111-8111-111111111111':{apiUrl:'https://skillpack.app/v1',skills:{notes:{version:process.env.MODE==='wrong receipt'?'2.0.0':'1.0.0',pinned:'1.0.0',skillId:'22222222-2222-4222-8222-222222222222',checksum,targets:[{tool:'codex',version:'1.0.0',packageChecksum:checksum}]}}}}}));
process.stdout.write(process.env.SKILLPACK_API_KEY);process.stderr.write(process.env.SKILLPACK_API_KEY);
`;
    for (const name of ["ssh", "ssh-keygen", "skillpack"]) writeFileSync(join(root, name), fake, { mode: 0o755 });
    if (mode === "missing executable")
      writeFileSync(join(root, "skillpack"), "#!/nonexistent/skillpack-interpreter\n", { mode: 0o755 });
    const entry = join(import.meta.dir, "../src/private-skill.ts");
    const launchEntry = join(import.meta.dir, "../src/launch.ts");
    const script = `import {launchSandbox} from ${JSON.stringify(launchEntry)}; import {installPrivateSkill} from ${JSON.stringify(entry)}; const key='cmp_pat_'+'a'.repeat(48); const provider={sshKey:async({key})=>{const fs=require('node:fs');for(const home of process.getuid()===0?[process.env.HOME,process.env.HOME+'/.root']:[process.env.HOME])fs.appendFileSync(home+'/.ssh/authorized_keys',key+'\\n');return {sshEndpoint:'fake.test:22',hostKey:'ssh-ed25519 AAAA'};}}; if(process.env.LAUNCH==='1'){
 let stored=[],prompted=false;const now=new Date().toISOString();
 Object.assign(provider,{id:'boat',harnesses:['codex'],capabilities:{codex:{reasoningEffort:true}},fork:async()=>({id:'fake',state:'ready',expiresAt:new Date(Date.now()+86400000)}),get:async()=>({id:'fake',state:'ready',expiresAt:new Date(Date.now()+86400000)}),exec:async()=>({detached:false,exitCode:0,stdout:'',stderr:'',timedOut:false,truncated:false}),prompt:async()=>{prompted=true;if(stored.length!==1)throw Error('receipt_not_persisted');return {promptId:'p',conversationId:'c',status:'queued'};},stop:async()=>{},delete:async()=>({status:'deleted'})});
 const golden={id:'golden',orgId:'org',ownerId:'owner',name:'web',visibility:'org',provider:'boat',providerSnapshotId:'snapshot',config:{repos:[{url:'https://github.com/example/repo.git',branch:'main',dir:'repo'}],init:[]}};
 const stores={goldens:{findByName:async()=>[golden]},sandboxes:{insert:async input=>({...input,createdAt:now,conversationIds:[]}),update:async()=>{},recordSkills:async(_id,receipts)=>{stored=receipts;}},credentials:{resolve:async()=>({env:{OPENAI_API_KEY:'synthetic-model-key'},github:{status:'not_connected'}}),skillpackKey:async()=>process.env.MODE==='missing key'?null:key}};
 try{const result=await launchSandbox(provider,stores,{userId:'owner',orgId:'org',role:'member'},{golden:'web',harness:'codex',skills:['notes@1.0.0'],prompt:'start'});console.log(JSON.stringify({receipt:result.sandbox.skills[0],prompted}));}catch(e){console.log(JSON.stringify({reason:e.reason,stage:e.stage,prompted}));}
}else try{console.log(JSON.stringify(await installPrivateSkill(provider,{sandboxId:'fake',projectDir:${JSON.stringify(root)},reference:process.env.MODE==='bad reference'?'not-a-pin':'notes@1.0.0',harness:'codex',key:process.env.MODE==='unreadable key'?'invalid':key})));}catch(e){console.log(JSON.stringify({reason:e.reason}));}`;
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      env: {
        ...process.env,
        HOME: root,
        PATH: `${root}:${process.env.PATH}`,
        MODE: mode.startsWith("launch ") ? mode.slice(7) : mode,
        LAUNCH: mode.startsWith("launch ") ? "1" : "0",
      },
    });
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString(),
      stderr = result.stderr.toString();
    expect(stdout + stderr).not.toContain("cmp_pat_" + "a".repeat(48));
    const value = JSON.parse(stdout);
    if (mode === "ok" || mode === "broad key" || mode === "launch ok")
      expect(mode === "launch ok" ? value.receipt : value).toEqual({
        reference: "notes@1.0.0",
        version: "1.0.0",
        skillId: "22222222-2222-4222-8222-222222222222",
        checksum: `sha256:${"a".repeat(64)}`,
        origin: "https://skillpack.app/v1",
        workspaceId: "11111111-1111-4111-8111-111111111111",
      });
    else
      expect(value.reason).toBe(
        {
          refused: "skillpack_credential_refused",
          "launch refused": "skillpack_credential_refused",
          "launch missing key": "skillpack_credential_missing",
          expired: "skillpack_credential_refused",
          revoked: "skillpack_credential_refused",
          missing: "skillpack_skill_unavailable",
          "missing read permission": "skillpack_skill_unavailable",
          "wrong receipt": "skillpack_receipt_invalid",
          "cli unavailable": "skillpack_cli_unavailable",
          "missing executable": "skillpack_cli_unavailable",
          "auth unavailable": "skillpack_auth_unavailable",
          protocol: "skillpack_protocol_invalid",
          conflict: "skillpack_install_conflict",
          rejected: "skillpack_request_rejected",
          "install usage": "skillpack_request_rejected",
          "unreadable key": "skillpack_credential_unreadable",
          "bad reference": "skillpack_request_rejected",
          "install nonzero": "skillpack_install_nonzero",
          "unsafe lock": "skillpack_ssh_key_cleanup_failed",
        }[mode],
      );
    if (mode === "launch ok") expect(value.prompted).toBe(true);
    if (mode === "launch refused" || mode === "launch missing key") {
      expect(value.prompted).toBe(false);
      expect(value.stage).toBe(mode === "launch refused" ? "auth" : "credential");
    }
    for (const home of homes) {
      const contents = readFileSync(join(home, ".ssh/authorized_keys"), "utf8");
      if (mode === "unsafe lock") expect(contents).toStartWith(originalKeys);
      else expect(contents).toBe(originalKeys);
    }
    for (const path of readdirSync(root, { recursive: true })) {
      try {
        expect(readFileSync(join(root, String(path)), "utf8")).not.toContain("cmp_pat_" + "a".repeat(48));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EISDIR") throw error;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
