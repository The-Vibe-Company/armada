// The Armada API as every command calls it: with this CLI's version, so a
// server that expects a newer CLI says so instead of answering in a shape this
// one does not know. What the server says of the latest CLI is kept per run,
// for the release notice (`release.ts`).
import { armadaApi, type ServerCli } from "@armada/core";
import { version } from "../package.json" with { type: "json" };
import type { Io } from "./io.ts";

/** What a run heard: the server's CLI versions. */
export interface Heard {
  server: ServerCli | null;
}

const runs = new WeakMap<Io, Heard>();

/** What this run (`io`) heard so far. */
export function heard(io: Io): Heard {
  let h = runs.get(io);
  if (!h) {
    h = { server: null };
    runs.set(io, h);
  }
  return h;
}

export const apiOf = (io: Io, url: string, cliVersion: string = version) =>
  armadaApi({
    url,
    version: cliVersion,
    onServerCli: (server) => {
      heard(io).server = server;
    },
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
