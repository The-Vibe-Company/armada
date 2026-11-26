import { AuthError } from "@armada/auth";
import { commandClient } from "@armada/sdk/commands";
import { ArmadaApiError } from "../api-responses.ts";
import { type ArmadaApiIo, authenticatedSession } from "../sdk-session.ts";
import type { Command } from "./command.ts";

const usage = "  armada api ROUTE [JSON|-]";

export default {
  name: "api",
  summary: "Call a versioned Armada API route",
  usage: { auth: `${usage}                Call a versioned /api/v1/ API route directly` },
  help: `Usage: ${usage.trim()}
POST to /api/v1/ROUTE using the selected Armada login and print the JSON response.
Pass the route relative to /api/v1/. With no body argument, send {}.
Pass - to read JSON from a pipe or redirected file. Use stdin for bodies that contain secrets.
Treat stdout as sensitive if the endpoint returns credentials.
Example: armada api org/list
`,
  async run([route, input, ...extra], { io, deps, auth }) {
    if (!route || extra.length) throw new AuthError(`Usage: ${usage.trim()}`, "usage");

    const [path] = route.split("?", 1);
    if (
      !path ||
      path.split("/").some((segment) => !segment || /^(?:\.|%2e){1,2}$/i.test(segment)) ||
      !/^[-a-z0-9._~%/]+$/i.test(path) ||
      /%2f|%5c/i.test(path) ||
      route.includes("#") ||
      /\s/.test(route)
    )
      throw new AuthError("Use a route relative to /api/v1/.", "usage");

    if (input === "-" && !deps.readStdin && process.stdin.isTTY)
      throw new AuthError("Pipe or redirect a JSON body to stdin.", "usage");

    let body = input ?? "{}";
    if (input === "-") {
      try {
        body = deps.readStdin
          ? await deps.readStdin()
          : new TextDecoder("utf-8", { fatal: true }).decode(await Bun.stdin.arrayBuffer());
      } catch {
        throw new AuthError("Could not read a valid UTF-8 JSON body from stdin.", "usage");
      }
    }
    try {
      JSON.parse(body);
    } catch {
      throw new AuthError("Request body must be valid JSON.", "usage");
    }

    const client = await createRawApiClient({ ...auth, fetch: deps.fetch ?? auth.fetch });
    const result = await client.request<string>(`/api/v1/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (result) io.out(result.endsWith("\n") ? result : `${result}\n`);
    return 0;
  },
} satisfies Command;

async function createRawApiClient(io: ArmadaApiIo) {
  const { origin, timeoutMs, token, renewToken } = await authenticatedSession(io, { safeRefreshErrors: true });
  const rawResponses = new WeakMap<object, Pick<Response, "text">>();
  return commandClient(
    origin,
    {
      fetch: async (input, options) => {
        const response = await io.fetch(input, { ...options, ...{ timeout: false } });
        if (response.ok && response.body) rawResponses.set(response, response.clone());
        return response;
      },
      token,
      timeoutMs,
      invalidPath: (error) => {
        throw new AuthError(error.message, "usage");
      },
      ...(renewToken ? { renewToken } : {}),
    },
    (result) => {
      if (result.kind === "transport")
        throw new AuthError(
          result.timedOut ? "Armada API request timed out." : "Armada could not reach the server.",
          "unavailable",
        );
      const { response, payload, bodyReadFailed } = result;
      if (!response.ok) {
        const error =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>).error
            : undefined;
        const rawMessage =
          error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
            ? ((error as Record<string, unknown>).message as string).trim()
            : "";
        const serverCode =
          response.status === 401
            ? "unauthorized"
            : result.failure?.serverCode && result.failure.serverCode.length <= 80
              ? result.failure.serverCode
              : "api_error";
        throw new ArmadaApiError(
          serverCode,
          response.status,
          rawMessage
            ? `${rawMessage} (HTTP ${response.status})`
            : `Armada API request failed (HTTP ${response.status}).`,
        );
      }
      if (bodyReadFailed) throw new AuthError("Armada API response could not be read.", "unavailable");
      if (response.status === 204 || response.status === 205) return "";
      return rawJsonText(rawResponses.get(response), payload);
    },
  );
}

async function rawJsonText(response: Pick<Response, "text"> | undefined, payload: unknown) {
  let text: string | undefined;
  try {
    text = await response?.text();
  } catch {
    throw new AuthError("Armada API response could not be read.", "unavailable");
  }
  if (!text || (payload === null && !/^[\t\n\r ]*null[\t\n\r ]*$/.test(text)))
    throw new AuthError("Armada API response was not valid JSON.", "unavailable");
  return text;
}
