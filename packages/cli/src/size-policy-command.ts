import { GoldenError, type MachineSizePolicyResult } from "@armada/core";
import { flag, parseArgs, single } from "./args.ts";
import { createArmadaApiClient } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";

/** Full replacement avoids silently dropping defaults through a client-side patch. */
export async function sizePolicyCommand(
  argv: readonly string[],
  auth: AuthIo,
  read: (path?: string) => Promise<string>,
): Promise<number> {
  const args = parseArgs(argv);
  const allowed = new Set(["--org", "--provider", "--file", "--json"]);
  for (const key of args.options.keys())
    if (!allowed.has(key)) throw new GoldenError("invalid_config", `Unsupported size-policy option '${key}'.`);
  const [golden, ...extra] = args.positionals;
  if (!golden || extra.length) throw new GoldenError("invalid_config", "Give exactly one golden name.");
  const provider = single(args, "--provider");
  if (provider !== undefined && provider !== "boat" && provider !== "modal")
    throw new GoldenError("invalid_config", "--provider is boat or modal.");
  const file = single(args, "--file");
  let policy: unknown;
  if (file !== undefined) {
    try {
      policy = JSON.parse(await read(file === "-" ? undefined : file));
    } catch {
      throw new GoldenError("invalid_config", "Supply a size policy JSON file, or --file - for stdin.");
    }
    if (!policy || typeof policy !== "object" || Array.isArray(policy))
      throw new GoldenError("invalid_config", "Supply a versioned size policy object.");
  }
  const client = await createArmadaApiClient(auth);
  const result = await client.request<MachineSizePolicyResult>("/api/v1/golden/size-policy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      golden,
      ...(provider === undefined ? {} : { provider }),
      ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
      ...(file === undefined ? {} : { policy }),
    }),
  });
  // Preserve the actual server response, including version and configured repository selectors.
  auth.out(`${JSON.stringify(result, null, 2)}\n`);
  if (file !== undefined && !flag(args, "--json"))
    auth.err("Size defaults updated for future launches only; existing machines are unchanged.\n");
  return 0;
}
