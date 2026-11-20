import { dirname, join } from "node:path";
import { shellQuote } from "../../core/src/shell-quote.ts";

type Mode = "git-run" | "git" | "gh" | "native";

export function githubToolCommands(
  socket: string,
  git: string,
  gh: string,
  runtime: Pick<NodeJS.Process, "argv" | "execPath">,
) {
  const entry = runtime.argv[1];
  if (!entry) throw Error("github_tools_denied");
  const self = entry.startsWith("/$bunfs/")
    ? [runtime.execPath]
    : [runtime.execPath, "--config=/dev/null", "--no-env-file", entry];
  function command(mode: Mode, ...args: string[]) {
    const invocation = [...self, "github-client", mode, ...args].map(shellQuote).join(" ");
    return `unset BUN_BE_BUN BUN_OPTIONS NODE_OPTIONS BUN_CONFIG_VERBOSE_FETCH; exec ${invocation}`;
  }
  return {
    git: command("git-run", socket, git),
    gh: command("gh", socket, gh, git),
    credential: `!${command("git", socket)}`,
    native: command("native", join(dirname(socket), "redact.sock")),
  };
}

function repository(value: string) {
  const name = value
    .trim()
    .replace(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/, "")
    .replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw Error("repository_selection");
  return name;
}

function apiRepository(args: string[]) {
  const values = new Set(
    "--cache --field -F --header -H --hostname --input --jq -q --method -X --preview -p --raw-field -f --template -t".split(
      " ",
    ),
  );
  const switches = new Set("--include -i --paginate --silent --slurp --verbose --allow-escape-sequences".split(" "));
  let endpoint: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (values.has(flag)) {
      const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (value === undefined || (flag === "--hostname" && value.toLowerCase() !== "github.com"))
        throw Error("repository_selection");
    } else if (!switches.has(arg)) {
      if (arg.startsWith("-") || endpoint !== undefined) throw Error("repository_selection");
      endpoint = arg;
    }
  }
  const parts = endpoint?.replace(/^\//, "").split("/") ?? [];
  if (
    parts.length < 3 ||
    parts[0] !== "repos" ||
    parts.some((part) => !part || /[^A-Za-z0-9_.-]/.test(part) || part === "." || part === "..")
  )
    throw Error("repository_selection");
  return repository(parts.slice(1, 3).join("/"));
}

function ghCommand(args: string[]) {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    const arg = args[index++]!;
    if (["-R", "--repo", "--hostname"].includes(arg)) {
      if (args[index++] === undefined) throw Error("repository_selection");
    } else if (!["--help", "-h", "--version"].includes(arg) && !/^--(?:repo|hostname)=/.test(arg)) {
      throw Error("repository_selection");
    }
  }
  for (const [i, arg] of args.entries()) {
    if (
      (arg === "--hostname" && args[i + 1]?.toLowerCase() !== "github.com") ||
      (arg.startsWith("--hostname=") && arg.slice(11).toLowerCase() !== "github.com") ||
      (/^https?:\/\//.test(arg) && !/^https:\/\/(?:api\.)?github\.com\//.test(arg))
    )
      throw Error("repository_selection");
  }
  return index;
}

function ghRepository(args: string[], index: number, git: string, env: NodeJS.ProcessEnv) {
  const [command, subcommand, ...rest] = args.slice(index);
  if (command === "api")
    return apiRepository([...args.slice(0, index), ...(subcommand === undefined ? [] : [subcommand]), ...rest]);
  let selected = env.GH_REPO;
  for (const [i, arg] of args.entries()) {
    if ((arg === "-R" || arg === "--repo") && args[i + 1] !== undefined) selected = args[i + 1];
    if (arg.startsWith("--repo=")) selected = arg.slice(7);
  }
  const values = new Set(
    "-R --repo --json --jq -q --template -t --branch -b --remote-name --upstream-remote-name --body --body-file --title --author --assignee --label --search --limit -L --head --base --state".split(
      " ",
    ),
  );
  const operands: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") {
      operands.push(...rest.slice(i + 1));
      break;
    }
    if (values.has(arg)) {
      if (rest[++i] === undefined) throw Error("repository_selection");
    } else if (!arg.startsWith("-")) operands.push(arg);
  }
  let positional: string | undefined;
  if (command === "repo") {
    if (!subcommand || !["clone", "view", "fork"].includes(subcommand)) throw Error("repository_selection");
    if (operands[0]) positional = repository(operands[0]);
  }
  if (command === "pr" || command === "issue") {
    for (const operand of operands) {
      if (!operand.startsWith("https://github.com/")) continue;
      const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:pull|issues)\/[0-9]+\/?$/.exec(
        operand,
      );
      if (!match?.[1] || match[0] !== operand) throw Error("repository_selection");
      const target = repository(match[1]);
      if (positional && positional.toLowerCase() !== target.toLowerCase()) throw Error("repository_selection");
      positional = target;
    }
  }
  if (positional) {
    if (selected && repository(selected).toLowerCase() !== positional.toLowerCase())
      throw Error("repository_selection");
    return positional;
  }
  if (!selected) {
    const result = Bun.spawnSync([git, "config", "--get", "remote.origin.url"], { env, stderr: "ignore" });
    if (result.success) selected = result.stdout.toString();
  }
  return selected ? repository(selected) : undefined;
}

function gitCommandIndex(args: readonly string[]) {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    const arg = args[index++]!;
    if (arg === "--") break;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) index++;
  }
  return index;
}

function splitGitAlias(value: string) {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === quote) quote = undefined;
    else if (!quote && (char === "'" || char === '"')) quote = char;
    else if (char === "\\" && quote !== "'") {
      const next = value[++i];
      if (next === undefined) return undefined;
      word += next;
    } else if (!quote && /[ \t\r\n\v\f]/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    } else word += char;
    started = true;
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

function superviseGit(git: string, args: string[], env: NodeJS.ProcessEnv) {
  const index = gitCommandIndex(args);
  let command = args[index];
  if (!command) return false;
  const prefix = args.slice(0, index);
  const builtins = Bun.spawnSync([git, "--list-cmds=builtins"], { env, stderr: "ignore" });
  if (!builtins.success) return true;
  const names = new Set(builtins.stdout.toString().split("\n"));
  for (let depth = 0; depth < 16; depth++) {
    if (command === "credential") return true;
    if (names.has(command)) return false;
    const alias = Bun.spawnSync([git, ...prefix, "config", "--get", `alias.${command}`], { env, stderr: "ignore" });
    if (!alias.success) return alias.exitCode !== 1;
    const value = alias.stdout.toString().trim();
    if (value.startsWith("!")) return true;
    const words = splitGitAlias(value);
    if (!words) return true;
    const offset = gitCommandIndex(words);
    command = words[offset];
    if (!command) return true;
    prefix.push(...words.slice(0, offset));
  }
  return true;
}

function post(socket: string, path: string, body: string | Buffer, headers?: Record<string, string>) {
  return fetch(`http://private${path}`, {
    unix: socket,
    method: "POST",
    body,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: headers ?? { "Content-Type": "application/json" },
  });
}

async function readBody(body: ReadableStream<Uint8Array> | null, limit: number) {
  const parts: Uint8Array[] = [];
  let size = 0;
  if (body) {
    for await (const part of body) {
      size += part.length;
      if (size > limit) throw Error("response_oversized");
      parts.push(part);
    }
  }
  return Buffer.concat(parts, size);
}

async function execute(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  redactor: string,
  nativeSecrets?: string[],
) {
  const child = Bun.spawn([executable, ...args], { env, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const stopping = new AbortController();
  const forward = (signal: NodeJS.Signals) => {
    stopping.abort();
    child.kill(signal);
  };
  for (const signal of signals) process.on(signal, forward);
  async function redact(input: Buffer, stream: boolean) {
    while (true) {
      try {
        if (nativeSecrets?.length) {
          const registration = await post(redactor, "/register", JSON.stringify(nativeSecrets));
          if (!registration.ok) throw Error("registration");
          await registration.body?.cancel();
        }
        const response = await post(redactor, "/redact", input, {
          "Content-Type": "application/octet-stream",
          "X-Armada-Stream": stream ? "1" : "0",
        });
        if (!response.ok) throw Error("redaction");
        const bytes = await readBody(response.body, 262144);
        const count = Number(response.headers.get("x-armada-consumed") ?? input.length);
        if (!Number.isSafeInteger(count) || count < 0 || count > input.length) throw Error("redaction");
        return { bytes, count };
      } catch (error) {
        if (!nativeSecrets) throw error;
        if (stopping.signal.aborted) return { bytes: Buffer.alloc(0), count: input.length };
        await Bun.sleep(100);
      }
    }
  }
  async function pipe(source: ReadableStream<Uint8Array>, output: NodeJS.WriteStream) {
    let pending = Buffer.alloc(0);
    async function write(bytes: Buffer) {
      if (bytes.length)
        await new Promise<void>((resolve, reject) =>
          output.write(bytes, (error) => (error ? reject(error) : resolve())),
        );
    }
    for await (const chunk of source) {
      for (let offset = 0; offset < chunk.length; offset += 65536) {
        pending = Buffer.concat([pending, chunk.subarray(offset, offset + 65536)]);
        const { bytes, count } = await redact(pending, true);
        pending = pending.subarray(count);
        await write(bytes);
      }
    }
    if (pending.length) await write((await redact(pending, false)).bytes);
  }
  try {
    const [code] = await Promise.all([
      child.exited,
      pipe(child.stdout, process.stdout),
      pipe(child.stderr, process.stderr),
    ]);
    if (child.signalCode) {
      for (const signal of signals) process.off(signal, forward);
      process.kill(process.pid, child.signalCode);
    }
    return code;
  } catch {
    child.kill("SIGKILL");
    await child.exited;
    throw Error("redaction");
  } finally {
    for (const signal of signals) process.off(signal, forward);
  }
}

export async function runGitHubClient(argv: string[]) {
  const [mode, socket, executable, ...rest] = argv;
  if (!socket) return 1;
  const env = { ...process.env };
  const secrets = [...new Set([env.GH_TOKEN, env.GITHUB_TOKEN].filter((value): value is string => !!value))];
  const redactor = join(dirname(socket), "redact.sock");
  let stage = "repository_selection";
  try {
    if (!executable) throw Error();
    if (mode === "native") {
      stage = "redaction";
      return await execute(executable, rest, env, socket, secrets);
    }
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    if (mode === "git-run" && !superviseGit(executable, rest, env)) {
      process.execve!(executable, [executable, ...rest], env);
    }
    stage = "registration";
    if (secrets.length) {
      const response = await post(redactor, "/register", JSON.stringify(secrets));
      if (!response.ok) throw Error();
      await response.body?.cancel();
    }
    if (mode === "git-run") {
      stage = "redaction";
      return await execute(executable, rest, env, redactor);
    }
    stage = "repository_selection";
    let repo: string | undefined;
    let ghArgs: string[] = [];
    if (mode === "git") {
      if (executable !== "get") return 0;
      const fields = new Map<string, string>();
      for (const line of (await readBody(Bun.stdin.stream(), 65536)).toString().split("\n")) {
        if (!line) break;
        const equals = line.indexOf("=");
        if (equals >= 0) fields.set(line.slice(0, equals), line.slice(equals + 1));
      }
      if (fields.get("protocol") !== "https" || fields.get("host") !== "github.com") return 0;
      repo = repository(fields.get("path") ?? "");
    } else if (mode === "gh") {
      const [git, ...args] = rest;
      if (!git) throw Error();
      ghArgs = args;
      const index = ghCommand(args);
      const status = args[index] === "auth" && args[index + 1] === "status";
      if (!status) repo = ghRepository(args, index, git, env);
      if (!repo) {
        stage = "broker_request";
        const response = await post(socket, "/repositories", "{}");
        if (!response.ok) throw Error();
        const { repositories } = JSON.parse((await readBody(response.body, 262144)).toString()) as {
          repositories: string[];
        };
        if (!repositories.length) {
          process.stderr.write("This sandbox has no repository authorization; launch with --repo owner/repo.\n");
          return 1;
        }
        if (status) {
          process.stdout.write(
            `Managed GitHub authorization is scoped to: ${repositories.map(repository).join(", ")}\n`,
          );
          return 0;
        }
        stage = "repository_selection";
        throw Error();
      }
    } else throw Error();
    stage = "broker_request";
    const response = await post(socket, "/", JSON.stringify({ repository: repo, operation: mode }));
    if (!response.ok) {
      stage = "broker_denied";
      const { error } = JSON.parse((await readBody(response.body, 1024)).toString()) as { error: unknown };
      if (
        typeof error === "string" &&
        /^(?:github_credentials_(?:denied|unavailable|http_denied|http_unavailable|oversized|invalid_json|invalid_token))$/.test(
          error,
        )
      )
        stage = error;
      throw Error();
    }
    stage = "broker_response";
    const { token } = JSON.parse((await readBody(response.body, 16384)).toString()) as { token: unknown };
    if (typeof token !== "string" || !token || /[^\x21-\x7e]/.test(token)) throw Error();
    if (mode === "git") {
      process.stdout.write(`username=x-access-token\npassword=${token}\n`);
      return 0;
    }
    delete env.GH_ENTERPRISE_TOKEN;
    delete env.GITHUB_ENTERPRISE_TOKEN;
    stage = "redaction";
    return await execute(
      executable,
      ghArgs,
      { ...env, GH_HOST: "github.com", GH_TOKEN: token, GITHUB_TOKEN: token },
      redactor,
    );
  } catch {
    process.stderr.write(
      stage === "repository_selection"
        ? "No repository selected or unsupported GitHub command: run inside a checkout or pass -R owner/repo.\n"
        : `Managed GitHub credentials unavailable (${stage}).\n`,
    );
    return 1;
  }
}
