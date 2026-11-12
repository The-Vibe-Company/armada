import { writeFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { AcpDriver } from "./acp.ts";
import { ChildOwner } from "./children.ts";
import { validateHarnessCwd } from "./cwd.ts";
import { HarnessError } from "./errors.ts";
import type { Driver, DriverContext, DriverResumeContext, Turn } from "./protocol.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** The ACP prompt response contains only the final model step in this pin. Exported native messages own full-turn usage. */
function exportedTurnUsage(saved: unknown, baseline: Set<string>) {
  const missing = {
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
  if (!record(saved) || !Array.isArray(saved.messages)) return missing;
  const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const models = new Set<string>(),
    ids = new Set<string>();
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  for (const message of saved.messages) {
    if (!record(message) || !record(message.info)) return missing;
    const info = message.info;
    if (info.role !== "assistant") continue;
    if (typeof info.id !== "string") return missing;
    if (baseline.has(info.id)) continue;
    if (ids.has(info.id)) return missing;
    ids.add(info.id);
    const t = info.tokens;
    if (
      !record(t) ||
      !record(t.cache) ||
      !record(info.time) ||
      !count(info.time.completed) ||
      typeof info.finish !== "string" ||
      !count(t.total) ||
      !count(t.input) ||
      !count(t.output) ||
      !count(t.reasoning) ||
      !count(t.cache.read) ||
      !count(t.cache.write) ||
      typeof info.providerID !== "string" ||
      typeof info.modelID !== "string"
    )
      return missing;
    if (t.total !== t.input + t.output + t.reasoning + t.cache.read + t.cache.write) return missing;
    models.add(`${info.providerID}/${info.modelID}`);
    totals.inputTokens += t.input;
    // Native OpenCode output excludes reasoning; Armada's output includes that subset.
    totals.outputTokens += t.output + t.reasoning;
    totals.reasoningTokens += t.reasoning;
    totals.cachedTokens += t.cache.read;
    totals.cacheWriteTokens += t.cache.write;
    if (Object.values(totals).some((value) => !count(value))) return missing;
  }
  return ids.size ? { model: models.size === 1 ? [...models][0] : null, ...totals } : missing;
}

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
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
      child.once("error", () => resolve(null));
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
    const pending = await lstat(`${path}.pending`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (pending) throw new HarnessError("invalid_harness_protocol");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024)
      throw new HarnessError("invalid_harness_protocol");
    const saved = JSON.parse(await readFile(path, "utf8"));
    if (saved?.info?.id !== id || !Array.isArray(saved.messages)) throw new HarnessError("invalid_harness_protocol");
    await this.command(["import", path], cwd);
    return new Set<string>(
      saved.messages.flatMap((message: unknown) =>
        record(message) && record(message.info) && typeof message.info.id === "string" ? [message.info.id] : [],
      ),
    );
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
      // Verify that redaction preserved the pinned vendor's import schema before acknowledging continuity.
      await this.command(["import", temp], cwd);
      await rename(temp, path);
      await rm(`${path}.pending`, { force: true });
      return saved as unknown;
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
      const baseline = sessionId ? await this.restore(sessionId, cwd) : new Set<string>();
      c.signal.throwIfAborted();
      await mkdir(join(this.options.root, "sessions"), { recursive: true, mode: 0o700 });
      native = this.acp.start({
        ...c,
        emit: (event) => {
          if (event.kind !== "other" || event.type !== "armada/turnUsage") c.emit(event);
        },
        session: (id) => {
          sessionId = id;
          writeFileSync(`${this.path(id)}.pending`, "", { mode: 0o600, flag: "wx" });
          c.session(id);
        },
      });
      return { turn: native, cwd, baseline };
    })();
    return {
      done: (async () => {
        const { turn, cwd, baseline } = await ready;
        try {
          return await turn.done;
        } finally {
          if (sessionId) {
            try {
              const saved = await this.save(sessionId, cwd);
              c.emit({ kind: "other", type: "armada/turnUsage", data: exportedTurnUsage(saved, baseline) });
            } catch (error) {
              c.emit({ kind: "other", type: "armada/turnUsage", data: exportedTurnUsage(null, baseline) });
              throw error;
            }
          }
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
