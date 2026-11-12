import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the actual private script and native wrapper in an isolated guest-home fixture.
// Transport executable replacement stays in a child process, never the suite's PATH.
test("private account handoff selects only the new native env and fences stale file/capability writes", () => {
  const home = mkdtempSync(join(tmpdir(), "repoint-guest-")),
    bin = join(home, "bin");
  try {
    mkdirSync(bin);
    for (const name of ["node", "bash", "flock", "id", "mkdir", "python3"]) {
      const path = Bun.which(name);
      if (!path) throw Error(`Fixture requires ${name}`);
      symlinkSync(path, join(bin, name));
    }
    for (const root of [home, join(home, ".root")]) {
      mkdirSync(join(root, ".ssh"), { recursive: true });
      writeFileSync(join(root, ".ssh/authorized_keys"), "# existing\n", { mode: 0o600 });
    }
    const transport = `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
if(path.basename(process.argv[1])==='ssh-keygen'){const f=process.argv[process.argv.indexOf('-f')+1];fs.writeFileSync(f,'fake key');fs.writeFileSync(f+'.pub','ssh-ed25519 AAAA fixture');process.exit(0);}
const input=fs.readFileSync(0,'utf8').replaceAll('/home/user',process.env.HOME).replaceAll('/root',process.env.HOME+'/.root');const r=cp.spawnSync('bash',['-c','bash -c '+process.argv.at(-1)],{input,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);`;
    for (const name of ["ssh", "ssh-keygen"]) writeFileSync(join(bin, name), transport, { mode: 0o755 });
    for (const harness of ["codex", "claude"])
      writeFileSync(
        join(bin, harness + ".armada-original"),
        "#!/usr/bin/env node\nconsole.log(JSON.stringify({openai:process.env.OPENAI_API_KEY,anthropic:process.env.ANTHROPIC_API_KEY,bearer:process.env.ANTHROPIC_AUTH_TOKEN,baseUrl:process.env.ANTHROPIC_BASE_URL,oauth:process.env.CLAUDE_CODE_OAUTH_TOKEN,auth:process.env.ARMADA_CODEX_AUTH_JSON,args:process.argv.slice(2)}))",
        { mode: 0o755 },
      );
    const helper = join(import.meta.dir, "../src/ssh-repoint-credentials.ts"),
      ssh = join(import.meta.dir, "../src/ssh-executor.ts"),
      wrapper = join(import.meta.dir, "../../provider-boat/src/native-cwd.ts");
    const source = `import {sshRepointCredentials,CAPTURE_MODEL_ENVIRONMENT} from ${JSON.stringify(helper)};import {sshHydrateAuthState} from ${JSON.stringify(ssh)};import {nativeCwdCommand} from ${JSON.stringify(wrapper)};import fs from 'node:fs';
const home=process.env.HOME,bin=home+'/bin',old='old-model-api-secret',next='new-model-api-secret';
const provider={id:'boat',sshKey:async({key})=>{for(const p of [home,home+'/.root'])fs.appendFileSync(p+'/.ssh/authorized_keys',key+'\\n');return {sshEndpoint:'fake.test:22',hostKey:'ssh-ed25519 AAAA'};}};
const run=(command,args=[],env={})=>Bun.spawnSync(['bash','-c',command.replaceAll('/home/user',home),'--',...args],{env:{...process.env,OPENAI_API_KEY:old,ANTHROPIC_API_KEY:'old-other-harness-secret',ANTHROPIC_AUTH_TOKEN:'old-claude-gateway-bearer',ANTHROPIC_BASE_URL:'https://old-claude.example',ARMADA_CODEX_AUTH_JSON:'old-json-secret',ARMADA_CODEX_ENDPOINT:JSON.stringify({version:1,baseUrl:'https://old-gateway.example/v1'}),...env}});
const base={harness:'codex',env:{},credentialId:'credential',credentialVersion:2,sandboxId:'sandbox'};
const captured=run(CAPTURE_MODEL_ENVIRONMENT);if(captured.exitCode!==0)throw Error('capture failed');
const values=await sshRepointCredentials(provider,'fake',{...base,revision:'5',phase:'capture'});
await sshRepointCredentials(provider,'fake',{...base,env:{OPENAI_API_KEY:next,ARMADA_CODEX_ENDPOINT:JSON.stringify({version:1,baseUrl:'https://gateway.example/v1',apiVersion:'2026-11-01'})},revision:'5',phase:'install',native:false,nativeMode:'none'});
const probe=run(nativeCwdCommand(bin+'/codex','codex'),['probe']);if(probe.exitCode!==0)throw Error('native probe failed');const result=JSON.parse(probe.stdout.toString());
let staleInstall=false;try{await sshRepointCredentials(provider,'fake',{...base,env:{OPENAI_API_KEY:old},revision:'4',phase:'install'});}catch{staleInstall=true;}
await sshRepointCredentials(provider,'fake',{...base,revision:'6',phase:'capture'});
const auth=n=>JSON.stringify({tokens:{access_token:'native-access-'+n,refresh_token:'native-refresh-'+n,account_id:'same-account'}});
await sshHydrateAuthState(provider,'fake',auth('new'),{credentialRevision:6});
await sshRepointCredentials(provider,'fake',{...base,revision:'6',phase:'install',native:true,nativeMode:'file',nativeAccountId:'same-account'});
let staleHydrate=false;try{await sshHydrateAuthState(provider,'fake',auth('old'),{credentialRevision:5});}catch{staleHydrate=true;}
const native=run(nativeCwdCommand(bin+'/codex','codex'),['probe']);const nativeEnv=JSON.parse(native.stdout.toString());
const saved=JSON.parse(fs.readFileSync(home+'/.codex/auth.json','utf8'));
// An unfenced old broker write must fail closed if it points at another pin.
fs.writeFileSync(home+'/.armada/model-access.json',JSON.stringify({capability:Buffer.from(JSON.stringify({accountId:'wrong',version:1,sandboxId:'sandbox'})).toString('base64url')+'.synthetic'}),{mode:0o600});
const wrong=run(nativeCwdCommand(bin+'/codex','codex'),['probe']);
await sshRepointCredentials(provider,'fake',{...base,harness:'claude',revision:'7',phase:'capture'});
await sshRepointCredentials(provider,'fake',{...base,harness:'claude',env:{CLAUDE_CODE_OAUTH_TOKEN:'new-claude-secret'},revision:'7',phase:'install',native:false,nativeMode:'none'});
const claude=run(nativeCwdCommand(bin+'/claude','claude'),['probe']);const claudeEnv=JSON.parse(claude.stdout.toString());
console.log(JSON.stringify({selected:result.openai===next,endpoint:result.args.join(' ').includes('https://gateway.example/v1')&&!result.args.join(' ').includes(next)&&!result.args.join(' ').includes('old-gateway'),otherAbsent:!result.anthropic&&!result.auth,captured:values.includes(old)&&values.includes('old-claude-gateway-bearer')&&!values.includes('codex'),staleInstall,staleHydrate,nativeSelected:saved.tokens.access_token==='native-access-new'&&!nativeEnv.openai&&!nativeEnv.auth,wrongPinRejected:wrong.exitCode!==0,claudeSelected:claudeEnv.oauth==='new-claude-secret'&&!claudeEnv.openai&&!claudeEnv.anthropic&&!claudeEnv.bearer&&!claudeEnv.baseUrl}));`;
    const result = Bun.spawnSync([process.execPath, "--eval", source], {
      env: { ...process.env, HOME: home, PATH: bin },
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output + result.stderr.toString()).not.toContain("old-model-api-secret");
    expect(output + result.stderr.toString()).not.toContain("new-model-api-secret");
    expect(JSON.parse(output)).toEqual({
      selected: true,
      endpoint: true,
      otherAbsent: true,
      captured: true,
      staleInstall: true,
      staleHydrate: true,
      nativeSelected: true,
      wrongPinRejected: true,
      claudeSelected: true,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
