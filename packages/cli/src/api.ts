// The Armada API as every command calls it: with this CLI's version, so a
// server that expects a newer CLI says so instead of answering in a shape this
// one does not know.
import { armadaApi } from "@armada/core";
import { version } from "../package.json" with { type: "json" };
import type { Io } from "./io.ts";

export const apiOf = (io: Io, url: string, cliVersion: string = version) =>
  armadaApi({ url, version: cliVersion, ...(io.fetch ? { fetch: io.fetch } : {}) });
