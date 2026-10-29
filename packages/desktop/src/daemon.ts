import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type DaemonAddress = { url: string; wsUrl: string };
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Options = {
  executable: string;
  entry: string;
  database: string;
  projects: string;
  staticDir: string;
  env?: NodeJS.ProcessEnv;
  startupMs?: number;
  shutdownMs?: number;
};

/** Owns exactly one child, from spawn through readiness and confirmed process exit. */
export class DaemonProcess {
  readonly ready: Promise<DaemonAddress>;
  readonly exited: Promise<Exit>;
  readonly pid: number;
  private child;
  private stopping?: Promise<void>;
  private rejectReady!: (error: Error) => void;
  private shutdownMs: number;

  constructor(options: Options) {
    this.shutdownMs = options.shutdownMs ?? 5000;
    this.child = spawn(
      options.executable,
      [
        options.entry,
        "--database",
        options.database,
        "--projects",
        options.projects,
        "--port",
        "0",
        "--static-dir",
        options.staticDir,
      ],
      { env: options.env ?? process.env, stdio: ["ignore", "pipe", "ignore"] },
    );
    // A failed spawn has no PID; errors still reject readiness and settle exited.
    this.pid = this.child.pid ?? 0;
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const lines = createInterface({ input: this.child.stdout });
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.child.once("error", () => reject(new Error("Could not start armadad")));
      void this.exited.then(() => reject(new Error("armadad exited before readiness")));
      lines.on("line", (line) => {
        try {
          const value = JSON.parse(line);
          const url = new URL(value.url);
          if (
            url.protocol !== "http:" ||
            url.hostname !== "127.0.0.1" ||
            !url.port ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash ||
            value.wsUrl !== `ws://${url.host}/`
          )
            throw new Error("Invalid readiness address");
          resolve({ url: url.origin, wsUrl: value.wsUrl });
        } catch {
          reject(new Error("Invalid armadad readiness line"));
        }
      });
    });
    const timeout = setTimeout(
      () => this.rejectReady(new Error("armadad readiness timed out")),
      options.startupMs ?? 15000,
    );
    // Attach rejection handling immediately, including quit-before-ready and spawn failures.
    void this.ready.then(
      () => {
        clearTimeout(timeout);
        lines.close();
      },
      () => {
        clearTimeout(timeout);
        lines.close();
        void this.stop();
      },
    );
  }

  stop(): Promise<void> {
    this.stopping ??= this.terminate();
    return this.stopping;
  }

  private async terminate(): Promise<void> {
    this.rejectReady(new Error("armadad stopped before readiness"));
    this.child.kill("SIGTERM");
    const force = setTimeout(() => this.child.kill("SIGKILL"), this.shutdownMs);
    try {
      await this.exited;
    } finally {
      clearTimeout(force);
    }
  }
}
