import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { AcpDriver } from "./acp.ts";
import { ChildOwner } from "./children.ts";
import { validateHarnessCwd } from "./cwd.ts";
import { HarnessError } from "./errors.ts";
import type { Driver, DriverContext, DriverResumeContext, Turn } from "./protocol.ts";

/** Preserve native sessions as sanitized vendor JSON exports, never the SQLite database/auth/cache. */
export class OpenCodeDriver implements Driver {
  private acp: AcpDriver;
  private children = new ChildOwner();
  constructor(
    private options: {
      executable: string;
      root: string;
      cwd: string;
      env: Record<string, string>;
      redact(text: string): string;
      args?: string[];
    },
  ) {
    this.acp = new AcpDriver({ ...options, args: [...(options.args ?? []), "acp"] });
  }
  configureReadableVariables(variables: Record<string, string>) {
    this.acp.configureReadableVariables(variables);
  }
  private path(id: string) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new HarnessError("invalid_harness_protocol");
    return join(this.options.root, "sessions", `${id}.json`);
  }
  private async command(args: string[], cwd: string): Promise<string> {
    const child = this.children.spawn(this.options.executable, [...(this.options.args ?? []), ...args], {
      cwd,
      env: this.options.env,
    });
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", () => reject(new HarnessError("harness_process_lost")));
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      child.stdin.end();
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of child.stdout) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new HarnessError("invalid_harness_protocol");
        parts.push(Buffer.from(chunk));
      }
      if ((await exited) !== 0) throw new HarnessError("harness_failed");
      return Buffer.concat(parts).toString("utf8");
    } finally {
      clearTimeout(timer);
      await this.children.release(child);
    }
  }
  private async restore(id: string, cwd: string) {
    const path = this.path(id);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024)
      throw new HarnessError("invalid_harness_protocol");
    const saved = JSON.parse(await readFile(path, "utf8"));
    if (saved?.info?.id !== id || !Array.isArray(saved.messages)) throw new HarnessError("invalid_harness_protocol");
    await this.command(["import", path], cwd);
  }
  private async save(id: string, cwd: string) {
    const saved = JSON.parse(await this.command(["export", id], cwd));
    if (saved?.info?.id !== id || !Array.isArray(saved.messages)) throw new HarnessError("invalid_harness_protocol");
    const path = this.path(id);
    await mkdir(join(this.options.root, "sessions"), { recursive: true, mode: 0o700 });
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(this.options.redact(JSON.stringify(saved)));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async resumeSession(c: DriverResumeContext): Promise<{ sessionId: string }> {
    const cwd = validateHarnessCwd(c.request.cwd ?? this.options.cwd);
    await this.restore(c.sessionId, cwd);
    return this.acp.resumeSession(c);
  }
  start(c: DriverContext): Turn {
    let native: Turn | undefined;
    let sessionId = c.sessionId;
    const ready = (async () => {
      const cwd = validateHarnessCwd(c.request.cwd ?? this.options.cwd);
      if (sessionId) await this.restore(sessionId, cwd);
      c.signal.throwIfAborted();
      native = this.acp.start({
        ...c,
        session: (id) => {
          sessionId = id;
          c.session(id);
        },
      });
      return { turn: native, cwd };
    })();
    return {
      done: (async () => {
        const { turn, cwd } = await ready;
        try {
          return await turn.done;
        } finally {
          if (sessionId) await this.save(sessionId, cwd);
        }
      })(),
      interrupt: async () => {
        const { turn } = await ready;
        await turn.interrupt();
      },
      steer: async (text) => {
        const { turn } = await ready;
        await turn.steer(text);
      },
    };
  }
  async close() {
    await this.acp.close();
    await this.children.close();
  }
}
