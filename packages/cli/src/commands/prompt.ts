import { AuthError } from "@armada/auth";
import { GoldenError } from "@armada/core";
import { acceptedOptions, flag, parseArgs, single, uuid } from "../args.ts";
import { isFullUuid, isUuidPrefix, readCurrentSandbox, resolveSandboxReference } from "../current-sandbox.ts";
import { type ArmadaCommandClient, createSdkCommandClient } from "../sdk-session.ts";
import type { Command } from "./command.ts";

export default {
  name: "prompt",
  summary: "Start a turn or redirect a running turn",
  usage: `  armada prompt [--steer] [sandbox-id] <text>
                                           Start a turn or redirect a running turn`,
  help: `Usage: armada prompt [--steer] [--org UUID] [--json] [sandbox-id] [--] <text>
A new prompt automatically resumes a retained stopped sandbox. Use --steer to redirect a running turn.
Steering can join a turn natively or interrupt and restart the same conversation.
Check the receipt's delivery field to see which happened.
Omit the ID when ARMADA_SANDBOX or .armada/sandbox is set; use -- if text starts with an option or UUID prefix.
New turns accept --request-id UUID, --model ID and --reasoning-effort LEVEL.
Runtime model and effort remain launch-pinned. Full-account prompts can queue FIFO before execution.
For uncertain runtime delivery, reuse the request ID with identical input.
Native providers do not deduplicate by request ID. Inspect state before retrying.
Example: armada prompt SANDBOX_UUID --steer -- "Focus on the failing test"
`,
  automaticJson: true,
  useSelectedOrg: true,
  async run(argv, { auth, deps }) {
    const args = parseArgs(argv, ["--request-id"], ["--steer"]);
    const steer = flag(args, "--steer");
    acceptedOptions(args, "prompt", [
      "--org",
      "--json",
      "--steer",
      ...(steer ? [] : ["--request-id", "--model", "--reasoning-effort"]),
    ]);

    const end = argv.indexOf("--");
    const explicitImplicit = end >= 0 && args.positionals.length === argv.length - end - 1;
    const first = args.positionals[0];
    const looksLikeSandbox =
      !explicitImplicit &&
      first !== undefined &&
      (isFullUuid(first) || (args.positionals.length > 1 && first.length >= 4 && isUuidPrefix(first)));
    const current = looksLikeSandbox ? undefined : await readCurrentSandbox(auth.env, deps.sandboxFile);
    const [selector, ...words] =
      explicitImplicit || (!looksLikeSandbox && current && args.positionals.length > 0)
        ? [undefined, ...args.positionals]
        : args.positionals;
    const text = words.join(" ");
    if (!text.trim())
      throw new GoldenError("invalid_config", "Provide prompt text. Pass a sandbox ID or set ARMADA_SANDBOX.");

    const org = single(args, "--org");
    const requestId = single(args, "--request-id");
    if (requestId !== undefined) uuid(requestId, "--request-id");
    const model = single(args, "--model");
    const effort = single(args, "--reasoning-effort");
    let api: Promise<ArmadaCommandClient> | undefined;
    const client = () => (api ??= createSdkCommandClient(auth));
    const id = await resolveSandboxReference(selector, current, org, async (body) =>
      (await client()).sandboxes.list(body),
    );
    if (steer) {
      const { sandboxes } = await client();
      auth.out(`${JSON.stringify(await sandboxes.steer({ id, org, text }), null, 2)}\n`);
      return 0;
    }

    const request_id = requestId?.toLowerCase() ?? crypto.randomUUID();
    if (!flag(args, "--json")) auth.err("Sending message… Waking the sandbox if paused; waiting for acceptance.\n");
    const signal = AbortSignal.timeout(660_000);
    const result = await client()
      .then(({ sandboxes }) =>
        sandboxes.send({ id, org, prompt: text, request_id, model, reasoning_effort: effort }, { signal }),
      )
      .catch((error: unknown) => {
        if (error instanceof AuthError)
          error.message += ` Send request ID: ${request_id}. Keep it with the original input when investigating uncertain delivery.`;
        throw error;
      });
    auth.out(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  },
} satisfies Command;
