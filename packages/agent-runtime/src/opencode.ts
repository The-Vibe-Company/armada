import { writeFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { AcpDriver } from "./acp.ts";
import { ChildOwner } from "./children.ts";
import { validateHarnessCwd } from "./cwd.ts";
import { HarnessError, RequestRefused } from "./errors.ts";
import { ModelRateLimitWait } from "./model-rate-limit.ts";
import {
  exportedModelThrottle,
  exportedToolProofs,
  exportedTurnUsage,
  isOpenCodeRecord as record,
} from "./opencode-export-observations.ts";
import { createOpenCodeRetryObserver } from "./opencode-retry-events.ts";
import type { Driver, DriverContext, DriverResumeContext, Turn } from "./protocol.ts";

/** Preserve native sessions as sanitized vendor JSON exports, never the SQLite database/auth/cache. */
export class OpenCodeDriver implements Driver {
  private acp: AcpDriver;
  private children = new ChildOwner();
  private nativeDrivers = new Set<AcpDriver>();
  constructor(
    private options: {
      executable: string;
      root: string;
      cwd: string;
      env: Record<string, string>;
      redact(text: string): string;
      createRetryObserver?: typeof createOpenCodeRetryObserver;
    },
  ) {
    this.acp = new AcpDriver({ ...options, args: ["acp"] });
  }
  configureReadableVariables(variables: Record<string, string>) {
    this.acp.configureReadableVariables(variables);
  }
  private path(id: string) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new HarnessError("invalid_harness_protocol");
    return join(this.options.root, "sessions", `${id}.json`);
  }
  private async command(args: string[], cwd: string): Promise<string> {
    const child = this.children.spawn(this.options.executable, args, {
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
    if (
      saved.messages.some(
        (message: unknown) =>
          record(message) &&
          Array.isArray(message.parts) &&
          message.parts.some(
            (part: unknown) =>
              record(part) &&
              part.type === "tool" &&
              part.tool === "task" &&
              record(part.state) &&
              record(part.state.metadata) &&
              typeof part.state.metadata.sessionId === "string",
          ),
      )
    )
      throw new HarnessError("invalid_harness_protocol");
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
    // Definite refusal before any native work starts: replaying the same request ID is safe.
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(c.sessionId)) throw new RequestRefused("invalid_harness_protocol");
    await this.restore(c.sessionId, cwd);
    return this.acp.resumeSession(c);
  }
  start(c: DriverContext): Turn {
    let native: Turn | undefined;
    let sessionId = c.sessionId;
    let interrupted = false;
    let waiting = false;
    const steers: string[] = [];
    const rateLimitWait = new ModelRateLimitWait();
    const startNative = async (context: DriverContext): Promise<Turn> => {
      const observer = await (this.options.createRetryObserver ?? createOpenCodeRetryObserver)(
        { ...context, request: { ...context.request, cwd: context.request.cwd ?? this.options.cwd } },
        rateLimitWait,
      );
      const driver = new AcpDriver({
        ...this.options,
        args: observer.args,
        env: { ...this.options.env, ...observer.env },
        observation: observer.observation,
      });
      this.nativeDrivers.add(driver);
      try {
        const turn = driver.start(context);
        return {
          ...turn,
          done: turn.done.finally(async () => {
            try {
              await driver.close();
            } finally {
              this.nativeDrivers.delete(driver);
            }
          }),
        };
      } catch (error) {
        try {
          await observer.observation.close();
        } finally {
          try {
            await driver.close();
          } finally {
            this.nativeDrivers.delete(driver);
          }
        }
        throw error;
      }
    };
    const ready = (async () => {
      const cwd = validateHarnessCwd(c.request.cwd ?? this.options.cwd);
      const baseline = sessionId ? await this.restore(sessionId, cwd) : new Set<string>();
      c.signal.throwIfAborted();
      await mkdir(join(this.options.root, "sessions"), { recursive: true, mode: 0o700 });
      native = await startNative({
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
        let active = turn;
        const throttleBaseline = new Set(baseline);
        for (;;) {
          const result = await active.done.then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          let throttle: { retryAfter?: string } | undefined;
          if (sessionId) {
            try {
              const saved = await this.save(sessionId, cwd);
              if (!result.ok && !interrupted) throttle = exportedModelThrottle(saved, throttleBaseline);
              // A retry's init/auth/transport failure may export no new assistant at all.
              // Never mistake the preceding attempt's throttle for fresh evidence.
              if (record(saved) && Array.isArray(saved.messages))
                for (const message of saved.messages)
                  if (record(message) && record(message.info) && typeof message.info.id === "string")
                    throttleBaseline.add(message.info.id);
              if (!throttle) {
                for (const proof of exportedToolProofs(saved, baseline, c.mcp))
                  c.emit({ kind: "other", type: proof.type, data: proof.data });
                c.emit({ kind: "other", type: "armada/turnUsage", data: exportedTurnUsage(saved, baseline) });
              }
            } catch (error) {
              c.emit({ kind: "other", type: "armada/turnUsage", data: exportedTurnUsage(null, baseline) });
              throw error;
            }
          }
          if (interrupted || c.signal.aborted) return "interrupted" as const;
          if (throttle && sessionId) {
            waiting = true;
            try {
              await rateLimitWait.wait(c, throttle.retryAfter);
            } catch (error) {
              if (interrupted || c.signal.aborted) return "interrupted" as const;
              throw error;
            } finally {
              waiting = false;
            }
            if (interrupted || c.signal.aborted) return "interrupted" as const;
            // The export has cleared the pending marker; ACP loads the same native conversation.
            native = await startNative({
              ...c,
              sessionId,
              request: {
                ...c.request,
                text: [
                  "Continue from where the model provider request was rate limited. Do not repeat completed work.",
                  ...steers.splice(0),
                ].join("\n"),
              },
              emit: (event) => {
                if (event.kind !== "other" || event.type !== "armada/turnUsage") c.emit(event);
              },
              session: (id) => {
                if (id !== sessionId) throw new HarnessError("invalid_harness_protocol");
                writeFileSync(`${this.path(id)}.pending`, "", { mode: 0o600, flag: "wx" });
                c.session(id);
              },
            });
            active = native;
            continue;
          }
          if (!result.ok) throw result.error;
          return result.value;
        }
      })(),
      interrupt: async () => {
        interrupted = true;
        rateLimitWait.cancel();
        await ready;
        if (!waiting) await native?.interrupt();
      },
      steer: async (text) => {
        await ready;
        if (waiting) {
          steers.push(text);
          return;
        }
        await native?.steer(text);
      },
    };
  }
  async close() {
    await this.acp.close();
    await Promise.all([...this.nativeDrivers].map((driver) => driver.close()));
    await this.children.close();
  }
}
