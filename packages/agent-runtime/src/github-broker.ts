import { randomBytes, timingSafeEqual } from "node:crypto";
import { unlinkSync } from "node:fs";
import { chmod, chown, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type { GitHubRuntimeConfiguration as GitHubBrokerConfiguration } from "@armada/core";

import type { GitHubRuntimeConfiguration as GitHubBrokerConfiguration } from "@armada/core";

/** GitHub-only capability. No vault, refresh-token, provider or model operations. */
export class GitHubBroker {
  private configuration: GitHubBrokerConfiguration | undefined;
  private revision = 0;
  private minimum = 0n;
  private generation: string | undefined;
  private readonly retired = new Set<string>();
  constructor(
    private readonly register: (values: readonly string[]) => void,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  configure(value: GitHubBrokerConfiguration | null): void {
    if (value !== null) {
      const url = new URL(value.url);
      if (
        value.version !== 1 ||
        !/^[1-9][0-9]{0,18}$/.test(value.revision) ||
        (this.generation !== undefined && value.generation !== this.generation) ||
        typeof value.revision !== "string" ||
        typeof value.generation !== "string" ||
        !value.generation ||
        value.generation.length > 512 ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        url.pathname !== "/api/internal/github/credentials" ||
        !/^armada_gh_[a-f0-9]{64}$/.test(value.capability) ||
        !Number.isFinite(value.expiresAt) ||
        value.expiresAt <= this.now()
      )
        throw Error("github_configuration_denied");
      const revision = BigInt(value.revision);
      if (
        revision < this.minimum ||
        (revision === this.minimum && JSON.stringify(value) !== JSON.stringify(this.configuration))
      )
        throw Error("github_configuration_denied");
      if (
        value.retired &&
        (!Array.isArray(value.retired) ||
          value.retired.length > 4096 ||
          value.retired.some((token) => typeof token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token)))
      )
        throw Error("github_configuration_denied");
      this.remember([value.capability, ...(value.retired ?? [])]);
      this.minimum = revision;
      this.generation = value.generation;
    }
    this.revision++;
    this.configuration = value ? { ...value } : undefined;
  }

  private remember(values: readonly string[]): void {
    // Registration is synchronous and precedes every private response or execution.
    this.register(values);
    for (const value of values) this.retired.add(value);
  }

  async acquire(repository: string, operation: "gh" | "git"): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !["gh", "git"].includes(operation))
      throw Error("github_credentials_denied");
    const configuration = this.configuration,
      revision = this.revision;
    if (!configuration || configuration.expiresAt <= this.now()) throw Error("github_credentials_denied");
    let token: unknown;
    try {
      const response = await this.fetcher(configuration.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${configuration.capability}` },
        body: JSON.stringify({ version: 1, repository, operation }),
      });
      if (!response.ok) throw Error("denied");
      const body = await response.text();
      if (body.length > 16384) throw Error("oversized");
      token = (JSON.parse(body) as { token?: unknown }).token;
      if (typeof token !== "string" || !token.length || token.length > 8192 || !/^[\x21-\x7e]+$/.test(token))
        throw Error("invalid");
      this.remember([token]);
    } catch {
      // HTTP diagnostics can contain credentials. Never propagate body, cause or error text.
      throw Error("github_credentials_unavailable");
    }
    if (revision !== this.revision || configuration.expiresAt <= this.now()) throw Error("github_credentials_denied");
    return token as string;
  }

  /** Credential replies require root IPC. Unprivileged native processes get only a redact oracle. */
  async listen(
    root: string,
    owner = process.getuid?.(),
  ): Promise<{ socket: string; redactSocket: string; activation: string; close(): void }> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await lstat(root);
    if (directory.isSymbolicLink() || !directory.isDirectory() || directory.uid !== owner || directory.mode & 0o077)
      throw Error("github_socket_denied");
    const socket = join(root, "credentials.sock"),
      redactSocket = join(root, "redact.sock");
    const activation = randomBytes(32).toString("hex");
    this.remember([activation]);
    let active = false;
    async function body(request: Request, limit: number): Promise<Buffer> {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (request.body)
        for await (const part of request.body) {
          bytes += part.length;
          if (bytes > limit) throw Error("denied");
          chunks.push(part);
        }
      return Buffer.concat(chunks);
    }
    const register = async (request: Request) => {
      const values = JSON.parse((await body(request, 20000)).toString()) as string[];
      if (
        !Array.isArray(values) ||
        values.length > 2 ||
        values.some((value) => typeof value !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(value))
      )
        throw Error("denied");
      this.remember(values);
      return Response.json({ acknowledged: true });
    };
    const redaction = Bun.serve({
      unix: redactSocket,
      maxRequestBodySize: 262144,
      fetch: async (request) => {
        try {
          const path = new URL(request.url).pathname;
          if (request.method !== "POST") throw Error("denied");
          if (path === "/register") return await register(request);
          if (path !== "/redact") throw Error("denied");
          const value = (await body(request, 262144)).toString("latin1");
          const secrets = [...this.retired].sort((a, b) => b.length - a.length);
          const streaming = request.headers.get("x-armada-stream") === "1";
          let consumed = 0;
          const output: string[] = [];
          while (consumed < value.length) {
            const tail = value.slice(consumed);
            // Prefer waiting for a longer possible leaf over publishing its shorter prefix.
            if (streaming && secrets.some((secret) => secret.length > tail.length && secret.startsWith(tail))) break;
            const match = secrets.find((secret) => value.startsWith(secret, consumed));
            if (match) {
              output.push("***");
              consumed += match.length;
            } else {
              output.push(value[consumed]!);
              consumed++;
            }
          }
          return new Response(Buffer.from(output.join(""), "latin1"), {
            headers: { "cache-control": "no-store", "x-armada-consumed": String(consumed) },
          });
        } catch {
          return new Response(null, { status: 403 });
        }
      },
    });
    const credentials = Bun.serve({
      unix: socket,
      maxRequestBodySize: 1048576,
      fetch: async (request) => {
        try {
          const path = new URL(request.url).pathname;
          if (request.method !== "POST") throw Error("denied");
          if (path === "/activate") {
            const value = JSON.parse((await body(request, 1024)).toString()) as { key: string };
            const supplied = Buffer.from(typeof value.key === "string" ? value.key : "");
            if (supplied.length !== activation.length || !timingSafeEqual(supplied, Buffer.from(activation)))
              throw Error("denied");
            active = true;
            return Response.json({ acknowledged: true });
          }
          if (!active) throw Error("denied");
          if (path === "/configure") {
            this.configure(JSON.parse((await body(request, 1048576)).toString()));
            return Response.json({ acknowledged: true });
          }
          if (path === "/register") return await register(request);
          if (path !== "/") throw Error("denied");
          const value = JSON.parse((await body(request, 1024)).toString()) as {
            repository: string;
            operation: "gh" | "git";
          };
          const token = await this.acquire(value.repository, value.operation);
          return Response.json({ token }, { headers: { "cache-control": "no-store" } });
        } catch {
          return new Response(null, { status: 403 });
        }
      },
    });
    await chmod(socket, 0o600);
    await chmod(redactSocket, 0o600);
    if (owner !== undefined && owner !== process.getuid?.()) await chown(redactSocket, owner, owner);
    return {
      socket,
      redactSocket,
      activation,
      close: () => {
        active = false;
        this.configure(null);
        credentials.stop(true);
        redaction.stop(true);
        for (const path of [socket, redactSocket]) {
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      },
    };
  }
}
