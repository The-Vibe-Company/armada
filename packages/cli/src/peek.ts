import {
  ArmadaApiError,
  type ArmadaConfig,
  type ClaimRef,
  type Credentials,
  fetchPullRequest,
  type InboxItem,
  type LatestEvent,
  machinePaths,
  type PeekTail,
  Refusal,
  RuntimeError,
  readWatchState,
  redactSecrets,
  runtimeNameOf,
  updateWatchState,
} from "@armada/core";
import type { Io } from "./io.ts";
import { httpOptions, UsageError } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { claimRef, type Peek, runtimeFor } from "./runtimes/adapter.ts";
import { liveFleet, type WorkerArgs } from "./worker.ts";

export function requirePeekCoordinator(credentials: Credentials): void {
  if (requireSignIn(credentials).kind === "worker")
    throw new ArmadaApiError(
      "peek is for a coordinator; worker sessions cannot inspect runtimes",
      "armada login",
      false,
      403,
    );
}

interface PeekResult {
  ticket: string;
  claimedAt: string | null;
  launchedAt: string | null;
  heartbeatAt: string | null;
  profile: string | null;
  report: LatestEvent | null;
  runtime: Peek & { name: string; handle: string | null; observedAt: string | null; unavailable: string | null };
  pull: {
    number: number;
    url: string;
    headSha: string;
    counts: { passed: number; running: number; failed: number };
    failing: string[];
    running: string[];
    complete: boolean;
  } | null;
  inbox: InboxItem[];
  warnings: string[];
}
const clipped = (text: string, limit: number) =>
  Array.from(text).length > limit
    ? `${Array.from(text)
        .slice(0, limit - 1)
        .join("")}…`
    : text;
// Runtime text must never control the terminal (ANSI, CR, newlines or bidi overrides).
const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}]+/gu, " ");

export async function peek(io: Io, config: ArmadaConfig, credentials: Credentials, args: WorkerArgs): Promise<number> {
  requirePeekCoordinator(credentials);
  const [raw, ...extra] = args.rest;
  if (!raw || extra.length || !/^[a-z][a-z0-9]*-\d+$/i.test(raw))
    throw new UsageError("peek needs one ticket: armada peek <ticket>");
  const actions = args.options.actions === undefined ? 5 : Number(args.options.actions);
  if (!Number.isSafeInteger(actions) || actions < 0 || actions > 100)
    throw new UsageError("--actions must be an integer between 0 and 100");
  const ticket = raw.toUpperCase();
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) throw new Refusal("peek needs Armada's stored worker", "armada login");
  const [stored, events, inbox] = await Promise.all([
    fleet.runtimeHandle(ticket),
    fleet.latestEvents(),
    fleet.ticketItems(ticket),
  ]);
  const launch =
    !stored || stored.releasedAt
      ? (await fleet.pendingLaunches())
          .filter((l) => l.ticket === ticket)
          .sort((a, b) => b.launchedAt.localeCompare(a.launchedAt))[0]
      : undefined;
  const handle = launch ? null : stored;
  if (!handle && !launch) throw new Refusal(`${ticket} has no worker claim or pending launch`, "armada status");
  const name = handle?.runtime ?? launch?.runtime ?? (launch?.handle?.includes("/") ? "Conductor" : "unknown");
  const runtime = runtimeNameOf(name);
  const ref: ClaimRef | null =
    handle && runtime
      ? claimRef(handle)
      : launch?.handle && runtime
        ? {
            ticket,
            runtime,
            handle: launch.handle,
            claimedAt: null,
            launchId: null,
            releasedAt: null,
          }
        : null;
  const now = (io.now ?? (() => new Date()))();
  const secrets = [
    credentials.armadaSignIn?.kind === "api-key" ? credentials.armadaSignIn.key : credentials.armadaSignIn?.token,
    credentials.linearApiKey,
    credentials.githubToken,
    ...config.secrets.names.map((n) => io.env[n]),
  ].filter((v): v is string => !!v);
  const clean = (text: string, limit = 2000) => clipped(plain(redactSecrets(text, secrets)), limit);
  const warnings: string[] = [];
  let reading: Peek = {
    state: handle?.runtimeState?.state ?? "unknown",
    since: handle?.runtimeState?.since ?? null,
    detail: "stored observation",
    link: null,
    lastReply: null,
    actions: [],
    cursor: null,
    truncated: false,
  };
  let observedAt = handle?.runtimeState?.at ?? null;
  let unavailable: string | null = ref ? null : "launch has no bound runtime session yet";
  if (ref) {
    const paths = machinePaths(io.env);
    const namespace = `${config.project.slug}.peek`;
    const generation = `${ref.claimedAt ?? launch?.launchedAt}/${ref.launchId ?? ""}`;
    const saved = paths ? await readWatchState(paths, namespace).catch(() => null) : null;
    const tail = saved?.peekTail?.[ref.handle];
    const cache = tail?.generation === generation ? tail : null;
    try {
      const exec = io.exec;
      // All supporting Herdr/git reads share the same upper bound as the transcript read.
      const runtimeIo: Io = exec
        ? {
            ...io,
            exec: (command, args, options) =>
              exec(command, args, {
                ...options,
                maxOutputBytes: Math.min(options.maxOutputBytes ?? 2_000_000, 2_000_000),
              }),
          }
        : io;
      const fresh = await runtimeFor(runtimeIo, config, name, secrets).peek(ref, {
        actions: 100,
        cursor: cache ? (saved?.peek?.[ref.handle] ?? null) : null,
      });
      const { actionResults, ...snapshot } = fresh;
      const combined = [...(cache?.actions ?? []), ...fresh.actions].slice(-100);
      for (const result of actionResults ?? []) {
        const action = combined.find((a) => a.id === result.id);
        if (action) action.exit = result.exit;
      }
      reading = {
        ...snapshot,
        detail: clean(fresh.detail),
        since:
          fresh.since ??
          (handle?.runtimeState?.state === fresh.state &&
          (fresh.sequence === undefined || handle.runtimeState.sequence === fresh.sequence)
            ? (handle.runtimeState.since ?? handle.runtimeState.at)
            : now.toISOString()),
        lastReply: fresh.lastReply ?? cache?.lastReply ?? null,
        actions: combined,
        truncated: fresh.truncated,
      };
      if (reading.lastReply) reading.lastReply = { ...reading.lastReply, text: clean(reading.lastReply.text, 600) };
      reading.actions = reading.actions.map((a) => ({ ...a, text: clean(a.text) }));
      observedAt = now.toISOString();
      // A pending launch has no claim generation to publish against yet.
      if (handle)
        try {
          const changed = await fleet.observeRuntime({
            ticket,
            handle: handle.handle,
            claimedAt: handle.claimedAt,
            state: reading.state,
            ...(reading.since ? { since: reading.since } : {}),
            ...(reading.sequence === undefined ? {} : { sequence: reading.sequence }),
          });
          if (!changed) warnings.push("claim changed; runtime observation was not published");
        } catch {
          warnings.push("runtime observation could not be published to Armada");
        }
      if (paths && reading.cursor)
        try {
          const peek = { ...saved?.peek };
          const peekTail = { ...saved?.peekTail };
          // Insertion order is the eviction order. Both maps are capped together.
          delete peek[ref.handle];
          delete peekTail[ref.handle];
          peek[ref.handle] = reading.cursor;
          peekTail[ref.handle] = {
            generation,
            lastReply: reading.lastReply,
            actions: reading.actions,
            truncated: reading.truncated,
          } satisfies PeekTail;
          const keys = Object.keys(peek).slice(-50);
          await updateWatchState(paths, namespace, {
            peek: Object.fromEntries(Object.entries(peek).filter(([k]) => keys.includes(k))),
            peekTail: Object.fromEntries(Object.entries(peekTail).filter(([k]) => keys.includes(k))),
          });
        } catch {
          warnings.push("transcript cursor could not be saved on this machine");
        }
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      unavailable =
        error.code === "unsupported" ? `unsupported: ${error.next}` : "runtime not reachable from this machine";
      if (cache)
        reading = {
          ...reading,
          lastReply: cache.lastReply,
          actions: cache.actions.slice(-100),
          cursor: saved?.peek?.[ref.handle] ?? null,
          truncated: cache.truncated,
        };
      if (reading.lastReply) reading.lastReply = { ...reading.lastReply, text: clean(reading.lastReply.text, 600) };
      reading.actions = reading.actions.map((a) => ({ ...a, text: clean(a.text) }));
    }
  }
  const report = events[ticket] ?? null;
  let pull: PeekResult["pull"] = null;
  const match = report?.prUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/);
  if (match?.[1]?.toLowerCase() === config.github.repository.toLowerCase() && match[2]) {
    if (!credentials.githubToken) warnings.push("checks not read: no GitHub token");
    else
      try {
        const pr = await fetchPullRequest({
          token: credentials.githubToken,
          repository: config.github.repository,
          number: Number(match[2]),
          ...httpOptions(io),
        });
        if (pr)
          pull = {
            number: pr.number,
            url: pr.url,
            headSha: pr.headSha ?? "unknown",
            counts: {
              passed: (pr.checks ?? []).filter((c) => c.state === "success").length,
              running: (pr.checks ?? []).filter((c) => c.state === "pending").length,
              failed: (pr.checks ?? []).filter((c) => c.state === "failure").length,
            },
            failing: (pr.checks ?? []).filter((c) => c.state === "failure").map((c) => clean(c.name)),
            running: (pr.checks ?? []).filter((c) => c.state === "pending").map((c) => clean(c.name)),
            complete: pr.checksComplete ?? false,
          };
        else warnings.push("checks not read: pull request not found");
      } catch {
        warnings.push("checks not read: GitHub unavailable");
      }
  }
  const profile = handle?.profile ?? null;
  const p = profile ? config.conductor.profiles[profile] : null;
  const result: PeekResult = {
    ticket,
    claimedAt: handle?.claimedAt ?? null,
    launchedAt: launch?.launchedAt ?? null,
    heartbeatAt: handle?.lastHeartbeatAt ?? null,
    profile: p ? `${profile} (${p.agent}, ${p.model}, ${p.effort})` : profile,
    report: report ? { ...report, message: report.message ? clean(report.message) : null } : null,
    runtime: {
      ...reading,
      actions: actions ? reading.actions.slice(-actions) : [],
      name,
      handle: ref?.handle ?? null,
      observedAt,
      unavailable,
    },
    pull,
    inbox: inbox.map((item) => ({ ...item, body: clean(item.body) })),
    warnings,
  };
  io.stdout(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderPeek(result, io, now));
  return 0;
}

export function renderPeek(result: PeekResult, io: Io, now: Date): string {
  const age = (at: string | null) => {
    if (!at || !Number.isFinite(Date.parse(at))) return "unknown";
    const min = Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 60_000));
    return min < 1
      ? "just now"
      : min < 60
        ? `${min} min ago`
        : min < 1440
          ? `${Math.floor(min / 60)} hr ago`
          : `${Math.floor(min / 1440)} days ago`;
  };
  const formatter = new Intl.DateTimeFormat(undefined, {
    timeZone: io.env.TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  const time = (at: string | null) =>
    at && Number.isFinite(Date.parse(at)) ? `${formatter.format(new Date(at))} (${age(at)})` : "unknown";
  const r = result.runtime;
  const lines = [
    `${result.ticket} · ${result.report?.phase ?? "not claimed"} · ${result.report?.kind ?? "reported"} ${time(result.report?.at ?? null)}`,
    `Runtime    ${r.name} · ${r.state === "gone" ? "archived" : r.state} since ${time(r.since)}${r.unavailable ? ` · ${r.unavailable} · observed ${time(r.observedAt)}` : ""}`,
    ...(r.handle ? [`Session    ${r.handle}${r.link ? ` · ${r.link}` : ""}`] : []),
    `Alive      heartbeat ${age(result.heartbeatAt)} · ${result.claimedAt ? `claimed ${time(result.claimedAt)}` : `launched ${time(result.launchedAt)}`}${result.profile ? ` · profile ${result.profile}` : ""}`,
    `Report     ${result.report?.message ?? "none"}`,
    `Last reply ${r.lastReply ? `${time(r.lastReply.at)}  ${r.lastReply.text}` : "none"}`,
    ...r.actions.map(
      (a, index) =>
        `${index === 0 ? "Actions   " : "          "} ${time(a.at)}  ${a.exit == null ? "exit …" : `exit ${a.exit}`}  ${a.text}`,
    ),
    ...(result.pull
      ? [
          `Pull       #${result.pull.number} · ${result.pull.counts.passed} passed, ${result.pull.counts.running} running${result.pull.running.length ? ` (${result.pull.running.join(", ")})` : ""}, ${result.pull.counts.failed} failed${result.pull.failing.length ? ` (${result.pull.failing.join(", ")})` : ""} · head ${result.pull.headSha.slice(0, 7)}${result.pull.complete ? "" : " · partial checks"}`,
        ]
      : []),
    ...(result.inbox.length
      ? result.inbox.map(
          (item) => `Inbox      ${item.kind} #${item.id} open since ${time(item.createdAt)} · ${item.body}`,
        )
      : ["Inbox      nothing open"]),
    ...(r.detail.includes("unknown agent format") ? ["Runtime    unknown agent format"] : []),
    ...(r.truncated ? ["Transcript older events skipped (bounded read)"] : []),
    ...result.warnings,
  ];
  const width = Math.max(20, io.terminalWidth ?? 80);
  return `${lines.map((line) => clipped(plain(line), width)).join("\n")}\n`;
}
