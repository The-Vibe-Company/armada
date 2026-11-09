import { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio, spawn } from "node:child_process";
import { groupState, type ProcessIdentity, processIdentity } from "./processes.ts";
/** Keeps ownership until exit AND process-group quiescence, not merely until stream close. */
export class ChildOwner {
  private children = new Map<
    ChildProcessWithoutNullStreams,
    { identity?: ProcessIdentity; ready: Promise<void>; closed: Promise<void> }
  >();
  spawn(command: string, args: string[], options: SpawnOptionsWithoutStdio) {
    const child = spawn(command, args, { ...options, detached: true, stdio: "pipe" });
    const state: { identity?: ProcessIdentity; ready: Promise<void>; closed: Promise<void> } = {
      ready: Promise.resolve(),
      closed: Promise.resolve(),
    };
    state.ready = new Promise((resolve) => {
      child.once("spawn", () => {
        const identity = processIdentity(child.pid as number);
        if (identity) state.identity = identity;
        resolve();
      });
      child.once("error", () => resolve());
    });
    state.closed = new Promise((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    child.stdin.on("error", () => {});
    this.children.set(child, state);
    return child;
  }
  async release(child: ChildProcessWithoutNullStreams) {
    const state = this.children.get(child);
    if (!state) return;
    await state.ready;
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      state.closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (child.pid) {
      const status = groupState(child.pid, state.identity);
      if (status === "unverifiable") throw Error("harness_process_group_unverifiable");
      if (status === "live") process.kill(-child.pid, "SIGKILL");
    }
    await state.closed;
    if (child.pid) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const status = groupState(child.pid, state.identity);
        if (status === "gone") {
          this.children.delete(child);
          return;
        }
        if (status === "unverifiable") throw Error("harness_process_group_unverifiable");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw Error("harness_process_group_live");
    }
    this.children.delete(child);
  }
  async close() {
    await Promise.all([...this.children.keys()].map((child) => this.release(child)));
  }
}
