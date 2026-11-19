import { AuthError } from "@armada/auth";
import { createArmadaApiClient } from "../armada-api.ts";
import type { Command } from "./command.ts";

const usage = "  armada api ROUTE [JSON|-]";

export default {
  name: "api",
  summary: "Call a versioned Armada API route",
  usage,
  help: `Usage: ${usage.trim()}
POST to /api/v1/ROUTE using the selected Armada login and print the JSON response.
Pass the route relative to /api/v1/. With no body argument, send {}.
Pass - to read JSON from a pipe or redirected file. Use stdin for bodies that contain secrets.
Treat stdout as sensitive if the endpoint returns credentials.
Example: armada api org/list
`,
  useSelectedOrg: false,
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

    let body: string;
    try {
      body = input === "-" ? await (deps.readStdin ?? (() => Bun.stdin.text()))() : (input ?? "{}");
    } catch {
      throw new AuthError("Could not read the JSON body from stdin.", "usage");
    }
    try {
      JSON.parse(body);
    } catch {
      throw new AuthError("Request body must be valid JSON.", "usage");
    }

    const client = await createArmadaApiClient({ ...auth, fetch: deps.fetch ?? auth.fetch }, { rawJson: true });
    const result = await client.request<string>(`/api/v1/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (result) io.out(result.endsWith("\n") ? result : `${result}\n`);
    return 0;
  },
} satisfies Command;
