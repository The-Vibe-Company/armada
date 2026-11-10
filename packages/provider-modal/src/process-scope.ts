import { ProviderError } from "@armada/core";
import type { Sandbox } from "modal";
import { refusal } from "./errors.ts";
import type { Machine, ProcessBaseline } from "./ports.ts";

// Runs only inside the SDK-selected physical sandbox. pidfds anchor signals to the inspected
// incarnation where supported; gVisor fallback revalidates start identity before each owned-process signal.
const controller = String.raw`
import { readFileSync,readlinkSync,readdirSync,statSync } from "node:fs";
import { dlopen,FFIType,read } from "bun:ffi";
const inspections=new Set();
const errnoClass=e=>({1:"EPERM",3:"ESRCH",13:"EACCES",22:"EINVAL",38:"ENOSYS",95:"EOPNOTSUPP"})[e]??"other";
function denied(primitive,code){if(code!=="ESRCH")inspections.add(primitive+"_"+code);}
function category(row){
  let comm="";try{comm=readFileSync("/proc/"+row.pid+"/comm","utf8").trim();}catch{}
  return comm==="codex"?41:["bun","bun.exe","node"].includes(comm)?42:row.uid===0?43:44;
}
let survivorCode=40, survivor;
const roots=["/home/user/.armada-runtime","/home/user/.codex","/home/user/.claude","/home/user/.claude.json"];
const inside=p=>roots.some(root=>p===root||p.startsWith(root+"/")||p.startsWith(root+" (deleted)"));
function nameClass(name){return ["bun","bun.exe"].includes(name)?"bun":name==="node"?"node":name==="codex"?"codex":name==="claude"?"claude":["sshd","sshd-session","sshd-auth"].includes(name)?"ssh":"other";}
function names(row){
  let comm="unreadable",exe="unreadable",runner=false;
  try{comm=nameClass(readFileSync("/proc/"+row.pid+"/comm","utf8").trim());}catch{}
  try{exe=nameClass(readlinkSync("/proc/"+row.pid+"/exe").replace(/ \(deleted\)$/," ").trim().split("/").pop());}catch{}
  if(comm==="bun"||exe==="bun")try{runner=readFileSync("/proc/"+row.pid+"/cmdline","utf8").split("\0").includes("/opt/armada/main.js");}catch{}
  return {comm,exe,runner,owned:runner||[comm,exe].some(x=>["codex","claude","ssh"].includes(x))};
}
function managedState(row){
  let unreadable=false;try{if(inside(readlinkSync("/proc/"+row.pid+"/cwd")))return "managed";}catch{unreadable=true;}
  try{for(const fd of readdirSync("/proc/"+row.pid+"/fd")){try{if(inside(readlinkSync("/proc/"+row.pid+"/fd/"+fd)))return "managed";}catch(e){if(!["ENOENT","ESRCH"].includes(e.code))unreadable=true;}}}catch{unreadable=true;}
  return unreadable?"unreadable":"outside";
}
try {
const input=JSON.parse(await Bun.stdin.text());
// The SDK binds the physical sandbox and generation. Self namespace links are supplementary
// evidence only: gVisor can permanently deny ptrace-gated links, especially PID1's.
function namespace(){const result={};for(const [key,name] of [["pid","pid"],["mount","mnt"]]){
  try{result[key]=readlinkSync("/proc/self/ns/"+name);}catch(e){denied("self_namespace",["EACCES","EPERM","EINVAL","ENOENT","ENOSYS"].includes(e.code)?e.code:"other");result[key]="unavailable";}
}return result;}
function identity(pid){
  let raw;try{raw=readFileSync("/proc/"+pid+"/stat","utf8");}catch(e){if(e.code==="ENOENT"||e.code==="ESRCH")return;denied("proc_stat",["EACCES","EPERM"].includes(e.code)?e.code:"other");throw Error("process_identity_unreadable");}
  const fields=raw.slice(raw.lastIndexOf(")")+2).split(" ");
  let uid;try{const status=readFileSync("/proc/"+pid+"/status","utf8");uid=Number(/^Uid:\s+(\d+)\s+(\d+)/m.exec(status)?.[2]);}catch(e){
    denied("proc_status",["EACCES","EPERM"].includes(e.code)?e.code:"other");uid=statSync("/proc/"+pid).uid;
  }
  if(!Number.isSafeInteger(uid)||!/^\d+$/.test(fields[19]??"")||!/^\d+$/.test(fields[1]??""))throw Error("process_identity_invalid");
  return {pid,start:fields[19],parent:Number(fields[1]),state:fields[0],uid};
}
function all(){return readdirSync("/proc").filter(x=>/^\d+$/.test(x)).map(x=>{try{return identity(Number(x));}catch(e){try{readFileSync("/proc/"+x+"/stat");}catch(check){if(check.code==="ENOENT"||check.code==="ESRCH")return;throw e;}throw e;}}).filter(Boolean);}
const ns=namespace();
if(input.op==="capture"){
  const rows=all().filter(x=>x.uid===0).map(x=>({pid:x.pid,start:x.start}));
  if(!rows.some(x=>x.pid===1)||rows.length>4096)throw Error("control_baseline_invalid");
  console.log(JSON.stringify({version:1,physicalId:input.physicalId,generation:input.generation,namespace:ns,processes:rows}));
}else{
  const baseline=input.baseline;
  if(!baseline||baseline.version!==1||baseline.physicalId!==input.physicalId||baseline.generation!==input.generation||
    Object.keys(ns).some(k=>ns[k]!=="unavailable"&&baseline.namespace[k]!=="unavailable"&&baseline.namespace[k]!==ns[k]))throw Error("process_baseline_mismatch");
  const controls=new Map(baseline.processes.map(x=>[x.pid,x.start]));
  const init=identity(1);if(!init||controls.get(1)!==init.start)throw Error("pid1_identity_changed");
  let current=identity(process.pid);const ancestry=new Map();
  for(let n=0;current&&n<128;n++){ancestry.set(current.pid,current.start);if(current.pid===1)break;if(current.parent===0){ancestry.set(1,init.start);break;}const parent=identity(current.parent);if(!parent||parent.pid===current.pid)throw Error("cleanup_ancestry_unverifiable");current=parent;}
  if(!ancestry.has(1))throw Error("cleanup_ancestry_unverifiable");
  let libc;try{libc=dlopen("libc.so.6",{pidfd_open:{args:[FFIType.i32,FFIType.u32],returns:FFIType.i32},pidfd_send_signal:{args:[FFIType.i32,FFIType.i32,FFIType.ptr,FFIType.u32],returns:FFIType.i32},__errno_location:{args:[],returns:FFIType.ptr},close:{args:[FFIType.i32],returns:FFIType.i32}});}catch{denied("pidfd_open","ENOSYS");}
  const owned=new Map(),failures=new Map();
  const key=row=>row.pid+":"+row.start;
  const live=row=>row&&!['Z','X'].includes(row.state);
  // Root control descendants are infrastructure, not ownership of a managed turn. Do not
  // extend trust from PID1 (orphans) or through a user process (sudo/double-fork writers).
  function role(row){
    if(row.pid===1&&controls.get(1)===row.start)return "pid1";
    if(ancestry.get(row.pid)===row.start)return "scrub_ancestor";
    const known=names(row);
    if(known.runner)return "armada_runner"; // It still owns journal descriptors: must terminate.
    if(known.owned)return "harness";
    if(controls.get(row.pid)===row.start)return "baseline_control";
    if(row.uid!==0)return "writer";
    const seen=new Set([row.pid]);let parent=row;
    for(let depth=0;depth<128;depth++){
      if(parent.parent<=1||seen.has(parent.parent))break;
      parent=identity(parent.parent);if(!parent||parent.uid!==0)break;
      seen.add(parent.pid);
      if(names(parent).owned)break;
      if(controls.get(parent.pid)===parent.start||ancestry.get(parent.pid)===parent.start)return "platform_control_child";
    }
    return "writer";
  }
  function excluded(row){
    const kind=role(row);
    if(kind==="pid1"||kind==="scrub_ancestor")return true;
    return ["baseline_control","platform_control_child"].includes(kind)&&managedState(row)!=="managed";
  }
  function describe(rows){const row=rows[0],known=names(row);return {
    processUidClass:row.uid===0?"root":"user",processIsAncestor:ancestry.get(row.pid)===row.start,processIsPid1:row.pid===1,
    processCommClass:known.comm,processExeClass:known.exe,processRole:role(row),processSurvivorCount:Math.min(rows.length,4096),
    processStateClass:["T","t"].includes(row.state)?"stopped":row.state==="D"?"blocked":["R","S","I"].includes(row.state)?"running":"unknown",
    processManagedState:managedState(row),
  };}
  function pin(row){
    const old=owned.get(row.pid);if(old&&old.start===row.start)return old;
    if(old?.fd>=0)libc.symbols.close(old.fd);owned.delete(row.pid);
    let fd=-1;if(libc){fd=libc.symbols.pidfd_open(row.pid,0);if(fd<0)denied("pidfd_open",errnoClass(read.i32(libc.symbols.__errno_location())));}
    const now=identity(row.pid);if(!live(now)||now.start!==row.start){if(fd>=0)libc.symbols.close(fd);return;}
    const pinned={...now,fd};owned.set(row.pid,pinned);return pinned;
  }
  function signal(row,sig){
    const now=identity(row.pid);if(!live(now)||now.start!==row.start||excluded(now))return;
    if(row.fd>=0){if(libc.symbols.pidfd_send_signal(row.fd,sig,null,0)===0)return;
      const code=errnoClass(read.i32(libc.symbols.__errno_location()));if(code==="ESRCH")return;denied("pidfd_signal",code);
    }
    // On gVisor pidfds may be unsupported or permission gated. Only an additional,
    // still-matching process in this SDK-selected sandbox may receive a numeric signal.
    const checked=identity(row.pid);if(!live(checked)||checked.start!==row.start||excluded(checked))return;
    try{process.kill(row.pid,sig);}catch(e){if(e.code!=="ESRCH"){denied("kill",["EPERM","EACCES"].includes(e.code)?e.code:"other");failures.set(key(row),"signal");}}
  }
  try{
    // Freeze writers before killing them so descendants cannot continually replenish the scope.
    for(let pass=0;pass<128;pass++){
      const rows=all().filter(row=>!excluded(row)&&live(row));if(!rows.length)break;
      for(const row of rows){const pinned=pin(row);if(pinned)signal(pinned,19);}
      if(!all().some(row=>!excluded(row)&&live(row)&&!['T','t'].includes(row.state)))break;
      if(rows.some(row=>failures.has(key(row))))break;
    }
    for(const row of owned.values())signal(row,9);
    for(let pass=0;pass<100;pass++){
      const rows=all().filter(row=>!excluded(row)&&live(row));if(!rows.length)break;
      for(const row of rows){const pinned=pin(row);if(pinned){signal(pinned,19);signal(pinned,9);}}
      await Bun.sleep(10);
    }
    const remaining=all().filter(row=>!excluded(row)&&live(row));
    if(remaining.length){survivor=describe(remaining);survivorCode=category(remaining[0])+(failures.has(key(remaining[0]))?20:0);throw Error("writer_survived");}
  }finally{if(libc){for(const row of owned.values())if(row.fd>=0)libc.symbols.close(row.fd);libc.close();}}
  console.log(JSON.stringify({inspections:[...inspections]}));
}
}catch{console.log(JSON.stringify({inspections:[...inspections],survivor}));process.exit(survivorCode);}
`;
const PROCESS_FAILURES: Readonly<Record<number, string>> = {
  40: "unknown",
  41: "codex",
  42: "runtime_or_mcp",
  43: "privileged_writer",
  44: "user_writer",
};

async function invoke(sandbox: Sandbox, input: object, capture: boolean): Promise<string> {
  const child = await sandbox.exec(
    ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "/opt/armada/runtime-bun/bun", "-e", controller],
    { env: {}, secrets: [], timeoutMs: 30_000, stdout: "pipe", stderr: "ignore" },
  );
  await child.stdin.writeText(JSON.stringify(input));
  await child.stdin.close();
  const output = child.stdout?.readText?.() ?? Promise.resolve("");
  const [exit, text] = await Promise.all([child.wait(), output]);
  let inspection: string | undefined;
  const survivorDetails: Record<string, string | number | boolean> = {};
  if (!capture || exit !== 0) {
    try {
      const parsed = JSON.parse(text);
      const enums: Record<string, readonly string[]> = {
        processUidClass: ["root", "user", "unknown"],
        processCommClass: ["armada_runner", "codex", "claude", "bun", "node", "ssh", "other", "unreadable"],
        processExeClass: ["armada_runner", "codex", "claude", "bun", "node", "ssh", "other", "unreadable"],
        processRole: [
          "pid1",
          "scrub_ancestor",
          "baseline_control",
          "platform_control_child",
          "armada_runner",
          "harness",
          "writer",
        ],
        processStateClass: ["running", "stopped", "blocked", "unknown"],
        processManagedState: ["managed", "outside", "unreadable"],
      };
      for (const [field, allowed] of Object.entries(enums)) {
        const value: unknown = parsed.survivor?.[field];
        if (typeof value === "string" && allowed.includes(value)) survivorDetails[field] = value;
      }
      for (const field of ["processIsAncestor", "processIsPid1"]) {
        const value: unknown = parsed.survivor?.[field];
        if (typeof value === "boolean") survivorDetails[field] = value;
      }
      const count = parsed.survivor?.processSurvivorCount;
      if (Number.isSafeInteger(count) && count >= 1 && count <= 4096) survivorDetails.processSurvivorCount = count;
      const values = parsed.inspections;
      if (Array.isArray(values))
        inspection = values.findLast(
          (value: unknown) =>
            typeof value === "string" &&
            /^(self_namespace|proc_stat|proc_status|pidfd_open|pidfd_signal|kill)_(EPERM|EACCES|ENOSYS|EOPNOTSUPP|EINVAL|ENOENT|other)$/.test(
              value,
            ),
        );
    } catch {
      /* Never retain remote exception text. */
    }
  }
  if (exit !== 0)
    throw new ProviderError({
      provider: "modal",
      code: "conflict",
      message: "Physical process identity/quiescence could not be proven; source retained.",
      retryable: false,
      details: {
        modalFailure: "process_quiescence_failed",
        ...survivorDetails,
        ...(inspection ? { processInspection: inspection } : {}),
        processCategory: PROCESS_FAILURES[exit >= 50 && exit < 80 ? 40 + (exit % 10) : exit] ?? "unknown",
        processFailure:
          exit >= 50 && exit < 60
            ? "pidfd_open"
            : exit >= 60 && exit < 70
              ? "pidfd_signal"
              : exit >= 70 && exit < 80
                ? "identity_changed"
                : "unproven",
      },
    });
  return text;
}
export async function captureProcessBaseline(sandbox: Sandbox, machine: Machine): Promise<ProcessBaseline> {
  if (!machine.physicalId || machine.phase !== "booting")
    throw refusal("conflict", "Process baseline capture requires a fresh physical machine before admission.");
  const data = JSON.parse(
    await invoke(sandbox, { op: "capture", physicalId: machine.physicalId, generation: machine.generation }, true),
  ) as ProcessBaseline;
  if (
    data.version !== 1 ||
    data.physicalId !== machine.physicalId ||
    data.generation !== machine.generation ||
    !data.namespace?.pid ||
    !data.namespace.mount ||
    !Array.isArray(data.processes) ||
    !data.processes.length ||
    data.processes.length > 4096 ||
    data.processes.some((x) => !Number.isSafeInteger(x.pid) || x.pid < 1 || !/^\d+$/.test(x.start)) ||
    !data.processes.some((x) => x.pid === 1)
  )
    throw refusal("conflict", "Invalid physical control baseline; admission refused.");
  return data;
}
export async function quiesceSandboxProcesses(sandbox: Sandbox, machine: Machine): Promise<void> {
  if (
    !machine.processBaseline ||
    machine.processBaseline.physicalId !== machine.physicalId ||
    machine.processBaseline.generation !== machine.generation
  )
    throw refusal(
      "conflict",
      "Trusted physical process baseline missing; source retained.",
      "process_baseline_missing",
    );
  await invoke(
    sandbox,
    {
      op: "quiesce",
      physicalId: machine.physicalId,
      generation: machine.generation,
      baseline: machine.processBaseline,
    },
    false,
  );
}
