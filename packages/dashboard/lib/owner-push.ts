// Owner chat alerts (THE-1097). Snapshot-only reads, durable keys and atomic
// delivery claims across instances. Traffic triggers are throttled per project.
import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { buildDigest, type Digest, type OwnerItem, ownerItems, renderDigest } from "@armada/core/read";
import { type Database, iso, isoAt, type Queryable, type Row, transaction } from "./db";
import { digestRecords } from "./digest";
import { DEFAULT_DIGEST, type DigestSchedule, digestSchedule, digestSlots } from "./digest-slots";
import { loadOverview, newCache, type Sources } from "./fleet-data";
import { liveStore } from "./fleet-store";
import { STRINGS } from "./i18n";
import { inQuietHours, notificationTitle, notifyOf } from "./notify";
import {
  type Actor,
  eraseOwnerWebhook,
  type OwnerWebhook,
  readOwnerWebhook,
  type VaultKey,
  writeOwnerWebhook,
} from "./vault";

export interface OwnerChannel {
  id: number;
  organization: string;
  project: string | null;
  format: "slack" | "json";
  alerts: boolean;
  digest: DigestSchedule;
  timeZone: string;
  language: "en" | "fr";
  quiet: { from: string; to: string } | null;
  failures: number;
  pausedReason: string | null;
  createdBy: string;
  createdAt: string;
  last: { at: string; sentAt: string | null; error: string | null; attempts: number } | null;
}

const channelOf = (r: Row): OwnerChannel => ({
  id: Number(r.id),
  organization: String(r.organization),
  project: r.project === null ? null : String(r.project),
  format: r.format as OwnerChannel["format"],
  alerts: Boolean(r.alerts),
  digest: digestSchedule(r.digest) ?? DEFAULT_DIGEST,
  timeZone: String(r.time_zone),
  language: r.language as OwnerChannel["language"],
  quiet: r.quiet as OwnerChannel["quiet"],
  failures: Number(r.failures),
  pausedReason: r.paused_reason === null ? null : String(r.paused_reason),
  createdBy: String(r.created_by),
  createdAt: isoAt(r.created_at),
  last: r.last_at
    ? {
        at: isoAt(r.last_at),
        sentAt: iso(r.last_sent_at),
        error: r.last_error === null ? null : String(r.last_error),
        attempts: Number(r.last_attempts),
      }
    : null,
});

/** Safe settings metadata only. The secret is never selected here. */
export async function listOwnerChannels(db: Database, organization: string): Promise<OwnerChannel[]> {
  const rs = await db.query(
    `SELECT c.*, COALESCE(p.updated_at, p.created_at) AS last_at, p.sent_at AS last_sent_at,
    p.error AS last_error, p.attempts AS last_attempts FROM owner_channels c
    LEFT JOIN LATERAL (SELECT created_at, updated_at, sent_at, error, attempts FROM owner_pushes
      WHERE channel = c.id ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT 1) p ON true
    WHERE c.organization = $1 ORDER BY c.id`,
    [organization],
  );
  return rs.rows.map(channelOf);
}

/** Only public HTTPS targets, without userinfo. Error messages never quote the address. */
export function webhookUrl(value: string): URL {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      value.length > 8192 ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443") ||
      !host.includes(".") ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      (isIP(host) && !publicAddress(host))
    )
      throw new Error();
    return url;
  } catch {
    throw new Error("invalid webhook address");
  }
}

// Conservative public-address test. IPv6 targets must be global unicast;
// mapped IPv4, loopback, link-local and unique-local are refused too.
export function publicAddress(ip: string): boolean {
  if (isIP(ip) === 6) return /^[23][0-9a-f]{3}:/i.test(ip) && !/^2001:(?:0:|db8:)/i.test(ip);
  if (isIP(ip) !== 4) return false;
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Production transport pins a public DNS answer; no redirects, no response bodies or provider errors escape. */
export const safeWebhookFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async (
  input,
  init,
) => {
  const url = webhookUrl(String(input));
  const signal = init?.signal;
  const work = (async () => {
    const addresses = await lookup(url.hostname, { all: true });
    const address = addresses[0];
    if (!address || addresses.some((a) => !publicAddress(a.address))) throw new Error("webhook unavailable");
    signal?.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: "POST",
          headers: init?.headers as Record<string, string>,
          signal: signal ?? undefined,
          // Keep the original hostname for TLS and Host, but connect to the checked IP.
          lookup: (_hostname, options, callback) =>
            options.all ? callback(null, [address]) : callback(null, address.address, address.family),
        },
        (response) => {
          response.resume();
          try {
            resolve(new Response(null, { status: response.statusCode ?? 502 }));
          } catch {
            reject(new Error("webhook unavailable"));
          }
        },
      );
      req.on("error", () => reject(new Error("webhook unavailable")));
      req.end(String(init?.body ?? ""));
    });
  })();
  if (!signal) return work;
  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(new Error("webhook unavailable"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
};

export async function saveOwnerChannel(
  db: Database,
  input: {
    organization: string;
    project: string | null;
    format: "slack" | "json";
    alerts: boolean;
    digest?: DigestSchedule;
    timeZone: string;
    language: "en" | "fr";
    quiet: OwnerChannel["quiet"];
    url: string;
    signingSecret: string;
    actor: Actor;
    now: Date;
    vault: VaultKey;
  },
): Promise<void> {
  if (
    !["slack", "json"].includes(input.format) ||
    !["en", "fr"].includes(input.language) ||
    !notifyOf({ on: input.alerts, quiet: input.quiet }) ||
    input.signingSecret.length > 4096
  )
    throw new Error("invalid channel settings");
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format(input.now);
  } catch {
    throw new Error("invalid channel settings");
  }
  const schedule = digestSchedule(input.digest ?? DEFAULT_DIGEST);
  if (!schedule) throw new Error("invalid digest settings");
  await transaction(db, async (tx) => {
    // Lock the organization, including the first save: settings and credentials change together.
    const org = await tx.query(`SELECT "id" FROM "organization" WHERE "id" = $1 FOR UPDATE`, [input.organization]);
    if (!org.rows.length) throw new Error("invalid organization");
    if (input.project) {
      const p = await tx.query(`SELECT slug FROM projects WHERE slug = $1 AND organization_id = $2`, [
        input.project,
        input.organization,
      ]);
      if (!p.rows.length) throw new Error("invalid project");
    }
    const old = await readOwnerWebhook(tx, input.vault, input.organization).catch(() => null);
    const value: OwnerWebhook = {
      url: input.url || old?.url || "",
      signingSecret: input.signingSecret || old?.signingSecret || "",
    };
    webhookUrl(value.url);
    if (input.format === "json" && value.signingSecret.length < 16) throw new Error("invalid signing secret");
    await tx.query(
      `INSERT INTO owner_channels (organization, project, format, alerts, time_zone, language, quiet, created_by, created_at, digest, digest_checked_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9) ON CONFLICT (organization) DO UPDATE SET
      project = excluded.project, format = excluded.format, alerts = excluded.alerts,
      time_zone = excluded.time_zone, language = excluded.language, quiet = excluded.quiet,
      created_by = excluded.created_by, created_at = excluded.created_at, failures = 0, paused_reason = NULL,
      generation = owner_channels.generation + 1, digest = excluded.digest, digest_checked_at = excluded.digest_checked_at`,
      [
        input.organization,
        input.project || null,
        input.format,
        input.alerts,
        input.timeZone,
        input.language,
        input.quiet ? JSON.stringify(input.quiet) : null,
        input.actor.label,
        input.now,
        JSON.stringify(schedule),
      ],
    );
    await writeOwnerWebhook(tx, input.vault, input.organization, value, input.actor, input.now);
  });
}

export async function removeOwnerChannel(
  db: Database,
  input: { organization: string; actor: Actor; now: Date },
): Promise<void> {
  await transaction(db, async (tx) => {
    await tx.query(`SELECT "id" FROM "organization" WHERE "id" = $1 FOR UPDATE`, [input.organization]);
    await tx.query(`DELETE FROM owner_channels WHERE organization = $1`, [input.organization]);
    await eraseOwnerWebhook(tx, input.organization, input.actor, input.now);
  });
}

export interface OwnerPayload {
  schema: 1;
  kind: "alert" | "digest";
  organization: string;
  items: { key: string; kind: OwnerItem["kind"]; project: string; ticket: string | null; title: string; url: string }[];
  text: string;
  project?: string | null;
}

function payloadOf(channel: OwnerChannel, item: OwnerItem, baseUrl: string): OwnerPayload {
  const url = new URL(item.href, baseUrl).href;
  // Escape mrkdwn controls so a ticket title cannot tag a channel or forge a link.
  const title = notificationTitle(STRINGS[channel.language], item)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n]/g, " ");
  return {
    schema: 1,
    kind: "alert",
    organization: channel.organization,
    items: [{ key: item.key, kind: item.kind, project: item.project, ticket: item.ticket, title: item.title, url }],
    text: `${title}\n${url}`,
  };
}

function quietAt(channel: OwnerChannel, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: channel.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  // inQuietHours reads local hours; only those two fields matter here.
  const local = new Date(
    2000,
    0,
    1,
    Number(parts.find((p) => p.type === "hour")?.value),
    Number(parts.find((p) => p.type === "minute")?.value),
  );
  return inQuietHours(channel.quiet, local);
}

interface TickOptions {
  organization: string;
  /** Live server clock; a fixed Date is convenient for deterministic callers/tests. */
  now: Date | (() => Date);
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  vault: VaultKey;
  baseUrl: string;
}

const tickNow = (opts: TickOptions): Date => (typeof opts.now === "function" ? opts.now() : opts.now);

/** Load only the stored snapshots and live rows. No tracker/forge reads, even for marked or missing snapshots. */
async function snapshotOverview(db: Database, organization: string, now: Date) {
  const sources: Sources = {
    live: async () => liveStore(db),
    database: async () => db,
    fallbackProjects: () => [],
    readConfig: async () => {
      throw new Error("owner tick cannot refresh");
    },
    readSnapshot: async () => {
      throw new Error("owner tick cannot refresh");
    },
  };
  return loadOverview(
    { sources, cache: newCache(), now: () => now, snapshotMs: 60_000, refresh: false },
    { organization, home: null },
  );
}

async function post(
  channel: OwnerChannel,
  payload: OwnerPayload,
  credential: OwnerWebhook | null,
  opts: TickOptions,
): Promise<string | null> {
  if (!credential) return "credentials";
  try {
    webhookUrl(credential.url);
    const body = JSON.stringify(channel.format === "slack" ? { text: payload.text } : payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (channel.format === "json") {
      if (credential.signingSecret.length < 16) return "credentials";
      headers["x-armada-signature"] =
        `sha256=${createHmac("sha256", credential.signingSecret).update(body).digest("hex")}`;
    }
    const response = await opts.fetch(credential.url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? null : `http-${response.status}`;
  } catch {
    return "unavailable";
  }
}

async function deliver(
  db: Database,
  channel: OwnerChannel,
  opts: TickOptions,
  manualKey: string | null = null,
): Promise<void> {
  const credential = await readOwnerWebhook(db, opts.vault, opts.organization).catch(() => null);
  // Bound each callback. Further items remain in the durable queue for the next pulse.
  for (let n = 0; n < 20; n++) {
    const at = tickNow(opts);
    if (!manualKey && quietAt(channel, at)) return;
    const claim = randomUUID();
    const rs = await db.query(
      `UPDATE owner_pushes SET claim = $2, claimed_until = $3, attempts = attempts + 1, updated_at = $4
      WHERE (channel, key) = (SELECT p.channel, p.key FROM owner_pushes p JOIN owner_channels c ON c.id = p.channel
        WHERE p.channel = $1 AND p.sent_at IS NULL AND p.attempts < 5
          AND (p.claimed_until IS NULL OR p.claimed_until <= $4)
          AND c.organization = $5 AND c.generation = $6 AND c.paused_reason IS NULL
          AND (c.alerts OR p.payload->>'kind' = 'digest')
          AND ($7::text IS NULL OR p.key = $7)
          AND (c.project IS NULL OR (p.payload->>'kind' = 'digest' AND p.payload->>'project' = c.project) OR p.payload->'items'->0->>'project' = c.project OR p.key LIKE 'test:%')
        ORDER BY p.created_at, p.key LIMIT 1 FOR UPDATE OF p SKIP LOCKED)
      RETURNING key, payload`,
      [
        channel.id,
        claim,
        new Date(at.getTime() + 60_000),
        at,
        opts.organization,
        channelGeneration.get(channel),
        manualKey,
      ],
    );
    const row = rs.rows[0];
    if (!row) return;
    const error = await post(channel, row.payload as OwnerPayload, credential, opts);
    await transaction(db, async (tx) => {
      // A settings edit during the request must not let an old failure pause the replacement.
      const c = await tx.query(`SELECT generation FROM owner_channels WHERE id = $1 FOR UPDATE`, [channel.id]);
      if (!c.rows.length) return;
      const saved = await tx.query(
        `UPDATE owner_pushes SET sent_at = $4, error = $3, claim = NULL
        WHERE channel = $1 AND key = $2 AND claim = $5`,
        [channel.id, row.key, error, error ? null : tickNow(opts), claim],
      );
      if (!saved.rowCount || Number(c.rows[0]?.generation) !== channelGeneration.get(channel)) return;
      await tx.query(
        `UPDATE owner_channels SET failures = CASE WHEN $2::text IS NULL THEN 0 ELSE failures + 1 END,
        paused_reason = CASE WHEN $2 IN ('http-404','http-410') THEN $2
          WHEN $2::text IS NOT NULL AND failures + 1 >= 10 THEN 'failures' ELSE paused_reason END
        WHERE id = $1`,
        [channel.id, error],
      );
    });
  }
}

// Metadata objects keep the version privately; it never needs to enter a page/API answer.
const channelGeneration = new WeakMap<OwnerChannel, number>();

async function channelDigest(db: Queryable, channel: OwnerChannel, since: string, now: Date): Promise<Digest> {
  const projects = await db.query(
    `SELECT slug FROM projects WHERE organization_id = $1 AND ($2::text IS NULL OR slug = $2) ORDER BY slug`,
    [channel.organization, channel.project],
  );
  const digests: Digest[] = [];
  for (const p of projects.rows) digests.push(buildDigest((await digestRecords(db, String(p.slug), since, now)).input));
  const empty = buildDigest({
    since,
    until: now.toISOString(),
    now,
    summary: { since, merged: [], started: [], stuck: [], waiting: [], quiet: true },
    inFlight: [],
    phaseMedians: {},
  });
  const all = empty;
  all.titles = {};
  all.ownerItems = [];
  all.extras = { mainRed: [], deploys: [], jobs: [] };
  for (const d of digests) {
    all.quiet = all.quiet && d.quiet;
    Object.assign(all.titles, d.titles);
    all.inFlight.push(...d.inFlight);
    all.ownerItems.push(...(d.ownerItems ?? []));
    all.extras.mainRed?.push(...(d.extras?.mainRed ?? []));
    all.extras.deploys?.push(...(d.extras?.deploys ?? []));
    all.extras.jobs?.push(...(d.extras?.jobs ?? []));
    all.summary.quiet = all.summary.quiet && d.summary.quiet;
    all.summary.merged.push(...d.summary.merged);
    all.summary.started.push(...d.summary.started);
    all.summary.stuck.push(...d.summary.stuck);
    all.summary.waiting.push(...d.summary.waiting);
  }
  return all;
}

/** Slot creation and window advancement share the channel lock; delivery happens after commit. */
async function queueScheduledDigest(db: Database, channel: OwnerChannel, at: Date, baseUrl: string) {
  await transaction(db, async (tx) => {
    const rs = await tx.query(`SELECT * FROM owner_channels WHERE id = $1 FOR UPDATE`, [channel.id]);
    const row = rs.rows[0];
    if (!row || row.paused_reason || Number(row.generation) !== channelGeneration.get(channel)) return;
    const current = channelOf(row);
    const checked = new Date(isoAt(row.digest_checked_at ?? row.created_at));
    if (checked > at) return;
    const slots = digestSlots(current.digest, current.timeZone, checked, at);
    const previous = await tx.query(
      `SELECT created_at FROM owner_pushes WHERE channel = $1
      AND (key LIKE 'digest:%' OR (key LIKE 'digest-manual:%' AND payload->>'project' = $2))
      AND error IS DISTINCT FROM 'skipped'
      ORDER BY created_at DESC LIMIT 1`,
      [channel.id, current.project],
    );
    let since = isoAt(previous.rows[0]?.created_at ?? row.created_at);
    // A suppressed quiet window advances activity, but only a visible scheduled digest consumes notices.
    const noticed = await tx.query(
      `SELECT created_at FROM owner_pushes WHERE channel = $1
      AND key LIKE 'digest:%' AND error IS DISTINCT FROM 'skipped' AND error IS DISTINCT FROM 'quiet-digest'
      ORDER BY created_at DESC LIMIT 1`,
      [channel.id],
    );
    let noticedAt = noticed.rows[0]?.created_at ?? null;
    for (const slot of slots) {
      if (at.getTime() - slot.at.getTime() > 30 * 60_000) {
        await tx.query(
          `INSERT INTO owner_pushes (channel,key,created_at,sent_at,error,payload)
          VALUES ($1,$2,$3,$3,'skipped',$4) ON CONFLICT DO NOTHING`,
          [
            channel.id,
            slot.key,
            at,
            JSON.stringify({ schema: 1, kind: "digest", organization: channel.organization, items: [], text: "" }),
          ],
        );
        continue;
      }
      const exists = await tx.query(`SELECT key FROM owner_pushes WHERE channel = $1 AND key = $2`, [
        channel.id,
        slot.key,
      ]);
      if (exists.rows.length) continue;
      const digest = await channelDigest(tx, current, since, at);
      const missed = await tx.query(
        `SELECT key FROM owner_pushes WHERE channel = $1 AND error = 'skipped'
          AND ($2::timestamptz IS NULL OR created_at > $2) ORDER BY key`,
        [channel.id, noticedAt],
      );
      digest.skipped = missed.rows.map((r) => String(r.key).slice("digest:".length));
      const payload: OwnerPayload = {
        schema: 1,
        kind: "digest",
        organization: channel.organization,
        project: current.project,
        items: [],
        text: renderDigest(digest, {
          language: current.language,
          format: current.format === "slack" ? "slack" : "plain",
          appUrl: baseUrl,
        }),
      };
      const skip = current.digest.skipQuiet && digest.quiet;
      await tx.query(
        `INSERT INTO owner_pushes (channel,key,created_at,sent_at,error,payload)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [channel.id, slot.key, at, skip ? at : null, skip ? "quiet-digest" : null, JSON.stringify(payload)],
      );
      since = at.toISOString();
      if (!skip) noticedAt = at;
    }
    await tx.query(`UPDATE owner_channels SET digest_checked_at = $2 WHERE id = $1`, [channel.id, at]);
  });
}

/** On-demand sends use the same queue and renderer. Only safe status returns to the terminal. */
export async function sendOwnerDigest(
  db: Database,
  opts: TickOptions,
  project: string,
  digest: Digest,
  language: "en" | "fr",
): Promise<boolean> {
  const rows = await db.query(
    `SELECT c.* FROM owner_channels c JOIN projects p ON p.organization_id = c.organization
    WHERE c.organization = $1 AND p.slug = $2 AND (c.project IS NULL OR c.project = $2) AND c.paused_reason IS NULL`,
    [opts.organization, project],
  );
  const row = rows.rows[0];
  if (!row) return false;
  const channel = channelOf(row);
  channelGeneration.set(channel, Number(row.generation));
  const key = `digest-manual:${randomUUID()}`;
  const at = tickNow(opts);
  const payload: OwnerPayload = {
    schema: 1,
    kind: "digest",
    organization: opts.organization,
    project,
    items: [],
    text: renderDigest(digest, {
      language,
      format: channel.format === "slack" ? "slack" : "plain",
      appUrl: opts.baseUrl,
    }),
  };
  await transaction(db, async (tx) => {
    const locked = await tx.query(`SELECT generation FROM owner_channels WHERE id = $1 FOR UPDATE`, [channel.id]);
    if (Number(locked.rows[0]?.generation) !== channelGeneration.get(channel)) return;
    await tx.query(`INSERT INTO owner_pushes (channel,key,created_at,payload) VALUES ($1,$2,$3,$4)`, [
      channel.id,
      key,
      at,
      JSON.stringify(payload),
    ]);
  });
  await deliver(db, channel, opts, key);
  const sent = await db.query(`SELECT sent_at FROM owner_pushes WHERE channel = $1 AND key = $2`, [channel.id, key]);
  return !!sent.rows[0]?.sent_at;
}

/** Safe to call concurrently. Initial keys and retry attempts are both claimed in Postgres. */
export async function ownerTick(db: Database, opts: TickOptions): Promise<void> {
  const rs = await db.query(
    `SELECT * FROM owner_channels WHERE organization = $1 AND (alerts OR jsonb_array_length(digest->'times') > 0) AND paused_reason IS NULL`,
    [opts.organization],
  );
  if (!rs.rows.length) return;
  const at = tickNow(opts);
  const overview = await snapshotOverview(db, opts.organization, at);
  if (overview.live.state !== "ok") return;
  const items = ownerItems(overview);
  for (const row of rs.rows) {
    const channel = channelOf(row);
    channelGeneration.set(channel, Number(row.generation));
    const quiet = quietAt(channel, at);
    await queueScheduledDigest(db, channel, at, opts.baseUrl);
    for (const item of channel.alerts ? items : []) {
      if (channel.project && item.project !== channel.project) continue;
      await db.query(
        `INSERT INTO owner_pushes (channel, key, created_at, sent_at, error, payload)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING key`,
        [
          channel.id,
          item.key,
          at,
          quiet ? at : null,
          quiet ? "quiet" : null,
          JSON.stringify(payloadOf(channel, item, opts.baseUrl)),
        ],
      );
    }
    if (!quiet) await deliver(db, channel, opts);
  }
}

/** Fleet traffic pulse, never a source refresh; lease is scoped to the operation's project. */
export async function ownerPulse(db: Database, opts: TickOptions & { project: string }): Promise<void> {
  const at = tickNow(opts);
  const rs = await db.query(
    `INSERT INTO leases (project, name, holder, acquired_at, expires_at)
    SELECT slug, 'owner-tick', $3, $4, $5 FROM projects WHERE slug = $1 AND organization_id = $2
    ON CONFLICT (project, name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at WHERE leases.expires_at <= $4 RETURNING project`,
    [opts.project, opts.organization, randomUUID(), at, new Date(at.getTime() + 60_000)],
  );
  if (rs.rows.length) await ownerTick(db, opts);
}

export async function sendOwnerTest(db: Database, opts: TickOptions): Promise<boolean> {
  const channels = await listOwnerChannels(db, opts.organization);
  const channel = channels[0];
  if (!channel) return false;
  const rs = await db.query(`SELECT generation FROM owner_channels WHERE id = $1`, [channel.id]);
  channelGeneration.set(channel, Number(rs.rows[0]?.generation));
  const payload: OwnerPayload = {
    schema: 1,
    kind: "alert",
    organization: opts.organization,
    items: [],
    text: `${channel.language === "fr" ? "Armada : le canal reçoit vos alertes." : "Armada: this channel receives your alerts."}\n${new URL("/", opts.baseUrl).href}`,
  };
  const at = tickNow(opts);
  const key = `test:${randomUUID()}`;
  const claim = randomUUID();
  await db.query(
    `INSERT INTO owner_pushes (channel,key,created_at,payload,attempts,claim,claimed_until,updated_at) VALUES ($1,$2,$3,$4,1,$5,$6,$3)`,
    [channel.id, key, at, JSON.stringify(payload), claim, new Date(at.getTime() + 60_000)],
  );
  // Test uses the same queue, retry/pause and timeout rules, even if automatic alerts are off.
  const credential = await readOwnerWebhook(db, opts.vault, opts.organization).catch(() => null);
  const error = await post(channel, payload, credential, opts);
  await transaction(db, async (tx) => {
    await tx.query(`SELECT id FROM owner_channels WHERE id = $1 FOR UPDATE`, [channel.id]);
    await tx.query(
      `UPDATE owner_pushes SET claim = NULL, sent_at = $3, error = $4,
      claimed_until = $5 WHERE channel = $1 AND key = $2`,
      [channel.id, key, error ? null : tickNow(opts), error, new Date(tickNow(opts).getTime() + 60_000)],
    );
    await tx.query(
      `UPDATE owner_channels SET failures = CASE WHEN $2::text IS NULL THEN 0 ELSE failures + 1 END,
      paused_reason = CASE WHEN $2 IN ('http-404','http-410') THEN $2
        WHEN $2::text IS NOT NULL AND failures + 1 >= 10 THEN 'failures' ELSE paused_reason END
      WHERE id = $1 AND generation = $3`,
      [channel.id, error, channelGeneration.get(channel)],
    );
  });
  return !error;
}
