import { createHash } from "node:crypto";
import type { McpConfiguration, McpConnection } from "./protocol.ts";

const fail = (): never => {
  throw Error("invalid_mcp_configuration");
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
  )
    fail();
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.length) || value.includes("\0"))
    return fail();
  try {
    encodeURIComponent(value);
  } catch {
    return fail();
  }
  return value;
}
function dictionary(value: unknown, kind: "header" | "env"): Record<string, string> {
  const input = record(value);
  if (Object.keys(input).length > 64) fail();
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of Object.keys(input).sort()) {
    if (["__proto__", "prototype", "constructor"].includes(name)) fail();
    if (
      kind === "env" ? !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) : !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)
    )
      fail();
    if (seen.has(name.toLowerCase()) && kind === "header") fail();
    seen.add(name.toLowerCase());
    const val = string(input[name], 8192, true);
    if (
      kind === "header" &&
      [...val].some((char) => {
        const code = char.charCodeAt(0);
        return (code < 32 && code !== 9) || code === 127;
      })
    )
      fail();
    result[name] = val;
  }
  return Object.freeze(result);
}
/** Strict, bounded protocol validation. Returns a detached, immutable future-turn snapshot. */
export function validateMcpConfiguration(value: unknown): McpConfiguration {
  const input = record(value);
  keys(input, ["revision", "servers"]);
  const revision = string(input.revision, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(revision)) fail();
  const source = record(input.servers);
  if (Object.keys(source).length > 32) fail();
  const servers: Record<string, McpConnection> = {};
  for (const name of Object.keys(source).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || ["__proto__", "prototype", "constructor"].includes(name))
      fail();
    const server = record(source[name]);
    let connection: McpConnection;
    if (server.type === "http") {
      keys(server, ["type", "url"], ["headers"]);
      const url = string(server.url, 4096);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return fail();
      }
      if (
        !/^https?:\/\//i.test(url) ||
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        fail();
      connection = {
        type: "http",
        url,
        ...(server.headers !== undefined ? { headers: dictionary(server.headers, "header") } : {}),
      };
    } else if (server.type === "stdio") {
      keys(server, ["type", "command"], ["args", "env"]);
      const command = string(server.command, 1024);
      if (/[\r\n]/.test(command)) fail();
      let args: string[] | undefined;
      if (server.args !== undefined) {
        if (!Array.isArray(server.args) || server.args.length > 64) fail();
        args = (server.args as unknown[]).map((v) => string(v, 4096, true));
        Object.freeze(args);
      }
      connection = {
        type: "stdio",
        command,
        ...(args ? { args } : {}),
        ...(server.env !== undefined ? { env: dictionary(server.env, "env") } : {}),
      };
    } else return fail();
    servers[name] = Object.freeze(connection);
  }
  const result = Object.freeze({ revision, servers: Object.freeze(servers) });
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) fail();
  return result;
}
export function mcpSecretValues(configuration: McpConfiguration): string[] {
  return Object.values(configuration.servers)
    .flatMap((server) =>
      server.type === "http"
        ? [server.url, ...new URL(server.url).searchParams.values(), ...Object.values(server.headers ?? {})]
        : [...(server.args ?? []), ...Object.values(server.env ?? {})],
    )
    .filter(Boolean);
}
export function mcpDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
