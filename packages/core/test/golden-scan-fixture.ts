import type { ExecRequest, ExecResult, Provider } from "../src/server.ts";
import { scanGoldenSandbox } from "../src/server.ts";

export function provider(result: Partial<ExecResult>, calls: ExecRequest[]): Provider {
  return {
    exec: async (request: ExecRequest) => {
      calls.push(request);
      return { detached: false, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...result };
    },
  } as unknown as Provider;
}

export async function capturedScript(): Promise<string> {
  const calls: ExecRequest[] = [];
  await scanGoldenSandbox(provider({ exitCode: 0 }, calls), "bx_1");
  const command = calls[0]?.command;
  if (!command) throw new Error("the scan did not run a command");
  return command;
}
