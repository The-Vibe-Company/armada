/** Secret-free bridge configuration. Separate ownership marker means generic MCP
 * refresh/scrub preserves it and unrelated user/external servers. It cannot install
 * arbitrary commands or external URLs: only this VM's loopback broker endpoint. */
export const boatOrchestratorBridgeScript = String.raw`set +x
node <<'ARMADA_ORCHESTRATOR_BRIDGE'
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const c=JSON.parse(process.env.ARMADA_GIT_TOKEN||'null');delete process.env.ARMADA_GIT_TOKEN;
function checked(p,dir=false){try{const s=fs.lstatSync(p);if(s.isSymbolicLink()||(dir?!s.isDirectory():!s.isFile()))throw Error('orchestrator_bridge_conflict');}catch(e){if(e.code!=='ENOENT')throw e;}}
function read(p){checked(p);try{return fs.readFileSync(p,'utf8');}catch(e){if(e.code==='ENOENT')return '';throw e;}}
function write(p,text){checked(p);const tmp=p+'.orchestrator-'+process.pid;try{fs.writeFileSync(tmp,text,{mode:0o600,flag:'wx'});if(process.getuid()===0)fs.chownSync(tmp,homeOwner.uid,homeOwner.gid);fs.renameSync(tmp,p);}finally{fs.rmSync(tmp,{force:true});}}
const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
if(c.boot!==boot||!Number.isInteger(c.port)||c.port<1||c.port>65535)throw Error('orchestrator_bridge_denied');
const home=os.homedir(),homeOwner=fs.statSync(home),owned=path.join(home,'.armada'),codexDir=path.join(home,'.codex');
checked(owned,true);checked(codexDir,true);fs.mkdirSync(owned,{recursive:true,mode:0o700});fs.mkdirSync(codexDir,{recursive:true,mode:0o700});if(process.getuid()===0){fs.chownSync(owned,homeOwner.uid,homeOwner.gid);fs.chownSync(codexDir,homeOwner.uid,homeOwner.gid);}
const marker=path.join(owned,'orchestrator-bridge-owned.json'),known=read(marker);
if(known && known!==JSON.stringify({version:1,server:'armada_orchestrator'}))throw Error('orchestrator_bridge_conflict');
const claudeFile=path.join(home,'.claude.json'),claude=JSON.parse(read(claudeFile)||'{}');claude.mcpServers ||= {};
if(typeof claude.mcpServers!=='object'||Array.isArray(claude.mcpServers))throw Error('orchestrator_bridge_conflict');
if(claude.mcpServers.armada_orchestrator && !known)throw Error('orchestrator_bridge_conflict');
const codexFile=path.join(codexDir,'config.toml');let toml=read(codexFile);
const begin='# BEGIN ARMADA ORCHESTRATOR BRIDGE',end='# END ARMADA ORCHESTRATOR BRIDGE';
const first=toml.indexOf(begin),last=toml.indexOf(end);
if((first<0)!==(last<0)||first>=0&&last<first||first>=0&&!known)throw Error('orchestrator_bridge_conflict');
if(first>=0)toml=toml.slice(0,first)+toml.slice(last+end.length);
if(/\[mcp_servers\.(?:"armada_orchestrator"|armada_orchestrator)\]/.test(toml))throw Error('orchestrator_bridge_conflict');
const url='http://127.0.0.1:'+c.port+'/mcp';
claude.mcpServers.armada_orchestrator={type:'http',url};
// Ownership is nonsecret and durable before config writes. Never a token or broker control key.
write(marker,JSON.stringify({version:1,server:'armada_orchestrator'}));
write(claudeFile,JSON.stringify(claude,null,2)+'\n');
write(codexFile,toml.trimEnd()+'\n'+begin+'\n[mcp_servers.armada_orchestrator]\nurl = '+JSON.stringify(url)+'\n'+end+'\n');
console.log('ARMADA_ORCHESTRATOR_RECEIPT '+Buffer.from(JSON.stringify({physicalGeneration:boot,acknowledged:true,port:c.port})).toString('base64url'));
ARMADA_ORCHESTRATOR_BRIDGE
`;
