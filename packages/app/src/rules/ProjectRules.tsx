import { z } from "zod";
import { Block } from "@/components/page";

// Read only the daemon's rules slice. The app has no repository-config or daemon runtime imports.
const target = { cli: z.enum(["claude", "codex", "opencode"]), model: z.string(), effort: z.string().optional() };
const place = z.enum(["local", "vm"]);
const schema = z.object({
  revision: z.number().int().nonnegative(),
  value: z.object({
    routing: z
      .array(z.union([z.object({ labels: z.array(z.string()), ...target }), z.object({ when: z.string(), ...target })]))
      .optional(),
    defaultRoute: z.object(target).nullable().optional(),
    placement: z.object({ workers: place, coordinator: place }).optional(),
    policy: z
      .object({
        silenceMinutes: z.number().positive().optional(),
        quietMinutes: z.number().positive().optional(),
        maxWorkers: z.number().int().positive().nullable().optional(),
      })
      .optional(),
  }),
});
const placement = (value: "local" | "vm" | undefined) =>
  value === "local" ? "On this machine" : value === "vm" ? "In a VM" : "Not set";
const minutes = (value: number | undefined) => (value === undefined ? "Not set" : `${value} min`);

/** Current project intent, live from its folded snapshot; the coordinator's chat owns edits. */
export function ProjectRules({ state }: { state: unknown }) {
  const raw = state && typeof state === "object" ? Reflect.get(state, "rules") : undefined;
  const parsed = schema.safeParse(raw);
  return (
    <Block heading="Rules">
      {!parsed.success ? (
        <p className="m-0 text-text-2">This daemon does not provide readable project rules.</p>
      ) : (
        <div className="overflow-hidden rounded-card bg-card shadow-ring">
          <div className="flex flex-wrap items-center justify-between gap-2 border-line border-b px-4 py-3">
            <p className="m-0 text-text-2">
              {parsed.data.revision === 0
                ? "No rules set yet. Tell the coordinator how to run this project."
                : "Set routing, placement and limits in the coordinator’s chat."}
            </p>
            {parsed.data.revision > 0 && (
              <span className="font-mono text-small text-text-3">Revision {parsed.data.revision}</span>
            )}
          </div>
          <dl className="m-0 grid grid-cols-1 gap-x-8 gap-y-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Workers" value={placement(parsed.data.value.placement?.workers)} />
            <Fact label="Coordinator" value={placement(parsed.data.value.placement?.coordinator)} />
            <Fact
              label="Max workers"
              value={
                parsed.data.value.policy?.maxWorkers === null
                  ? "No cap"
                  : (parsed.data.value.policy?.maxWorkers?.toString() ?? "Not set")
              }
            />
            <Fact label="Silence after" value={minutes(parsed.data.value.policy?.silenceMinutes)} />
            <Fact label="Quiet after" value={minutes(parsed.data.value.policy?.quietMinutes)} />
          </dl>
          <div className="border-line border-t">
            <div className="px-4 pt-3 pb-2 text-small text-text-3">Routing · in priority order</div>
            <ol className="m-0 list-none p-0">
              {parsed.data.value.routing?.map((route, index) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: read-only ordered rules may be identical; each position is distinct.
                  key={index}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-line-soft border-b px-4 py-2.5"
                >
                  <span className="min-w-0 break-words">
                    {"labels" in route ? route.labels.join(" · ") : route.when}
                  </span>
                  <Target target={route} />
                </li>
              ))}
            </ol>
            {!parsed.data.value.routing?.length && <p className="m-0 px-4 py-2 text-text-2">No routing rules set.</p>}
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span className="text-text-2">Default</span>
              {parsed.data.value.defaultRoute ? (
                <Target target={parsed.data.value.defaultRoute} />
              ) : (
                <span className="text-text-3">Not set</span>
              )}
            </div>
          </div>
        </div>
      )}
    </Block>
  );
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-small text-text-3">{label}</dt>
      <dd className="m-0">{value}</dd>
    </div>
  );
}
function Target({ target }: { target: { cli: string; model: string; effort?: string } }) {
  return (
    <span className="min-w-0 break-all font-mono text-small text-text-2">
      {target.cli} · {target.model}
      {target.effort ? ` · ${target.effort}` : ""}
    </span>
  );
}
