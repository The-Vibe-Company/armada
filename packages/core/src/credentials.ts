import { CLAUDE_ENDPOINT_ENV, parseClaudeEndpoint } from "./claude-endpoint.ts";
import { CODEX_ENDPOINT_ENV, parseCodexEndpoint } from "./codex-endpoint.ts";
import type { Harness, Visibility } from "./contract.ts";
import { decryptSecret, EncryptionKeyError } from "./crypto.ts";
import type { CredentialKind, CredentialScope } from "./database.types.ts";
import type { GitHubAccess } from "./github.ts";
import type { GoldenActor } from "./golden.ts";
import { mapHarnesses } from "./harnesses.ts";
import { LaunchError } from "./launch-error.ts";
import { type ModelPriceOverrides, parseModelPriceOverrides } from "./model-price-overrides.ts";
import { SKILLPACK_TOKEN_PATTERN } from "./skillpack-token.ts";
import { redactKnownTokens } from "./token-redaction.ts";
import type { UsagePricingContext } from "./usage-pricing.ts";
import { VaultError } from "./vault-error.ts";

/** The credential kinds a launch injects. Claude Code takes a subscription token, Codex an OpenAI key or `auth.json`. */
export type LaunchCredentialKind = "claude_oauth" | "openai";

/**
 * Where decrypted credentials come from. The database holds ciphertext a user JWT cannot read,
 * so the real source (#461) runs where the encryption key is. Returns null when none is set.
 */
export interface CredentialSource {
  get(scope: CredentialScope, ownerId: string, kind: LaunchCredentialKind): Promise<string | null>;
}

/** The variable that carries the content of Codex's `auth.json` into the sandbox, where launch writes it to disk. */
export const CODEX_AUTH_ENV = "ARMADA_CODEX_AUTH_JSON";

/** What a launch hands to the sandbox: its environment, and every value in it that must never be printed. */
export interface CredentialBinding {
  credentialId: string;
  credentialVersion: number;
}

export interface HarnessCredentials {
  /** Server-only pricing metadata from the same sealed/bound account; never harness configuration. */
  modelPrices?: ModelPriceOverrides;
  /** Server-generated, secret-free price catalog pinned for a new session, not sandbox environment. */
  usagePricing?: UsagePricingContext;
  binding?: CredentialBinding;
  env: Record<string, string>;
  secrets: string[];
  /** The harness reads its login from this file, which launch writes from {@link CODEX_AUTH_ENV}. */
  codexAuthJson: boolean;
  /**
   * The person's GitHub access, resolved beside the model credentials. Launch puts the token in the
   * sandbox environment and sets git up with it. Absent means GitHub was not looked up.
   */
  github?: GitHubAccess;
}

/** The user's own credential wins over the org's default. A blank value counts as not set. */
export async function resolveCredential(
  source: CredentialSource,
  actor: GoldenActor,
  kind: LaunchCredentialKind,
): Promise<string | null> {
  const own = clean(await source.get("user", actor.userId, kind));
  if (own) return own;
  return clean(await source.get("org", actor.orgId, kind));
}

/**
 * Resolves the credentials of one harness and nothing else: no other model key, and never an
 * account-level secret of the provider. Throws before anything starts when the harness has none.
 */
export async function harnessCredentials(
  source: CredentialSource,
  actor: GoldenActor,
  harness: Harness,
): Promise<HarnessCredentials> {
  if (harness === "claude") {
    const token = await resolveCredential(source, actor, "claude_oauth");
    if (!token) {
      throw new LaunchError(
        "no_credentials",
        "No Claude Code token is set for you or your org. Connect Claude through Anthropic SSO first.",
      );
    }
    return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, secrets: [token], codexAuthJson: false };
  }
  const value = await resolveCredential(source, actor, "openai");
  if (!value) {
    throw new LaunchError(
      "no_credentials",
      "No OpenAI key or Codex auth.json is set for you or your org. Add one before launching Codex.",
    );
  }
  if (value.startsWith("{")) {
    const leaves = authJsonSecrets(value);
    return { env: { [CODEX_AUTH_ENV]: value }, secrets: [value, ...leaves], codexAuthJson: true };
  }
  return { env: { OPENAI_API_KEY: value }, secrets: [value], codexAuthJson: false };
}

/**
 * Turns {@link resolveCredentials}'s result into what a launch forks with. A Codex `auth.json` rides
 * along as {@link CODEX_AUTH_ENV}; launch writes it to `~/.codex/auth.json` and never onto the command line.
 */
export function toHarnessCredentials(resolved: ResolvedCredentials, github?: GitHubAccess): HarnessCredentials {
  const env = { ...resolved.env };
  const secrets = Object.values(resolved.env);
  const auth = resolved.files[0]?.content;
  if (auth !== undefined) {
    env[CODEX_AUTH_ENV] = auth;
    secrets.push(auth, ...authJsonSecrets(auth));
  }
  return {
    ...(resolved.binding ? { binding: resolved.binding } : {}),
    ...(resolved.modelPrices ? { modelPrices: resolved.modelPrices } : {}),
    env,
    secrets,
    codexAuthJson: auth !== undefined,
    ...(github ? { github } : {}),
  };
}

/** Replaces every secret in `text`, so command output and error messages are safe to show. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = redactKnownTokens(text);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret !== "") out = out.split(secret).join("***");
  }
  return out;
}

function clean(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function authJsonSecrets(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LaunchError("no_credentials", "The stored Codex auth.json is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LaunchError("no_credentials", "The stored Codex auth.json is not a JSON object.");
  }
  const leaves: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      if (node.length >= 8) leaves.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (typeof node === "object" && node !== null) {
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(parsed);
  return leaves;
}

export const MAX_SECRET_LENGTH = 8192;
export const MAX_AUTH_FILE_LENGTH = 65536;

/** Where Codex reads its login file in a boat.dev sandbox. */
export const CODEX_AUTH_PATH = "/home/user/.codex/auth.json";

interface KindInfo {
  /** The name `armada creds set <name>` takes. */
  name: string;
  label: string;
  /** What launch injects it as. A file kind has no variable. */
  env?: string;
}

/** OpenCode keys come with OpenCode (v1): the schema has no kind for them yet. */
export const CREDENTIAL_KINDS: Readonly<Record<CredentialKind, KindInfo>> = {
  claude_oauth: { name: "claude-oauth", label: "Claude Code OAuth token", env: "CLAUDE_CODE_OAUTH_TOKEN" },
  anthropic: { name: "anthropic", label: "Anthropic API key", env: "ANTHROPIC_API_KEY" },
  openai: { name: "openai", label: "OpenAI API key for Codex", env: "OPENAI_API_KEY" },
  codex_auth: { name: "codex-auth", label: "Codex auth.json" },
  boat: { name: "boat", label: "boat.dev API key" },
  modal: { name: "modal", label: "Modal token pair (id and secret)" },
  skillpack: { name: "skillpack", label: "Skillpack personal access token" },
};

/**
 * The credential kinds each harness runs on. Within one scope, the first kind a harness finds wins. The two Claude
 * kinds never reach the sandbox together. Published by `launch/options` so a client never keeps its own copy.
 */
export const HARNESS_KINDS: Readonly<Record<Harness, readonly CredentialKind[]>> = mapHarnesses(
  (descriptor) => descriptor.credentialKinds,
);

export function parseCredentialKind(name: string): CredentialKind {
  const wanted = name.trim().toLowerCase().replaceAll("_", "-");
  for (const [kind, info] of Object.entries(CREDENTIAL_KINDS)) {
    if (info.name === wanted) return kind as CredentialKind;
  }
  const known = Object.values(CREDENTIAL_KINDS)
    .map((info) => info.name)
    .join(", ");
  throw new VaultError("invalid", `Unknown credential '${name}'. Use one of: ${known}.`);
}

export function credentialName(kind: CredentialKind): string {
  return CREDENTIAL_KINDS[kind].name;
}

/**
 * Checks a value before it is encrypted. A token or key is trimmed and has no whitespace inside:
 * that is almost always a bad paste. An auth.json must be a JSON object. The error never repeats the value.
 */
export function parseCredentialValue(kind: CredentialKind, raw: string): string {
  const value = raw.trim();
  if (value === "") throw new VaultError("invalid", "The value is empty.");
  if (kind === "modal") return JSON.stringify(modalPairJson(parseModalTokenPair(value)));
  if (kind === "skillpack" && !new RegExp(`^${SKILLPACK_TOKEN_PATTERN}$`).test(value)) {
    throw new VaultError(
      "invalid",
      "A Skillpack token starts with cmp_pat_ followed by 48 lowercase hexadecimal characters.",
    );
  }
  if (kind === "anthropic" && value.startsWith("{")) {
    try {
      const { endpoint, apiKey, prices, ...extra } = JSON.parse(value);
      if (
        Object.keys(extra).length ||
        typeof apiKey !== "string" ||
        !apiKey ||
        apiKey.length > MAX_SECRET_LENGTH ||
        /\s/.test(apiKey)
      )
        throw Error();
      return JSON.stringify({
        endpoint: parseClaudeEndpoint(endpoint),
        apiKey,
        ...(prices === undefined ? {} : { prices: parseModelPriceOverrides(prices) }),
      });
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        "invalid",
        "A Claude gateway connection needs endpoint {version:1,baseUrl,auth:api-key|bearer} and apiKey.",
      );
    }
  }
  if (kind === "openai" && value.startsWith("{")) {
    try {
      const { endpoint, apiKey, prices, ...extra } = JSON.parse(value);
      if (
        Object.keys(extra).length ||
        typeof apiKey !== "string" ||
        !apiKey ||
        apiKey.length > MAX_SECRET_LENGTH ||
        /\s/.test(apiKey)
      )
        throw Error();
      return JSON.stringify({
        endpoint: parseCodexEndpoint(endpoint),
        apiKey,
        ...(prices === undefined ? {} : { prices: parseModelPriceOverrides(prices) }),
      });
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        "invalid",
        "A custom OpenAI connection needs endpoint {version:1,baseUrl,apiVersion?} and apiKey.",
      );
    }
  }
  if (kind === "codex_auth") {
    if (value.length > MAX_AUTH_FILE_LENGTH) throw new VaultError("invalid", "That auth.json is too large.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new VaultError("invalid", "A Codex auth.json is a JSON file.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
      throw new VaultError("invalid", "A Codex auth.json is a JSON object.");
    }
    return value;
  }
  if (value.length > MAX_SECRET_LENGTH) throw new VaultError("invalid", "That value is too long to be a key.");
  if (/\s/.test(value)) {
    throw new VaultError("invalid", "A key has no spaces or line breaks. Check what you pasted.");
  }
  return value;
}

/** A Modal token: its id and its secret, which only work together. Stored as one row, so never mixed. */
export interface ModalTokenPair {
  tokenId: string;
  tokenSecret: string;
}

const MODAL_TOKEN_ID = /^ak-[A-Za-z0-9]{8,200}$/;
const MODAL_TOKEN_SECRET = /^as-[A-Za-z0-9]{8,200}$/;

/**
 * Reads a Modal token pair: `{"token_id": "ak-...", "token_secret": "as-..."}` (the keys of `modal.toml`) or
 * the id and the secret separated by whitespace. Both halves are required and checked together. The error
 * never repeats a value.
 */
export function parseModalTokenPair(raw: string): ModalTokenPair {
  const value = raw.trim();
  if (value.length > MAX_SECRET_LENGTH) throw new VaultError("invalid", "That value is too long to be a token pair.");
  let id: unknown;
  let secret: unknown;
  if (value.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new VaultError("invalid", "A Modal token pair in JSON is an object with token_id and token_secret.");
    }
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    id = record.token_id ?? record.tokenId;
    secret = record.token_secret ?? record.tokenSecret;
  } else {
    const parts = value.split(/\s+/);
    if (parts.length === 2) [id, secret] = parts;
  }
  if (typeof id !== "string" || typeof secret !== "string") {
    throw new VaultError(
      "invalid",
      "A Modal token pair needs both the token id (ak-...) and the token secret (as-...).",
    );
  }
  if (!MODAL_TOKEN_ID.test(id) || !MODAL_TOKEN_SECRET.test(secret)) {
    throw new VaultError("invalid", "That is not a Modal token pair: the id starts with ak- and the secret with as-.");
  }
  return { tokenId: id, tokenSecret: secret };
}

function modalPairJson(pair: ModalTokenPair): { token_id: string; token_secret: string } {
  return { token_id: pair.tokenId, token_secret: pair.tokenSecret };
}

/**
 * The Modal token that manages a golden's sandboxes, from one scope whole. A private golden uses its
 * owner's own pair when there is one; everything else, and the fallback, is the org's. It is a management
 * credential: it stays on the server and never reaches a sandbox or a model environment.
 */
export async function resolveModalTokens(
  reader: CredentialReader,
  encryptionKey: string | undefined,
  input: { userId: string; orgId: string; visibility: Visibility },
): Promise<ModalTokenPair & { scope: CredentialScope }> {
  const scopes: [CredentialScope, string][] =
    input.visibility === "private"
      ? [
          ["user", input.userId],
          ["org", input.orgId],
        ]
      : [["org", input.orgId]];
  for (const [scope, ownerId] of scopes) {
    const row = (await reader.credentials(scope, ownerId)).find((candidate) => candidate.kind === "modal");
    if (!row) continue;
    const opened = await open(row.valueEnc, encryptionKey);
    let pair: ModalTokenPair;
    try {
      pair = parseModalTokenPair(opened);
    } catch {
      throw new VaultError("unavailable", `The stored ${scope} Modal token pair is not valid. Set it again.`);
    }
    return { ...pair, scope };
  }
  throw new VaultError(
    "missing_credential",
    input.visibility === "private"
      ? "No Modal token pair for you or your org. Run 'armada creds set modal' or ask an org admin to set the org's."
      : "Your org has no Modal token pair. An org admin sets it with 'armada creds set modal --org <name>'.",
  );
}

/**
 * Private registry access, resolved separately from model credentials. The caller must authorize org
 * membership first. User wins over org; absence means public-only registry access. Never inject this
 * key into a harness environment or use it with a custom registry origin.
 */
export async function resolveSkillpackCredential(
  reader: CredentialReader,
  encryptionKey: string | undefined,
  input: { userId: string; orgId: string },
): Promise<{ key: string; scope: CredentialScope } | null> {
  for (const [scope, ownerId] of [
    ["user", input.userId],
    ["org", input.orgId],
  ] as const) {
    const row = (await reader.credentials(scope, ownerId)).find((candidate) => candidate.kind === "skillpack");
    if (!row) continue;
    if (
      (row.status !== undefined && row.status !== "active") ||
      (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now())
    ) {
      throw new VaultError(
        "credential_refused",
        "The stored Skillpack credential is expired or revoked. Set it again.",
      );
    }
    const value = await open(row.valueEnc, encryptionKey);
    try {
      return { key: parseCredentialValue("skillpack", value), scope };
    } catch {
      throw new VaultError("unavailable", "The stored Skillpack credential is not valid. Set it again.");
    }
  }
  return null;
}

/** Ciphertext of the stored credentials. Only the server, as the service role, can read it. */
export interface StoredCredential {
  id?: string;
  kind: CredentialKind;
  valueEnc: Uint8Array;
  isDefault?: boolean;
  status?: string;
  expiresAt?: string | null;
  version?: number;
}

export interface CredentialReader {
  credentials(scope: CredentialScope, ownerId: string): Promise<StoredCredential[]>;
  orgBoatKey(orgId: string): Promise<Uint8Array | null>;
}

export interface ResolvedCredentials {
  modelPrices?: ModelPriceOverrides;
  binding?: CredentialBinding;
  /** Variables to put in the sandbox environment at launch. Never in the golden. */
  env: Record<string, string>;
  /** Files to write into the sandbox at launch. */
  files: { path: string; content: string; mode: number }[];
  /** Which kind came from which scope. No values. */
  sources: { kind: CredentialKind; scope: CredentialScope }[];
}

/**
 * Model credentials for a launch: the user's own, then the org's default. The first scope that
 * has a credential this harness can use wins, whole: user and org values are never mixed.
 */
export async function resolveCredentials(
  reader: CredentialReader,
  encryptionKey: string | undefined,
  input: { userId: string; orgId: string; harness: Harness; credentialId?: string; credentialVersion?: number },
): Promise<ResolvedCredentials> {
  const kinds = HARNESS_KINDS[input.harness];
  for (const [scope, ownerId] of [
    ["user", input.userId],
    ["org", input.orgId],
  ] as const) {
    const rows = await reader.credentials(scope, ownerId);
    const compatible = rows.filter((row) => kinds.includes(row.kind));
    const candidates =
      input.credentialId !== undefined ? rows.filter((row) => row.id === input.credentialId) : compatible;
    if (candidates.length === 0) continue;
    const defaults = candidates.filter((row) => row.isDefault);
    const row =
      input.credentialId !== undefined
        ? candidates[0]
        : defaults.length === 1
          ? defaults[0]
          : candidates.length === 1
            ? candidates[0]
            : undefined;
    if (!row) throw new VaultError("conflict", "Multiple compatible accounts: choose credentialId or set a default.");
    if (
      !kinds.includes(row.kind) ||
      (row.status !== undefined && row.status !== "active") ||
      (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) ||
      (input.credentialVersion !== undefined && row.version !== input.credentialVersion)
    ) {
      throw new VaultError(
        "credential_refused",
        "The selected credential is incompatible, expired, revoked or changed. No fallback was used.",
      );
    }
    const result = deliver(row.kind, scope, await open(row.valueEnc, encryptionKey));
    if (row.id) result.binding = { credentialId: row.id, credentialVersion: row.version ?? 1 };
    return result;
  }
  throw new VaultError(
    "missing_credential",
    `No ${input.harness === "claude" ? "Claude" : "Codex"} credential for you or your org. Run 'armada creds set ${credentialName(kinds[0] ?? "claude_oauth")}'.`,
  );
}

/**
 * The boat.dev key that pays for a golden's sandboxes. A private golden uses its owner's personal
 * key when there is one; everything else, and the fallback, is the org key. Returns the key itself:
 * the caller uses it in memory for one provider call and never stores or prints it.
 */
export async function resolveBoatKey(
  reader: CredentialReader,
  encryptionKey: string | undefined,
  input: { userId: string; orgId: string; visibility: Visibility },
): Promise<{ key: string; scope: CredentialScope }> {
  if (input.visibility === "private") {
    const personal = (await reader.credentials("user", input.userId)).find((row) => row.kind === "boat");
    if (personal) return { key: await open(personal.valueEnc, encryptionKey), scope: "user" };
  }
  const org = await reader.orgBoatKey(input.orgId);
  if (org) return { key: await open(org, encryptionKey), scope: "org" };
  throw new VaultError(
    "missing_credential",
    input.visibility === "private"
      ? "No boat.dev key for you or your org. Run 'armada creds set boat' or ask an org admin to set the org key."
      : "Your org has no boat.dev key. An org admin sets it with 'armada creds set boat --org <name>'.",
  );
}

function open(sealed: Uint8Array, encryptionKey: string | undefined): Promise<string> {
  return decryptSecret(new Uint8Array(sealed), encryptionKey).catch((error: unknown) => {
    if (error instanceof EncryptionKeyError) throw error;
    throw new VaultError("unavailable", "A stored credential could not be decrypted.");
  });
}

function deliver(kind: CredentialKind, scope: CredentialScope, value: string): ResolvedCredentials {
  const source = { kind, scope };
  if (kind === "anthropic" && value.startsWith("{")) {
    const parsed = JSON.parse(parseCredentialValue(kind, value));
    return {
      env: { ANTHROPIC_API_KEY: parsed.apiKey, [CLAUDE_ENDPOINT_ENV]: JSON.stringify(parsed.endpoint) },
      files: [],
      sources: [source],
      ...(parsed.prices ? { modelPrices: parsed.prices as ModelPriceOverrides } : {}),
    };
  }
  if (kind === "openai" && value.startsWith("{")) {
    const parsed = JSON.parse(parseCredentialValue(kind, value));
    return {
      env: { OPENAI_API_KEY: parsed.apiKey, [CODEX_ENDPOINT_ENV]: JSON.stringify(parsed.endpoint) },
      files: [],
      sources: [source],
      ...(parsed.prices ? { modelPrices: parsed.prices as ModelPriceOverrides } : {}),
    };
  }
  const env = CREDENTIAL_KINDS[kind].env;
  if (env) return { env: { [env]: value }, files: [], sources: [source] };
  return { env: {}, files: [{ path: CODEX_AUTH_PATH, content: value, mode: 0o600 }], sources: [source] };
}
