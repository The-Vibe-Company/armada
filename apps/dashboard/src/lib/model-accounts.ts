/**
 * Named model accounts as the dashboard sees them: the safe DTO of the control API (#603) and the rules the Credentials page and the launch dialog apply to them. These are narrow app
 * interfaces matching the published contract, so the dashboard compiles on its own; no DTO carries a token, a
 * refresh token or auth state, and the parsers keep only the named fields, so nothing else is ever rendered.
 */
import type { Harness } from "@armada/core";

export const ACCOUNT_KINDS = ["claude_oauth", "anthropic", "openai", "codex_auth"] as const;
/** #603's account statuses; any other value reads as `unknown` rather than as working. */
export const ACCOUNT_STATUSES = ["active", "revoked", "deleted", "unknown"] as const;
export const ACCOUNT_SCOPES = ["user", "org"] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export type AccountScope = (typeof ACCOUNT_SCOPES)[number];

export interface ModelAccount {
  id: string;
  scope: AccountScope;
  kind: AccountKind;
  name: string;
  /** The default of its scope for its harness. */
  isDefault: boolean;
  status: AccountStatus;
  expiresAt: string | null;
  updatedAt: string;
  /** Compare-and-swap version: every mutation names the version the person saw. */
  version: number;
}

export type KindInfo = {
  label: string;
  harness: Harness;
  harnessLabel: string;
  /** A subscription bills a plan; an API key bills usage. */
  billing: "subscription" | "api";
  /** What to paste and where it comes from. */
  valueLabel: string;
  hint: string;
};

export const KIND_INFO: Record<AccountKind, KindInfo> = {
  claude_oauth: {
    label: "Claude subscription",
    harness: "claude",
    harnessLabel: "Claude Code",
    billing: "subscription",
    valueLabel: "OAuth token",
    hint: "Run claude setup-token on your machine, sign in, and paste the token it prints.",
  },
  anthropic: {
    label: "Anthropic API key",
    harness: "claude",
    harnessLabel: "Claude Code",
    billing: "api",
    valueLabel: "API key",
    hint: "From console.anthropic.com. Billed per token.",
  },
  codex_auth: {
    label: "ChatGPT subscription",
    harness: "codex",
    harnessLabel: "Codex",
    billing: "subscription",
    valueLabel: "auth.json",
    hint: "Run codex login on your machine, sign in with ChatGPT, and paste the content of ~/.codex/auth.json.",
  },
  openai: {
    label: "OpenAI API key",
    harness: "codex",
    harnessLabel: "Codex",
    billing: "api",
    valueLabel: "API key",
    hint: "From platform.openai.com. Billed per token.",
  },
};

export const STATUS_INFO: Record<AccountStatus, { label: string; tone: "ok" | "warn" | "error" | "muted" }> = {
  active: { label: "Active", tone: "ok" },
  revoked: { label: "Revoked", tone: "error" },
  deleted: { label: "Removed", tone: "error" },
  unknown: { label: "Status unknown", tone: "warn" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** #603 accepts 1 to 120 characters. */
export const MAX_ACCOUNT_NAME = 120;

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isoOrNull(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** An account DTO, or null when it does not match the contract. An unknown status reads as `unknown`. */
export function parseAccount(value: unknown): ModelAccount | null {
  if (!isRow(value)) return null;
  if (typeof value.id !== "string" || !UUID.test(value.id)) return null;
  if (!oneOf(ACCOUNT_SCOPES, value.scope) || !oneOf(ACCOUNT_KINDS, value.kind)) return null;
  const name = text(value.name, MAX_ACCOUNT_NAME);
  const expiresAt = isoOrNull(value.expiresAt);
  const updatedAt = isoOrNull(value.updatedAt);
  if (!name || expiresAt === undefined || !updatedAt) return null;
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 0) return null;
  return {
    id: value.id,
    scope: value.scope,
    kind: value.kind,
    name,
    isDefault: value.isDefault === true,
    status: oneOf(ACCOUNT_STATUSES, value.status) ? value.status : "unknown",
    expiresAt,
    updatedAt,
    version: value.version,
  };
}

/**
 * `creds/list {org}`'s `{user: [...], orgs: [{id, credentials: [...]}]}`, reduced to the model accounts of the
 * viewer and of that one org. A row without the account fields (a hosting key, an older server) is not an account
 * and is left out; scope comes from where the row sits, never from the row itself.
 */
export function accountsFromList(payload: unknown, org: string): { accounts: ModelAccount[]; legacy: boolean } {
  const record = isRow(payload) ? payload : {};
  let legacy = false;
  const rows = (items: unknown, scope: AccountScope) =>
    (Array.isArray(items) ? items : [])
      .map((item) => {
        if (typeof item !== "object" || item === null) return null;
        const account = parseAccount({ ...item, scope });
        // A model credential without an id is a row from a server older than named accounts.
        if (!account && oneOf(ACCOUNT_KINDS, (item as { kind?: unknown }).kind) && !("id" in item)) legacy = true;
        return account;
      })
      .filter((row): row is ModelAccount => row !== null);
  const orgs = Array.isArray(record.orgs) ? record.orgs : [];
  const mine = orgs.find((item) => isRow(item) && item.id === org);
  const accounts = [...rows(record.user, "user"), ...rows(isRow(mine) ? mine.credentials : undefined, "org")];
  return { accounts, legacy };
}

/** A value quoted for a POSIX shell: a name with spaces, quotes or `$` is passed as one literal argument. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * How accounts can be connected, as the server reports it (#604 `creds/accounts/auth-capabilities`): whether a
 * hosted browser sign-in exists, and the Armada CLI command that signs a kind in on the person's machine. Only what
 * the server reports is offered; a server that reports nothing offers paste only.
 */
export type AuthCapabilities = { hostedOAuth: boolean; terminal: Partial<Record<AccountKind, string>> };

/**
 * The only terminal sign-ins the dashboard will show, by kind. A server's command is accepted only when it is one
 * of these exactly, bare or as its documented `--name <name>` template; anything else is not shown.
 */
const CLI_LOGIN: Partial<Record<AccountKind, string>> = {
  codex_auth: "armada creds login codex",
  claude_oauth: "armada creds login claude",
};

/** The allowlisted base for a reported command, or null: never a placeholder, an extra flag or arbitrary shell. */
function loginBase(kind: unknown, command: unknown): string | null {
  if (!oneOf(ACCOUNT_KINDS, kind) || typeof command !== "string") return null;
  const base = CLI_LOGIN[kind];
  const reported = command.trim().replace(/\s+/g, " ");
  return base && (reported === base || reported === `${base} --name <name>`) ? base : null;
}

/** #604's `modelAuthCapabilities` names harnesses, not credential kinds. */
const HARNESS_LOGIN_KIND: Record<string, AccountKind> = { codex: "codex_auth", claude: "claude_oauth" };

/**
 * #604 `creds/accounts/auth-capabilities`: nested `{codex: {login}, claude: {login}}` (login null when there is
 * none), or a `nativeCLI` list or map of kind to command. Import templates (`--file <...>`) are not offered: they
 * name a private path the dashboard cannot fill in.
 */
export function parseAuthCapabilities(value: unknown): AuthCapabilities | null {
  if (!isRow(value)) return null;
  const terminal: AuthCapabilities["terminal"] = {};
  const entries: [unknown, unknown][] = Array.isArray(value.nativeCLI)
    ? value.nativeCLI.map((row) => (isRow(row) ? [row.kind, row.command] : [null, null]))
    : isRow(value.nativeCLI)
      ? Object.entries(value.nativeCLI)
      : [];
  for (const [harness, kind] of Object.entries(HARNESS_LOGIN_KIND)) {
    const nested = value[harness];
    if (isRow(nested)) entries.push([kind, nested.login]);
  }
  for (const [kind, command] of entries) {
    const base = loginBase(kind, command);
    if (base) terminal[kind as AccountKind] = base;
  }
  return { hostedOAuth: value.hostedOAuth === true, terminal };
}

/** The command a person runs to sign a kind in from their terminal, or null when the server offers none. */
export function terminalLogin(capabilities: AuthCapabilities | null, kind: AccountKind, name: string): string | null {
  const base = capabilities?.terminal[kind];
  return base ? `${base} --name ${shellQuote(name.trim() || "Work")}` : null;
}

/** A name for an account: trimmed, one line, short enough to read in a select. */
export function checkAccountName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!value) return { ok: false, error: "Give the account a name, such as Work or Personal." };
  if (value.length > MAX_ACCOUNT_NAME)
    return { ok: false, error: `Keep the name under ${MAX_ACCOUNT_NAME} characters.` };
  return { ok: true, value };
}

/** The kind's label when it adds something: a migrated account is often named after its kind already. */
export function kindNote(account: Pick<ModelAccount, "kind" | "name">): string | null {
  const label = KIND_INFO[account.kind].label;
  return account.name.toLowerCase() === label.toLowerCase() ? null : label;
}

export function accountsFor(accounts: readonly ModelAccount[], harness: Harness): ModelAccount[] {
  return accounts.filter((account) => KIND_INFO[account.kind].harness === harness);
}

/** Why a launch cannot use an account now, in a word or two ("expired", "removed"), or null when it can. */
export function accountProblem(account: Pick<ModelAccount, "status" | "expiresAt">, now: number): string | null {
  if (account.status !== "active") return STATUS_INFO[account.status].label.toLowerCase();
  if (account.expiresAt !== null && Date.parse(account.expiresAt) <= now) return "expired";
  return null;
}

export function isUsable(account: ModelAccount, now: number): boolean {
  return accountProblem(account, now) === null;
}

/**
 * Whether an account may become the default. The server resolves an implicit launch to the default with no fallback
 * (#603), so a default that cannot run would refuse every launch that names no account: reconnect it first.
 */
export function checkDefaultChoice(
  accounts: readonly ModelAccount[],
  id: string,
  now: number,
): { ok: true } | { ok: false; error: string } {
  const account = accounts.find((candidate) => candidate.id === id);
  if (!account) return { ok: false, error: "That account no longer exists. Reload the page." };
  const problem = accountProblem(account, now);
  if (problem !== null)
    return {
      ok: false,
      error: `${account.name} cannot run now (${problem}). Reconnect it before making it the default.`,
    };
  return { ok: true };
}

/**
 * The account the launch dialog preselects for a harness, in the order the server resolves it (#603): the
 * personal default, the only personal account, the org default, the only org account. Several candidates and no
 * default is `ambiguous`: the person chooses, so no billing account is ever picked for them.
 */
export type LaunchWhy = "personal-default" | "personal-only" | "org-default" | "org-only";

export type LaunchDefault =
  | { state: "resolved"; account: ModelAccount; why: LaunchWhy }
  | { state: "unusable"; account: ModelAccount; why: LaunchWhy }
  | { state: "ambiguous" }
  | { state: "none" };

export function launchDefault(accounts: readonly ModelAccount[], harness: Harness, now: number): LaunchDefault {
  const compatible = accountsFor(accounts, harness);
  for (const scope of ACCOUNT_SCOPES) {
    const rows = compatible.filter((account) => account.scope === scope);
    const marked = rows.find((account) => account.isDefault);
    const pick = marked ?? (rows.length === 1 ? rows[0] : undefined);
    if (pick) {
      const prefix = scope === "user" ? "personal" : "org";
      const why: LaunchWhy = marked ? `${prefix}-default` : `${prefix}-only`;
      return { state: isUsable(pick, now) ? "resolved" : "unusable", account: pick, why };
    }
    if (rows.length > 1) return { state: "ambiguous" };
  }
  return { state: "none" };
}

/**
 * The accounts the launch dialog offers, or why it offers none: a server older than named accounts launches with
 * its own resolution and no selection; a failed read blocks a launch rather than letting the server pick silently.
 */
export type LaunchAccounts =
  | { state: "ready"; accounts: ModelAccount[]; orgName: string /** When the list was read. */; now: number }
  | { state: "legacy" }
  | { state: "unavailable"; reason: string };

/**
 * The model accounts of the viewer and of the selected org. `legacy` is a server older than named accounts: its
 * keys still launch, but they cannot be listed by name here. A failed read is an error, never an empty list.
 */
export type AccountList =
  | { state: "ready"; orgId: string; orgName: string; accounts: ModelAccount[] }
  | { state: "legacy" }
  | { state: "no-org" }
  | { state: "not-configured" }
  | { state: "error"; message: string };

/**
 * The account a launch request bills, as the server action decides it: `id` undefined only where no account is
 * sent (a server older than named accounts, or an agent with no account at all, which the server then refuses on
 * its own). Otherwise the request must name a listed, compatible, usable account: a blank, foreign or unusable choice
 * is refused, so the server never picks who is billed.
 */
export function checkAccountChoice(
  list: AccountList,
  harness: Harness,
  requested: string,
  now: number,
): { ok: true; id: string | undefined } | { ok: false; error: string } {
  if (requested && !UUID.test(requested)) return { ok: false, error: "That request is not valid." };
  if (list.state === "legacy") return { ok: true, id: undefined };
  if (list.state !== "ready")
    return {
      ok: false,
      error: `Model accounts could not be loaded${list.state === "error" ? `: ${list.message}` : "."} Reload and try again.`,
    };
  const compatible = accountsFor(list.accounts, harness);
  if (compatible.length === 0) {
    return requested
      ? { ok: false, error: "That account is not available for this agent." }
      : { ok: true, id: undefined };
  }
  if (!requested) return { ok: false, error: "Choose which account the agent runs on." };
  const chosen = compatible.find((item) => item.id === requested);
  if (!chosen) return { ok: false, error: "That account is not available for this agent. Reload and choose again." };
  const problem = accountProblem(chosen, now);
  if (problem) return { ok: false, error: `${chosen.name} is ${problem}. Replace its token or choose another.` };
  return { ok: true, id: chosen.id };
}

/* ---------------------------------------------------------------- usage (#604) */

/**
 * One account's usage, as `creds/accounts/usage` reports it from the harness's own rate-limit structures:
 * `fresh` or `stale` windows, or `unavailable` (the account reports none, such as a model-only token) or `error`
 * (the read failed). `version` is the secret version the report was observed under.
 */
export const USAGE_STATUSES = ["fresh", "stale", "unavailable", "error"] as const;
/** A report the server sent but this dashboard cannot read (a newer shape): never a server status. */
export type UsageReadStatus = (typeof USAGE_STATUSES)[number] | "unreadable";
export type UsageStatus = (typeof USAGE_STATUSES)[number];
/**
 * One allowance window, from #624's `Window {id, label, kind, usedPercent, resetsAt, sourceId?, observedAt?,
 * windowDurationMins?, ...}`. `id` is unique within a report; `usedPercent` null is a reading the provider reported
 * as unavailable, never zero. `sourceId` is the native meter the window belongs to (null when the source did not
 * identify itself) and `observedAt` when that window was last read: a sparse update keeps an older window with its
 * original time.
 */
export type UsageWindow = {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  sourceId: string | null;
  observedAt: string | null;
  /** The window's length as the provider reports it, in minutes. */
  durationMins: number | null;
};
/**
 * A native credit snapshot (#624 v3 `{hasCredits, unlimited, balance}`). `balance` is the provider's exact decimal
 * string: it is never turned into a number, summed or given a currency.
 */
export type CreditBalance = { hasCredits: boolean; unlimited: boolean; balance: string | null };
/** One meter's credits: which native meter reported it, under what name, and when. */
export type CreditMeter = CreditBalance & {
  key: string;
  sourceId: string | null;
  label: string;
  observedAt: string | null;
};
export interface AccountUsage {
  accountId: string;
  version: number;
  status: UsageReadStatus;
  observedAt: string | null;
  windows: UsageWindow[];
  extraUsage: { used: number; limit: number | null; currency: string } | null;
  /** Every distinct credit reading, one per meter view; balances are never added up. */
  credits: CreditMeter[];
  /** Windows in the report this dashboard could not read; the readable ones are still shown. */
  hiddenWindows: number;
  /** Credit snapshots in the report this dashboard could not read. */
  hiddenCredits: number;
}

/** A native meter id: the key of the provider's meter map, or null for a source that did not name itself. */
function sourceIdOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

/** #624's credit snapshot: undefined when absent, null when present but not in the published shape. */
function parseCredits(value: unknown): CreditBalance | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRow(value) || typeof value.hasCredits !== "boolean" || typeof value.unlimited !== "boolean") return null;
  const balance = value.balance;
  const exact = balance === null || (typeof balance === "string" && /^[+-]?\d{1,240}(?:\.\d{1,240})?$/.test(balance));
  return exact ? { hasCredits: value.hasCredits, unlimited: value.unlimited, balance: balance as string | null } : null;
}

const sameCredits = (a: CreditBalance, b: CreditBalance) =>
  a.hasCredits === b.hasCredits && a.unlimited === b.unlimited && a.balance === b.balance;

const sameReading = (a: UsageWindow, b: UsageWindow) =>
  a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt && a.observedAt === b.observedAt;

export function parseUsage(value: unknown): AccountUsage | null {
  if (!isRow(value) || typeof value.accountId !== "string" || !UUID.test(value.accountId)) return null;
  if (!oneOf(USAGE_STATUSES, value.status)) return null;
  if (typeof value.version !== "number" || !Number.isInteger(value.version)) return null;
  const observedAt = isoOrNull(value.observedAt);
  if (observedAt === undefined) return null;
  const rows: unknown[] = Array.isArray(value.windows) ? value.windows : [];
  const windows: UsageWindow[] = [];
  const kinds = new Map<UsageWindow, string>();
  const seen = new Map<string, number>();
  const add = (window: UsageWindow, kind: string) => {
    // Every readable window is shown; a repeated identity only gets a distinct key, never dropped or miscounted.
    const count = (seen.get(window.id) ?? 0) + 1;
    seen.set(window.id, count);
    const keyed = count > 1 ? { ...window, id: `${window.id}#${count}` } : window;
    windows.push(keyed);
    kinds.set(keyed, kind);
  };
  let hiddenWindows = 0;
  for (const row of rows) {
    const parsed = parseWindow(row);
    if (parsed) add(parsed.window, parsed.kind);
    else hiddenWindows++;
  }
  // Only a report none of whose windows can be read is unrecognized; readable siblings are kept otherwise.
  if (rows.length > 0 && windows.length === 0) return null;

  // #624 v3: `buckets` holds every native meter view; the flat windows above already show them, merged with the
  // summary (`compatibility`) view. A meter's own reading is added only where it differs from what is shown.
  const buckets = (Array.isArray(value.buckets) ? value.buckets : []).slice(0, 64).filter(isRow);
  const bucketLabel = (bucket: Row) => text(bucket.label, 120) ?? sourceIdOf(bucket.sourceId) ?? "Account";
  for (const bucket of buckets) {
    const sourceId = sourceIdOf(bucket.sourceId);
    for (const row of Array.isArray(bucket.windows) ? bucket.windows : []) {
      const parsed = parseWindow(row);
      if (!parsed) continue;
      const shown = windows.find((window) => window.sourceId === sourceId && kinds.get(window) === parsed.kind);
      if (shown && sameReading(shown, parsed.window)) continue;
      const label = `${bucketLabel(bucket)} · ${humanize(parsed.kind)}${shown ? " (meter view)" : ""}`;
      add({ ...parsed.window, id: `meter:${sourceId ?? ""}:${parsed.kind}`, label: label.slice(0, 140) }, parsed.kind);
    }
  }

  const credits: CreditMeter[] = [];
  let hiddenCredits = 0;
  // The top-level snapshot is the summary view of one meter (`creditsSourceId`); each bucket is its own meter.
  const summary = parseCredits(value.credits);
  const summarySource = sourceIdOf(value.creditsSourceId);
  if (summary === null) hiddenCredits++;
  if (summary) {
    const compatibility = isRow(value.compatibility) ? value.compatibility : null;
    const named =
      (compatibility && sourceIdOf(compatibility.sourceId) === summarySource ? compatibility : undefined) ??
      buckets.find((bucket) => sourceIdOf(bucket.sourceId) === summarySource);
    credits.push({
      key: "summary",
      sourceId: summarySource,
      label: named ? bucketLabel(named) : (summarySource ?? "Account"),
      ...summary,
      observedAt: isoOrNull(value.creditsObservedAt) ?? null,
    });
  }
  const keys = new Map<string, number>();
  for (const bucket of buckets) {
    const reading = parseCredits(bucket.credits);
    if (reading === null) hiddenCredits++;
    if (!reading) continue;
    const sourceId = sourceIdOf(bucket.sourceId);
    const bucketObserved = isoOrNull(bucket.creditsObservedAt) ?? null;
    const sameMeter = summary && summarySource === sourceId;
    // The summary already shows this exact reading of this meter: one meter, one line.
    if (sameMeter && sameCredits(summary, reading) && credits[0]?.observedAt === bucketObserved) continue;
    const base = `meter:${sourceId ?? ""}`;
    const count = (keys.get(base) ?? 0) + 1;
    keys.set(base, count);
    credits.push({
      key: count > 1 ? `${base}#${count}` : base,
      sourceId,
      label: `${bucketLabel(bucket)}${sameMeter ? " (meter view)" : ""}`,
      ...reading,
      observedAt: bucketObserved,
    });
  }

  return {
    accountId: value.accountId,
    version: value.version,
    status: value.status,
    observedAt,
    windows,
    extraUsage: extraUsage(value.extraUsage),
    credits,
    hiddenWindows,
    hiddenCredits,
  };
}

/** A `Window` this dashboard can read, or null. `usedPercent` is a number or an explicit null; anything else is not. */
function parseWindow(row: unknown): { window: UsageWindow; kind: string } | null {
  if (!isRow(row)) return null;
  const kind = text(row.kind, 60);
  const resetsAt = isoOrNull(row.resetsAt);
  const used = row.usedPercent;
  if (!kind || resetsAt === undefined) return null;
  if (used !== null && !(typeof used === "number" && Number.isFinite(used))) return null;
  const model = text(row.model, 60);
  const qualifiers = [model, text(row.surface, 40), text(row.group, 40)].filter(Boolean);
  const label = text(row.label, 60);
  const duration = row.windowDurationMins;
  return {
    kind,
    window: {
      // #624 v1 sends a stable `id` and a source-derived `label`; an older report is identified by its kind.
      id: text(row.id, 60) ?? [kind, ...qualifiers].join("/"),
      // A label that is only the native kind ("primary") reads as the kind does elsewhere.
      label:
        label && label !== kind
          ? label
          : `${humanize(kind)}${qualifiers.length && !label ? ` (${qualifiers.join(", ")})` : ""}`,
      usedPercent: used === null ? null : Math.min(100, Math.max(0, used)),
      resetsAt,
      sourceId: sourceIdOf(row.sourceId),
      observedAt: isoOrNull(row.observedAt) ?? null,
      durationMins: typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0 ? duration : null,
    },
  };
}

/** "five_hour" -> "Five hour": the provider's own kind, readable, with no name the contract does not define. */
function humanize(kind: string): string {
  const words = kind.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A window's reported length: "5 h", "7 days", "90 min". */
export function formatDuration(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return minutes > 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

/** A credit reading in words: the exact balance the provider sent, "Unlimited", or what is missing. */
export function creditText(credits: CreditBalance): string {
  if (credits.unlimited) return "Unlimited";
  if (credits.balance !== null) return `${credits.balance.replace(/^\+/, "")} credits`;
  return credits.hasCredits ? "Balance not reported" : "No credits";
}

/**
 * #604/#624 `extraUsage {enabled, currency, usedMinor, limitMinor}`, in the currency's minor units. Shown only when
 * enabled, with an ISO currency and a used amount; converted with that currency's own fraction digits.
 */
function extraUsage(extra: unknown): AccountUsage["extraUsage"] {
  if (!isRow(extra) || extra.enabled !== true) return null;
  const currency = typeof extra.currency === "string" ? extra.currency : "";
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  let digits: number;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
  const amount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
  // #624 v1 sends major units (`used`, `limit`) beside the canonical minor ones. A major field the producer sent wins,
  // and its explicit null means it could not tell: only a report without that field is converted from minor units.
  const major = (key: "used" | "limit", minor: unknown) => {
    if (key in extra) return amount(extra[key]);
    const units = amount(minor);
    return units === null ? null : units / 10 ** digits;
  };
  const used = major("used", extra.usedMinor);
  return used === null ? null : { used, limit: major("limit", extra.limitMinor), currency };
}

/** The report for an account the server answered but in a shape this dashboard cannot read. */
export function unreadableUsage(accountId: string): AccountUsage {
  return {
    accountId,
    version: 0,
    status: "unreadable",
    observedAt: null,
    windows: [],
    extraUsage: null,
    credits: [],
    hiddenWindows: 0,
    hiddenCredits: 0,
  };
}

/**
 * How an account's usage reads. Numbers are shown only for a report with windows, spend or credits: as current when fresh and
 * observed under the account's current secret, otherwise as last known. Everything else is said in words, never
 * as zero. `null` usage means this server does not report usage (or was not asked).
 */
export type UsageView =
  | {
      kind: "fresh" | "stale";
      windows: UsageWindow[];
      observedAt: string;
      extra: AccountUsage["extraUsage"];
      credits: CreditMeter[];
      hiddenWindows: number;
      hiddenCredits: number;
    }
  | { kind: "unknown" | "unavailable" | "error" | "unreadable"; reason: string };

export function usageView(usage: AccountUsage | null, account: Pick<ModelAccount, "version">): UsageView {
  if (!usage) return { kind: "unknown", reason: "Not reported by this server." };
  if (usage.status === "unreadable")
    return { kind: "unreadable", reason: "This server reports usage in a form this dashboard cannot read yet." };
  if (usage.status === "error") return { kind: "error", reason: "The last read failed. Reload the page to try again." };
  // Reported spend or credits alone are shown without windows: no window or zero allowance is invented for them.
  const reading = usage.windows.length > 0 || usage.extraUsage !== null || usage.credits.length > 0;
  if (usage.status === "unavailable" || !usage.observedAt || !reading)
    return { kind: "unavailable", reason: "No allowance reading is available for this account yet." };
  const stale = usage.status === "stale" || usage.version !== account.version;
  return {
    kind: stale ? "stale" : "fresh",
    windows: usage.windows,
    observedAt: usage.observedAt,
    extra: usage.extraUsage,
    credits: usage.credits,
    hiddenWindows: usage.hiddenWindows,
    hiddenCredits: usage.hiddenCredits,
  };
}

/** "in 3 h 20 min", "in 2 days", "now": a reset time relative to `now`, for a label next to the absolute time. */
export function relativeTime(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  const past = ms < 0;
  const minutes = Math.round(Math.abs(ms) / 60_000);
  let span: string;
  if (minutes < 1) return "now";
  if (minutes < 60) span = `${minutes} min`;
  else if (minutes < 48 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    span = rest && hours < 10 ? `${hours} h ${rest} min` : `${hours} h`;
  } else span = `${Math.round(minutes / 1440)} days`;
  return past ? `${span} ago` : `in ${span}`;
}

export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
}
