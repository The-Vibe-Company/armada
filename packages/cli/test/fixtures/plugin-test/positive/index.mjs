import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// These reference providers translate fixture HTTP rows and drive real processes.
// They are deliberately independent of the runner's checks and expected events.
export function activate(ctx) {
  const actor = 'reference';
  const append = (project, kind, payload) => ctx.events.append({project, kind, payload, actor, at: new Date().toISOString()});
  const request = (endpoint, data) => fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const tracker = ctx.config.tracker.reference.endpoint;
  ctx.register.tracker('reference', {
    async read({project, signal}) {
      const body = await (await fetch(tracker, {signal})).json();
      for (const ticket of body.tickets) await append(project, 'ticket.seen', ticket);
      for (const {id, ...comment} of body.comments) await append(project, 'ticket.report-posted', {...comment,comment:id});
    },
    async write(value) { await request(tracker, value); },
  });
  const forge = ctx.config.forge.reference.endpoint;
  ctx.register.forge('reference', {
    async read({project, signal}) {
      const body = await (await fetch(forge, {signal})).json();
      for (const pull of body.pullRequests) await append(project, 'pull-request.seen', pull);
    },
    async merge(value) { return (await request(forge, value)).json(); },
  });
  for (const seam of ['runtime', 'node']) {
    const workers = new Map();
    ctx.register[seam]('reference', {
      async prepare({repository,branch}) {
        const path = ctx.config[seam].reference.workspaceRoot;
        await execute("git", ["clone", "--quiet", repository, path]);
        await execute("git", ["-C", path, "switch", "--quiet", "-c", branch]);
        return {id:randomUUID(),path,node:'local'};
      },
      async launch({workspace, worker, command, args}) {
        const quote = (s) => "'"+s.replaceAll("'", "'\\''")+"'";
        const scriptArgs = process.platform === 'darwin'
          ? ['-q','/dev/null',command,...args]
          : ['-q','-c',[command,...args].map(quote).join(' '),'/dev/null'];
        const child = spawn('script',scriptArgs,{cwd:workspace.path,stdio:'pipe'});
        const record = {child,state:'running',reply:''};
        child.stdout.on('data',(chunk) => {record.reply += chunk;});
        child.stderr.on('data',(chunk) => {record.reply += chunk;});
        child.on('exit',() => {record.state = 'stopped';});
        const ref = {...worker,handle:randomUUID()};
        workers.set(ref.handle,record);
        return ref;
      },
      async observe(ref) { const record=workers.get(ref.handle);return {state:record.state,reply:record.reply}; },
      async deliver(ref,message) { workers.get(ref.handle).child.stdin.write(message+'\n'); },
      async stop(ref) {
        const record=workers.get(ref.handle);
        if(record.state==='stopped') return;
        // Ask the real worker to exit, then close script after it drains.
        record.child.stdin.write('exit\n');
        await new Promise((resolve) => record.child.once('exit',resolve));
      },
    });
  }
  ctx.register.model('reference', {
    create(model) {
      return createOpenAICompatible({name:'fixture',baseURL:ctx.config.model.reference.endpoint,apiKey:'fixture'})(model);
    },
  });
}
