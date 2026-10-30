import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { LaunchRequest, PluginContext, PrepareRequest, RuntimeProvider, WorkerRef } from "@armada/plugin-api";
import { RuntimeLaunchRefusal } from "@armada/plugin-api";
import { checkedMutation } from "@armada/plugin-api/guard";

interface Profile {
  agent: "claude" | "codex" | "opencode" | "cursor";
  model: string;
  effort: string;
}
interface ConductorOptions {
  binary?: string;
  defaultProfile?: string;
  profiles?: Record<string, Profile>;
  routing?: { labels: string[]; profile: string }[];
}
const labelKey = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "");
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(value) &&
  !/armada_(?:launch|worker|session|key)_/.test(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Conductor returned an invalid response");
  return value as Record<string, unknown>;
};
const handle = (ref: WorkerRef) => {
  const [workspace, session, extra] = ref.handle.split("/");
  if (!identifier(workspace) || !identifier(session) || extra !== undefined)
    throw new Error("Invalid Conductor worker handle");
  return { workspace, session };
};

/** Owns remote workspaces. The host supplies a brief, never its Armada session or socket capability. */
export function conductorRuntime(options: ConductorOptions = {}): RuntimeProvider {
  const prepared = new Map<string, PrepareRequest>();
  const run = (args: string[], input?: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      // argv never contains prompts or credentials. Neither failure path exposes native output.
      const child = execFile(
        options.binary || "conductor",
        [...args, "--json"],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error)
            return reject(
              ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
                ? new RuntimeLaunchRefusal("Conductor executable could not start; check its path in Providers")
                : new Error("Conductor command failed; inspect the workspace before retrying"),
            );
          try {
            resolve(object(JSON.parse(stdout)));
          } catch {
            reject(new Error("Conductor returned an invalid response; inspect the workspace before retrying"));
          }
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  const status = async (ref: WorkerRef) => {
    const h = handle(ref);
    const result = await run(["session", "status", h.session]);
    if (result.workspaceId !== h.workspace || result.sessionId !== h.session)
      throw new Error("Conductor session does not match the worker workspace");
    if (typeof result.status !== "string") throw new Error("Conductor returned an invalid session state");
    return result;
  };
  const workspaceStatus = async (ref: WorkerRef) => {
    const h = handle(ref);
    const result = await run(["workspace", "status", h.workspace]);
    if (result.workspaceId !== h.workspace) throw new Error("Conductor workspace does not match the worker");
    if (typeof result.status !== "string") throw new Error("Conductor returned an invalid workspace state");
    return result;
  };
  const profile = (request: Pick<LaunchRequest, "args" | "labels">) => {
    const labels = (request.labels ?? []).map(labelKey);
    const routed = options.routing?.find((rule) =>
      rule.labels.some((label) => labels.includes(labelKey(label))),
    )?.profile;
    const explicit = request.args[request.args.indexOf("--model") + 1];
    const selected = (request.args.includes("--model") ? explicit : undefined) ?? routed ?? options.defaultProfile;
    const value = selected ? options.profiles?.[selected] : undefined;
    if (!value) throw new Error("Configure a Conductor profile in Providers before launching");
    return value;
  };
  return {
    needsLaunchToken: true,
    async prepare(request) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository))
        throw new Error("Conductor needs a GitHub repository");
      if (!request.branch || request.branch.startsWith("-") || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(request.branch))
        throw new Error("Invalid Conductor branch");
      profile({ labels: request.labels, args: request.profile ? ["--model", request.profile] : [] });
      const id = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      prepared.set(id, request);
      return { id, path: "", node: "conductor" };
    },
    async launch(request) {
      const facts = prepared.get(request.workspace.id);
      if (!facts || facts.ticket !== request.worker.ticket || facts.project !== request.worker.project)
        throw new Error("Conductor workspace preparation does not match the worker");
      if (!request.brief || !request.brief.startsWith("armada login --launch-token "))
        throw new Error("Conductor launch needs an authenticated worker brief");
      const p = profile(request);
      const result = await checkedMutation(request.worker, () =>
        run(
          [
            "workspace",
            "create",
            "--repo-url",
            `https://github.com/${facts.repository}`,
            ...(request.baseBranch ? ["--branch", request.baseBranch] : []),
            "--name",
            facts.ticket,
            "--session-name",
            `${facts.ticket} (${request.worker.session})`,
            "--agent",
            p.agent,
            "--model",
            p.model,
            "--effort",
            p.effort,
            "--message-file",
            "-",
            "--env",
            `ARMADA_TICKET=${facts.ticket}`,
          ],
          request.brief,
        ),
      );
      if (!identifier(result.workspaceId) || !identifier(result.sessionId))
        throw new Error("Conductor create outcome unknown; inspect the workspace before retrying");
      prepared.delete(request.workspace.id);
      return { ...request.worker, handle: `${result.workspaceId}/${result.sessionId}` };
    },
    async recover(request) {
      if (!Number.isFinite(Date.parse(request.since)) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository))
        throw new Error("Invalid Conductor recovery request");
      const listed = await run([
        "workspace",
        "list",
        "--mine",
        "--repo",
        request.repository,
        "--since",
        new Date(Date.parse(request.since) - 120_000).toISOString(),
        "--limit",
        "10",
      ]);
      if (listed.hasMore !== false || !Array.isArray(listed.data) || listed.data.length > 10) return null;
      const matches: WorkerRef[] = [];
      for (const entry of listed.data) {
        const workspace = object(entry);
        if (
          !identifier(workspace.id) ||
          workspace.name !== request.ticket ||
          workspace.state === "archived" ||
          typeof workspace.repoUrl !== "string" ||
          workspace.repoUrl
            .replace(/\.git$/, "")
            .replace(/\/$/, "")
            .toLowerCase() !== `https://github.com/${request.repository}`.toLowerCase()
        )
          continue;
        const listedSessions = await run(["workspace", "session", workspace.id, "--limit", "10"]);
        if (listedSessions.hasMore !== false || !Array.isArray(listedSessions.data) || listedSessions.data.length !== 1)
          continue;
        const session = object(listedSessions.data[0]);
        if (!identifier(session.id) || session.name !== `${request.ticket} (${request.worker.session})`) continue;
        const ref = { ...request.worker, handle: `${workspace.id}/${session.id}` };
        await status(ref);
        matches.push(ref);
      }
      return matches.length === 1 ? (matches[0] ?? null) : null;
    },
    async deliver(ref, message, key) {
      await status(ref);
      if ((await workspaceStatus(ref)).status === "archived") throw new Error("Conductor workspace is archived");
      const delivery = createHash("sha256").update(key).digest("hex");
      const result = await checkedMutation(ref, () =>
        run(
          ["message", "create", "--session", handle(ref).session, "--message-file", "-", "--message-id", delivery],
          message,
        ),
      );
      if (!identifier(result.messageId) || !["sent", "queued"].includes(String(result.state)))
        throw new Error("Conductor delivery outcome unknown; retry only with the same delivery key");
    },
    async observe(ref) {
      if ((await workspaceStatus(ref)).status === "archived") return { state: "stopped" };
      const result = await status(ref);
      if (result.status === "working") return { state: "running", activity: "working" };
      if (result.status === "idle") return { state: "running", activity: "idle" };
      if (result.status === "starting" || result.status === "queued") return { state: "starting" };
      if (result.status === "failed" || result.status === "error") return { state: "failed" };
      return { state: "unknown" };
    },
    async stop(ref) {
      if ((await workspaceStatus(ref)).status === "archived") return;
      const result = await status(ref);
      if (["working", "starting", "queued"].includes(String(result.status)))
        await checkedMutation(ref, () => run(["session", "cancel", handle(ref).session]));
      for (let attempt = 0; attempt < 5; attempt++) {
        const after = await status(ref);
        if (
          after.status === "idle" ||
          after.status === "stopped" ||
          after.status === "failed" ||
          after.status === "error"
        )
          return;
        await delay(200);
      }
      throw new Error("Conductor worker has not stopped; workspace retained");
    },
    async archive(ref) {
      if ((await workspaceStatus(ref)).status === "archived") return;
      const state = await status(ref);
      if (!["idle", "stopped", "failed", "error"].includes(String(state.status)))
        throw new Error("Conductor worker is still active; workspace retained");
      const sessions = await run(["workspace", "session", handle(ref).workspace, "--limit", "10"]);
      if (
        sessions.hasMore !== false ||
        !Array.isArray(sessions.data) ||
        sessions.data.length !== 1 ||
        object(sessions.data[0]).id !== handle(ref).session
      )
        throw new Error("Conductor workspace contains other sessions; retained for inspection");
      const result = await checkedMutation(ref, () => run(["workspace", "archive", handle(ref).workspace]));
      if (result.status !== "archived")
        throw new Error("Conductor archive outcome unknown; inspect the workspace before retrying");
    },
  };
}

export function activate(ctx: PluginContext): void {
  ctx.register.runtime("conductor", conductorRuntime((ctx.config.runtime?.conductor ?? {}) as ConductorOptions));
}
