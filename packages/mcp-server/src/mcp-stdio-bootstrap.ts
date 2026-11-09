import { MCP_STDIO_EXECUTABLES, type McpStdioLauncher, type Provider, shellQuote } from "@armada/core/server";

/** Fixed filesystem checks only. This never executes an MCP package on the control server or VM. */
export async function resolveMcpStdioExecutable(
  provider: Provider,
  sandboxId: string,
  launcher: McpStdioLauncher,
): Promise<string> {
  const candidates: MCPPaths = MCP_STDIO_EXECUTABLES[launcher];
  const command = `for p in ${candidates.map(shellQuote).join(" ")}; do if [ -f "$p" ] && [ -x "$p" ]; then printf '%s\\n' "$p"; exit 0; fi; done; exit 127`;
  const result = await provider.exec({ sandboxId, command, timeoutSeconds: 30 });
  if (result.detached || result.timedOut || result.exitCode !== 0 || !candidates.includes(result.stdout.trim()))
    throw Error(
      `MCP ${launcher} is not installed at a supported fixed path in this golden. Install ${launcher} in /usr/local/bin or /usr/bin (uvx also supports the user .local/bin) before launch; no agent was started.`,
    );
  return result.stdout.trim();
}
type MCPPaths = readonly string[];
