import { normalizeResolvedMcpStdio, type Provider, sshStdinCheckout } from "@armada/core/server";

/** Private bootstrap payload. Remote entries must contain gateway credentials only. */
export interface McpBootstrap {
  revision: string;
  servers: Record<string, NativeMcpServer>;
}
export type NativeMcpServer =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

/**
 * Installs both user-scope native configurations before the first prompt. No exec endpoint ever
 * sees the payload. SSH registers an ephemeral key and pins the provider-returned host key.
 * This proves configuration delivery, not upstream health or a running harness's live reload.
 */
export async function bootstrapBoatMcp(provider: Provider, sandboxId: string, config: McpBootstrap): Promise<void> {
  const normalized = normalizeNativeMcpBootstrap(config);
  try {
    await sshStdinCheckout(provider, {
      sandboxId,
      token: JSON.stringify(normalized),
      script: config.revision === "snapshot_scrub" ? nativeMcpScrubScript : nativeMcpInstallScript,
    });
  } catch {
    // Remote diagnostics may echo a substring of the JSON payload: never propagate them.
    throw new Error("MCP native configuration failed over pinned SSH; no agent was started. Retry bootstrap.");
  }
}

export function normalizeNativeMcpBootstrap(config: McpBootstrap): McpBootstrap {
  const servers: Record<string, NativeMcpServer> = {};
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.revision)) throw new Error("Invalid MCP bootstrap revision.");
  for (const [name, server] of Object.entries(config.servers)) {
    if (!/^armada_[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error("Invalid managed MCP server name.");
    if (server.type === "http") {
      const url = new URL(server.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) {
        throw new Error("Native remote MCP requires a credential-free HTTPS gateway URL.");
      }
      for (const [key, value] of Object.entries(server.headers ?? {})) {
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) || /[\r\n\0]/.test(value)) {
          throw new Error("Invalid MCP gateway header.");
        }
      }
    } else if (server.type === "stdio") {
      normalizeResolvedMcpStdio(server.command, server.args ?? []);
      if ((server.args ?? []).some((v) => v.includes("\0"))) throw new Error("Invalid MCP arguments.");
      for (const [key, value] of Object.entries(server.env ?? {})) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || value.includes("\0")) throw new Error("Invalid MCP environment.");
      }
    } else throw new Error("Unsupported native MCP transport.");
    servers[name] =
      server.type === "stdio"
        ? { ...server, ...normalizeResolvedMcpStdio(server.command, server.args ?? []) }
        : { ...server };
  }
  return { revision: config.revision, servers };
}

/** Script travels on SSH stdin, never argv. It is also used to scrub before snapshot with servers={}. */
export const nativeMcpInstallScript = `set +x
node <<'ARMADA_NATIVE_MCP'
const fs = require('node:fs');
const path = require('node:path');
const home = require('node:os').homedir();
const config = JSON.parse(process.env.ARMADA_GIT_TOKEN);
delete process.env.ARMADA_GIT_TOKEN;
const begin = '# BEGIN ARMADA MANAGED MCP';
const end = '# END ARMADA MANAGED MCP';
function checked(p, dir=false) {
  try { const s=fs.lstatSync(p); if(s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile())) throw Error('Unsafe config path'); }
  catch(e) { if(e.code !== 'ENOENT') throw e; }
}
function read(p) { checked(p); try { return fs.readFileSync(p,'utf8'); } catch(e) { if(e.code==='ENOENT') return ''; throw e; } }
function write(p, text) {
  checked(p); const tmp=p+'.armada-'+process.pid;
  try { fs.writeFileSync(tmp,text,{mode:0o600,flag:'wx'}); fs.renameSync(tmp,p); fs.chmodSync(p,0o600); }
  finally { fs.rmSync(tmp,{force:true}); }
}
const codexDir=path.join(home,'.codex'); checked(codexDir,true); fs.mkdirSync(codexDir,{recursive:true,mode:0o700});
const ownedDir=path.join(home,'.armada'); checked(ownedDir,true); fs.mkdirSync(ownedDir,{recursive:true,mode:0o700});
const ownedFile=path.join(ownedDir,'mcp-owned.json');
const previousOwned=JSON.parse(read(ownedFile)||'[]');
const codexOwnedFile=path.join(ownedDir,'mcp-codex-owned.json');
const codexOwned=JSON.parse(read(codexOwnedFile)||'[]');
if(!Array.isArray(codexOwned)||codexOwned.some(n=>typeof n!=='string'||!/^armada_[a-zA-Z0-9_-]+$/.test(n))) throw Error('Invalid Codex MCP ownership manifest');
if(!Array.isArray(previousOwned)||previousOwned.some(n=>typeof n!=='string'||!/^armada_[a-zA-Z0-9_-]+$/.test(n))) throw Error('Invalid MCP ownership manifest');
const claudeFile=path.join(home,'.claude.json');
const claude=JSON.parse(read(claudeFile)||'{}');
claude.mcpServers ||= {};
if(typeof claude.mcpServers!=='object'||Array.isArray(claude.mcpServers)) throw Error('Invalid native MCP object');
for(const name of Object.keys(config.servers)) if(claude.mcpServers[name]&&!previousOwned.includes(name)) throw Error('MCP name conflicts with an unmanaged native definition');
for(const name of previousOwned) delete claude.mcpServers[name];
Object.assign(claude.mcpServers,config.servers);
const codexFile=path.join(codexDir,'config.toml');
let toml=read(codexFile);
const first=toml.indexOf(begin), last=toml.indexOf(end);
if((first<0)!==(last<0) || (first>=0 && last<first)) throw Error('Broken MCP config markers');
if(first>=0) toml=toml.slice(0,first)+toml.slice(last+end.length);
const q=JSON.stringify;
let block='';
for(const [name,s] of Object.entries(config.servers)) {
  if(toml.includes('[mcp_servers.'+name) || toml.includes('[mcp_servers.'+q(name))) throw Error('Conflicting MCP configuration');
  block+='\\n[mcp_servers.'+q(name)+']\\n';
  if(s.type==='http') {
    block+='url = '+q(s.url)+'\\n';
    if(s.headers) block+='http_headers = { '+Object.entries(s.headers).map(([k,v])=>q(k)+' = '+q(v)).join(', ')+' }\\n';
  } else {
    block+='command = '+q(s.command)+'\\nargs = ['+(s.args||[]).map(q).join(', ')+']\\n';
    if(s.env) block+='env = { '+Object.entries(s.env).map(([k,v])=>q(k)+' = '+q(v)).join(', ')+' }\\n';
  }
}
write(codexOwnedFile,JSON.stringify([...new Set([...codexOwned,...previousOwned,...Object.keys(config.servers)])]));
// Journal only ownership names BEFORE writing credentials, so a crash between the two
// atomic config writes cannot orphan an untracked transient entry. Never journal a token.
write(ownedFile,JSON.stringify([...new Set([...previousOwned,...Object.keys(config.servers)])]));
// Claude may back up its user config. Scrub only our manifest-owned entries, preserve all others.
if(Object.keys(config.servers).length===0) {
  const backupDirs=[home,path.join(home,'.claude','backups')];
  for(const dir of backupDirs) {
    checked(dir,true);
    let files;try {files=fs.readdirSync(dir);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    for(const name of files) if(name.startsWith('.claude.json.backup')) {
      const file=path.join(dir,name),value=JSON.parse(read(file));
      if(value.mcpServers) for(const owned of previousOwned) delete value.mcpServers[owned];
      write(file,JSON.stringify(value)+'\\n');
    }
  }
}
// Prepare both documents before any config write; errors contain no payload.
write(claudeFile,JSON.stringify(claude,null,2)+'\\n');
write(codexFile,toml.trimEnd()+(block ? '\\n'+begin+block+end+'\\n' : '\\n'));
if(Object.keys(config.servers).length) write(ownedFile,JSON.stringify(Object.keys(config.servers)));
else fs.rmSync(ownedFile,{force:true});
ARMADA_NATIVE_MCP
status=$?
unset ARMADA_GIT_TOKEN
exit $status
`;

/** No Node dependency for an untouched/public-only golden. Marked or journaled config fails
 * closed if its JSON scrubber is unavailable; absence of owned artifacts is the only no-op. */
export const nativeMcpScrubScript = `set +x
if [ ! -e "$HOME/.armada/mcp-owned.json" ]; then
  armada_mcp_marked=0
  if [ -e "$HOME/.codex/config.toml" ] && [ ! -f "$HOME/.codex/config.toml" ]; then exit 1; fi
  if [ -f "$HOME/.codex/config.toml" ]; then
    if [ ! -r "$HOME/.codex/config.toml" ]; then exit 1; fi
    while IFS= read -r armada_mcp_line || [ -n "$armada_mcp_line" ]; do
      case "$armada_mcp_line" in '# BEGIN ARMADA MANAGED MCP') armada_mcp_marked=1;; esac
    done < "$HOME/.codex/config.toml" || exit 1
  fi
  if [ "$armada_mcp_marked" = 0 ]; then exit 0; fi
fi
${nativeMcpInstallScript}`;
