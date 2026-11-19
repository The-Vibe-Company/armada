import { SQL } from "bun";
import { countArchitecture, gitText, readArchitectureTree } from "./architecture-counters";

const weekMs = 7 * 24 * 60 * 60 * 1000;
const databaseHelp = "Pass --read-only and set ARMADA_METRICS_READ_ONLY_DATABASE_URL to a read-only PostgreSQL role.";

export function weeklyFixShare(log: string, end: Date) {
  const until = end.getTime();
  let merges = 0;
  let fixes = 0;
  for (const line of log.split("\n")) {
    const [timestamp, parents = "", subject = ""] = line.split("\0");
    const at = Number(timestamp) * 1000;
    if (!(at > until - weekMs && at <= until)) continue;
    // GitHub squash merges have one parent and a PR number appended to the subject.
    if (!parents.includes(" ") && !/\(#\d+\)$/.test(subject)) continue;
    merges++;
    if (subject.startsWith("fix(")) fixes++;
  }
  return {
    fromExclusive: new Date(until - weekMs).toISOString(),
    through: end.toISOString(),
    merges,
    fixes,
    share: merges === 0 ? null : fixes / merges,
  };
}

export const deliveryQueries = {
  hasRuntimePromptAttribution: `
    select count(*) = 8 as available
    from information_schema.columns
    where table_schema = 'public' and (table_name, column_name) in (
      ('runtime_commands', 'sandbox_id'),
      ('runtime_commands', 'epoch'),
      ('runtime_commands', 'created_at'),
      ('runtime_commands', 'accepted_prompt_id'),
      ('runtime_events', 'sandbox_id'),
      ('runtime_events', 'epoch'),
      ('runtime_events', 'created_at'),
      ('runtime_events', 'visible_text_prompt_id')
    )
  `,
  runtimeCommandToFirstVisibleText: `
    with first_text as (
      select sandbox_id, epoch, visible_text_prompt_id, min(created_at) as first_at
      from public.runtime_events
      where visible_text_prompt_id is not null and created_at is not null
      group by sandbox_id, epoch, visible_text_prompt_id
    ), samples as (
      select extract(epoch from (text.first_at - command.created_at)) * 1000 as ms
      from public.runtime_commands command
      join first_text text on text.sandbox_id = command.sandbox_id
        and text.epoch = command.epoch and text.visible_text_prompt_id = command.accepted_prompt_id
      where text.first_at >= command.created_at
    )
    select count(*)::integer as samples,
      percentile_cont(0.50) within group (order by ms) as "p50Ms",
      percentile_cont(0.95) within group (order by ms) as "p95Ms"
    from samples
  `,
  launchStageTotals: `
    select sandbox.provider::text as provider, stage.stage,
      count(*)::integer as samples,
      sum(extract(epoch from (stage.at - accepted.at)) * 1000)::double precision as "totalMs"
    from public.sandbox_launch_stages stage
    join public.sandbox_launch_stages accepted on accepted.sandbox_id = stage.sandbox_id
      and accepted.activation = stage.activation and accepted.stage = 'accepted'
    join public.sandboxes sandbox on sandbox.id = stage.sandbox_id
    where stage.activation = 1
    group by sandbox.provider, stage.stage
    order by sandbox.provider, stage.stage
  `,
};

async function databaseCounters(url: string) {
  const client = new SQL(url, { max: 1, connectionTimeout: 10 });
  try {
    return await client.begin("READ ONLY", async (tx) => {
      const [schema] = await tx.unsafe<{ available: boolean }[]>(deliveryQueries.hasRuntimePromptAttribution);
      const [latency] = schema?.available
        ? await tx.unsafe<{ samples: number; p50Ms: number | null; p95Ms: number | null }[]>(
            deliveryQueries.runtimeCommandToFirstVisibleText,
          )
        : [null];
      return {
        runtimeCommandToFirstVisibleText: latency,
        runtimeLatencyUnavailableReason: schema?.available
          ? null
          : "Required runtime journal columns are unavailable to the read-only role.",
        launchStageTotals: await tx.unsafe<{ provider: string; stage: string; samples: number; totalMs: number }[]>(
          deliveryQueries.launchStageTotals,
        ),
      };
    });
  } finally {
    await client.close();
  }
}

async function main(args: string[]) {
  const readOnly = args.includes("--read-only");
  const offline = args.includes("--offline");
  const weekEnd = args.find((arg) => arg.startsWith("--week-ending="))?.slice("--week-ending=".length);
  if (
    readOnly === offline ||
    args.some((arg) => !["--read-only", "--offline"].includes(arg) && !arg.startsWith("--week-ending=")) ||
    args.length > (weekEnd === undefined ? 1 : 2)
  ) {
    throw new Error("Use exactly one of --offline or --read-only, optionally with --week-ending=YYYY-MM-DD.");
  }
  const end = weekEnd === undefined ? new Date() : new Date(`${weekEnd}T23:59:59.999Z`);
  if (weekEnd !== undefined && (!Number.isFinite(end.getTime()) || end.toISOString().slice(0, 10) !== weekEnd)) {
    throw new Error("Use a valid UTC date for --week-ending=YYYY-MM-DD.");
  }
  const url = Bun.env.ARMADA_METRICS_READ_ONLY_DATABASE_URL;
  if (readOnly && (!url || !/^postgres(?:ql)?:\/\//.test(url))) {
    throw new Error(databaseHelp);
  }
  const log = gitText(".", ["log", "--first-parent", "--format=%ct%x00%P%x00%s"]);
  const counters = {
    ...countArchitecture(await readArchitectureTree(".")),
    weeklyFixShare: weeklyFixShare(log, end),
    ...(readOnly
      ? await databaseCounters(url!)
      : {
          runtimeCommandToFirstVisibleText: null,
          runtimeLatencyUnavailableReason: "Offline mode.",
          launchStageTotals: null,
        }),
  };
  console.log(JSON.stringify(counters, null, 2));
}

if (import.meta.main) {
  // Driver errors and argument text can contain the URL. Print only a fixed diagnostic.
  await main(Bun.argv.slice(2)).catch(() => {
    console.error(
      `Unable to collect delivery counters. Use --offline or --read-only, optionally with --week-ending=YYYY-MM-DD. ${databaseHelp}`,
    );
    process.exitCode = 1;
  });
}
