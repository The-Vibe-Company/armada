import { stat } from "node:fs/promises";
import { GitHubBroker, type GitHubBrokerConfiguration } from "./github-broker.ts";
import { prepareGitHubTools, runGitHubInstallMode } from "./github-tools.ts";
import { Journal } from "./journal.ts";

// Same private stdin bootstrap as the runtime. Capability/access bytes remain in memory only.
async function main() {
  const input = JSON.parse(await Bun.stdin.text()) as {
    root: string;
    configuration: GitHubBrokerConfiguration;
    homes: string[];
    tools: { gh: string; git: string; ghWrapper: string; gitWrapper: string };
  };
  const journal = new Journal(":memory:", (value) => value);
  const broker = new GitHubBroker((values) => journal.registerSecrets(values));
  broker.configure(input.configuration);
  const listener = await broker.listen(input.root, (await stat("/home/user")).uid);
  try {
    await prepareGitHubTools({
      root: input.root,
      socket: listener.socket,
      activation: listener.activation,
      ...input.tools,
      homes: input.homes,
    });
    process.stdout.write("github_broker_ready\n");
  } catch {
    listener.close();
    throw Error("github_boot_failed");
  }
}
void (process.argv[2] === "github-install" ? runGitHubInstallMode() : main()).catch(() => {
  process.stderr.write("github_boot_failed\n");
  process.exit(1);
});
