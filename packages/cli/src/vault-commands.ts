import {
  type CredentialInfo,
  credentialName,
  type MemberInfo,
  type OrgCredentials,
  type OrgSummary,
  parseCredentialKind,
  parseRole,
  VaultError,
} from "@armada/core";
import { parseArgs, single } from "./args.ts";
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
    case "create": {
      const args = parseArgs(rest);
      const name = one(args.positionals, "armada org create <name>");
      const { org } = await control<{ org: OrgSummary }>(io.auth, "org/create", { name });
      io.auth.out(`Created org ${org.name}. You are its admin.\nid: ${org.id}\n`);
      return 0;
    }
    case "list": {
      parseArgs(rest);
      const { orgs } = await control<{ orgs: OrgSummary[] }>(io.auth, "org/list", {});
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
      io.auth.out(`Added ${member.email ?? email} as ${member.role}.\n`);
      return 0;
    }
    case "role": {
      const [email, role] = expect(
        args.positionals,
        2,
        "armada org members role <email> <admin|member> [--org <name>]",
      );
      await control(io.auth, "members/role", { org, email, role: parseRole(role ?? "") });
      io.auth.out(`${email} is now ${role}.\n`);
      return 0;
    }
    case "remove": {
      const [email] = expect(args.positionals, 1, "armada org members remove <email> [--org <name>]");
      await control(io.auth, "members/remove", { org, email });
      io.auth.out(`Removed ${email}.\n`);
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
      const value = await readValue(args, io);
      await control(io.auth, "creds/set", { scope, org, kind: credentialName(kind), value });
      io.auth.out(
        `Stored ${credentialName(kind)} for ${scope === "org" ? `org ${org}` : "you"}, encrypted. It is never shown again.\n`,
      );
      return 0;
    }
    case "list": {
      expect(args.positionals, 0, "armada creds list [--org <name>]");
      const listed = await control<{ user: CredentialInfo[]; orgs: OrgCredentials[] }>(io.auth, "creds/list", { org });
      const out = [section("You", listed.user)];
      for (const entry of listed.orgs) out.push(section(`Org ${entry.name} (${entry.role})`, entry.credentials));
      io.auth.out(`${out.join("\n")}\n`);
      return 0;
    }
    case "rm": {
      const [name] = expect(args.positionals, 1, "armada creds rm <kind> [--org <name>]");
      const kind = parseCredentialKind(name ?? "");
      await control(io.auth, "creds/rm", { scope, org, kind: credentialName(kind) });
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
