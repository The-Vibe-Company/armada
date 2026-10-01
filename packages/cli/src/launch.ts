import type { ArmadaConfig, Credentials } from "@armada/core";
import { apiOf } from "./api.ts";
import { type Io, UsageError } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { rearmFor, remember, watchOf } from "./watch.ts";

export async function launch(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: { rest: string[]; json: boolean },
) {
  const [operation, ticket, ...extra] = args.rest;
  if (operation !== "revoke" || !ticket || extra.length || !/^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/.test(ticket))
    throw new UsageError("launch needs a ticket to revoke: armada launch revoke <ticket>");
  const revoked = await apiOf(io, credentials.armadaApi.url).revokeLaunch(requireSignIn(credentials), {
    project: config.project.slug,
    ticket: ticket.toUpperCase(),
  });
  const known = (await watchOf(io, config.project.slug)).state?.inFlight;
  const inFlight = known?.filter((held) => held !== revoked.ticket) ?? null;
  if (inFlight)
    await remember(io, config.project.slug, { inFlight, readAt: (io.now ?? (() => new Date()))().toISOString() });
  const watch = await rearmFor(io, config.project.slug, { inFlight, open: null });
  io.stdout(
    args.json
      ? `${JSON.stringify({ ...revoked, watch }, null, 2)}\n`
      : `Revoked the pending launch of ${revoked.ticket}.\n${watch.line}\n`,
  );
  return 0;
}
