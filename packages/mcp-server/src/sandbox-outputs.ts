import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret, type Provider, type Sql } from "@armada/core/server";
import type { CallerResult } from "./caller.ts";
import type { Route } from "./http.ts";

// No caller-controlled command, root, traversal, symlink following or special files.
export const OUTPUT_COLLECTOR = `python3 - <<'PY'
import os,stat,json,base64
files=[]
total=0
try:
 root=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 directory=os.open('outputs',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
 try:
  for name in sorted(os.listdir(directory))[:32]:
   if len(name)>255 or '/' in name or '\\\\' in name: continue
   try:
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
    try:
     info=os.fstat(fd)
     if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>65536: continue
     data=os.read(fd,65537)
     if len(data)>65536 or total+len(data)>262144: continue
     total+=len(data)
     files.append({'name':name,'base64':base64.b64encode(data).decode()})
    finally: os.close(fd)
   except OSError: continue
 finally: os.close(directory); os.close(root)
except FileNotFoundError: pass
print(json.dumps(files))
PY`;

export function parseOutputs(stdout: string): { name: string; bytes: Buffer; digest: string }[] {
  if (stdout.length > 400000) throw Error("output_limit");
  const values: unknown = JSON.parse(stdout);
  if (!Array.isArray(values) || values.length > 32) throw Error("output_limit");
  let total = 0;
  const names = new Set<string>();
  return values.map((value) => {
    if (!value || typeof value.name !== "string" || !/^[^/\\\x00-\x1f\x7f]{1,255}$/.test(value.name) ||
      value.name === "." || value.name === ".." || names.has(value.name) || typeof value.base64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) throw Error("invalid_output");
    names.add(value.name);
    const bytes = Buffer.from(value.base64, "base64");
    total += bytes.length;
    if (bytes.length > 65536 || total > 262144) throw Error("output_limit");
    return { name: value.name, bytes, digest: createHash("sha256").update(bytes).digest("hex") };
  });
}

export function createSandboxOutputs(sql: Sql, key: string | undefined, providerFor: (id: string) => Promise<Provider>) {
  async function collect(id: string, providerId: string, signal?: AbortSignal) {
    if (!key) throw Error("output_encryption_unavailable");
    const provider = await providerFor(id);
    const result = await provider.exec({ sandboxId: providerId, command: OUTPUT_COLLECTOR, onlyIfRunning: true,
      timeoutSeconds: 10, ...(signal ? { signal } : {}) });
    if (result.detached || result.exitCode !== 0 || result.truncated || result.timedOut) throw Error("output_collection_unavailable");
    const files = parseOutputs(result.stdout);
    // Replace the bounded snapshot atomically. Readers retain the last successful snapshot on collection failure.
    const payload = await Promise.all(files.map(async file => ({name:file.name,digest:file.digest,size:file.bytes.length,
      content: Buffer.from(await encryptSecret(file.bytes.toString("base64"),key)).toString("hex")})));
    await sql.query(`with incoming as (select * from jsonb_to_recordset($2::jsonb) as f(name text,digest text,size integer,content text)),
      removed as (delete from public.sandbox_outputs where sandbox_id=$1 and name not in(select name from incoming))
      insert into public.sandbox_outputs(sandbox_id,name,digest,size,content_enc)
      select $1,name,digest,size,decode(content,'hex') from incoming
      on conflict(sandbox_id,name) do update set digest=excluded.digest,size=excluded.size,content_enc=excluded.content_enc,updated_at=now()
      where sandbox_outputs.digest<>excluded.digest`,[id,JSON.stringify(payload)]);

  }
  const pending = new Set<Promise<boolean>>();
  return {
    async reconcileOne(signal: AbortSignal): Promise<boolean> {
      if (!key) return false;
      const row = (await sql.query<{id:string; provider_sandbox_id:string}>(`update public.sandboxes set outputs_checked_at=now()
        where id=(select id from public.sandboxes where status='running' and provider in ('boat','modal')
        and (outputs_checked_at is null or outputs_checked_at<now()-interval '30 seconds')
        order by outputs_checked_at nulls first for update skip locked limit 1) returning id,provider_sandbox_id`)).rows[0];
      if (!row) return false;
      const work = collect(row.id,row.provider_sandbox_id,signal).then(() => true);
      pending.add(work);
      try { return await work; } finally { pending.delete(work); }
    },
    async drain() { await Promise.allSettled(pending); },
    route(authenticate: (request: Request) => Promise<CallerResult>): Route {
      return async request => {
        const url = new URL(request.url);
        const match = /^\/api\/v1\/sandboxes\/([0-9a-f-]{36})\/outputs(?:\/([^/]+))?$/.exec(url.pathname);
        if (!match) return null;
        if (request.method !== "GET") return Response.json({error:"Use GET"},{status:405});
        const auth = await authenticate(request);
        if (!auth.ok) return Response.json({error:"unauthorized"},{status:401});
        const caller = auth.caller;
        const row = (await sql.query<{id:string}>(`select s.id from public.sandboxes s join public.members m on m.org_id=s.org_id
          where s.id=$1 and s.status<>'deleted' and m.user_id=$2 and s.org_id=any($3::uuid[])
          and (s.owner_id=$2 or m.role='admin') and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)`,
          [match[1],caller.userId,caller.orgs.map(o=>o.orgId)])).rows[0];
        if (!row) return Response.json({error:"not_found"},{status:404});
        const name = match[2] ? decodeURIComponent(match[2]) : null;
        if (!name) {
          const files = await sql.query(`select name,size,digest as sha256,updated_at as "updatedAt" from public.sandbox_outputs where sandbox_id=$1 order by name limit 32`,[row.id]);
          return Response.json({directory:"/workspace/outputs",files:files.rows});
        }
        const file = (await sql.query<{name:string;content_enc:Uint8Array<ArrayBuffer>}>(`select name,content_enc from public.sandbox_outputs where sandbox_id=$1 and name=$2`,[row.id,name])).rows[0];
        if (!file) return Response.json({error:"not_found"},{status:404});
        if (!key) return Response.json({error:"unavailable"},{status:503});
        const bytes = Buffer.from(await decryptSecret(file.content_enc,key),"base64");
        const type = new Blob([], {type: Bun.file(file.name).type}).type || "application/octet-stream";
        return new Response(bytes,{headers:{"content-type":type,"content-length":String(bytes.length),"content-disposition":`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,"x-content-type-options":"nosniff","cache-control":"private, no-store"}});
      };
    },
  };
}
