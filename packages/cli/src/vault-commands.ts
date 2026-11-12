import {
  type CredentialInfo,
  credentialName,
  type MemberInfo,
  type OrgCredentials,
  type OrgSummary,
  parseClaudeEndpoint,
  parseCodexEndpoint,
  parseCredentialKind,
  parseCredentialValue,
  parseRole,
  VaultError,
} from "@armada/core";
import { flag, parseArgs, single } from "./args.ts";
import { armadaApiUrl } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";
import { control } from "./control.ts";
import { invitationCommand } from "./invitation-commands.ts";
import { nativeCodexLogin } from "./native-model-login.ts";

export interface VaultIo {
  auth: AuthIo;
  readFile: (path: string) => Promise<string>;
  /** The secret piped in on stdin. Rejects when stdin is a terminal. */
  readStdin: () => Promise<string>;
}

export async function orgCommand(argv: readonly string[], io: VaultIo): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "use":
    case "current": {
      const args = parseArgs(rest);
      const origin = armadaApiUrl(io.auth.env.ARMADA_URL);
      const preferences = io.auth.preferences;
      if (!preferences) throw usage("Organization preferences are not available.");
      if (sub === "current") {
        expect(args.positionals, 0, "armada org current");
        io.auth.out(`${JSON.stringify({ org: (await preferences.read(origin)) ?? null })}\n`);
        return 0;
      }
      const ref = one(args.positionals, "armada org use <name|UUID|none>");
      if (ref === "none") {
        await preferences.write(origin, undefined);
        io.auth.out("Organization selection cleared.\n");
        return 0;
      }
      const { orgs } = await control<{ orgs: OrgSummary[] }>(io.auth, "org/list", {});
      const matches = orgs.filter((org) => org.id === ref || org.name.toLowerCase() === ref.toLowerCase());
      if (matches.length !== 1 || !matches[0]) throw usage("Choose one of your organizations by UUID or exact name.");
      await preferences.write(origin, matches[0].id);
      io.auth.out(`${JSON.stringify({ org: matches[0] })}\n`);
      return 0;
    }
    case "setup":
    case "connect": {
      const args = parseArgs(rest);
      const org = single(args, "--org");
      let body: Record<string, unknown> = { org };
      if (sub === "connect") {
        const provider = one(args.positionals, "armada org connect boat|modal [--org <name>] [--file <path>]");
        if (provider !== "boat" && provider !== "modal") throw usage("Provider is boat or modal.");
        body = { org, provider, value: parseCredentialValue(provider, await readValue(args, io)) };
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
    case "create": {
      const args = parseArgs(rest);
      const name = one(args.positionals, "armada org create <name>");
      const { org } = await control<{ org: OrgSummary }>(io.auth, "org/create", { name });
      io.auth.out(
        flag(args, "--json")
          ? `${JSON.stringify({ org })}\n`
          : `Created org ${org.name}. You are its admin.\nid: ${org.id}\nRequired next: pipe a provider credential into armada org connect boat|modal --org ${org.id}.\n`,
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
    case "invitations":
      return invitationCommand(rest, io);
    case "members":
      return members(rest, io);
    default:
      throw usage("Run armada org create, list, setup, connect, invitations or members.");
  }
}

async function members(argv: readonly string[], io: VaultIo): Promise<number> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest);
  const org = single(args, "--org");
  switch (sub) {
    case "list": {
      expect(args.positionals, 0, "armada org members list [--org <name>]");
      const listed = await control<{ org: OrgSummary; members: MemberInfo[] }>(io.auth, "members/list", { org });
      if (flag(args, "--json")) {
        io.auth.out(`${JSON.stringify(listed)}\n`);
        return 0;
      }
      const lines = listed.members.map((member) => `${member.email ?? member.userId}  ${member.role}`);
      io.auth.out(`${listed.org.name}\n${lines.join("\n")}\n`);
      return 0;
    }
    case "add": {
      const [email] = expect(
        args.positionals,
        1,
        "armada org members add <email> [--role admin|member] [--org <name>]",
      );
      const role = parseRole(single(args, "--role") ?? "member");
      const { member } = await control<{ member: MemberInfo }>(io.auth, "members/add", { org, email, role });
      io.auth.out(
        flag(args, "--json")
          ? `${JSON.stringify({ member })}\n`
          : `Added ${member.email ?? email} as ${member.role}.\n`,
      );
      return 0;
    }
    case "role": {
      const [email, role] = expect(
        args.positionals,
        2,
        "armada org members role <email> <admin|member> [--org <name>]",
      );
      await control(io.auth, "members/role", { org, email, role: parseRole(role ?? "") });
      io.auth.out(flag(args, "--json") ? `${JSON.stringify({ ok: true })}\n` : `${email} is now ${role}.\n`);
      return 0;
    }
    case "remove": {
      const [email] = expect(args.positionals, 1, "armada org members remove <email> [--org <name>]");
      await control(io.auth, "members/remove", { org, email });
      io.auth.out(flag(args, "--json") ? `${JSON.stringify({ ok: true })}\n` : `Removed ${email}.\n`);
      return 0;
    }
    default:
      throw usage("Run armada org members list, add, role or remove.");
  }
}

export async function credsCommand(argv: readonly string[], io: VaultIo): Promise<number> {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, [
    "--id",
    "--expected-version",
    "--base-url",
    "--api-version",
    "--endpoint-auth",
    "--sandbox-id",
  ]);
  const org = single(args, "--org");
  const scope = org === undefined ? "user" : "org";
  if (
    sub !== "set" &&
    (args.options.has("--base-url") || args.options.has("--api-version") || args.options.has("--endpoint-auth"))
  )
    throw usage("Endpoint options are only supported by creds set openai or anthropic.");
  switch (sub) {
    case "holders":
    case "release": {
      const [id] = expect(
        args.positionals,
        1,
        "armada creds holders|release <account-UUID> --expected-version <revision> [--org <UUID>] [--sandbox-id <holder-UUID>]",
      );
      const revision = single(args, "--expected-version");
      if (!revision || !/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision)))
        throw usage("Holder inspection and release require --expected-version <positive integer>.");
      const target = { id, version: Number(revision), scope, org };
      if (sub === "holders") {
        const result = await control(io.auth, "creds/accounts/holder", target);
        io.auth.out(`${JSON.stringify(result)}\n`);
      } else {
        const sandboxId = single(args, "--sandbox-id");
        if (!sandboxId)
          throw usage(
            "Release requires --sandbox-id <holder-UUID> from creds holders; recorded holders are permanently deleted.",
          );
        await control(io.auth, "creds/accounts/release", {
          ...target,
          sandboxId,
          ...(single(args, "--file") ? { value: await readValue(args, io) } : {}),
        });
        io.auth.out("Subscription holder released. Inspect holders again before launching.\n");
      }
      return 0;
    }
    case "login":
    case "import": {
      const [harness] = expect(
        args.positionals,
        1,
        "armada creds import claude|codex --name <name> [--file <path>] [--org <name>]",
      );
      if (harness !== "claude" && harness !== "codex") throw usage("Native import supports claude or codex.");
      const id = single(args, "--id");
      const revision = single(args, "--expected-version");
      if (id && (!revision || !/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision))))
        throw usage("Replacing an account requires --expected-version <positive integer>.");
      if (!id && revision) throw usage("--expected-version requires --id.");
      const name = single(args, "--name");
      if (!id && !name?.trim()) throw usage("Creating an account requires --name.");
      if (sub === "login" && harness !== "codex")
        throw usage(
          "For Claude, run claude setup-token locally and import its token securely with armada creds import claude.",
        );
      const kind = harness === "claude" ? "claude_oauth" : "codex_auth";
      let raw: string;
      if (sub === "login") {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        try {
          raw = await nativeCodexLogin({
            path: io.auth.env.PATH ?? "/usr/bin:/bin",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
            device: (url, code) => io.auth.err(`Open ${url} and enter ${code} to authorize native Codex.\n`),
          });
        } finally {
          process.removeListener("SIGINT", cancel);
          process.removeListener("SIGTERM", cancel);
        }
      } else raw = await readValue(args, io);
      const value = parseCredentialValue(kind, raw);
      if (kind === "codex_auth") {
        const native = JSON.parse(value);
        if (
          !native.tokens ||
          typeof native.tokens.access_token !== "string" ||
          typeof native.tokens.refresh_token !== "string" ||
          typeof native.tokens.account_id !== "string"
        )
          throw usage(
            "Import the native Codex ChatGPT auth.json, with ChatGPT token fields, using only this tool's own native login.",
          );
      }
      // Native consent occurs locally before import. Only the Armada API receives
      // this secret; never print its response, which must not become a secret sink.
      await control(io.auth, "creds/accounts/set", {
        scope,
        org,
        kind: credentialName(kind),
        name,
        value,
        ...(id ? { id, expectedVersion: Number(revision) } : {}),
      });
      io.auth.out("Imported native credential account, encrypted. Allowance may be unavailable.\n");
      return 0;
    }
    case "set": {
      const [name] = expect(args.positionals, 1, "armada creds set <kind> [--org <name>] [--file <path>]");
      const kind = parseCredentialKind(name ?? "");
      const baseUrl = single(args, "--base-url");
      const apiVersion = single(args, "--api-version");
      const endpointAuth = single(args, "--endpoint-auth");
      if (apiVersion !== undefined && baseUrl === undefined) throw usage("--api-version requires --base-url.");
      if (endpointAuth !== undefined && (baseUrl === undefined || kind !== "anthropic"))
        throw usage("--endpoint-auth requires creds set anthropic --base-url.");
      if (apiVersion !== undefined && kind !== "openai") throw usage("--api-version supports openai (Codex) only.");
      if (baseUrl !== undefined && kind !== "openai" && kind !== "anthropic")
        throw usage("--base-url supports openai (Codex) or anthropic (Claude Code) only.");
      if (baseUrl !== undefined && !single(args, "--name") && !single(args, "--id"))
        throw usage("A custom endpoint requires --name to create an account or --id to replace one.");
      let endpoint: ReturnType<typeof parseCodexEndpoint> | ReturnType<typeof parseClaudeEndpoint> | undefined;
      if (baseUrl !== undefined) {
        try {
          endpoint =
            kind === "anthropic"
              ? parseClaudeEndpoint({ version: 1, baseUrl, auth: endpointAuth ?? "bearer" })
              : parseCodexEndpoint({ version: 1, baseUrl, ...(apiVersion !== undefined ? { apiVersion } : {}) });
        } catch {
          throw usage(
            kind === "anthropic"
              ? "Invalid Claude gateway. Use an HTTPS base URL without URL credentials, query or fragment, and --endpoint-auth bearer or api-key."
              : "Invalid Codex endpoint. Use an HTTPS Responses base URL without URL credentials, query or fragment.",
          );
        }
      }
      const raw = await readValue(args, io);
      if (endpoint && raw.trim().startsWith("{"))
        throw usage("With --base-url, supply only the API key through stdin or --file, not connection JSON.");
      const value = parseCredentialValue(kind, endpoint ? JSON.stringify({ endpoint, apiKey: raw.trim() }) : raw);
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
        },
      );
      if (flag(args, "--json")) {
        io.auth.out(`${JSON.stringify({ ok: true })}\n`);
        return 0;
      }
      if (endpoint)
        io.auth.out(
          kind === "anthropic"
            ? "Custom Claude gateway: Modal only; supports Claude models only and requires Anthropic Messages with streaming/tool use.\n"
            : "Custom Codex endpoint: Modal only; requires the Responses API (not chat completions).\n",
        );
      io.auth.out(
        `Stored ${credentialName(kind)} for ${scope === "org" ? `org ${org}` : "you"}, encrypted. It is never shown again.\n`,
      );
      return 0;
    }
    case "list": {
      expect(args.positionals, 0, "armada creds list [--org <name>]");
      const listed = await control<{ user: CredentialInfo[]; orgs: OrgCredentials[] }>(io.auth, "creds/list", { org });
      if (flag(args, "--json")) {
        io.auth.out(`${JSON.stringify(listed)}\n`);
        return 0;
      }
      const out = [section("You", listed.user)];
      for (const entry of listed.orgs) out.push(section(`Org ${entry.name} (${entry.role})`, entry.credentials));
      io.auth.out(`${out.join("\n")}\n`);
      return 0;
    }
    case "rename":
    case "default":
    case "remove": {
      const [id, name] = expect(
        args.positionals,
        sub === "rename" ? 2 : 1,
        `armada creds ${sub} <id>${sub === "rename" ? " <name>" : ""}`,
      );
      const result = await control(io.auth, `creds/accounts/${sub}`, { scope, org, id, name });
      io.auth.out(`${JSON.stringify(result)}\n`);
      return 0;
    }
    case "rm": {
      const [name] = expect(args.positionals, 1, "armada creds rm <kind> [--org <name>]");
      const kind = parseCredentialKind(name ?? "");
      await control(io.auth, "creds/rm", { scope, org, kind: credentialName(kind) });
      if (flag(args, "--json")) {
        io.auth.out(`${JSON.stringify({ ok: true })}\n`);
        return 0;
      }
      io.auth.out(`Removed ${credentialName(kind)} for ${scope === "org" ? `org ${org}` : "you"}.\n`);
      return 0;
    }
    default:
      throw usage("Run armada creds login, import, set, list, rename, default, remove or rm.");
  }
}

/** The value comes from a file or from stdin, never from an argument: arguments end up in shell history. */
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

function section(title: string, rows: CredentialInfo[]): string {
  if (rows.length === 0) return `${title}: none`;
  const lines = rows.map(
    (row) =>
      `  ${credentialName(row.kind)}${row.id ? `  ${row.id}  ${row.name}  ${row.status}${row.isDefault ? " (default)" : ""}` : ""}${row.createdAt ? `  ${row.createdAt.slice(0, 10)}` : ""}`,
  );
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
