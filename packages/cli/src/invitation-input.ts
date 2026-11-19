import { VaultError } from "@armada/core";
import { parseArgs, single } from "./args.ts";

/** CLI input only: the producer's versioned DTO is constructed by the API adapter. */
export type InvitationInput =
  | { action: "create"; org?: string | undefined; email: string; role: "admin" | "member"; json: boolean }
  | { action: "list"; org?: string | undefined; json: boolean }
  | { action: "resend" | "revoke"; org?: string | undefined; id: string; json: boolean }
  | { action: "accept"; file?: string | undefined; json: boolean };

/** Never interpolate rejected arguments: they may contain an invitation token. */
export function parseInvitationInput(argv: readonly string[]): InvitationInput {
  try {
    const [action, ...rest] = argv;
    if (!["create", "list", "resend", "revoke", "accept"].includes(action ?? "")) throw invalid();
    const args = parseArgs(rest);
    const allowed = new Set([
      "--json",
      ...(action === "accept" ? ["--file"] : ["--org"]),
      ...(action === "create" ? ["--role"] : []),
    ]);
    for (const key of args.options.keys()) if (!allowed.has(key)) throw invalid();
    const json = args.options.has("--json");
    const org = single(args, "--org");
    const expected = action === "create" || action === "resend" || action === "revoke" ? 1 : 0;
    if (args.positionals.length !== expected) throw invalid();
    const value = args.positionals[0];
    if (expected && !value?.trim()) throw invalid();
    if (action === "accept") return { action, file: single(args, "--file"), json };
    if (action === "list") return { action, org, json };
    if (action === "resend" || action === "revoke") return { action, org, id: value as string, json };
    const role = single(args, "--role") ?? "member";
    if (role !== "admin" && role !== "member") throw invalid();
    return { action: "create", org, email: value as string, role, json };
  } catch {
    throw invalid();
  }
}

export async function readInvitationToken(
  file: string | undefined,
  io: { readFile(path: string): Promise<string>; readStdin(): Promise<string> },
): Promise<string> {
  let token: string;
  try {
    token = (await (file === undefined ? io.readStdin() : io.readFile(file))).trim();
  } catch {
    throw new VaultError("invalid", "Could not read invitation token. Pipe it on stdin or use --file <path>.");
  }
  if (!token) throw new VaultError("invalid", "Invitation token input is empty.");
  return token;
}

function invalid(): VaultError {
  return new VaultError(
    "invalid",
    "Run armada org invitations create <email> [--role admin|member] [--org <name|UUID>], list, resend <id>, revoke <id>, or accept [--file <path>]. Use --json for JSON output. Acceptance tokens are read only from stdin or a file.",
  );
}
