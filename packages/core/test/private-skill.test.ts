import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Owns actual guest script execution, command-local auth and receipt/error sanitization.
// Child process isolation keeps fake transport executables out of other suites' PATH.
// Fake SSH maps the provider's guest home to a temporary home, never the CI host's /home/user.
test.each(["ok", "refused", "broad key", "missing", "wrong receipt"])("private installer %s", (mode) => {
  const root = mkdtempSync(join(tmpdir(), "private-skill-"));
  try {
    const fake = `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const kind=path.basename(process.argv[1]);
if(kind==='ssh-keygen'){const target=process.argv[process.argv.indexOf('-f')+1];fs.writeFileSync(target,'fake key');fs.writeFileSync(target+'.pub','ssh-ed25519 AAAA fake');process.exit(0);}
if(kind==='ssh'){const input=fs.readFileSync(0,'utf8').replaceAll("'/home/user'",JSON.stringify(process.env.HOME));const r=cp.spawnSync('bash',['-c','bash -c '+process.argv.at(-1)],{input,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);}
if(!process.env.SKILLPACK_API_KEY||process.env.ARMADA_GIT_TOKEN)process.exit(9);
if(process.env.MODE==='refused')process.exit(3);
if(process.argv[2]==='auth'){process.stdout.write(JSON.stringify({workspace:{id:'11111111-1111-4111-8111-111111111111'},token:{scopes:process.env.MODE==='broad key'?['skills:read','secrets:read']:['skills:read']}}));process.exit(0);}
if(process.env.MODE==='missing')process.exit(4);
const root=process.argv[process.argv.indexOf('--project')+1],checksum='sha256:'+'a'.repeat(64);
fs.mkdirSync(root+'/.companion',{recursive:true});
fs.writeFileSync(root+'/.companion/skills.lock.json',JSON.stringify({lockfileVersion:2,workspaces:{'11111111-1111-4111-8111-111111111111':{apiUrl:'https://skillpack.app/v1',skills:{notes:{version:process.env.MODE==='wrong receipt'?'2.0.0':'1.0.0',pinned:'1.0.0',skillId:'22222222-2222-4222-8222-222222222222',checksum,targets:[{tool:'codex',version:'1.0.0',packageChecksum:checksum}]}}}}}));
process.stdout.write(process.env.SKILLPACK_API_KEY);process.stderr.write(process.env.SKILLPACK_API_KEY);
`;
    for (const name of ["ssh", "ssh-keygen", "skillpack"]) writeFileSync(join(root, name), fake, { mode: 0o755 });
    const entry = join(import.meta.dir, "../src/private-skill.ts");
    const script = `import {installPrivateSkill} from ${JSON.stringify(entry)}; const key='cmp_pat_'+'a'.repeat(48); const provider={sshKey:async()=>({sshEndpoint:'fake.test:22',hostKey:'ssh-ed25519 AAAA'})}; try{console.log(JSON.stringify(await installPrivateSkill(provider,{sandboxId:'fake',projectDir:${JSON.stringify(root)},reference:'notes@1.0.0',harness:'codex',key})));}catch(e){console.log(JSON.stringify({reason:e.reason}));}`;
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      env: { ...process.env, HOME: root, PATH: `${root}:${process.env.PATH}`, MODE: mode },
    });
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString(),
      stderr = result.stderr.toString();
    expect(stdout + stderr).not.toContain("cmp_pat_" + "a".repeat(48));
    const value = JSON.parse(stdout);
    if (mode === "ok")
      expect(value).toEqual({
        reference: "notes@1.0.0",
        version: "1.0.0",
        skillId: "22222222-2222-4222-8222-222222222222",
        checksum: `sha256:${"a".repeat(64)}`,
        origin: "https://skillpack.app/v1",
      });
    else
      expect(value.reason).toBe(
        mode === "refused" || mode === "broad key"
          ? "skillpack_credential_refused"
          : mode === "missing"
            ? "skillpack_skill_unavailable"
            : "skillpack_install_failed",
      );
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
