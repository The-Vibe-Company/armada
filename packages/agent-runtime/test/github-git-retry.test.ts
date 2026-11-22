import { expect, spyOn, test } from "bun:test";
import { GitHubBroker } from "../src/github-broker.ts";
import { runGitHubClient } from "../src/github-client.ts";
import { retryGitHubAuthentication } from "../src/github-git-retry.ts";

const authFailure = "fatal: Authentication failed for 'https://github.com/acme/repo-7.git/'\n";
const rotatedCredential = "offline-successor";
const gitSocket = "/offline/credentials.sock";

test("a multi-repository refresh recovers when another runtime rotates its in-flight credential", async () => {
  let current = "offline-original";
  let acquisitions = 0;
  const fetchCredential = (async () => {
    acquisitions++;
    return Response.json({ token: current });
  }) as unknown as typeof fetch;
  const repositories = Array.from({ length: 8 }, (_, index) => `acme/repo-${index + 1}`);
  const launch = (generation: string) => {
    const broker = new GitHubBroker(
      () => {},
      fetchCredential,
      () => 0,
    );
    broker.configure({
      version: 1,
      revision: "1",
      generation,
      repositories,
      url: "https://armada.example/api/runtime/github/credentials",
      capability: `armada_gh_${"a".repeat(64)}`,
      expiresAt: 100,
    });
    return broker;
  };
  const first = launch("first");
  const second = launch("second");
  let requestedRepository = "";
  let helperOutput = "";
  const stdin = spyOn(Bun.stdin, "stream").mockImplementation(() =>
    new Blob([`protocol=https\nhost=github.com\npath=${requestedRepository}.git\n\n`]).stream(),
  );
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    helperOutput += chunk.toString();
    return true;
  });
  const builtins = spyOn(Bun, "spawnSync").mockReturnValue({
    success: true,
    stdout: Buffer.from("fetch\n"),
  } as ReturnType<typeof Bun.spawnSync>);
  const runGit = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
    const repository = args.at(-1)!;
    const exited = (async () => {
      requestedRepository = repository;
      helperOutput = "";
      expect(await runGitHubClient(["git", gitSocket, "get"])).toBe(0);
      const credential = /^password=(.*)$/m.exec(helperOutput)?.[1];
      if (repository === repositories[6] && current !== rotatedCredential) {
        current = rotatedCredential;
        await second.acquire(repositories[0]!, "git");
      }
      return credential === current ? 0 : 128;
    })();
    return {
      exited,
      stdout: new Blob().stream(),
      stderr: new ReadableStream({
        async start(stream) {
          if ((await exited) === 128) {
            stream.enqueue(Buffer.from(authFailure.slice(0, 24)));
            stream.enqueue(Buffer.from(authFailure.slice(24)));
          }
          stream.close();
        },
      }),
    };
  }) as typeof Bun.spawn);
  const directGit = spyOn(process, "execve").mockImplementation(() => {
    throw Error("test_unexpected_git_exec");
  });
  const brokerSocket = spyOn(globalThis, "fetch").mockImplementation((async (url, options) => {
    if (url === "http://private/redact") return new Response(options?.body);
    expect(url).toBe("http://private/");
    expect(options?.unix).toBe(gitSocket);
    const { repository, operation } = JSON.parse(String(options?.body));
    return Response.json({ token: await first.acquire(repository, operation) });
  }) as typeof fetch);
  try {
    const exitCodes = [];
    for (const repo of repositories) {
      exitCodes.push(await runGitHubClient(["git-run", gitSocket, "git", "fetch", repo]));
    }
    expect(exitCodes).toEqual(Array(8).fill(0));
    expect(acquisitions).toBe(10);
  } finally {
    brokerSocket.mockRestore();
    directGit.mockRestore();
    runGit.mockRestore();
    builtins.mockRestore();
    stdout.mockRestore();
    stdin.mockRestore();
  }
});

test.each([
  [authFailure, false, 2],
  ["fatal: unable to access 'https://github.com/acme/repo-8.git/': The requested URL returned error: 401\n", false, 2],
  ["fatal: unable to access 'https://github.com/acme/repo-8.git/': The requested URL returned error: 502\n", false, 1],
  ["fatal: Authentication failed for 'https://example.com/acme/repo-8.git/'\n", false, 1],
  [authFailure, true, 2],
  [`${authFailure}error: failed to push some refs\n`, true, 1],
  ["error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401\n", true, 1],
])("preserves the terminal Git error %s (push=%s) after %d attempts", async (error, push, expectedAttempts) => {
  let attempts = 0;
  const stderr: Buffer[] = [];
  expect(
    await retryGitHubAuthentication(
      async (writeStderr) => {
        attempts++;
        await writeStderr(Buffer.from(error));
        return 128;
      },
      async (bytes) => {
        stderr.push(bytes);
      },
      push,
    ),
  ).toBe(128);
  expect(attempts).toBe(expectedAttempts);
  expect(Buffer.concat(stderr).toString()).toBe(error);
});
