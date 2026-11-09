import {
  type CredentialInfo,
  credentialName,
  type MemberInfo,
  type OrgCredentials,
  type OrgSummary,
  parseCredentialKind,
  parseCredentialValue,
  parseRole,
  VaultError,
} from "@armada/core";
import { flag, parseArgs, single } from "./args.ts";
import { armadaApiUrl } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";
import { control } from "./control.ts";

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
    case "create": {
      const args = parseArgs(rest);
      const name = one(args.positionals, "armada org create <name>");
      const { org } = await control<{ org: OrgSummary }>(io.auth, "org/create", { name });
      io.auth.out(
        flag(args, "--json")
          ? `${JSON.stringify({ org })}\n`
          : `Created org ${org.name}. You are its admin.\nid: ${org.id}\n`,
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
    case "members":
      return members(rest, io);
    default:
      throw usage("Run armada org create, list or members.");
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
  const args = parseArgs(rest);
  const org = single(args, "--org");
  const scope = org === undefined ? "user" : "org";
  switch (sub) {
    case "set": {
      const [name] = expect(args.positionals, 1, "armada creds set <kind> [--org <name>] [--file <path>]");
      const kind = parseCredentialKind(name ?? "");
      const value = parseCredentialValue(kind, await readValue(args, io));
      await control(io.auth, "creds/set", { scope, org, kind: credentialName(kind), value });
      if (flag(args, "--json")) {
        io.auth.out(`${JSON.stringify({ ok: true })}\n`);
        return 0;
      }
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
      throw usage("Run armada creds set, list or rm.");
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
    (row) => `  ${credentialName(row.kind)}${row.createdAt ? `  ${row.createdAt.slice(0, 10)}` : ""}`,
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
