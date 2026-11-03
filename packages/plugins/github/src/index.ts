import type { FleetEvent } from "@armada/daemon/events";
import type { FleetTables } from "@armada/daemon/fold";
import type { ForgeProvider, PluginContext } from "@armada/plugin-api";
import { GithubReader } from "./github.ts";
import { inspectGithub, restEndpoint } from "./inspect.ts";
import { githubToken } from "./keychain.ts";
import { githubConnection } from "./status.ts";

interface Config {
  endpoint?: string;
  projects?: Record<string, { repository: string }>;
}

export function activate(ctx: PluginContext): void {
  const config = ctx.config.forge?.github as Config;
  const readers = new Map<string, GithubReader>();
  const token = (project: string, signal?: AbortSignal) =>
    githubToken({
      signal,
      keychain: { read: async () => ctx.secrets.get("GITHUB_TOKEN", project) },
    });
  const provider: ForgeProvider = {
    ...githubConnection(ctx.secrets, config.endpoint),
    async read({ project, signal }) {
      signal?.throwIfAborted();
      const settings = config.projects?.[project];
      if (!settings) throw new Error("GitHub project is not configured");
      let reader = readers.get(project);
      if (!reader) {
        reader = new GithubReader({
          project,
          repository: settings.repository,
          actor: "owner",
          endpoint: config.endpoint,
          token: (signal) => token(project, signal),
          openPullRequests: async () => {
            const tables = (await ctx.events.fold(project)) as FleetTables;
            return (tables?.projects?.[project]?.pullRequests ?? []).filter(
              (pr) => !("repository" in pr) || pr.repository === settings.repository,
            );
          },
          activeTickets: async () => {
            const tables = (await ctx.events.fold(project)) as FleetTables;
            return new Set(
              (tables?.projects?.[project]?.sessions ?? [])
                .filter((session) => !["released", "merged"].includes(session.phase))
                .map((session) => session.ticket),
            );
          },
          tickets: async () =>
            new Set(
              (await ctx.events.read(project, 0)).flatMap((event) =>
                event.kind === "ticket.seen" ? [(event.payload as { id: string }).id] : [],
              ),
            ),
          fetch: (...args) => fetch(...args),
          store: {
            append: async (event) => (await ctx.events.append(event)) as FleetEvent,
            readSince: async (after) => (await ctx.events.read(project, after)) as FleetEvent[],
          },
        });
        readers.set(project, reader);
      }
      const stop = () => reader.stop();
      signal?.addEventListener("abort", stop, { once: true });
      try {
        const result = await reader.refresh();
        signal?.throwIfAborted();
        const state = reader.state();
        return {
          ...state,
          ...(!result.ok ? { error: result.error } : state.failures.length ? { error: "GitHub reading failed" } : {}),
        };
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    },
    async inspect({ project, number, signal }) {
      try {
        const repository = config.projects?.[project]?.repository;
        if (!repository || !Number.isSafeInteger(number) || number <= 0) throw new Error();
        const key = await token(project, signal);
        const inspectionSignal = signal ?? new AbortController().signal;
        return await inspectGithub({
          endpoint: config.endpoint,
          repository,
          number,
          token: key,
          signal: inspectionSignal,
          fetch: (...args) => fetch(...args),
          now: () => new Date(),
        });
      } catch {
        throw new Error("GitHub inspection failed");
      }
    },
    async updateBranch({ project, number, expectedHead, signal, beforeWrite }) {
      try {
        const repository = config.projects?.[project]?.repository;
        if (!repository || !Number.isSafeInteger(number) || number <= 0 || !/^[a-f0-9]{40}$/i.test(expectedHead))
          throw new Error();
        const key = await token(project, signal);
        signal?.throwIfAborted();
        beforeWrite?.();
        const response = await fetch(
          `${restEndpoint(config.endpoint)}/repos/${repository}/pulls/${number}/update-branch`,
          {
            method: "PUT",
            redirect: "error",
            signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({ expected_head_sha: expectedHead }),
          },
        );
        signal?.throwIfAborted();
        if (response.status === 202) return { updated: true };
        if ([401, 403, 404, 409, 422].includes(response.status)) return { updated: false };
        throw new Error();
      } catch {
        throw new Error("GitHub branch update failed");
      }
    },
    async merge({ project, number, head, signal, beforeWrite }) {
      try {
        const repository = config.projects?.[project]?.repository;
        if (!repository || !Number.isSafeInteger(number) || number <= 0 || !/^[a-f0-9]{40}$/i.test(head))
          throw new Error();
        const key = await token(project, signal);
        signal?.throwIfAborted();
        beforeWrite?.();
        let rest = config.endpoint ?? "https://api.github.com";
        try {
          const url = new URL(rest);
          if (url.pathname.replace(/\/+$/, "") === "/graphql")
            url.pathname = url.pathname.replace(/\/+$/, "").slice(0, -"/graphql".length) || "/";
          url.search = "";
          url.hash = "";
          rest = url.toString().replace(/\/$/, "");
        } catch {
          rest = rest.replace(/\/graphql\/?$/, "").replace(/\/$/, "");
        }
        const endpoint = `${rest}/repos/${repository}/pulls/${number}/merge`;
        const response = await fetch(endpoint, {
          method: "PUT",
          redirect: "error",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ sha: head, merge_method: "squash" }),
        });
        if (!response.ok) {
          if ([401, 403, 405, 409, 422].includes(response.status)) return { merged: false };
          throw new Error();
        }
        const body = (await response.json()) as { merged?: boolean; sha?: unknown };
        if (typeof body.merged !== "boolean") throw new Error();
        signal?.throwIfAborted();
        const result: { merged: boolean; mergeCommit?: string } = { merged: response.ok && body.merged === true };
        if (typeof body.sha === "string" && /^[a-f0-9]{40}$/i.test(body.sha))
          result.mergeCommit = body.sha.toLowerCase();
        return result;
      } catch {
        throw new Error("GitHub merge failed");
      }
    },
  };
  ctx.register.forge("github", provider);
}
