import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { PluginRegistry } from "@armada/daemon/plugins";
import { type PluginEvent, type PluginManifest, type Providers, SEAMS, type WorkerRef } from "@armada/plugin-api";
import { guarded } from "@armada/plugin-api/guard";
import { generateText, jsonSchema, type LanguageModel } from "ai";

export interface FixtureRequest {
  method: string;
  path: string;
  body: unknown;
}
export interface SeamCheckOptions {
  registry: PluginRegistry;
  manifest: PluginManifest;
  events: PluginEvent[];
  directory: string;
  fixtureRoot: string;
  endpoint: string;
  requests: FixtureRequest[];
  nodeCommand?: string;
  check(name: string, action: (signal: AbortSignal) => Promise<void>): Promise<boolean>;
}
interface Recording {
  expectedEvents: { kind: string; payload: unknown }[];
  initialEvents?: { kind: string; payload: import("@armada/plugin-api").Json }[];
}
const project = "plugin-conformance";
const ticket = "CHECK-1";
const head = "0123456789abcdef0123456789abcdef01234567";
const execute = promisify(execFile);

/** Exercise registered providers against local fixtures; the host owns deadlines and cleanup. */
export async function runSeamChecks(options: SeamCheckOptions): Promise<void> {
  for (const seam of SEAMS) {
    for (const kind of Object.keys(options.manifest.contributions[seam] ?? {})) {
      const name = `${seam}.${kind}`;
      if (seam === "tracker" || seam === "forge") {
        const provider = options.registry.get(seam, kind);
        const ready = await options.check(`${name}.read-events`, async () => {
          assert(provider, "provider was not registered");
          const recording = JSON.parse(
            await readFile(join(options.fixtureRoot, seam, "response.json"), "utf8"),
          ) as Recording;
          for (const event of recording.initialEvents ?? []) {
            options.events.push({
              ...event,
              project,
              seq: options.events.length + 1,
              actor: "fixture",
              at: "2030-01-01T10:00:00.000Z",
            });
          }
          const eventStart = options.events.length;
          const requestStart = options.requests.length;
          await provider.read({ project, signal: AbortSignal.timeout(4000) });
          assertContact(options, requestStart, seam);
          for (const expected of recording.expectedEvents) {
            assert(
              options.events
                .slice(eventStart)
                .some(
                  (event) =>
                    event.project === project &&
                    event.kind === expected.kind &&
                    contains(event.payload, expected.payload),
                ),
              `read did not append the recorded ${expected.kind} payload for ${project}`,
            );
          }
        });
        if (!ready) continue;
        if (seam === "tracker") {
          await options.check(`${name}.write`, async () => {
            const comment = `conformance-write-${randomUUID()}`;
            const start = options.requests.length;
            await options.registry.get("tracker", kind)?.write({
              project,
              ticket,
              phase: "implementing",
              comment,
              signal: AbortSignal.timeout(4000),
            });
            const writes = writeRequests(options, start, seam);
            assert(
              [comment, "implementing", ticket].every((value) =>
                writes.some((request) => `${request.path} ${JSON.stringify(request.body)}`.includes(value)),
              ),
              "write did not send its unique comment to the fixture",
            );
          });
        } else {
          await options.check(`${name}.merge`, async () => {
            const start = options.requests.length;
            const result = await options.registry
              .get("forge", kind)
              ?.merge({ project, number: 17, head, signal: AbortSignal.timeout(4000) });
            assert.equal(result?.merged, true, "fixture merge was not confirmed");
            const writes = writeRequests(options, start, seam);
            assert(
              writes.some(
                (request) =>
                  JSON.stringify(request.body).includes(head) &&
                  `${request.path} ${JSON.stringify(request.body)}`.includes("17"),
              ),
              "merge did not send the pinned head and pull request number to the fixture",
            );
          });
        }
      } else if (seam === "runtime" || seam === "node") {
        await workerChecks(options, seam, kind);
      } else {
        await options.check(`${name}.tool-call`, async () => {
          const provider = options.registry.get("model", kind);
          assert(provider, "provider was not registered");
          const start = options.requests.length;
          const result = await generateText({
            model: provider.create("conformance-model") as LanguageModel,
            prompt: "Call conformance_echo with message fixture-tool-call.",
            tools: {
              conformance_echo: {
                description: "Echo the conformance fixture message.",
                inputSchema: jsonSchema<{ message: string }>({
                  type: "object",
                  properties: { message: { type: "string" } },
                  required: ["message"],
                  additionalProperties: false,
                }),
              },
            },
            toolChoice: { type: "tool", toolName: "conformance_echo" },
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(4000),
          });
          assertContact(options, start, "model", "POST");
          assert.equal(result.toolCalls.length, 1, "model did not produce one tool call");
          assert.equal(result.toolCalls[0]?.toolName, "conformance_echo");
          assert.deepEqual(result.toolCalls[0]?.input, { message: "fixture-tool-call" });
        });
      }
    }
  }
}

function contains(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => contains(actual[index], value))
    );
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => contains((actual as Record<string, unknown>)[key], value));
}
function fixturePath(options: SeamCheckOptions, request: FixtureRequest, seam: string): boolean {
  const url = new URL(request.path, options.endpoint);
  const root = new URL(options.endpoint);
  const base = root.pathname.replace(/\/$/, "");
  return (
    url.origin === root.origin && (url.pathname === `${base}/${seam}` || url.pathname.startsWith(`${base}/${seam}/`))
  );
}
function assertContact(options: SeamCheckOptions, start: number, seam: string, method?: string): void {
  assert(
    options.requests
      .slice(start)
      .some((request) => (!method || request.method.toUpperCase() === method) && fixturePath(options, request, seam)),
    `${seam} did not contact the local fixture${method ? ` with ${method}` : ""}`,
  );
}
function writeRequests(options: SeamCheckOptions, start: number, seam: string): FixtureRequest[] {
  return options.requests
    .slice(start)
    .filter(
      (request) =>
        ["POST", "PUT", "PATCH"].includes(request.method.toUpperCase()) && fixturePath(options, request, seam),
    );
}

async function workerChecks(options: SeamCheckOptions, seam: "runtime" | "node", kind: string): Promise<void> {
  const name = `${seam}.${kind}`;
  let provider = options.registry.get(seam, kind);
  let hostNode: Providers["node"] | undefined;
  if (seam === "runtime" && provider && "withNode" in provider && provider.withNode) {
    const { fixtureNode } = await import(pathToFileURL(join(options.fixtureRoot, "node", "host.mjs")).href);
    hostNode = fixtureNode(options.directory) as Providers["node"];
    provider = provider.withNode(hostNode);
  }
  if (provider) {
    const raw = provider;
    // A fixture generation is authoritative for this isolated sandbox only.
    provider = {
      prepare: (request) => raw.prepare(request),
      launch: (request) =>
        guarded(
          request.worker,
          () => {},
          () => raw.launch(request),
        ),
      deliver: (ref, message, key) =>
        guarded(
          ref,
          () => {},
          () => raw.deliver(ref, message, key),
        ),
      observe: (ref) => raw.observe(ref),
      stop: (ref) =>
        guarded(
          ref,
          () => {},
          () => raw.stop(ref),
        ),
      ...("dispose" in raw && raw.dispose ? { dispose: raw.dispose.bind(raw) } : {}),
    };
  }
  let worker: WorkerRef | undefined;
  let workspace: Awaited<ReturnType<Providers["node"]["prepare"]>> | undefined;
  try {
    const prepared = await options.check(`${name}.prepare`, async () => {
      assert(provider, "provider was not registered");
      const fixture = JSON.parse(await readFile(join(options.fixtureRoot, "node", "workspace.json"), "utf8")) as {
        file: string;
        content: string;
        branchPrefix: string;
      };
      const repository = join(options.directory, `${seam}-${kind}-repository`);
      await mkdir(repository, { recursive: true });
      await execute("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, fixture.file), fixture.content);
      await execute("git", ["-C", repository, "add", "README.md"]);
      await execute("git", [
        "-C",
        repository,
        "-c",
        "user.name=Conformance",
        "-c",
        "user.email=conformance@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Initialize fixture",
      ]);
      const branch = `${fixture.branchPrefix}-${randomUUID()}`;
      workspace = await provider.prepare({
        project,
        ticket,
        repository,
        branch,
        signal: AbortSignal.timeout(4000),
      });
      assert(workspace.id && workspace.node, "prepare returned an incomplete workspace");
      assert((await stat(workspace.path)).isDirectory(), "prepare did not create a workspace directory");
      const location = relative(options.directory, workspace.path);
      assert(
        location !== ".." && !location.startsWith("../") && !location.startsWith("/"),
        "workspace must stay inside the owned conformance sandbox",
      );
      assert.equal(
        await readFile(join(workspace.path, fixture.file), "utf8"),
        fixture.content,
        "prepare did not preserve the repository contents",
      );
      const current = await execute("git", ["-C", workspace.path, "branch", "--show-current"]);
      assert.equal(current.stdout.trim(), branch, "prepare did not check out the requested branch");
      await copyFile(join(options.fixtureRoot, "runtime", "worker.mjs"), join(workspace.path, "worker.mjs"));
    });
    if (!prepared || !workspace || !provider) return;
    const launched = await options.check(`${name}.launch`, async (signal) => {
      assert(workspace);
      worker = await launchWorker(
        options,
        provider,
        workspace,
        (reference) => {
          worker = reference;
        },
        signal,
      );
      await poll(
        provider,
        worker,
        (observation) =>
          observation.state === "running" && observation.reply?.includes("ARMADA_CONFORMANCE_READY") === true,
        undefined,
        signal,
      );
    });
    if (!launched || !worker || !workspace || !provider) return;
    await options.check(`${name}.deliver`, async (signal) => {
      assert(worker);
      const nonce = `nonce-${randomUUID()}`;
      await provider.deliver(worker, nonce, randomUUID());
      await poll(
        provider,
        worker,
        (observation) => observation.reply?.includes(`ARMADA_CONFORMANCE_ACK:${nonce}`) === true,
        undefined,
        signal,
      );
    });
    const stopped = await options.check(`${name}.stop`, async () => {
      assert(worker);
      await provider.stop(worker);
      await poll(provider, worker, (observation) => observation.state === "stopped");
    });
    if (!stopped) return;
    worker = undefined;
    await options.check(`${name}.normal-exit`, async (signal) => {
      assert(workspace);
      const deadline = Date.now() + 3500;
      worker = await launchWorker(
        options,
        provider,
        workspace,
        (reference) => {
          worker = reference;
        },
        signal,
      );
      await poll(
        provider,
        worker,
        (observation) =>
          observation.state === "running" && observation.reply?.includes("ARMADA_CONFORMANCE_READY") === true,
        deadline,
        signal,
      );
      signal.throwIfAborted();
      await provider.deliver(worker, "exit", randomUUID());
      await poll(provider, worker, (observation) => observation.state === "stopped", deadline, signal);
      worker = undefined;
    });
  } finally {
    if (worker && provider) await options.check(`${name}.cleanup`, () => provider.stop(worker as WorkerRef));
    const node = seam === "node" ? (provider as Providers["node"]) : hostNode;
    if (workspace && node?.dispose) {
      const prepared = workspace;
      const dispose = node.dispose.bind(node);
      await options.check(`${name}.dispose`, async () => {
        await rm(join(prepared.path, "worker.mjs"), { force: true });
        await dispose(prepared);
      });
    }
  }
}
async function launchWorker(
  options: SeamCheckOptions,
  provider: Providers["node"],
  workspace: Parameters<Providers["node"]["launch"]>[0]["workspace"],
  remember: (worker: WorkerRef) => void,
  signal: AbortSignal,
): Promise<WorkerRef> {
  const session = randomUUID();
  const worker = await provider.launch({
    workspace,
    worker: { project, ticket, session, generation: 1 },
    command: options.nodeCommand ?? process.execPath,
    args: [join(workspace.path, "worker.mjs")],
    env: {},
  });
  if (signal.aborted) {
    await provider.stop(worker);
    signal.throwIfAborted();
  }
  remember(worker);
  assert.equal(worker.project, project);
  assert.equal(worker.ticket, ticket);
  assert.equal(worker.session, session);
  assert.equal(worker.generation, 1);
  assert(worker.handle, "launch returned no worker handle");
  return worker;
}
async function poll(
  provider: Providers["node"],
  worker: WorkerRef,
  accepted: (observation: Awaited<ReturnType<Providers["node"]["observe"]>>) => boolean,
  deadline = Date.now() + 3500,
  signal?: AbortSignal,
): Promise<void> {
  let state = "unknown";
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const observation = await provider.observe(worker);
    signal?.throwIfAborted();
    if (accepted(observation)) return;
    state = observation.state;
    await delay(25, undefined, { signal });
  }
  throw new Error(`worker observation did not reach the expected state (last state: ${state})`);
}
