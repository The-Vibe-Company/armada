import type { Sandbox } from "modal";
import { refusal } from "./errors.ts";
import type { Machine, ProcessBaseline } from "./ports.ts";

// Runs only inside the SDK-selected physical sandbox. pidfds anchor signals to the inspected
// incarnation; PID reuse can never redirect a signal to a new process. Unsupported OS fails closed.
const controller = String.raw`
import { readFileSync,readlinkSync,readdirSync } from "node:fs";
import { dlopen,FFIType } from "bun:ffi";
const input=JSON.parse(await Bun.stdin.text());
const namespace=()=>({pid:readlinkSync("/proc/self/ns/pid"),mount:readlinkSync("/proc/self/ns/mnt")});
function identity(pid){
  let raw;try{raw=readFileSync("/proc/"+pid+"/stat","utf8");}catch(e){if(e.code==="ENOENT"||e.code==="ESRCH")return;throw Error("process_identity_unreadable");}
  const fields=raw.slice(raw.lastIndexOf(")")+2).split(" ");
  const status=readFileSync("/proc/"+pid+"/status","utf8");
  const uid=/^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
  if(!uid || !/^\d+$/.test(fields[19]??"") || !/^\d+$/.test(fields[1]??""))throw Error("process_identity_invalid");
  return {pid,start:fields[19],parent:Number(fields[1]),state:fields[0],uid:Number(uid[2])};
}
function all(){return readdirSync("/proc").filter(x=>/^\d+$/.test(x)).map(x=>{try{return identity(Number(x));}catch(e){try{readFileSync("/proc/"+x+"/stat");}catch{return;}throw e;}}).filter(Boolean);}
const ns=namespace();if(readlinkSync("/proc/1/ns/pid")!==ns.pid)throw Error("process_namespace_unverifiable");
if(input.op==="capture"){
  const rows=all().filter(x=>x.uid===0).map(x=>({pid:x.pid,start:x.start}));
  if(!rows.some(x=>x.pid===1)||rows.length>4096)throw Error("control_baseline_invalid");
  console.log(JSON.stringify({version:1,physicalId:input.physicalId,generation:input.generation,namespace:ns,processes:rows}));
}else{
  const baseline=input.baseline;
  if(!baseline || baseline.version!==1 || baseline.physicalId!==input.physicalId || baseline.generation!==input.generation || baseline.namespace.pid!==ns.pid || baseline.namespace.mount!==ns.mount)throw Error("process_baseline_mismatch");
  const controls=new Map(baseline.processes.map(x=>[x.pid,x.start]));
  const init=identity(1);if(!init || controls.get(1)!==init.start)throw Error("pid1_identity_changed");
  // Only the actual cleanup ancestry is an additional exclusion, never a PPid-based writer scope.
  let current=identity(process.pid);const ancestry=new Map();
  for(let n=0;current && n<128;n++) {ancestry.set(current.pid,current.start);if(current.pid===1)break;if(current.parent===0){ancestry.set(1,init.start);break;}const parent=identity(current.parent);if(!parent || parent.pid===current.pid)throw Error("cleanup_ancestry_unverifiable");current=parent;}
  if(!ancestry.has(1))throw Error("cleanup_ancestry_unverifiable");
  const libc=dlopen("libc.so.6",{pidfd_open:{args:[FFIType.i32,FFIType.u32],returns:FFIType.i32},pidfd_send_signal:{args:[FFIType.i32,FFIType.i32,FFIType.ptr,FFIType.u32],returns:FFIType.i32},close:{args:[FFIType.i32],returns:FFIType.i32}});
  const owned=new Map();
  function excluded(row){const expected=controls.get(row.pid)??ancestry.get(row.pid);if(expected!==undefined && expected!==row.start)throw Error("trusted_process_identity_changed");return expected!==undefined;}
  function pin(row){
    const old=owned.get(row.pid);if(old){if(old.start!==row.start)throw Error("writer_pid_reused");return old;}
    const fd=libc.symbols.pidfd_open(row.pid,0);
    if(fd<0){if(!identity(row.pid))return;throw Error("writer_pidfd_unavailable");}
    const now=identity(row.pid);if(!now || now.start!==row.start){libc.symbols.close(fd);if(now)throw Error("writer_identity_changed");return;}
    const pinned={...row,fd};owned.set(row.pid,pinned);return pinned;
  }
  function signal(row,sig){if(libc.symbols.pidfd_send_signal(row.fd,sig,null,0)<0){const now=identity(row.pid);if(now && now.start===row.start && !["Z","X"].includes(now.state))throw Error("writer_signal_unverifiable");}}
  try {
    // Freeze additional root/user writers first. A detached child reparented to PID1 is still
    // additional, and a child racing enumeration is frozen by the next sweep before deletion.
    for(let pass=0;pass<128;pass++){
      const rows=all().filter(row=>!excluded(row)&&!["Z","X"].includes(row.state));
      if(!rows.length)break;
      for(const row of rows){const pinned=pin(row);if(pinned)signal(pinned,19);}
      if(pass===127)throw Error("writer_freeze_unbounded");
      const next=all().filter(row=>!excluded(row)&&!["Z","X","T","t"].includes(row.state));
      if(!next.length)break;
    }
    for(const row of owned.values())signal(row,9);
    let clean=false;
    for(let pass=0;pass<100;pass++){
      const rows=all().filter(row=>!excluded(row)&&!["Z","X"].includes(row.state));
      if(!rows.length){clean=true;break;}
      for(const row of rows){const pinned=pin(row);if(pinned){signal(pinned,19);signal(pinned,9);}}
      await Bun.sleep(10);
    }
    if(!clean || all().some(row=>!excluded(row)&&!["Z","X"].includes(row.state)))throw Error("writer_quiescence_unproven");
  } finally {for(const row of owned.values())libc.symbols.close(row.fd);libc.close();}
}
`;

async function invoke(sandbox: Sandbox, input: object, capture: boolean): Promise<string> {
  const child = await sandbox.exec(
    ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "/opt/armada/runtime-bun/bun", "-e", controller],
    { env: {}, secrets: [], timeoutMs: 30_000, stdout: capture ? "pipe" : "ignore", stderr: "ignore" },
  );
  await child.stdin.writeText(JSON.stringify(input));
  await child.stdin.close();
  const output = capture ? child.stdout.readText() : Promise.resolve("");
  const [exit, text] = await Promise.all([child.wait(), output]);
  if (exit !== 0)
    throw refusal(
      "conflict",
      "Physical process identity/quiescence could not be proven; source retained.",
      "process_quiescence_failed",
    );
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
