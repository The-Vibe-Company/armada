// Post-close bookkeeping: native Linear automation wins. Otherwise only a
// complete, fresh reading of every descendant can close a program spec.
import { createHash } from "node:crypto";
import type { ArmadaConfig } from "./config.ts";
import type { LinearWriter, SpecChild, Ticket } from "./linear-write.ts";
import { isClosed, SPEC_TITLE } from "./model.ts";
import { firstState } from "./worker.ts";

const LIMIT = 10_000;
const DEPTH = 64;

export async function closeFinishedSpec(
  ctx: { config: ArmadaConfig; linear: LinearWriter },
  ticket: Ticket,
): Promise<{ lines: string[]; warnings: string[] }> {
  let spec: Ticket | null = null;
  try {
    const root = ctx.config.tracker.programRoot;
    const seen = new Set([ticket.id]);
    let parent = ticket.parentId;
    for (let depth = 0; parent && parent !== root; depth++) {
      if (depth >= DEPTH || seen.has(parent)) throw new Error("incomplete or cyclic spec ancestry");
      seen.add(parent);
      const ancestor = await ctx.linear.readTicket(parent);
      if (!ancestor) throw new Error(`ancestor ${parent} not found`);
      if (ancestor.parentId === root && SPEC_TITLE.test(ancestor.title.trim())) {
        spec = ancestor;
        break;
      }
      parent = ancestor.parentId;
    }
    if (!spec || isClosed(spec)) return { lines: [], warnings: [] };
    const native = await ctx.linear.parentAutoClose(spec.id);
    if (native.enabled === true) return { lines: [], warnings: [] };
    if (native.enabled === null) throw new Error("Linear did not return the team's Parent auto-close setting");

    const descendants: SpecChild[] = [];
    let parents = [spec.uuid];
    const visited = new Set(parents);
    for (let depth = 0; parents.length; depth++) {
      if (depth >= DEPTH) throw new Error("spec exceeds the completion depth limit");
      const next: string[] = [];
      for (const child of await ctx.linear.readChildren(parents)) {
        if (visited.has(child.uuid)) throw new Error("cyclic or repeated spec descendant");
        visited.add(child.uuid);
        if (visited.size > LIMIT) throw new Error("spec exceeds the completion read limit");
        // Even closed parents may have open children. Read all descendants.
        descendants.push(child);
        next.push(child.uuid);
      }
      parents = next;
    }
    if (!descendants.length || descendants.some((child) => !isClosed(child))) return { lines: [], warnings: [] };
    // The triggering ticket must still belong to this freshly read tree.
    if (!descendants.some((child) => child.id === ticket.id)) return { lines: [], warnings: [] };
    const done = firstState(spec.states, "completed");
    if (!done) throw new Error(`${spec.id} has no completed workflow state`);
    const list = (status: "completed" | "canceled") =>
      descendants
        .filter((child) => child.statusType === status)
        .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))
        .map((child) => `- [${child.id}](${child.url}) — ${child.title}`);
    const shipped = list("completed");
    const canceled = list("canceled");
    // Post first so a failed comment cannot leave a closed spec without its
    // summary. Its marker prevents duplicate summaries after an update retry.
    const summary = [
      shipped.length ? `Shipped:\n${shipped.join("\n")}` : "",
      canceled.length ? `Canceled:\n${canceled.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const key = createHash("sha256").update(summary).digest("hex").slice(0, 16);
    const marker = `Spec completion — all descendants are completed or canceled. Summary ${key}.`;
    if (spec.commentsTruncated)
      throw new Error("Linear did not return every spec comment; summary retry cannot be checked");
    if (!spec.comments.some((comment) => comment.excerpt.startsWith(marker)))
      await ctx.linear.comment(spec.uuid, `${marker}\n\n${summary}`);
    await ctx.linear.updateTicket(spec.uuid, { stateId: done.id });
    return {
      lines: [`${spec.id}: all ${descendants.length} descendants closed; moved to ${done.name}, summary posted.`],
      warnings: [],
    };
  } catch (err) {
    return {
      lines: [],
      warnings: [
        `Could not close spec${spec ? ` ${spec.id}` : ` for ${ticket.id}`} (${err instanceof Error ? err.message : String(err)})`,
      ],
    };
  }
}
