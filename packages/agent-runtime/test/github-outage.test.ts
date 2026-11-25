import { expect, spyOn, test } from "bun:test";
import { GitHubBroker } from "../src/github-broker.ts";
import { runGitHubClient } from "../src/github-client.ts";

// Own upstream-outage refusal and recovery without installing wrappers or spawning native peers.
test("broker distinguishes private acquisition failures and recovers without serving a stale credential", async () => {
  let failure: "fetch" | "body" | "redaction" | undefined;
  let token = "offline_first";
  const registered = new Set<string>();
  const broker = new GitHubBroker(
    (values) => {
      if (failure === "redaction") throw Error("redactor_private_diagnostic");
      for (const value of values) registered.add(value);
    },
    (async () => {
      if (failure === "fetch") throw Error("upstream_private_diagnostic");
      if (failure === "body")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(Error("body_private_diagnostic"));
            },
          }),
        );
      return Response.json({ token });
    }) as unknown as typeof fetch,
    () => 100,
  );
  broker.configure({
    version: 1,
    revision: "1",
    generation: "offline",
    url: "https://armada.example/api/internal/github/credentials",
    capability: `armada_gh_${"a".repeat(64)}`,
    expiresAt: 200,
  });
  expect(await broker.acquire("acme/repo", "git")).toBe("offline_first");
  failure = "fetch";
  await expect(broker.acquire("acme/repo", "git")).rejects.toThrow(/^github_credentials_fetch_failed$/);
  failure = "body";
  await expect(broker.acquire("acme/repo", "gh")).rejects.toThrow(/^github_credentials_body_failed$/);
  failure = "redaction";
  await expect(broker.acquire("acme/repo", "git")).rejects.toThrow(/^github_credentials_redaction_failed$/);
  token = "offline_second";
  failure = undefined;
  expect(await broker.acquire("acme/repo", "git")).toBe("offline_second");
  expect(registered.has("offline_first")).toBe(true);
  expect(registered.has("offline_second")).toBe(true);
});

test("the GitHub client reports a broker deadline without exposing the transport error", async () => {
  const timeout = AbortSignal.abort(new DOMException("private_transport_detail", "TimeoutError"));
  // oxlint-disable-next-line landmines-testing/no-test-doubles -- Trigger the request deadline without elapsed time.
  const deadline = spyOn(AbortSignal, "timeout").mockReturnValue(timeout);
  // oxlint-disable-next-line landmines-testing/no-test-doubles -- Feed the aborted request back at the Unix transport boundary without opening a socket.
  const transport = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1],
  ) => {
    options?.signal?.throwIfAborted();
    throw Error("expected an aborted request");
  }) as unknown as typeof fetch);
  let stderr = "";
  // oxlint-disable-next-line landmines-testing/no-test-doubles -- Capture the wrapper's user-facing diagnostic.
  const output = spyOn(process.stderr, "write").mockImplementation((line) => {
    stderr += line.toString();
    return true;
  });
  try {
    const status = await runGitHubClient([
      "gh",
      "/offline/credentials.sock",
      "gh",
      "git",
      "pr",
      "ready",
      "-R",
      "acme/repo",
    ]);
    expect(status).toBe(1);
    expect(stderr).toBe("Managed GitHub credentials unavailable (broker_timeout).\n");
  } finally {
    output.mockRestore();
    transport.mockRestore();
    deadline.mockRestore();
  }
});
