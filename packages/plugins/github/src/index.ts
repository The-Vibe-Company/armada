import type { FleetEvent } from "@armada/daemon/events";
import type { ForgeProvider, PluginContext } from "@armada/plugin-api";
import { GithubReader } from "./github.ts";
import { githubToken } from "./keychain.ts";

interface Config {
  endpoint?: string;
  projects?: Record<string, { repository: string }>;
}

export function activate(ctx: PluginContext): void {
  const config = ctx.config.forge?.github as Config;
  const readers = new Map<string, GithubReader>();
  const token = (signal?: AbortSignal) =>
    githubToken({
      signal,
      keychain: { read: async () => ctx.secrets.get("GITHUB_TOKEN") },
    });
  const provider: ForgeProvider = {
    async read({ project, signal }) {
      signal?.throwIfAborted();
      const settings = config.projects?.[project];
      if (!settings) return;
      let reader = readers.get(project);
      if (!reader) {
        reader = new GithubReader({
          project,
          repository: settings.repository,
          actor: "owner",
          endpoint: config.endpoint,
          token,
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
        if (!result.ok) throw new Error(result.error);
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    },
    async merge({ project, number, head, signal }) {
      try {
        const repository = config.projects?.[project]?.repository;
        if (!repository || !Number.isSafeInteger(number) || number <= 0 || !/^[a-f0-9]{40}$/i.test(head))
          throw new Error();
        const key = await token(signal);
        signal?.throwIfAborted();
        const endpoint = config.endpoint
          ? `${config.endpoint}/repos/${repository}/pulls/${number}/merge`
          : `https://api.github.com/repos/${repository}/pulls/${number}/merge`;
        const response = await fetch(endpoint, {
          method: "PUT",
          redirect: "error",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ sha: head, merge_method: "squash" }),
        });
        const body = (await response.json()) as { merged?: boolean };
        signal?.throwIfAborted();
        return { merged: response.ok && body.merged === true };
      } catch {
        throw new Error("GitHub merge failed");
      }
    },
  };
  ctx.register.forge("github", provider);
}
