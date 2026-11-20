import { expect, test } from "bun:test";
import { join } from "node:path";

test("the compiled CLI bundle contains no provider or database-client runtime", async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/main.ts")],
    target: "bun",
    minify: true,
    sourcemap: "external",
  });
  expect(result.success).toBe(true);

  const sourceMap = result.outputs.find(({ kind }) => kind === "sourcemap");
  if (!sourceMap) throw new Error("CLI build did not emit a source map.");
  const { sources }: { sources: string[] } = await sourceMap.json();
  expect(sources.some((source) => source.endsWith("packages/cli/src/main.ts"))).toBe(true);
  const forbiddenSources = sources.filter(
    (source) =>
      /(?:^|\/)packages\/(?:provider-[^/]+|docker-host|mcp-server)\//.test(source) ||
      /(?:^|\/)packages\/core\/src\/(?:server|vault-store)\.ts$/.test(source) ||
      /(?:^|\/)node_modules\/(?:@supabase\/|postgres\/|pg\/)/.test(source),
  );
  expect(forbiddenSources).toEqual([]);

  const entry = result.outputs.find(({ kind }) => kind === "entry-point");
  if (!entry) throw new Error("CLI build did not emit an entry point.");
  const directDatabaseClientMarkers = /SUPABASE_URL|\/rest\/v1\/|\.well-known\/armada/;
  expect(await entry.text()).not.toMatch(directDatabaseClientMarkers);
});
