import { AuthError } from "@armada/auth";
import {
  type CredentialInfo,
  credentialName,
  isModelConnectionTestResult,
  type OrgCredentials,
  type OrgSummary,
  parseClaudeEndpoint,
  parseCodexEndpoint,
  parseConnectionModels,
  parseCredentialKind,
  parseCredentialValue,
  parseModelPriceOverrides,
  parseOpenCodeEndpoint,
  VaultError,
} from "@armada/core";
import { antigravityLoginOperations, antigravityLoginPath, controlRouteKey, orgProvider } from "@armada/core/contract";
import { ArmadaApiError } from "./api-responses.ts";
import { acceptedOptions, flag, parseArgs, single } from "./args.ts";
import type { AuthIo } from "./auth-commands.ts";
import { authorizationUrl } from "./connection-authorization.ts";
import { control } from "./control.ts";
import { validateNativeCodexAuth } from "./native-login-protocol.ts";
import { nativeCodexLogin } from "./native-model-login.ts";
import type { Deps } from "./run.ts";
import { createSdkCommandClient } from "./sdk-session.ts";
import { promptSecret } from "./secret-input.ts";

export interface VaultIo {
  auth: AuthIo;
  readFile: (path: string) => Promise<string>;
  readStdin: (prompt?: string) => Promise<string>;
}

type ListedCredential = CredentialInfo & {
  exhaustedUntil?: string;
  monthlySpend?: { periodStart: string; usd: string; unpricedTurns: number };
};

export function vaultIo(auth: AuthIo, deps: Pick<Deps, "readFile" | "readStdin">) {
  return {
    auth,
    readFile: deps.readFile ?? ((path) => Bun.file(path).text()),
    readStdin:
      deps.readStdin ??
      ((prompt) => (process.stdin.isTTY ? promptSecret(process.stdin, process.stderr, prompt) : Bun.stdin.text())),
  } satisfies VaultIo;
}

export async function orgCommand(argv: readonly string[], io: VaultIo): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "setup":
    case "connect": {
      const args = parseArgs(rest);
      const org = single(args, "--org");
      let body: Record<string, unknown> = { org };
      if (sub === "connect") {
        const provider = orgProvider.safeParse(
          one(args.positionals, "armada org connect boat|modal [--org <name>] [--file <path>]"),
        );
        if (!provider.success) throw usage("Provider is boat or modal.");
        body = { org, provider: provider.data, value: parseCredentialValue(provider.data, await readValue(args, io)) };
      } else expect(args.positionals, 0, "armada org setup [--org <name>]");
      const status = await control<{
        org: OrgSummary;
        ready: boolean;
        providers: { provider: string; configured: boolean }[];
      }>(io.auth, `org/provider/${sub === "setup" ? "status" : "connect"}`, body);
      io.auth.out(
        flag(args, "--json")
          ? `${JSON.stringify(status)}\n`
          : `${status.org.name}: ${status.ready ? "ready" : "provider connection required"}\n${status.providers.map((p) => `${p.provider}: ${p.configured ? "configured" : "not configured"}`).join("\n")}\n`,
      );
      return 0;
    }
    case "list": {
      const args = parseArgs(rest);
      const { orgs } = await control<{ orgs: OrgSummary[] }>(io.auth, "org/list", {});
      if (flag(args, "--json")) {
        io.auth.out(`${JSON.stringify({ orgs })}\n`);
        return 0;
      }
      io.auth.out(
        orgs.length === 0 ? "No orgs.\n" : `${orgs.map((org) => `${org.name}  ${org.role}  ${org.id}`).join("\n")}\n`,
      );
      return 0;
    }
    default:
      throw new AuthError(`unknown command 'org ${sub}'. Run 'armada --help'.`, "usage");
  }
}

const priceOptions = ["--price-model", "--price-input", "--price-cached-input", "--price-output"];

export function parseAccountArgs(argv: readonly string[]) {
  return parseArgs(
    argv,
    [
      "--kind",
      "--max-agents",
      "--id",
      "--expected-version",
      "--base-url",
      "--models",
      "--api-version",
      "--endpoint-auth",
      ...priceOptions,
    ],
    ["--unlimited"],
  );
}

export async function modelAccountCommand(
  sub: string | undefined,
  args: ReturnType<typeof parseArgs>,
  io: VaultIo,
): Promise<number> {
  const org = single(args, "--org");
  const scope = org === undefined ? "user" : "org";
  const maxAgents = agentLimit(args);
  if (args.options.has("--kind") && sub !== "rm") throw usage("--kind requires account rm.");
  if (
    sub !== "add" &&
    (args.options.has("--base-url") ||
      args.options.has("--models") ||
      args.options.has("--api-version") ||
      args.options.has("--endpoint-auth") ||
      priceOptions.some((name) => args.options.has(name)))
  )
    throw usage("Endpoint options are only supported by account add openai, anthropic or opencode.");
  switch (true) {
    case sub === "login":
    case sub === "import": {
      const [harness] = expect(
        args.positionals,
        1,
        `armada account ${sub} ${sub === "login" ? "codex|antigravity" : "claude|codex|antigravity"} --name <name> [--org <name>]`,
      );
      if (sub === "login" && harness === "antigravity") return antigravityLogin(args, io);
      if (harness !== "claude" && harness !== "codex" && harness !== "antigravity")
        throw usage("Native import supports claude, codex or antigravity.");
      if (harness === "antigravity" && !single(args, "--file"))
        throw usage("Antigravity import requires --file <token file>.");
      const id = single(args, "--id");
      const revision = single(args, "--expected-version");
      if (id && (!revision || !/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision))))
        throw usage("Replacing an account requires --expected-version <positive integer>.");
      if (!id && revision) throw usage("--expected-version requires --id.");
      const name = single(args, "--name");
      if (!id && !name?.trim()) throw usage("Creating an account requires --name.");
      if (sub === "login" && harness !== "codex")
        throw usage(
          "For Claude, run claude setup-token locally and import its token securely with armada account import claude.",
        );
      const kind = harness === "claude" ? "claude_oauth" : harness === "codex" ? "codex_auth" : "antigravity";
      let raw: string;
      if (sub === "login") {
        const controller = new AbortController();
        const interrupt = () => controller.abort("SIGINT");
        const terminate = () => controller.abort("SIGTERM");
        const hangup = () => controller.abort("SIGHUP");
        process.once("SIGINT", interrupt);
        process.once("SIGTERM", terminate);
        process.once("SIGHUP", hangup);
        try {
          raw = await nativeCodexLogin({
            path: io.auth.env.PATH ?? "/usr/bin:/bin",
            signal: controller.signal,
            device: (url, code) =>
              io.auth.err(
                `Keep this terminal/session open until the account is published; closing the parent shell cancels login. Use tmux or screen for a persistent remote session.\nOpen ${url} and enter ${code} to authorize native Codex.\n`,
              ),
          });
        } finally {
          process.removeListener("SIGINT", interrupt);
          process.removeListener("SIGTERM", terminate);
          process.removeListener("SIGHUP", hangup);
        }
      } else raw = await readValue(args, io);
      const value = kind === "antigravity" ? importAntigravityToken(raw) : parseCredentialValue(kind, raw);
      if (kind === "codex_auth") validateNativeCodexAuth(value, false);
      await control(io.auth, "creds/accounts/set", {
        scope,
        org,
        kind: credentialName(kind),
        name,
        value,
        ...(id ? { id, expectedVersion: Number(revision) } : {}),
        ...(maxAgents !== undefined ? { maxAgents } : {}),
      });
      io.auth.out("Imported native credential account, encrypted. Allowance may be unavailable.\n");
      return 0;
    }
    case sub === "test": {
      const id = one(
        args.positionals,
        "armada account test <sandbox-id> --model <deployment-model> [--org <name>] [--json]",
      );
      if ([...args.options.keys()].some((key) => !["--org", "--model", "--json"].includes(key)))
        throw usage("Connection tests accept only --model, --org and --json; keys and URLs are never accepted.");
      const model = single(args, "--model");
      if (!model) throw usage("Connection tests require --model <deployment-model>.");
      const response = await control<{ test: unknown } | null>(
        io.auth,
        "sandbox/test-model-connection",
        {
          id,
          model,
          org,
        },
        AbortSignal.timeout(45000),
      );
      if (!response || !isModelConnectionTestResult(response.test))
        throw new VaultError("unavailable", "The server returned an invalid connection-test result.");
      const result = response.test;
      if (flag(args, "--json")) io.auth.out(JSON.stringify({ id, ...result }) + "\n");
      else if (result.ok)
        io.auth.out(
          "Connection accepted (HTTP " + result.status + "). This is not a full harness compatibility test.\n",
        );
      else
        io.auth.out(
          "Connection check failed: " +
            (result.status === null
              ? "connection failed or timed out"
              : "HTTP " +
                result.status +
                " " +
                (result.code ?? result.error) +
                (result.status === 401 ? " (account authentication rejected; check the saved key)" : "") +
                (result.status === 429 && result.retryAfterSeconds !== undefined
                  ? ` (retry after ${result.retryAfterSeconds} seconds)`
                  : "")) +
            ".\n",
        );
      return result.ok ? 0 : 1;
    }
    case sub === "add": {
      const [name] = expect(args.positionals, 1, "armada account add <kind> [--org <name>] [--file <path>]");
      const kind = parseCredentialKind(name ?? "");
      const baseUrl = single(args, "--base-url");
      const apiVersion = single(args, "--api-version");
      const rawModels = single(args, "--models");
      if ((kind === "openai" || kind === "opencode") && baseUrl !== undefined && !rawModels?.trim())
        throw usage("Custom Codex/OpenCode endpoints require --models with exact deployment/model IDs.");
      if (rawModels !== undefined && ((kind !== "openai" && kind !== "opencode") || baseUrl === undefined))
        throw usage("--models requires account add openai or opencode --base-url.");
      let models: string[] | undefined;
      if (kind === "openai" && rawModels !== undefined) {
        try {
          models = parseConnectionModels(rawModels.split(",").map((id) => id.trim()));
        } catch {
          throw usage("--models requires 1–32 exact deployment/model IDs; for Azure use resource deployment names.");
        }
      }
      const endpointAuth = single(args, "--endpoint-auth");
      if (apiVersion !== undefined && baseUrl === undefined) throw usage("--api-version requires --base-url.");
      if (endpointAuth !== undefined && (baseUrl === undefined || kind !== "anthropic"))
        throw usage("--endpoint-auth requires account add anthropic --base-url.");
      if (apiVersion !== undefined && kind !== "openai") throw usage("--api-version supports openai (Codex) only.");
      if (baseUrl !== undefined && kind !== "openai" && kind !== "anthropic" && kind !== "opencode")
        throw usage("--base-url supports openai (Codex), anthropic (Claude Code) or opencode.");
      if (baseUrl !== undefined && !single(args, "--name") && !single(args, "--id"))
        throw usage("A custom endpoint requires --name to create an account or --id to replace one.");
      let endpoint:
        | ReturnType<typeof parseCodexEndpoint>
        | ReturnType<typeof parseClaudeEndpoint>
        | ReturnType<typeof parseOpenCodeEndpoint>
        | undefined;
      if (baseUrl !== undefined) {
        try {
          endpoint =
            kind === "opencode"
              ? parseOpenCodeEndpoint({
                  version: 1,
                  baseUrl,
                  models: (single(args, "--models") ?? "").split(",").map((id) => id.trim()),
                })
              : kind === "anthropic"
                ? parseClaudeEndpoint({ version: 1, baseUrl, auth: endpointAuth ?? "bearer" })
                : parseCodexEndpoint({ version: 1, baseUrl, ...(apiVersion !== undefined ? { apiVersion } : {}) });
        } catch {
          throw usage(
            kind === "opencode"
              ? "Invalid OpenCode endpoint. Use an HTTPS base URL and comma-separated --models upstream model IDs."
              : kind === "anthropic"
                ? "Invalid Claude gateway. Use an HTTPS base URL without URL credentials, query or fragment, and --endpoint-auth bearer or api-key."
                : "Invalid Codex endpoint. Use an HTTPS Responses base URL without URL credentials, query or fragment.",
          );
        }
      }
      let prices: ReturnType<typeof parseModelPriceOverrides> | undefined;
      if (priceOptions.some((name) => args.options.has(name))) {
        if (!endpoint) throw usage("Price options require account add openai, anthropic or opencode --base-url.");
        const model = single(args, "--price-model");
        const input = single(args, "--price-input");
        const output = single(args, "--price-output");
        const cacheRead = single(args, "--price-cached-input");
        if (!model || input === undefined || output === undefined)
          throw usage(
            "Supply --price-model, --price-input and --price-output together; --price-cached-input is optional.",
          );
        prices = parseModelPriceOverrides({
          [model]: { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) },
        });
      }
      const raw = await readValue(args, io);
      if (endpoint && raw.trim().startsWith("{"))
        throw usage("With --base-url, supply only the API key through stdin or --file, not connection JSON.");
      const value = parseCredentialValue(
        kind,
        endpoint
          ? JSON.stringify({
              endpoint,
              apiKey: raw.trim(),
              ...(models ? { models } : {}),
              ...(prices ? { prices } : {}),
            })
          : raw,
      );
      await control(
        io.auth,
        single(args, "--id") !== undefined || single(args, "--name") !== undefined ? "creds/accounts/set" : "creds/set",
        {
          scope,
          org,
          kind: credentialName(kind),
          value,
          expectedVersion:
            single(args, "--expected-version") === undefined ? undefined : Number(single(args, "--expected-version")),
          id: single(args, "--id"),
          name: single(args, "--name"),
          ...(maxAgents !== undefined ? { maxAgents } : {}),
        },
      );
      if (flag(args, "--json")) {
        io.auth.out(`${JSON.stringify({ ok: true })}\n`);
        return 0;
      }
      if (endpoint) {
        const guidance =
          kind === "opencode"
            ? "Custom OpenCode endpoint: use --model armada/<upstream-model>."
            : kind === "anthropic"
              ? "Custom Claude gateway: supports Claude models only and requires Anthropic Messages with streaming/tool use."
              : "Custom Codex endpoint: requires the Responses API (not chat completions).";
        io.auth.out(`${guidance} Available on Modal, Docker hosts and runtime-backed Boat.\n`);
      }
      io.auth.out(
        `Stored ${credentialName(kind)} for ${scope === "org" ? `org ${org}` : "you"}, encrypted. It is never shown again.\n`,
      );
      return 0;
    }
    case sub === "ls": {
      expect(args.positionals, 0, "armada account ls [--org <name>]");
      const listed = await control<{
        user: ListedCredential[];
        orgs: (Omit<OrgCredentials, "credentials"> & { credentials: ListedCredential[] })[];
      }>(io.auth, "creds/list", { org });
      if (flag(args, "--json")) {
        io.auth.out(`${JSON.stringify(listed)}\n`);
        return 0;
      }
      const out = [section("You", listed.user)];
      for (const entry of listed.orgs) out.push(section(`Org ${entry.name} (${entry.role})`, entry.credentials));
      io.auth.out(`${out.join("\n")}\n`);
      return 0;
    }
    case sub === "limits": {
      const id = one(args.positionals, "armada account limits <account-id> --max-agents N | --unlimited");
      if (maxAgents === undefined) throw usage("Choose --max-agents N or --unlimited.");
      const model = single(args, "--model");
      const result = await control(io.auth, "creds/accounts/limits", {
        scope,
        org,
        id,
        maxAgents,
        ...(model ? { model } : {}),
      });
      io.auth.out(`${JSON.stringify(result)}\n`);
      return 0;
    }
    case sub === "default":
    case sub === "rm": {
      const kindInput = single(args, "--kind");
      if (kindInput === undefined) {
        const id = one(args.positionals, `armada account ${sub} <id>`);
        const action = sub === "rm" ? "remove" : "default";
        const result = await control(io.auth, `creds/accounts/${action}`, { scope, org, id });
        io.auth.out(`${JSON.stringify(result)}\n`);
        return 0;
      }
      expect(args.positionals, 0, "armada account rm --kind <kind> [--org <name>]");
      const kind = parseCredentialKind(kindInput);
      await control(io.auth, "creds/rm", { scope, org, kind: credentialName(kind) });
      if (flag(args, "--json")) {
        io.auth.out(`${JSON.stringify({ ok: true })}\n`);
        return 0;
      }
      io.auth.out(`Removed ${credentialName(kind)} for ${scope === "org" ? `org ${org}` : "you"}.\n`);
      return 0;
    }
    default:
      throw usage("See armada account --help for account commands.");
  }
}

async function readValue(args: ReturnType<typeof parseArgs>, io: VaultIo): Promise<string> {
  const file = single(args, "--file");
  if (file !== undefined) {
    try {
      return await io.readFile(file);
    } catch {
      throw new VaultError("invalid", `Could not read '${file}'.`);
    }
  }
  try {
    return await io.readStdin();
  } catch {
    throw usage("Pipe the value on stdin or pass --file <path>. It is not taken as an argument.");
  }
}

function monthlyApiSpend(row: ListedCredential) {
  if (!row.id || (row.kind !== "openai" && row.kind !== "anthropic" && row.kind !== "opencode")) return "";
  const spend = row.monthlySpend;
  const unpriced = spend?.unpricedTurns ?? 0;
  const usd = spend && (spend.usd !== "0" || unpriced === 0) ? spend.usd : "—";
  const note = unpriced > 0 ? ` (${unpriced} unpriced ${unpriced === 1 ? "turn" : "turns"})` : "";
  return `  API: ${usd} USD this month${note}`;
}

function section(title: string, rows: ListedCredential[]): string {
  if (rows.length === 0) return `${title}: none`;
  const lines = rows.map((row) => {
    const exhaustion = row.exhaustedUntil
      ? `  exhausted until ${row.exhaustedUntil.slice(0, 16).replace("T", " ")} UTC`
      : "";
    return `  ${credentialName(row.kind)}${row.id ? `  ${row.id}  ${row.name}  ${row.status}${row.isDefault ? " (default)" : ""}` : ""}${row.id ? `  ${row.runningAgents ?? 0} working / ${row.waitingAgents ?? 0} waiting-for-slot / ${row.maxAgents ?? "unlimited"} max` : ""}${exhaustion}${monthlyApiSpend(row)}${Object.entries(
      row.modelCounts ?? {},
    )
      .map(
        ([model, counts]) =>
          `\n    ${model}: ${counts.runningAgents} working / ${counts.waitingAgents} waiting / ${row.modelLimits?.[model] ?? "unlimited"} max`,
      )
      .join("")}${row.createdAt ? `  ${row.createdAt.slice(0, 10)}` : ""}`;
  });
  return `${title}:\n${lines.join("\n")}`;
}

function one(positionals: string[], form: string): string {
  const [value] = expect(positionals, 1, form);
  return value ?? "";
}

function expect(positionals: string[], count: number, form: string): string[] {
  if (positionals.length !== count) throw usage(`Run ${form}.`);
  return positionals;
}

function usage(message: string): VaultError {
  return new VaultError("invalid", message);
}

function agentLimit(args: ReturnType<typeof parseArgs>): number | null | undefined {
  const raw = single(args, "--max-agents");
  if (flag(args, "--unlimited")) {
    if (raw !== undefined) throw usage("Choose --max-agents or --unlimited, not both.");
    return null;
  }
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value))
    throw usage("--max-agents must be a positive integer.");
  return value;
}

function importAntigravityToken(raw: string) {
  let token: unknown;
  try {
    const file = JSON.parse(raw);
    token = file?.token;
  } catch {
    throw usage("Invalid Antigravity token file.");
  }
  return parseCredentialValue("antigravity", JSON.stringify({ method: "google", token }));
}

async function antigravityLogin(args: ReturnType<typeof parseArgs>, { auth, readStdin }: VaultIo) {
  acceptedOptions(args, "account login antigravity", ["--name", "--id", "--expected-version", "--org"]);
  const { startAntigravityLogin: start, completeAntigravityLogin: complete } = antigravityLoginOperations;
  const revision = single(args, "--expected-version");
  const name = single(args, "--name");
  const id = single(args, "--id");
  const target = start.input.body.safeParse({
    ...(name === undefined ? {} : { name }),
    ...(id === undefined ? {} : { id }),
    ...(revision === undefined ? {} : { expectedVersion: /^[1-9][0-9]*$/.test(revision) ? Number(revision) : NaN }),
    org: single(args, "--org"),
  });
  if (!target.success) throw usage("Give --name, or --id with --expected-version.");
  const client = await createSdkCommandClient(auth, { preserveServerErrors: true });
  const startedParsed = start.output.safeParse(
    await client.control(controlRouteKey(start.route), target.data, AbortSignal.timeout(310_000)),
  );
  if (!startedParsed.success)
    throw new VaultError("unavailable", "The server returned an invalid Antigravity sign-in response.");
  const started = startedParsed.data;
  const path = antigravityLoginPath(started.loginId);
  const url = authorizationUrl(started.authorizationUrl);
  if (new URL(url).origin !== "https://accounts.google.com")
    throw new VaultError("unavailable", "The server returned an unsafe Google link.");
  auth.err(`Open this link to sign in with Google: ${url}\n`);
  try {
    if (auth.interactive) auth.open(url);
  } catch {}
  let code: string;
  try {
    code = (await readStdin("Paste the Google code or callback URL, then Enter: ")).replace(/\r?\n$/, "");
    if (!code) throw usage("Enter the code from Google.");
  } catch {
    await client.request(path, { method: "DELETE" }).catch(() => {});
    throw usage("Antigravity sign-in cancelled. Start sign-in again.");
  }
  const result = await client
    .control(controlRouteKey({ path }), { code }, AbortSignal.timeout(310_000))
    .catch(async (error: unknown) => {
      if (error instanceof ArmadaApiError && (error.status === 400 || error.status === 404))
        await client.request(path, { method: "DELETE" }).catch(() => {});
      throw error;
    });
  const accountParsed = complete.output.safeParse(result);
  if (!accountParsed.success)
    throw new VaultError("unavailable", "The server returned an invalid Antigravity account response.");
  const account = accountParsed.data;
  auth.out(`${JSON.stringify(account, null, 2)}\n`);
  return 0;
}
