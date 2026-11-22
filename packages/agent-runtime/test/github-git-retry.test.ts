import { expect, test } from "bun:test";
import { GitHubBroker } from "../src/github-broker.ts";
import { retryGitHubAuthentication } from "../src/github-git-retry.ts";

const authFailure = "fatal: Authentication failed for 'https://github.com/acme/repo-8.git/'\n";
const rotatedCredential = "offline-successor";

test("a multi-repository refresh recovers when another runtime rotates its in-flight credential", async () => {
  let current = "offline-original";
  let acquisitions = 0;
  const fetchCredential = (async () => {
    acquisitions++;
    return Response.json({ token: current });
  }) as typeof fetch;
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
  const stderr: Buffer[] = [];
  const exitCodes = [];
  for (const repo of repositories) {
    exitCodes.push(
      await retryGitHubAuthentication(
        async (writeStderr) => {
          const credential = await first.acquire(repo, "git");
          if (repo === repositories[6] && current !== rotatedCredential) {
            // The second launch refreshes the owner's connection before the first uses its credential.
            current = rotatedCredential;
            await second.acquire(repositories[0]!, "git");
          }
          if (credential === current) return 0;
          await writeStderr(Buffer.from(authFailure.slice(0, 24)));
          await writeStderr(Buffer.from(authFailure.slice(24)));
          return 128;
        },
        async (bytes) => {
          stderr.push(bytes);
        },
      ),
    );
  }
  expect(exitCodes).toEqual(Array(8).fill(0));
  expect(acquisitions).toBe(10);
  expect(Buffer.concat(stderr).toString()).toBe("");
});

test.each([
  [authFailure, 2],
  ["fatal: unable to access 'https://github.com/acme/repo-8.git/': The requested URL returned error: 401\n", 2],
  ["fatal: unable to access 'https://github.com/acme/repo-8.git/': The requested URL returned error: 502\n", 1],
  ["fatal: Authentication failed for 'https://example.com/acme/repo-8.git/'\n", 1],
])("preserves a terminal Git failure and bounds attempts for %s", async (error, expectedAttempts) => {
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
    ),
  ).toBe(128);
  expect(attempts).toBe(expectedAttempts);
  expect(Buffer.concat(stderr).toString()).toBe(error);
});
