/** Public admission and private native delivery share this one exact-pin grammar. */
export const MCP_STDIO_EXECUTABLES = {
  npx: ["/usr/local/bin/npx", "/usr/bin/npx"],
  uvx: ["/usr/local/bin/uvx", "/usr/bin/uvx", "/home/user/.local/bin/uvx", "/root/.local/bin/uvx"],
} as const;
export type McpStdioLauncher = keyof typeof MCP_STDIO_EXECUTABLES;
export interface PinnedMcpStdio {
  command: McpStdioLauncher;
  args: string[];
}
export class McpStdioError extends Error {
  override readonly name = "McpStdioError";
  constructor(
    message: string,
    readonly category: "pin" | "arguments" = "pin",
  ) {
    super(message);
  }
}
const version = String.raw`[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const npm = new RegExp(`^(?:@[a-z0-9._-]+/)?[a-z0-9._-]+@${version}$`, "i");
const python = new RegExp(`^([a-z0-9._-]+)==${version}$`, "i");
/** Public registry spellings only; output argv is canonical for the real native launcher. */
export function parsePinnedMcpStdio(command: string, args: readonly string[]): PinnedMcpStdio {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new McpStdioError("MCP stdio arguments must be strings.", "arguments");
  const remaining = [...args];
  if (command === "npx") {
    if (remaining[0] === "-y" || remaining[0] === "--yes") remaining.shift();
    const pkg = remaining.shift();
    if (!pkg || !npm.test(pkg))
      throw new McpStdioError(
        "npx MCP requires package@exact.version; tags, ranges, URLs and shell commands are refused.",
      );
    if (args.some((arg) => /[\r\n\0]/.test(arg)))
      throw new McpStdioError("MCP stdio arguments cannot contain control characters.", "arguments");
    return { command: "npx", args: ["--yes", "--", pkg, ...remaining] };
  }
  if (command === "uvx") {
    const pkg = remaining.shift(),
      match = pkg ? python.exec(pkg) : null;
    if (!pkg || !match?.[1])
      throw new McpStdioError(
        "uvx MCP requires package==exact.version; tags, ranges, URLs and shell commands are refused.",
      );
    if (args.some((arg) => /[\r\n\0]/.test(arg)))
      throw new McpStdioError("MCP stdio arguments cannot contain control characters.", "arguments");
    return { command: "uvx", args: ["--from", pkg, "--", match[1], ...remaining] };
  }
  throw new McpStdioError("MCP stdio requires npx or uvx with an exact package version.");
}
/** Server-owned resolved delivery. Never use this to broaden the public registry's command grammar. */
export function normalizeResolvedMcpStdio(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const launcher = (Object.keys(MCP_STDIO_EXECUTABLES) as McpStdioLauncher[]).find((name) =>
    (MCP_STDIO_EXECUTABLES[name] as readonly string[]).includes(command),
  );
  if (!launcher)
    throw new McpStdioError(
      "Resolve the pinned MCP launcher to its supported fixed executable before native delivery.",
    );
  let definition: PinnedMcpStdio;
  if (launcher === "npx") {
    const raw = [...args];
    if (raw[0] === "--") raw.shift();
    else if ((raw[0] === "--yes" || raw[0] === "-y") && raw[1] === "--") raw.splice(1, 1);
    definition = parsePinnedMcpStdio("npx", raw);
  } else if (args[0] === "--from") {
    const executableIndex = args[2] === "--" ? 3 : 2;
    definition = parsePinnedMcpStdio("uvx", [args[1] ?? "", ...args.slice(executableIndex + 1)]);
    if (args[executableIndex] !== definition.args[3])
      throw new McpStdioError("uvx MCP executable must match its pinned package name.");
  } else definition = parsePinnedMcpStdio("uvx", args);
  return { command, args: definition.args };
}
