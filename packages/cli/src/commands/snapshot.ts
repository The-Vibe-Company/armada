import type { Command } from "./command.ts";

const usage = {
  ls: "armada snapshot ls [--provider boat|modal|docker] [--org ORG] [--json]",
  new: "armada snapshot new NAME (--config FILE | --repo URL ... [--init CMD ...]) [--provider boat|modal|docker] [--org ORG] [--idempotency-key KEY] [--provider boat|modal] [--org ORG] [--wait [--timeout SECONDS]]",
  update:
    "armada snapshot update NAME (--add-repo URL ... | --replace (--config FILE | --repo URL ...)) [--wait [--timeout SECONDS]]",
  rebuild: "armada snapshot rebuild UUID --provider docker --org UUID [--request-id UUID]",
  rm: "armada snapshot rm NAME|UUID [--provider boat|modal] [--org ORG]",
  show: "armada snapshot show NAME|UUID [--provider boat|modal|docker] [--org ORG]",
};
const subcommandHelp = {
  "snapshot ls": `Usage: ${usage.ls}
List visible snapshots. Docker requires --org UUID.
`,
  "snapshot new": `Usage: ${usage.new}
Boat/Modal options: --provider boat|modal, --org ORG, --private, --setup FILE, --idempotency-key KEY.
Docker options: --provider docker --host UUID|NAME --org UUID [--private] [--request-id UUID].
--wait observes the admitted build for up to --timeout seconds (default 60, max 600).
Use snapshot show to inspect the build later. --json prints a single receipt.
`,
  "snapshot update": `Usage: ${usage.update}
Boat/Modal only. Options: --provider boat|modal, --org ORG, --init CMD, --setup FILE, --idempotency-key KEY, --json.
--add-repo preserves the stored config. --replace replaces the entire config.
`,
  "snapshot rebuild": `Usage: ${usage.rebuild}
Build a Docker snapshot on its original host and retain the original. Supports --json.
`,
  "snapshot rm": `Usage: ${usage.rm}
Remove a Boat/Modal snapshot from launch selection. Use the ID from snapshot ls to disambiguate names.
`,
  "snapshot show": `Usage: ${usage.show}
   or: armada snapshot show --build JOB_ID [--org ORG]
   or: armada snapshot show --idempotency-key KEY --org ORG
Inspect a snapshot or a durable Boat/Modal build, including its build ID. Docker takes a snapshot UUID and --org UUID.
`,
};

export default {
  name: "snapshot",
  summary: "Manage provider-scoped snapshots",
  usage: {
    snapshots: Object.values(usage)
      .map((line) => `  ${line}`)
      .join("\n"),
  },
  help: `Usage: armada snapshot <ls|new|update|rebuild|rm|show> [arguments]
Manage provider-scoped snapshots. Use a verb with --help for its options.
${Object.values(usage)
  .map((line) => `  ${line}`)
  .join("\n")}
`,
  subcommandHelp,
  helpWhenBare: true,
  automaticJson: true,
  async run(argv, { io, deps }) {
    const { snapshotCommand } = await import("../run.ts");
    return snapshotCommand(argv, io, deps);
  },
} satisfies Command;
