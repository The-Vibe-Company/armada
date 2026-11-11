import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_USAGE_PYTHON } from "../src/native-usage.ts";

/** Exercises real guest admission and parsing, no harness/model or network. */
function guest(scenario: string): unknown {
  const home = mkdtempSync(join(tmpdir(), "armada-usage-"));
  try {
    const script = `import os,json,sys\nns={'__name__':'test'}\nexec(${JSON.stringify(NATIVE_USAGE_PYTHON)},ns)\nglobals().update(ns)\n${scenario}`;
    const result = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, HOME: home } });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return JSON.parse(result.stdout.toString());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const setup = `
init()
session='12345678-1234-1234-1234-123456789012'
os.makedirs(HOME+'/.codex/sessions/2026/01/01')
path=HOME+'/.codex/sessions/2026/01/01/rollout-'+session+'.jsonl'
def write(total,mode='w',model='gpt-5',turn='t1'):
    rows=[{'type':'session_meta','payload':{'id':session}}, {'type':'event_msg','payload':{'type':'task_started','turn_id':turn}}, {'type':'turn_context','payload':{'model':model}}, {'type':'event_msg','payload':{'type':'token_count','info':{'total_token_usage':dict(zip(['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens'],total))}}}, {'type':'event_msg','payload':{'type':'task_complete','turn_id':turn}}]
    with open(path,mode) as f:
        for row in rows: f.write(json.dumps(row)+'\\n')
def admit(ticket,prompt):
    save(ticket+'.json',{});save('pending.json',{'ticket':ticket,'at':time.time()});save('prompt-'+prompt+'.json',{'ticket':ticket})
`;
describe("Boat guest native usage", () => {
  test("multi-turn Codex cumulative counters yield deltas, retries do not add", () => {
    expect(
      guest(
        setup +
          `
admit('one','p1');capture('codex',session,True);start('one','t1')
write([100,20,40,10,5]);terminal('one','t1')
a=collect('p1');retry=collect('p1')
admit('two','p2');capture('codex',session,False);start('two','t2')
write([150,35,60,17,8],mode='a',turn='t2');terminal('two','t2')
print(json.dumps([a,retry,collect('p1'),collect('p2')]))
`,
      ),
    ).toEqual([
      [
        {
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 20,
          cachedTokens: 40,
          cacheWriteTokens: 10,
          reasoningTokens: 5,
        },
      ],
      [
        {
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 20,
          cachedTokens: 40,
          cacheWriteTokens: 10,
          reasoningTokens: 5,
        },
      ],
      [
        {
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 20,
          cachedTokens: 40,
          cacheWriteTokens: 10,
          reasoningTokens: 5,
        },
      ],
      [
        {
          model: "gpt-5",
          inputTokens: 50,
          outputTokens: 15,
          cachedTokens: 20,
          cacheWriteTokens: 7,
          reasoningTokens: 3,
        },
      ],
    ]);
  });
  test("a valid stale flush is never frozen at admission or attributed to the next turn", () => {
    expect(
      guest(
        setup +
          `
admit('one','p1');capture('codex',session,True);start('one','t1')
write([50,10,0,0,0])
# Remove the native completion marker, leaving valid but stale cumulative usage.
lines=open(path).readlines()
with open(path,'w') as f: f.writelines(lines[:-1])
terminal('one','t1');early=collect('p1')
admit('two','p2');capture('codex',session,False);start('two','t2')
stale=collect('p1')
# The delayed t1 flush and its native completion arrive AFTER t2 admission.
with open(path,'a') as f:
    f.write(json.dumps({'type':'event_msg','payload':{'type':'token_count','info':{'total_token_usage':{'input_tokens':100,'output_tokens':20,'cached_input_tokens':0}}}})+'\\n')
    f.write(json.dumps({'type':'event_msg','payload':{'type':'task_complete','turn_id':'t1'}})+'\\n')
write([150,30,0,0,0],mode='a',turn='t2');terminal('two','t2')
a=collect('p1');b=collect('p2')
print(json.dumps([early,stale,a[0]['inputTokens'],b[0]['inputTokens'],collect('p1')==a,collect('p2')==b]))
`,
      ),
    ).toEqual([[], [], 100, 50, true, true]);
  });
  test("missing resume baseline, symlink, mismatched session identity fail closed", () => {
    expect(
      guest(
        setup +
          `
admit('one','p1');capture('codex',session,False);start('one','t1')
write([100,20,40,10,5]);terminal('one','t1');resume=collect('p1')
admit('two','p2');capture('codex',session,False);start('two','t2')
write([150,30,40,10,5],mode='a',turn='t2');terminal('two','t2')
os.rename(path,path+'.other');os.symlink(path+'.other',path)
linked=collect('p2');os.unlink(path)
os.rename(path+'.other',path);valid=len(collect('p2'))
entry=load('two.json');entry.pop('final');save('two.json',entry)
with open(path,'w') as f: f.write(json.dumps({'type':'session_meta','payload':{'id':'wrong'}})+'\\n')
print(json.dumps([resume,linked,valid,collect('p2')]))
`,
      ),
    ).toEqual([[], [], 1, []]);
  });
  test("Claude cumulative files without a proven native boundary remain unknown", () => {
    expect(
      guest(`
init();session='12345678-1234-1234-1234-123456789012'
save('one.json',{'session':session,'harness':'claude','fresh':True,'turn':'t1','terminal':True})
save('prompt-p1.json',{'ticket':'one'})
print(json.dumps(collect('p1')))
`),
    ).toEqual([]);
  });
  test("ambiguous concurrent admissions invalidate mapping, fresh fork resets inherited tickets", () => {
    expect(
      guest(
        setup +
          `
import contextlib,io
def launch(ticket,generation):
    sys.argv=['usage','admit',ticket,generation]
    with contextlib.redirect_stdout(io.StringIO()): main()
launch('one','sandbox1');save('prompt-p1.json',{'ticket':'one'})
launch('two','sandbox1')
capture('codex',session,True);write([100,20,40,10,5]);terminal('one','t1')
ambiguous=collect('p1');disabled=os.path.exists(ROOT+'/disabled.json')
launch('three','sandbox2')
new_ticket=load('pending.json')['ticket'];reset=not os.path.exists(ROOT+'/one.json')
print(json.dumps([ambiguous,disabled,new_ticket,reset]))
`,
      ),
    ).toEqual([[], true, "three", true]);
  });
});
