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
export type UsageWindow = { id: string; label: string; usedPercent: number | null; resetsAt: string | null };
export interface AccountUsage {
  accountId: string;
  version: number;
  status: UsageReadStatus;
  observedAt: string | null;
  windows: UsageWindow[];
  extraUsage: { used: number; limit: number | null; currency: string } | null;
}

export function parseUsage(value: unknown): AccountUsage | null {
  if (!isRow(value) || typeof value.accountId !== "string" || !UUID.test(value.accountId)) return null;
  if (!oneOf(USAGE_STATUSES, value.status)) return null;
  if (typeof value.version !== "number" || !Number.isInteger(value.version)) return null;
  const observedAt = isoOrNull(value.observedAt);
  if (observedAt === undefined) return null;
  const windows: UsageWindow[] = [];
  for (const row of Array.isArray(value.windows) ? value.windows : []) {
    const id = isRow(row) ? text(row.id, 60) : undefined;
    const label = isRow(row) ? text(row.label, 60) : undefined;
    const resetsAt = isRow(row) ? isoOrNull(row.resetsAt) : undefined;
    // A window this dashboard cannot read makes the whole report unreadable: shown as a failed read, never as an
    // account that "does not report" its allowance.
    if (!isRow(row) || !id || !label || resetsAt === undefined) return null;
    const used = row.usedPercent;
    const usedPercent = typeof used === "number" && Number.isFinite(used) ? Math.min(100, Math.max(0, used)) : null;
    windows.push({ id, label, usedPercent, resetsAt });
  }
  return {
    accountId: value.accountId,
    version: value.version,
    status: value.status,
    observedAt,
    windows,
    extraUsage: extraUsage(value.extraUsage),
  };
}

/**
 * #604/#624 `extraUsage {enabled, currency, usedMinor, limitMinor}`, in the currency's minor units. Shown only when
 * enabled, with an ISO currency and a used amount; converted with that currency's own fraction digits.
 */
function extraUsage(extra: unknown): AccountUsage["extraUsage"] {
  if (!isRow(extra) || extra.enabled !== true) return null;
  const currency = typeof extra.currency === "string" ? extra.currency : "";
  const minor = (amount: unknown) =>
    typeof amount === "number" && Number.isInteger(amount) && amount >= 0 ? amount : null;
  const used = minor(extra.usedMinor);
  if (!/^[A-Z]{3}$/.test(currency) || used === null) return null;
  let digits: number;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
  const limit = minor(extra.limitMinor);
  const major = (amount: number) => amount / 10 ** digits;
  return { used: major(used), limit: limit === null ? null : major(limit), currency };
}

/** The report for an account the server answered but in a shape this dashboard cannot read. */
export function unreadableUsage(accountId: string): AccountUsage {
  return { accountId, version: 0, status: "unreadable", observedAt: null, windows: [], extraUsage: null };
}

/**
 * How an account's usage reads. Numbers are shown only for a report with windows: as current when fresh and
 * observed under the account's current secret, otherwise as last known. Everything else is said in words, never
 * as zero. `null` usage means this server does not report usage (or was not asked).
 */
export type UsageView =
  | { kind: "fresh" | "stale"; windows: UsageWindow[]; observedAt: string; extra: AccountUsage["extraUsage"] }
  | { kind: "unknown" | "unavailable" | "error" | "unreadable"; reason: string };

export function usageView(usage: AccountUsage | null, account: Pick<ModelAccount, "version">): UsageView {
  if (!usage) return { kind: "unknown", reason: "Not reported by this server." };
  if (usage.status === "unreadable")
    return { kind: "unreadable", reason: "This server reports usage in a form this dashboard cannot read yet." };
  if (usage.status === "error") return { kind: "error", reason: "The last read failed. Reload the page to try again." };
  if (usage.status === "unavailable" || !usage.observedAt || usage.windows.length === 0)
    return { kind: "unavailable", reason: "This account does not report its allowance." };
  const stale = usage.status === "stale" || usage.version !== account.version;
  return {
    kind: stale ? "stale" : "fresh",
    windows: usage.windows,
    observedAt: usage.observedAt,
    extra: usage.extraUsage,
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
