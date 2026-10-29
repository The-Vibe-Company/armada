import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/** Only real files under the build directory, including when a path contains a symlink. */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, directory: string): Promise<void> {
  const missing = () => {
    res.writeHead(404);
    res.end("Armada app build not found");
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  try {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    if (!path.startsWith("/") || path.includes("\0") || path.split(/[\\/]/).includes("..")) return missing();
    const root = await realpath(directory);
    const requested = resolve(root, `.${path === "/" ? "/index.html" : path}`);
    if (!requested.startsWith(`${root}${sep}`)) return missing();
    let file = requested;
    try {
      if (!(await stat(file)).isFile()) throw new Error("Not a file");
    } catch {
      // Vite's browser routes fall back to the shell; missing assets stay 404.
      if (extname(path) || !req.headers.accept?.includes("text/html")) return missing();
      file = resolve(root, "index.html");
    }
    file = await realpath(file);
    if (!file.startsWith(`${root}${sep}`)) return missing();
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Length": data.byteLength,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    missing();
  }
}
