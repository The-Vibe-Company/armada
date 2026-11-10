import type { Harness } from "./contract.ts";
import type { OrchestratorSkillReceipt } from "./orchestrator.ts";
import type { Provider } from "./provider.ts";
import { SKILLPACK_TOKEN_PATTERN } from "./skillpack-token.ts";
import { sshPrivateSkillCommand } from "./ssh-executor.ts";
import { cleanupGuestKey } from "./ssh-key-cleanup.ts";

export type PrivateSkillFailure =
  | "skillpack_credential_missing"
  | "skillpack_credential_refused"
  | "skillpack_skill_unavailable"
  | "skillpack_install_failed";
export class PrivateSkillError extends Error {
  constructor(readonly reason: PrivateSkillFailure) {
    super(reason);
  }
}

/** Native registry references are bare slugs, scoped by the key's workspace. */
export const PRIVATE_SKILL_PATTERN = /^[a-z0-9][a-z0-9-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/;

/** Shared private install boundary for orchestrator, launch and golden callers. No provider command journal. */
export async function installPrivateSkill(
  provider: Provider,
  input: {
    sandboxId: string;
    projectDir: string;
    reference: string;
    harness: Harness;
    key: string | null;
  },
): Promise<OrchestratorSkillReceipt & { workspaceId: string }> {
  if (!input.key) throw new PrivateSkillError("skillpack_credential_missing");
  if (
    !new RegExp(`^${SKILLPACK_TOKEN_PATTERN}$`).test(input.key) ||
    !PRIVATE_SKILL_PATTERN.test(input.reference) ||
    input.reference.length > 256 ||
    !input.projectDir.startsWith("/") ||
    [...input.projectDir].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new PrivateSkillError("skillpack_install_failed");
  const [slug, version] = input.reference.split("@");
  const tool = input.harness === "claude" ? "claude-code" : "codex";
  // Only fixed failure labels or the validated receipt leave the guest. Never forward CLI stderr/stdout.
  const script = `${cleanupGuestKey}
node <<'ARMADA_SKILL_INSTALL'
const {spawnSync}=require('node:child_process'),fs=require('node:fs');
const key=process.env.ARMADA_GIT_TOKEN;delete process.env.ARMADA_GIT_TOKEN;
const env={...process.env,SKILLPACK_API_KEY:key,SKILLPACK_TELEMETRY:'0'};
const base=['--api-url','https://skillpack.app/v1','--json'];
const home=fs.statSync('/home/user');
function run(args){return spawnSync('skillpack',args,{env,uid:home.uid,gid:home.gid,encoding:'utf8',timeout:240000,maxBuffer:1048576});}
function fail(reason){process.stdout.write(JSON.stringify({reason}));process.exit(0);}
try{
 const status=run(['auth','status',...base]);
 if(status.error||status.signal)fail('skillpack_install_failed');
 if(status.status!==0)fail((status.status===3||status.status===7)?'skillpack_credential_refused':'skillpack_install_failed');
 const s=JSON.parse(status.stdout),workspace=s.workspace?.id;
 // Native CLI currently projects secrets without enforcing --confirm-secrets. Require a capability fence.
 if(!Array.isArray(s.token?.scopes)||s.token.scopes.length!==1||s.token.scopes[0]!=='skills:read')fail('skillpack_credential_refused');
 if(typeof workspace!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).test(workspace))fail('skillpack_install_failed');
 const result=run(['install',${JSON.stringify(slug)},'--version',${JSON.stringify(version)},'--scope','project','--project',${JSON.stringify(input.projectDir)},'--tools',${JSON.stringify(tool)},'--pin','--yes',...base]);
 delete env.SKILLPACK_API_KEY;
 if(result.error||result.signal)fail('skillpack_install_failed');
 if(result.status!==0)fail(result.status===3?'skillpack_credential_refused':(result.status===4||result.status===7)?'skillpack_skill_unavailable':'skillpack_install_failed');
 const lock=JSON.parse(fs.readFileSync(${JSON.stringify(`${input.projectDir}/.companion/skills.lock.json`)},'utf8'));
 const w=lock.workspaces?.[workspace],e=w?.skills?.[${JSON.stringify(slug)}];
 if(![2,3].includes(lock.lockfileVersion)||w.apiUrl!=='https://skillpack.app/v1'||e?.version!==${JSON.stringify(version)}||e.pinned!==${JSON.stringify(version)}||!(/^[a-f0-9-]{36}$/).test(e.skillId)||!(/^sha256:[a-f0-9]{64}$/).test(e.checksum)||!e.targets?.some(t=>t.tool===${JSON.stringify(tool)}&&t.version===e.version&&t.packageChecksum===e.checksum))fail('skillpack_install_failed');
 process.stdout.write(JSON.stringify({reference:${JSON.stringify(input.reference)},version:e.version,skillId:e.skillId,checksum:e.checksum,origin:w.apiUrl,workspaceId:workspace}));
}catch{fail('skillpack_install_failed');}
ARMADA_SKILL_INSTALL`;
  try {
    const value = JSON.parse(
      await sshPrivateSkillCommand(provider, { sandboxId: input.sandboxId, key: input.key, script }),
    );
    if (
      ["skillpack_credential_refused", "skillpack_skill_unavailable", "skillpack_install_failed"].includes(value.reason)
    )
      throw new PrivateSkillError(value.reason);
    if (
      typeof value.workspaceId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.workspaceId) ||
      value.reference !== input.reference ||
      value.version !== version ||
      !/^[a-f0-9-]{36}$/.test(value.skillId) ||
      !/^sha256:[a-f0-9]{64}$/.test(value.checksum) ||
      value.origin !== "https://skillpack.app/v1"
    )
      throw new PrivateSkillError("skillpack_install_failed");
    return {
      reference: input.reference,
      version: version!,
      skillId: value.skillId,
      checksum: value.checksum,
      origin: value.origin,
      workspaceId: value.workspaceId,
    };
  } catch (error) {
    if (error instanceof PrivateSkillError) throw error;
    throw new PrivateSkillError("skillpack_install_failed");
  }
}
