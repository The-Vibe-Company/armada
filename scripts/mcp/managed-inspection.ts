/** Safe VM programs for operator-owned managed probes. Never returns argv, headers or environment. */
export interface HeaderSentinel {
  name: string;
  url: string;
  value: string;
}

export function installHeaderSentinel(probe: HeaderSentinel): string {
  return `node <<'ARMADA_HEADER_SENTINEL'
try {
const fs=require('node:fs'),p=require('node:path'),home=require('node:os').homedir();
const probe=${JSON.stringify(probe)};
function read(file){try{if(fs.lstatSync(file).isSymbolicLink())throw Error();return fs.readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return '';throw e;}}
function write(file,text){const tmp=file+'.argv-probe-'+process.pid;try{fs.writeFileSync(tmp,text,{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);fs.chmodSync(file,0o600);}finally{fs.rmSync(tmp,{force:true});}}
const c=p.join(home,'.claude.json'),claude=JSON.parse(read(c)||'{}');claude.mcpServers ||= {};
if(claude.mcpServers[probe.name])throw Error();
claude.mcpServers[probe.name]={type:'http',url:probe.url,headers:{'X-Armada-Argv-Sentinel':probe.value}};
const codex=p.join(home,'.codex');if(fs.lstatSync(codex).isSymbolicLink())throw Error();
const t=p.join(codex,'config.toml'),original=read(t),q=JSON.stringify;
if(original.includes('[mcp_servers.'+q(probe.name)+']'))throw Error();
write(c,JSON.stringify(claude));
write(t,original+['','# BEGIN ARMADA HARMLESS ARGV PROBE','[mcp_servers.'+q(probe.name)+']','url = '+q(probe.url),'http_headers = { '+q('X-Armada-Argv-Sentinel')+' = '+q(probe.value)+' }','# END ARMADA HARMLESS ARGV PROBE',''].join(String.fromCharCode(10)));
process.stdout.write(JSON.stringify({installed:true}));
}catch{process.exit(1);}
ARMADA_HEADER_SENTINEL`;
}

export function managedInspection(ids: string[], probe: HeaderSentinel): string {
  return String.raw`node <<'ARMADA_MANAGED_MCP_PROOF'
try {
const fs=require('node:fs'),p=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const ids=${JSON.stringify(ids)},probe=${JSON.stringify(probe)},home=os.homedir();
const claude=JSON.parse(fs.readFileSync(p.join(home,'.claude.json'),'utf8')).mcpServers||{};
const text=fs.readFileSync(p.join(home,'.codex/config.toml'),'utf8');
const codex={};let current;
for(const line of text.split('\n')){
 const section=/^\[mcp_servers\.(".*")\]$/.exec(line.trim());
 if(section){current=codex[JSON.parse(section[1])]={};continue;}
 const field=/^(command|args|url) = (.*)$/.exec(line.trim());if(current&&field)current[field[1]]=JSON.parse(field[2]);
}
const secret=/armada_(?:gw|sk|mcp|mrt)_[A-Za-z0-9_-]{24,}|\b(?:sk-ant-|sk-|ghu_|ghs_)[A-Za-z0-9_-]{20,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const publicServer=claude[probe.name],codexProbe=text.slice(text.indexOf('# BEGIN ARMADA HARMLESS ARGV PROBE'));
const result={configured:true,credentialArgvLeak:false,sentinelConfigured:!!publicServer&&publicServer.url===probe.url&&publicServer.headers?.['X-Armada-Argv-Sentinel']===probe.value&&codex[probe.name]?.url===probe.url&&codexProbe.includes(JSON.stringify(probe.value)),nativeChildObserved:false,sentinelInNativeArgv:false,headers:{},stdio:{}};
const descriptors=[];
for(const id of ids){
 const name='armada_'+id.replaceAll('-','_'),a=claude[name],b=codex[name];
 if(!a||!b){result.configured=false;continue;}
 if(a.type==='http'){
  const bearer=a.headers?.Authorization;
  if(typeof bearer!=='string'||!bearer.startsWith('Bearer armada_gw_')||a.url!==b.url)result.configured=false;
  else result.headers[id]=crypto.createHash('sha256').update(bearer).digest('hex');
 }else{
  if(a.command!==b.command||JSON.stringify(a.args)!==JSON.stringify(b.args))result.configured=false;
  const args=a.args||[],npx=a.command.endsWith('/npx'),spec=npx?args[2]:args[1];
  const fixed=npx?['/usr/local/bin/npx','/usr/bin/npx']:['/usr/local/bin/uvx','/usr/bin/uvx','/home/user/.local/bin/uvx','/root/.local/bin/uvx'];
  if(!fixed.includes(a.command))result.configured=false;
  const match=npx?/^(.*)@([0-9]+\.[0-9]+\.[0-9]+.*)$/.exec(spec||''):/^(.*)==([0-9]+\.[0-9]+\.[0-9]+.*)$/.exec(spec||'');
  if(!match){result.configured=false;continue;}
  descriptors.push({id,npx,pkg:match[1],version:match[2],spec,tail:npx?args.slice(3):args.slice(args[2]==='--'?4:3)});
  result.stdio[id]={processSeen:false,pinObserved:false,argvMatches:false};
 }
}
function samePkg(a,b){return a.toLowerCase().replace(/[-_.]+/g,'-')===b.toLowerCase().replace(/[-_.]+/g,'-');}
function metadata(file,d){
 try{
  let dir=p.dirname(fs.realpathSync(file));
  for(let i=0;i<10;i++,dir=p.dirname(dir)){const f=p.join(dir,'package.json');if(fs.existsSync(f)&&fs.statSync(f).size<131072){const j=JSON.parse(fs.readFileSync(f,'utf8'));if(j.name===d.pkg&&j.version===d.version)return true;}}
  const lib=p.join(p.dirname(p.dirname(file)),'lib');
  if(fs.existsSync(lib))for(const py of fs.readdirSync(lib).filter(n=>/^python[0-9]/.test(n)).slice(0,8)){
   const site=p.join(lib,py,'site-packages');if(!fs.existsSync(site))continue;
   for(const name of fs.readdirSync(site).filter(n=>n.endsWith('.dist-info')).slice(0,512)){
    const f=p.join(site,name,'METADATA');if(!fs.existsSync(f)||fs.statSync(f).size>131072)continue;
    const m=fs.readFileSync(f,'utf8'),n=/^Name:\s*(.+)$/m.exec(m)?.[1],v=/^Version:\s*(.+)$/m.exec(m)?.[1];
    if(n&&samePkg(n,d.pkg)&&v?.trim()===d.version)return true;
   }
  }
 }catch{}return false;
}
// Exclude the inspection process and ALL of its ancestors, including the exec shell
// whose command text legitimately contains the harmless sentinel. Never inspect environ.
const processes=new Map();
for(const name of fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n)))try{
 const pid=Number(name),stat=fs.readFileSync('/proc/'+pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
 processes.set(pid,{ppid:Number(fields[1])});
}catch{}
const excluded=new Set();let ancestor=process.pid;
while(ancestor&&!excluded.has(ancestor)){excluded.add(ancestor);ancestor=processes.get(ancestor)?.ppid;}
const native=new Set();
for(const [pid,row] of processes)if(!excluded.has(pid))try{
 const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);
 const first=argv.slice(0,2);
 if(first.some(arg=>/^(?:.*\/)?(?:claude|codex)(?:\.js)?$/.test(arg)||arg.includes('/@anthropic-ai/claude-code/cli.js')||arg.includes('/@anthropic-ai/claude-agent-sdk/cli.js')||arg.includes('/@openai/codex/bin/codex.js'))){native.add(pid);row.argv=argv;}
}catch{}
let changed=true;while(changed){changed=false;for(const [pid,row] of processes)if(!excluded.has(pid)&&!native.has(pid)&&native.has(row.ppid)){native.add(pid);changed=true;}}
for(const pid of native){
 let argv;try{argv=processes.get(pid).argv||fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);}catch{continue;}
 result.nativeChildObserved=true;
 if(argv.some(v=>v.includes(probe.value)))result.sentinelInNativeArgv=true;
 if(argv.some(v=>secret.test(v)))result.credentialArgvLeak=true;
 for(const d of descriptors){
  const files=argv.filter(v=>v.startsWith('/'));
  let candidate=argv.includes(d.spec)||files.some(f=>p.basename(f).includes(d.pkg.split('/').pop()));
  if(!candidate&&d.npx)for(const f of files)try{if(fs.realpathSync(f).includes('/node_modules/'+d.pkg+'/'))candidate=true;}catch{}
  if(!candidate)continue;
  const observed=result.stdio[d.id];observed.processSeen=true;
  if(argv.includes(d.spec)||files.some(f=>metadata(f,d)))observed.pinObserved=true;
  if(d.tail.length===0||argv.some((_v,i)=>d.tail.every((v,j)=>argv[i+j]===v)))observed.argvMatches=true;
 }
}
process.stdout.write(JSON.stringify(result));
}catch{process.exit(1);}
ARMADA_MANAGED_MCP_PROOF`;
}
