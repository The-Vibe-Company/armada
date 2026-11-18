import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

// Use the managed directory inode so the crash-released lock needs no
// persistent lockfile and cannot conflict with the running daemon's store lock.
export class DockerHostLifecycleBusy extends Error {
  constructor() {
    super("Docker host lifecycle operation in progress.");
  }
}

export async function withDockerHostLifecycle<T>(path: string, work: () => Promise<T>, nonblocking = false) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await new Promise<void>((resolve, reject) => {
      const args = nonblocking
        ? ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "0"]
        : ["--exclusive", "0"];
      const child = spawn("flock", args, { stdio: [directory.fd, "ignore", "ignore"] });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else if (nonblocking && code === 75) reject(new DockerHostLifecycleBusy());
        else reject(new Error("Could not lock the managed Docker host update."));
      });
    });
    const held = await directory.stat();
    const named = await lstat(path);
    if (held.ino !== named.ino || held.dev !== named.dev)
      throw new Error("Docker host installation changed while acquiring its lifecycle claim.");
    return await work();
  } finally {
    await directory.close();
  }
}
