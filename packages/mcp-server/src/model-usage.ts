import type { AgentEvent, Provider, Sql } from "@armada/core";
import { VaultError } from "@armada/core";
import type { Caller } from "./caller.ts";
import { codexReading } from "./model-usage-codex.ts";

/** These native records belong to the credential owner, not the sandbox audience. */
export function isPrivateModelEvent(event: AgentEvent): boolean {
  if (event.kind === "other" && event.type === "system" && object(event.data).subtype === "local_command_output")
    return true;
  return (
    event.kind === "other" &&
    [
      "usage_report",
      "rate_limit_event",
      "account/rateLimits/updated",
      "account/rateLimits/read",
      "account/updated",
      "auth_status",
    ].includes(event.type)
  );
}

export interface Window {
  sourceId?: string | null;
  observedAt?: string;
  windowDurationMins?: number;
  id: string;
  label: string;
  kind: string;
  usedPercent: number | null;
  resetsAt: string | null;
  group?: string;
  severity?: string;
  active?: boolean;
  model?: string;
  surface?: string;
}
export interface NativeCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}
export interface UsageBucket {
  sourceId: string | null;
  label: string;
  windows: Window[];
  credits?: NativeCredits;
  creditsObservedAt?: string;
}
export interface ModelUsage {
  credits?: NativeCredits;
  creditsObservedAt?: string;
  creditsSourceId?: string | null;
  compatibilitySourceId?: string | null;
  buckets?: UsageBucket[];
  compatibility?: UsageBucket;
  accountId: string;
  version: number;
  status: "fresh" | "stale" | "unavailable" | "error";
  observedAt: string | null;
  windows: Window[];
  extraUsage?: {
    enabled: boolean;
    currency: string | null;
    usedMinor: number | null;
    limitMinor: number | null;
    /** Additive #618 fields in major units; raw source minor units remain canonical. */
    used: number | null;
    limit: number | null;
  };
}
const object = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const finite = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
const percent = (x: unknown): number | null => {
  const n = finite(x);
  return n !== null && n <= 100 ? n : null;
};
const instant = (x: unknown): string | null => {
  const n = typeof x === "number" ? x * 1000 : typeof x === "string" ? Date.parse(x) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= 8.64e15 ? new Date(n).toISOString() : null;
};

/** Allowlisted metadata only: never return the native envelope or auth state. */
function majorUnits(value: number | null, currency: unknown): number | null {
  if (value === null || typeof currency !== "string") return null;
  const code = currency.toUpperCase();
  try {
    if (!Intl.supportedValuesOf("currency").includes(code)) return null;
    const digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
      .maximumFractionDigits;
    return value / 10 ** (digits ?? 2);
  } catch {
    return null;
  }
}
function reading(
  event: AgentEvent,
  previous: ModelUsage,
):
  | (Pick<
      ModelUsage,
      | "windows"
      | "extraUsage"
      | "credits"
      | "creditsObservedAt"
      | "creditsSourceId"
      | "compatibilitySourceId"
      | "buckets"
      | "compatibility"
    > & { unavailable?: boolean })
  | null {
  if (event.kind !== "other") return null;
  const data = object(event.data);
  if (event.type === "usage_report") {
    const limits = object(data.rate_limits);
    const extra = object(limits.extra_usage);
    return {
      ...(!Array.isArray(limits.limits) ? { unavailable: true } : {}),
      windows: (Array.isArray(limits.limits) ? limits.limits : []).slice(0, 64).map((raw, index) => {
        const row = object(raw);
        const scope = object(row.scope),
          model = object(scope.model),
          surface = object(scope.surface);
        const kind = typeof row.kind === "string" && row.kind ? row.kind.slice(0, 80) : "unknown";
        const scopedLabel =
          typeof model.display_name === "string"
            ? model.display_name
            : typeof surface.display_name === "string"
              ? surface.display_name
              : "";
        return {
          id: `${kind.slice(0, 40)}-${index}`,
          label:
            `${typeof row.group === "string" && row.group ? row.group : kind}${scopedLabel ? ` · ${scopedLabel}` : ""}`.slice(
              0,
              60,
            ),
          ...(typeof row.group === "string" ? { group: row.group.slice(0, 80) } : {}),
          ...(typeof row.severity === "string" ? { severity: row.severity.slice(0, 80) } : {}),
          ...(typeof row.is_active === "boolean" ? { active: row.is_active } : {}),
          ...(typeof model.display_name === "string" ? { model: model.display_name.slice(0, 120) } : {}),
          ...(typeof surface.display_name === "string" ? { surface: surface.display_name.slice(0, 120) } : {}),
          kind: typeof row.kind === "string" ? row.kind.slice(0, 80) : "unknown",
          usedPercent: percent(row.percent),
          resetsAt: instant(row.resets_at),
        };
      }),
      ...(typeof extra.is_enabled === "boolean"
        ? {
            extraUsage: {
              enabled: extra.is_enabled,
              currency:
                typeof extra.currency === "string" && /^[A-Za-z]{3}$/.test(extra.currency)
                  ? extra.currency.toUpperCase()
                  : null,
              usedMinor: finite(extra.used_credits),
              limitMinor: finite(extra.monthly_limit),
              used: majorUnits(finite(extra.used_credits), extra.currency),
              limit: majorUnits(finite(extra.monthly_limit), extra.currency),
            },
          }
        : {}),
    };
  }
  // Header rate_limit_event remains private diagnostic data, not a profile
  // quota refresh: model-only setup tokens cannot read profile allowance.
  if (event.type === "account/rateLimits/updated" || event.type === "account/rateLimits/read")
    return codexReading(data, new Date(event.at).toISOString(), event.type === "account/rateLimits/updated", previous);
  return null;
}

export interface ModelUsageApi {
  read(
    caller: Caller,
    id: string,
    sandboxId: string | undefined,
    resolve: (sandboxId: string) => Promise<{ provider: Provider; providerSandboxId: string }>,
  ): Promise<ModelUsage>;
}

/** Race a read against a deadline and ignore late completion without publishing cache data. */
function withinBudget<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(Error("usage_read_deadline"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(Error("usage_read_deadline"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw Error("usage_read_deadline");
        return work();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) abort();
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}

/** Passive, bounded, incremental reads. Authorization is repeated even on cache hits. */
export function createModelUsageApi(
  sql: Sql,
  now: () => Date = () => new Date(),
  readSignal: () => AbortSignal = () => AbortSignal.timeout(5000),
): ModelUsageApi {
  const cache = new Map<string, { cursor?: string | undefined; checked: number; value: ModelUsage }>();
  const inFlight = new Map<string, Promise<ModelUsage>>();
  return {
    async read(caller, requestedId, sandboxId, resolve) {
      const id = requestedId.toLowerCase();
      const budget = readSignal();
      const queryAuthorization = () =>
        sql.query<{ version: number; sandbox_id: string | null; mixed: boolean }>(
          `select c.version,visible.id as sandbox_id,coalesce(visible.mixed,false) as mixed from public.credentials c
           left join lateral (
             select s.id,exists(select 1 from public.sandbox_model_credentials material where material.sandbox_id=s.id and material.quota_history_mixed) as mixed from public.sandboxes s join public.goldens g on g.id=s.golden_id
             where s.credential_id=c.id and s.credential_version=c.version and s.deleted_at is null
             and not exists(select 1 from public.orchestrators o where o.sandbox_id=s.id)
             and s.org_id=g.org_id
             and ($2::uuid is null or s.id=$2::uuid)
             and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$3::uuid)
             and s.org_id=any($4::uuid[])
             and (s.owner_id=$3::uuid or exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$3::uuid and m.role='admin'))
             order by s.created_at desc,s.id limit 1
           ) visible on true
           where c.id=$1::uuid and c.status='active'
           and ((c.scope='user' and c.owner_id=$3::uuid) or
                (c.scope='org' and c.owner_id=any($4::uuid[]) and
                 exists(select 1 from public.members m where m.org_id=c.owner_id and m.user_id=$3::uuid)))`,
          [id, sandboxId ?? null, caller.userId, caller.orgs.map((org) => org.orgId)],
        );
      const authorize = () => withinBudget(budget, queryAuthorization);
      const permitted = await authorize();
      const version = permitted.rows[0]?.version;
      if (version === undefined) throw new VaultError("not_found", "No authorized pinned account.");
      const boundSandbox = permitted.rows[0]?.sandbox_id;
      if (!boundSandbox) {
        if (sandboxId) throw new VaultError("not_found", "No authorized pinned sandbox.");
        return { accountId: id, version, status: "unavailable", observedAt: null, windows: [] };
      }
      // Older native quota envelopes do not identify the account revision. Never relabel their retained history.
      if (permitted.rows[0]?.mixed)
        return { accountId: id, version, status: "unavailable", observedAt: null, windows: [] };
      const key = `${id}:${version}:${boundSandbox}`;
      const time = now().getTime();
      const prior = cache.get(key);
      const value: ModelUsage = prior?.value ?? {
        accountId: id,
        version,
        status: "unavailable",
        observedAt: null,
        windows: [],
      };
      const fresh = (result: ModelUsage): ModelUsage => {
        const stamps = [
          result.observedAt,
          result.creditsObservedAt,
          ...result.windows.map((window) => window.observedAt),
          ...(result.buckets ?? []).flatMap((bucket) => [
            bucket.creditsObservedAt,
            ...bucket.windows.map((window) => window.observedAt),
          ]),
        ].filter((stamp): stamp is string => typeof stamp === "string");
        const stale = stamps.some((stamp) => now().getTime() - Date.parse(stamp) > 60_000);
        return {
          ...result,
          status:
            result.observedAt && (result.status === "fresh" || result.status === "stale")
              ? stale
                ? "stale"
                : "fresh"
              : result.status,
        };
      };
      if (prior && time >= prior.checked && time - prior.checked < 15_000) return fresh(value);
      const pending = inFlight.get(key);
      if (pending) {
        let shared: ModelUsage | undefined;
        try {
          shared = await withinBudget(budget, () => pending);
        } catch {}
        const current = await withinBudget(AbortSignal.timeout(1000), queryAuthorization);
        if (current.rows[0]?.version !== version || current.rows[0]?.sandbox_id !== boundSandbox)
          throw new VaultError("not_found", "Pinned account authorization changed during shared usage read.");
        return shared ? fresh(shared) : { ...value, status: "error" };
      }
      if (inFlight.size >= 1000) return { ...value, status: "error" };
      const run = async (): Promise<ModelUsage> => {
        let cursor = prior?.cursor;
        let nextValue = value;
        try {
          const { provider, providerSandboxId } = await withinBudget(budget, () => resolve(boundSandbox));
          for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
            const page = await withinBudget(budget, () =>
              provider.events({
                sandboxId: providerSandboxId,
                limit: 100,
                signal: budget,
                ...(cursor ? { cursor } : {}),
              }),
            );
            if (page.events.length > 100) throw Error("usage_read_page_exceeded");
            for (const event of page.events) {
              if (!Number.isFinite(event.at) || event.at > now().getTime()) continue;
              const usage = reading(event, nextValue);
              if (
                usage &&
                Number.isFinite(event.at) &&
                event.at <= now().getTime() &&
                (!nextValue.observedAt || event.at >= Date.parse(nextValue.observedAt))
              )
                nextValue = {
                  accountId: id,
                  version,
                  status: usage.unavailable ? "unavailable" : "fresh",
                  observedAt: new Date(event.at).toISOString(),
                  windows: usage.windows,
                  ...(usage.extraUsage ? { extraUsage: usage.extraUsage } : {}),
                  ...(usage.credits ? { credits: usage.credits } : {}),
                  ...(usage.creditsObservedAt !== undefined ? { creditsObservedAt: usage.creditsObservedAt } : {}),
                  ...(usage.creditsSourceId !== undefined ? { creditsSourceId: usage.creditsSourceId } : {}),
                  ...(usage.compatibilitySourceId !== undefined
                    ? { compatibilitySourceId: usage.compatibilitySourceId }
                    : {}),
                  ...(usage.buckets ? { buckets: usage.buckets } : {}),
                  ...(usage.compatibility ? { compatibility: usage.compatibility } : {}),
                };
            }
            const next = page.cursor;
            if (!page.hasMore || !next || next === cursor) {
              cursor = next ?? cursor;
              break;
            }
            cursor = next;
          }
          const current = await authorize();
          if (current.rows[0]?.version !== version || current.rows[0]?.sandbox_id !== boundSandbox)
            throw new VaultError("not_found", "Pinned account authorization changed during usage read.");
          if (cache.size >= 1000 && !cache.has(key)) {
            const oldest = cache.keys().next().value;
            if (oldest) cache.delete(oldest);
          }
          cache.set(key, { cursor, checked: time, value: nextValue });
          return fresh(nextValue);
        } catch (error) {
          if (error instanceof VaultError) throw error;
          // Errors/timeouts do not bypass current ownership, even for last-known data.
          const current = await withinBudget(AbortSignal.timeout(1000), queryAuthorization);
          if (current.rows[0]?.version !== version || current.rows[0]?.sandbox_id !== boundSandbox)
            throw new VaultError("not_found", "Pinned account authorization changed during usage read.");
          return { ...nextValue, status: "error" };
        }
      };
      const flight = Promise.resolve()
        .then(run)
        .finally(() => {
          if (inFlight.get(key) === flight) inFlight.delete(key);
        });
      inFlight.set(key, flight);
      return flight;
    },
  };
}
