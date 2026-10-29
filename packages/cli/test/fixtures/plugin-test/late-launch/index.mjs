import { spawn, execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export function activate(ctx) {
  let child;
  ctx.register.runtime('late', {
    async prepare({repository,branch}) {
      await execute('git',['-C',repository,'switch','--quiet','-c',branch]);
      return {id:'late',node:'local',path:repository};
    },
    async launch({worker}) {
      child = spawn('node',['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'});
      await delay(5100);
      return {...worker,handle:'late-child'};
    },
    async observe() { throw new Error('timed-out launch must not continue observing'); },
    async deliver() { throw new Error('timed-out launch must not continue delivering'); },
    async stop() {
      const stopped = new Promise((resolve) => child.once('exit',resolve));
      child.kill('SIGTERM');
      await stopped;
      await writeFile(ctx.config.runtime.late.marker,'stopped');
    },
  });
}
