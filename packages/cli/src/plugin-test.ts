import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlugins, type PluginCatalogEntry } from "@armada/daemon/plugins";
import { type PluginConfig, type PluginEvent, pluginEventInputSchema } from "@armada/plugin-api";
import { type Io, UsageError } from "./io.ts";
import { runSeamChecks } from "./plugin-checks.ts";

export interface PluginCheck {
  name: string;
  passed: boolean;
  error?: string;
}
export interface PluginTestReport {
  plugin: string;
  loaded: boolean;
  passed: number;
  failed: number;
  checks: PluginCheck[];
  error?: string;
}
const oneLine = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/[\r\n\t]+/g, " ");

async function optionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Resolve a local package only; compatibility, config and activation stay owned by loadPlugins. */
async function directoryEntry(directory: string): Promise<PluginCatalogEntry> {
  const pkg = (await optionalJson(join(directory, "package.json"))) as Record<string, unknown> | undefined;
  const manifest = (await optionalJson(join(directory, "armada-plugin.json"))) ?? pkg?.armada ?? null;
  const id =
    typeof manifest === "object" && manifest && "id" in manifest && typeof manifest.id === "string"
      ? manifest.id
      : basename(directory);
  return {
    id,
    manifest,
    async load() {
      const exports = pkg?.exports;
      const entry =
        typeof exports === "object" && exports !== null ? ("." in exports ? exports["."] : exports) : exports;
      const target =
        typeof entry === "object" && entry !== null
          ? ((entry as Record<string, unknown>).import ?? (entry as Record<string, unknown>).default)
          : entry;
      const file = target ?? pkg?.main ?? "index.js";
      if (typeof file !== "string") throw new Error("module entry must be a string");
      const modulePath = resolve(directory, file);
      if (!modulePath.startsWith(`${directory}${sep}`)) throw new Error("module entry must be inside its package");
      return import(pathToFileURL(modulePath).href);
    },
  };
}

function fixtureDirectory(): string {
  // The published Node bundle carries the same examples beside armada.js.
  const bundled = fileURLToPath(new URL("./plugin-fixtures/", import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("../../plugin-api/fixtures/", import.meta.url));
}

async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, pending?: Set<Promise<unknown>>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const work = Promise.resolve().then(() => action(controller.signal));
  pending?.add(work);
  void work.then(
    () => pending?.delete(work),
    () => pending?.delete(work),
  );
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("check timed out after 5 seconds");
          controller.abort(error);
          reject(error);
        }, 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function testPlugin(io: Io, path: string, reportPath?: string, json = false): Promise<number> {
  if (reportPath && !io.writeFile) throw new UsageError("report file is not writable");
  const directory = resolve(io.cwd, path);
  const sandbox = await mkdtemp(join(tmpdir(), "armada-plugin-conformance-"));
  const report: PluginTestReport = { plugin: basename(directory), loaded: false, passed: 0, failed: 0, checks: [] };
  const fixtureRoot = fixtureDirectory();
  const requests: { method: string; path: string; body: unknown }[] = [];
  const pending = new Set<Promise<unknown>>();
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1_048_576) throw new Error("fixture request too large");
      }
      const path = new URL(req.url ?? "/", "http://fixture").pathname;
      requests.push({ method: req.method ?? "GET", path, body: body ? JSON.parse(body) : null });
      const seam = path.split("/")[1];
      if (!["tracker", "forge", "model"].includes(seam ?? "")) {
        res.writeHead(404).end();
        return;
      }
      const fixture = JSON.parse(await readFile(join(fixtureRoot, seam as string, "response.json"), "utf8"));
      const mutatingForge =
        seam === "forge" &&
        req.method !== "GET" &&
        (body.includes('"head"') || /mutation\b/.test(body) || path.endsWith("/merge"));
      res.writeHead(200, { "Content-Type": "application/json" });
      const operation = body ? /(?:query|mutation)\s+(\w+)/.exec(JSON.parse(body).query ?? "")?.[1] : undefined;
      const response = operation ? fixture.operations?.[operation] : fixture.response;
      if (!mutatingForge && operation && !response) throw new Error("unknown fixture operation");
      res.end(JSON.stringify(mutatingForge ? { merged: true } : response));
    } catch {
      res.writeHead(400).end();
    }
  });
  const finish = async () => {
    if (reportPath) await io.writeFile?.(resolve(io.cwd, reportPath), `${JSON.stringify(report, null, 2)}\n`);
    if (json) io.stdout(`${JSON.stringify(report)}\n`);
    else if (report.loaded)
      io.stdout(`${report.checks.length} checks: ${report.passed} passed, ${report.failed} failed\n`);
    return report.loaded && report.failed === 0 ? 0 : 1;
  };
  try {
    const entry = await directoryEntry(directory);
    report.plugin = entry.id;
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture endpoint unavailable");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const template = (await optionalJson(join(directory, "armada-plugin.test.json"))) ?? {};
    const config = JSON.parse(
      JSON.stringify(template).replace(/\$\{(endpoint|directory)\}/g, (_, key) =>
        JSON.stringify(key === "endpoint" ? endpoint : sandbox).slice(1, -1),
      ),
    ) as PluginConfig;
    const configPath = join(sandbox, "config.json");
    await writeFile(configPath, JSON.stringify({ plugins: [{ id: entry.id, enabled: true, config }] }));
    const events: PluginEvent[] = [];
    const boot = await bounded(() =>
      loadPlugins(
        {
          events: {
            append: async (input) => {
              const event = { ...pluginEventInputSchema.parse(input), seq: events.length + 1 };
              events.push(event);
              return structuredClone(event);
            },
            read: async (project, after) =>
              structuredClone(events.filter((e) => e.project === project && e.seq > after)),
            fold: async (project) => {
              const { fold } = await import("@armada/daemon");
              return fold(events.filter((e) => e.project === project) as unknown as Parameters<typeof fold>[0]);
            },
          },
          secrets: { get: async () => "plugin-conformance-secret" },
          log: {
            info() {},
            error(message) {
              report.error = oneLine(message);
            },
          },
        },
        configPath,
        [entry],
      ),
    );
    report.loaded = boot.plugins[0]?.loaded ?? false;
    if (!report.loaded) {
      if (!json) io.stderr(`${report.error}\n`);
      return await finish();
    }
    await runSeamChecks({
      registry: boot.registry,
      manifest: entry.manifest as import("@armada/plugin-api").PluginManifest,
      events,
      directory: sandbox,
      fixtureRoot,
      endpoint,
      requests,
      nodeCommand: "node",
      check: async (name, action) => {
        const result: PluginCheck = { name, passed: false };
        try {
          await bounded(action, pending);
          result.passed = true;
          report.passed++;
        } catch (error) {
          result.error = oneLine(error);
          report.failed++;
        }
        report.checks.push(result);
        if (!json) io.stdout(`${result.passed ? "PASS" : "FAIL"} ${name}${result.error ? `: ${result.error}` : ""}\n`);
        return result.passed;
      },
    });
    return await finish();
  } catch (error) {
    report.error = `Plugin ${report.plugin} refused: ${oneLine(error)}`;
    if (!json) io.stderr(`${report.error}\n`);
    return await finish();
  } finally {
    // Give aborted operations a bounded grace period to return their handles and stop them.
    if (pending.size)
      await bounded(async () => {
        await Promise.allSettled([...pending]);
      }).catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((accept) => server.close(() => accept()));
    await rm(sandbox, { recursive: true, force: true });
  }
}
