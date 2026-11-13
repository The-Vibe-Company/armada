import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Existing canonical smoke tests own archive/turn/checkpoint validation. This
// entrypoint owns zero-allocation account preflight and strict subscription USD.
test.each([
  "success",
  "key",
  "missing",
  "expired",
  "inventory-denied",
  "unknown",
  "zero",
  "estimated",
  "no-resume",
  "same-epoch",
  "historical-cost",
  "child-failed",
  "stop-only",
  "zero-first",
  "wrong-account",
  "no-status",
] as const)("single subscription acceptance entrypoint fails closed (%s)", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "subscription-check-"));
  const secret = `synthetic-${crypto.randomUUID()}`;
  try {
    const preload = join(root, "preload.ts");
    await writeFile(
      preload,
      `
const mode=${JSON.stringify(mode)};
let spawns=0;
process.on('exit',()=>console.log('SPAWNS '+spawns));
globalThis.fetch=async(url,init)=>{
 if(JSON.parse(init.body).org!=='org'||init.redirect!=='error')throw Error('unexpected request');
 if(String(url)==='https://armada.example/api/v1/sandbox/status'){
  if(mode==='no-status')return new Response('',{status:503});
  return Response.json({usage:{turnCount:3,turns:['first','followup','resumed'].map((promptId,i)=>({promptId,inputTokens:100,outputTokens:10,pricing:{basis:'api_equivalent',unknown:null,credentialId:mode==='wrong-account'?'replacement':'11111111-1111-4111-8111-111111111111',credentialVersion:2,usd:mode==='zero-first'&&i===0?'0':'0.001'}})),cost:{currency:'USD',usd:'0.003',basis:'api_equivalent',unknown:null,unpricedTurns:0}}});
 }
 if(String(url)!=='https://armada.example/api/v1/creds/list')throw Error('unexpected request');
 if(mode==='inventory-denied')return new Response('',{status:403});
 return Response.json({user:mode==='missing'?[]:[{id:'11111111-1111-4111-8111-111111111111',kind:mode==='key'?'openai':'codex_auth',status:'active',version:2,expiresAt:mode==='expired'?'2000-01-01T00:00:00Z':null,value:${JSON.stringify(secret)}}],orgs:[]});
};
Bun.spawn=(args,options)=>{
 spawns++;
 if(spawns!==1||!args[1].endsWith('/check-boat-runtime.ts')||JSON.stringify(args.slice(2))!==JSON.stringify(['--usage','--resume'])||options.env.ARMADA_RUNTIME_HARNESS!=='codex'||args.includes(${JSON.stringify(secret)}))throw Error('wrong canonical invocation');
 const cost=(later)=>({status:mode==='unknown'?'unknown':'priced',usd:mode==='unknown'?null:mode==='zero'?'0':later&&mode!=='historical-cost'?'0.003':'0.002',basis:mode==='estimated'?'estimated':'api_equivalent',unknown:mode==='unknown'?'tokens':null});
 const usage=(later)=>({turnCount:later?3:2,admission:'frozen',tokenTotals:{inputTokens:later?300:200,outputTokens:later?30:20},cost:cost(later)});
 const first={sandboxId:'22222222-2222-4222-8222-222222222222',source:'armada-runtime',epoch:'1',promptId:'first',answer:'verified',usage:'verified',usageProof:usage(false)};
 const last={sandboxId:first.sandboxId,source:'armada-runtime',previousEpoch:'1',epoch:mode==='same-epoch'?'1':'2',promptId:'resumed',resume:'verified',usageAfterResume:'verified',costAfterResume:'priced',usageProof:usage(true)};
 const text=${JSON.stringify(secret)}+'\\n'+JSON.stringify(first)+'\\n'+(mode==='no-resume'?'':JSON.stringify(last))+'\\nRuntime resume and stopped history verified.\\n';
 const stream=(s)=>new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(s));c.close();}});
 return {exited:Promise.resolve(['child-failed','stop-only'].includes(mode)?1:0),stdout:stream(mode==='stop-only'?'':text),stderr:stream(${JSON.stringify(secret)}+(mode==='stop-only'?' Stop not confirmed for 22222222-2222-4222-8222-222222222222; coordinator must inspect it.':''))};
};
`,
    );
    const child = Bun.spawn(
      [process.execPath, "--preload", preload, fileURLToPath(new URL("./check-boat-subscription.ts", import.meta.url))],
      {
        env: {
          ...process.env,
          ARMADA_URL: "https://armada.example",
          ARMADA_TOKEN: secret,
          ARMADA_RUNTIME_ORG: "org",
          ARMADA_RUNTIME_GOLDEN: "golden",
          ARMADA_RUNTIME_CREDENTIAL_ID: "11111111-1111-4111-8111-111111111111",
          ARMADA_RUNTIME_HARNESS: "codex",
          ARMADA_RUNTIME_SMOKE: "one_real_boat_launch",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(out + err).not.toContain(secret);
    expect(code).toBe(mode === "success" ? 0 : 1);
    expect(out).toContain(`SPAWNS ${["key", "missing", "expired", "inventory-denied"].includes(mode) ? 0 : 1}`);
    if (["child-failed", "stop-only"].includes(mode))
      expect(err).toContain("Recovery sandbox IDs: 22222222-2222-4222-8222-222222222222");
    if (mode === "success")
      expect(JSON.parse(out.split("\n")[0]!)).toMatchObject({
        subscription: "codex_auth",
        basis: "api_equivalent",
        firstPhaseUsd: "0.002",
        firstTurnUsd: "0.001",
        resumedTurnUsd: "0.001",
        resumedSessionUsd: "0.003",
        usage: "verified",
        cost: "positive",
        subscriptionAnswer: "verified",
        resume: "verified",
        refresh: "not_claimed",
      });
    else expect(out).not.toContain('"subscriptionAnswer":"verified"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
