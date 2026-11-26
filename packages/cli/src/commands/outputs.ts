import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AuthError } from "@armada/auth";
import { GoldenError } from "@armada/core";
import { sandboxOutputOperations } from "@armada/core/contract/sandbox-outputs";
import { acceptedOptions, flag, parseArgs, single, uuid } from "../args.ts";
import { resolveSandboxId } from "../current-sandbox.ts";
import { createArmadaSdkReader } from "../sdk-session.ts";
import type { Command } from "./command.ts";

const contract = sandboxOutputOperations.readSandboxOutput;

const outputs: Command["run"] = async (argv, { io, deps, auth }) => {
  const args = parseArgs(argv, ["-o", "--output"]);
  acceptedOptions(args, "outputs", ["--id", "--org", "--json", "-o", "--output"]);
  const [name] = args.positionals;
  const shortOutput = single(args, "-o");
  const longOutput = single(args, "--output");
  if (shortOutput !== undefined && longOutput !== undefined)
    throw new GoldenError("invalid_config", "Use -o or --output, not both.");
  const destination = shortOutput ?? longOutput;
  if (args.positionals.length > 1 || (destination !== undefined && (!name || !destination)))
    throw new GoldenError("invalid_config", "Use armada outputs [NAME] [-o DIR] [--id ID].");
  if (
    name !== undefined &&
    (!contract.input.path.name.safeParse(name).success ||
      (process.platform === "win32" &&
        (/[. ]$/.test(name) ||
          /[:*?"<>|]/.test(name) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))))
  )
    throw new GoldenError("invalid_config", "Invalid output file name.");

  const read = await createArmadaSdkReader({ ...auth, fetch: deps.fetch ?? auth.fetch });
  const id = await resolveSandboxId(single(args, "--id"), auth.env, deps.sandboxFile, single(args, "--org"), (input) =>
    read((sdk) => sdk.list(input)),
  );
  uuid(id, "sandbox id");
  const json = flag(args, "--json");
  if (name === undefined) {
    const snapshot = await read((sdk) => sdk.outputs.list({ id }));
    if (!sandboxOutputOperations.listSandboxOutputs.output.safeParse(snapshot).success)
      throw new AuthError("Armada returned an invalid output snapshot.", "unavailable");
    if (json) {
      io.out(`${JSON.stringify(snapshot)}\n`);
    } else {
      if (snapshot.unavailable) io.out("Output collection is unavailable for this sandbox.\n");
      if (!snapshot.files.length && !snapshot.unavailable) io.out("No saved outputs.\n");
      for (const file of snapshot.files)
        io.out(`${JSON.stringify(file.name)}\t${file.skipped ?? `${file.size} bytes`}\n`);
    }
    return 0;
  }

  const dir = resolve(destination ?? ".");
  const path = join(dir, name);
  const signal = AbortSignal.timeout(300_000);
  const response = await read((sdk) => sdk.outputs.get({ id, name }, { signal }), signal);
  if (response.status !== 200 || (!response.body && response.headers.get("content-length") !== "0")) {
    await response.body?.cancel();
    throw new AuthError("Armada did not return a complete output file.", "unavailable");
  }
  let temporaryDir: string | undefined;
  try {
    await mkdir(dir, { recursive: true });
    temporaryDir = await mkdtemp(join(dir, ".armada-output-"));
    const temporaryFile = join(temporaryDir, "download");
    await writeFile(temporaryFile, "", { mode: 0o600 });
    if (response.body) await Bun.write(temporaryFile, response);
    await link(temporaryFile, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST")
      throw new AuthError(
        `Output file ${JSON.stringify(path)} already exists. Choose a different destination directory or remove the existing file.`,
        "conflict",
      );
    throw new AuthError("Could not save the sandbox output. Check the destination and retry.", "unavailable");
  } finally {
    if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true });
    if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
  }
  io.out(json ? `${JSON.stringify({ path })}\n` : `Saved ${JSON.stringify(path)}.\n`);
  return 0;
};

const usage = "armada outputs [NAME] [-o DIR] [--id ID] [--org UUID] [--json]";

export default {
  name: "outputs",
  summary: "List or download saved sandbox outputs",
  usage: `  ${usage}
                                           List or download saved outputs`,
  help: `Usage: ${usage}
List saved outputs for the current sandbox or the sandbox selected with --id.
With NAME, download the file into DIR (default the current directory).
Choose a directory without a file of the same name.
Use --org to scope sandbox prefix lookup.
`,
  automaticJson: true,
  useSelectedOrg: true,
  run: outputs,
} satisfies Command;
