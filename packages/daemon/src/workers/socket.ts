import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import type { Workers } from "./service.ts";

/** Private Unix socket, deliberately separate from the owner's unauthenticated loopback WebSocket. */
export async function startWorkerSocket(workers: Workers, path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // The production caller holds the stable endpoint's owner lease. Never remove a live socket.
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("Worker socket already has a live owner"));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ENOENT") resolve();
      else if (error.code === "ECONNREFUSED") void unlink(path).then(resolve, reject);
      else reject(error);
    });
    probe.setTimeout(1000, () => {
      probe.destroy();
      reject(new Error("Worker socket owner unavailable"));
    });
  });
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const fail = (status: number) => {
      res.writeHead(status);
      res.end('{"ok":false,"message":"Worker request refused"}');
    };
    if (req.method !== "POST" || req.url !== "/worker" || req.headers.origin) return fail(403);
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return fail(403);
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) return fail(413);
      }
      const result = await workers.request(authorization.slice(7), JSON.parse(body));
      res.end(JSON.stringify(result));
    } catch {
      fail(403);
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
