// The installed CLI owns authentication and catalog resolution. Read only the
// model/list API: no thread/start, turn/start, login, or provider key handling.
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

interface CatalogProcess {
  stdin: Writable;
  stdout: Readable;
  on: (event: "error" | "close", listener: () => void) => unknown;
  kill: (signal: NodeJS.Signals) => boolean;
}
interface CatalogIo {
  start: (cwd: string) => CatalogProcess;
  deadline: (expire: () => void) => () => void;
}
const system: CatalogIo = {
  start: (cwd) => spawn("codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "ignore"] }),
  deadline: (expire) => {
    const timer = setTimeout(expire, 10_000);
    return () => clearTimeout(timer);
  },
};

/** Null means incomplete/unavailable, never an empty successful catalog. */
export function readCodexModels(cwd: string, io: CatalogIo = system): Promise<string[] | null> {
  return new Promise((resolve) => {
    let child: CatalogProcess;
    try {
      child = io.start(cwd);
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let cancel = () => {};
    const finish = (models: string[] | null) => {
      if (settled) return;
      settled = true;
      cancel();
      child.stdin.destroy();
      child.kill("SIGKILL");
      resolve(models);
    };
    cancel = io.deadline(() => finish(null));
    let buffer = "";
    let bytes = 0;
    let requestId = 0;
    const models = new Set<string>();
    const cursors = new Set<string>();
    const send = (message: unknown) => {
      if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const list = (cursor: string | null) => {
      requestId++;
      // Hidden entries can still be explicitly selected; do not mistake picker
      // visibility for a model being unknown to the installed CLI.
      send({ id: requestId, method: "model/list", params: { limit: 100, includeHidden: true, cursor } });
    };
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin.on("error", () => finish(null));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1_048_576) return finish(null);
      buffer += chunk;
      while (!settled) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (!message || typeof message !== "object") return finish(null);
          // Ignore notifications and unrelated response IDs, including diagnostics.
          if (message.id !== requestId) continue;
          if (message.error || !message.result || typeof message.result !== "object") return finish(null);
          if (requestId === 0) {
            send({ method: "initialized", params: {} });
            list(null);
            continue;
          }
          const { data, nextCursor } = message.result;
          if (!Array.isArray(data) || (nextCursor != null && typeof nextCursor !== "string")) return finish(null);
          for (const entry of data) {
            if (
              !entry ||
              typeof entry.model !== "string" ||
              !entry.model.trim() ||
              entry.model.length > 4096 ||
              /\p{Cc}/u.test(entry.model)
            )
              return finish(null);
            models.add(entry.model);
          }
          if (nextCursor == null) return finish([...models]);
          if (!nextCursor || cursors.has(nextCursor) || cursors.size >= 100) return finish(null);
          cursors.add(nextCursor);
          list(nextCursor);
        } catch {
          return finish(null);
        }
      }
    });
    send({
      id: 0,
      method: "initialize",
      params: { clientInfo: { name: "armada_doctor", version: "1" }, capabilities: { explicitGatewayOAuth: true } },
    });
  });
}
