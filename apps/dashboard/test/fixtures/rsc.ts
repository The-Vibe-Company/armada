import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const compiled = join(dirname(require.resolve("next/package.json")), "dist/compiled");
const serverReact = require(join(compiled, "react/react.react-server.js"));

// Load the server codec in its own React environment without changing the test
// process's module cache or spawning a process with --conditions=react-server.
const serverDOM = {};
runInNewContext(readFileSync(join(compiled, "react-dom/cjs/react-dom.react-server.development.js"), "utf8"), {
  exports: serverDOM,
  require: () => serverReact,
  process,
  console,
});
const server: { renderToReadableStream?: (node: unknown, manifest: object) => ReadableStream } = {};
runInNewContext(
  readFileSync(
    join(compiled, "react-server-dom-webpack/cjs/react-server-dom-webpack-server.edge.development.js"),
    "utf8",
  ),
  {
    exports: server,
    require: (id: string) => (id === "react" ? serverReact : serverDOM),
    process,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    Uint8Array,
    ArrayBuffer,
    AbortController,
  },
);
const client = require(join(compiled, "react-server-dom-webpack/client.edge.js"));

/** Use Next's actual Flight codecs, with no module references or network I/O. */
export async function roundTripRsc<T>(node: T): Promise<T> {
  if (!server.renderToReadableStream) throw new Error("RSC server codec unavailable");
  const wire = await new Response(server.renderToReadableStream(node, {})).text();
  return await client.createFromReadableStream(new Response(wire).body, {
    serverConsumerManifest: { moduleMap: {}, serverModuleMap: {}, moduleLoading: null },
  });
}
