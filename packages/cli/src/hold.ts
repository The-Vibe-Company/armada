import { type ArmadaConfig, type Credentials, Refusal } from "@armada/core";

import { type Io, UsageError } from "./io.ts";
import { liveFleet, type WorkerArgs } from "./worker.ts";

export async function hold(io: Io, config: ArmadaConfig, credentials: Credentials, a: WorkerArgs) {
  const [command, value, ...extra] = a.rest;
  if (extra.length) throw new UsageError(`unexpected argument ${extra[0]}`);
  if (command && command !== "add" && command !== "clear") throw new UsageError(`unknown hold command ${command}`);
  if (!command && a.options.reason !== undefined) throw new UsageError("--reason applies to hold clear");
  if (command === "add" && (!value?.trim() || a.options.reason !== undefined))
    throw new UsageError('armada hold add "<reason>"');
  const id = Number(value);
  if (command === "clear" && (!Number.isSafeInteger(id) || id < 1 || !a.options.reason?.trim()))
    throw new UsageError('armada hold clear <id> --reason "<why>"');
  const { fleet, warning } = liveFleet(io, config, credentials);
  if (!fleet)
    throw new Refusal(`merge holds need Armada, which is unavailable (${warning ?? "no answer"})`, "armada login");
  if (command === "add") {
    const h = await fleet.openHold({ kind: "manual", reason: value?.trim() ?? "" });
    io.stdout(a.json ? `${JSON.stringify(h, null, 2)}\n` : `Merges paused: ${h.reason} (hold #${h.id}).\n`);
  } else if (command === "clear") {
    const result = await fleet.clearHold({ id, reason: a.options.reason?.trim() ?? "" });
    if (!result) throw new Refusal(`hold #${id} does not exist in project ${config.project.slug}`, "armada hold");
    const h = result.hold;
    const line = result.cleared
      ? `Cleared hold #${id}: ${h.clearReason}.`
      : `Hold #${id} already cleared by ${h.clearedBy ?? "unknown"} at ${h.clearedAt}: ${h.clearReason}.`;
    const note = h.kind === "main-red" ? " If main is still red, the next snapshot refresh reopens this pause." : "";
    io.stdout(a.json ? `${JSON.stringify(result, null, 2)}\n` : `${line}${note}\n`);
  } else {
    const holds = await fleet.holds();
    io.stdout(
      a.json
        ? `${JSON.stringify(holds, null, 2)}\n`
        : holds.length
          ? `${holds.map((h) => `hold #${h.id} · ${h.kind} · since ${h.openedAt} · ${h.reason}`).join("\n")}\n`
          : "Merges are not paused.\n",
    );
  }
  return 0;
}
