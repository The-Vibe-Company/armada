import { z } from "zod";
import { readLogsErrors } from "./failures.ts";
import type { Operation } from "./index.ts";
import { LOGS_OUTPUT } from "./sandbox.ts";

export const MAX_LOG_PAGES = 100;

const versions = z
  .record(z.string(), z.union([z.number(), z.boolean(), z.string()]))
  .describe("Server feature versions for this provider path. Clients must tolerate unknown keys.");

const launchOptionsOutput = z
  .object({
    harnesses: z.array(
      z
        .object({
          id: z.string(),
          credentialKinds: z.array(z.string()),
          defaultModel: z.string(),
          defaultReasoningEffort: z.string(),
          reasoningEfforts: z.array(z.string()),
          models: z.array(
            z.object({ id: z.string(), label: z.string(), reasoningEfforts: z.array(z.string()) }).passthrough(),
          ),
        })
        .passthrough(),
    ),
    machineSizes: z.array(z.string()),
    ttl: z
      .object({ defaultSeconds: z.number(), maxSeconds: z.record(z.string(), z.number()) })
      .passthrough()
      .describe("Launch TTL default and per-provider maximums, in seconds."),
    providers: z.array(
      z
        .object({
          id: z.string(),
          enabled: z.boolean(),
          launchSources: z
            .array(z.string())
            .describe(
              '"golden" uses a snapshot (by name on Boat or Modal, by ID on Docker); "image" launches directly on a Docker host.',
            ),
          harnesses: z.array(z.string()),
          capabilities: z.record(z.string(), z.boolean()),
          unsupportedReasons: z.record(z.string(), z.string()),
        })
        .passthrough(),
    ),
    modalRuntime: versions.optional(),
    dockerRuntime: versions.optional(),
    boatRuntime: versions,
  })
  .passthrough();

export const launchOptionsOperation = {
  name: "launchOptions",
  toolName: "launch_options",
  route: { method: "POST", path: "/api/v1/launch/options" },
  input: { body: z.object({}) },
  output: launchOptionsOutput,
  readOnly: true,
  destructive: false,
  audience: "agent",
  description:
    "What a launch can ask for on this server: harnesses with their models and credential kinds, machine sizes, TTL limits, and each provider's launch sources and capabilities. The MCP launch tool accepts Boat and Modal snapshots. Read this catalog before offering launch choices.",
  errors: ["invalid", "unauthorized", "dependency_unavailable", "internal"],
} as const satisfies Operation<z.ZodType, z.ZodType>;

const paginationNumber = z
  .unknown()
  .refine((input): input is number => typeof input === "number", { error: "Invalid event pagination." })
  .meta({ type: "number" });

export const readLogsOperation = {
  name: "readLogs",
  toolName: "logs",
  mcpDescription:
    "The agent's events oldest first: prompts (with status and failure reason), messages and tool calls, " +
    "steers. The default is one bounded page (100 events). Set all to read every available page (up to " +
    `${MAX_LOG_PAGES} pages) in one response. Pass the returned cursor as since_cursor to read only what is new. ` +
    "An event read twice has the same id and the newer body; each id appears once per response.",
  route: { method: "POST", path: "/api/v1/logs/read" },
  input: {
    body: z.object({
      id: z
        .string({ error: ({ input }) => (input == null ? "id is required." : "id must be text.") })
        .describe("Armada sandbox ID returned by launch and list."),
      org: z.string({ error: "org must be text." }).nullish(),
      direction: z.enum(["forward", "backward"], { error: "Invalid event direction." }).optional(),
      limit: paginationNumber.optional().describe("Events per page, an integer from 1 to 1000 (up to 500 on Docker)."),
      maxBytes: paginationNumber.optional().describe("Page byte budget, an integer from 256 to 1048576."),
      coalesce: z.boolean({ error: "Invalid coalesce option." }).optional(),
      cursor: z
        .string({ error: "cursor must be text." })
        .nullish()
        .describe("The cursor of the previous page. Docker requires a nonempty string when provided."),
      all: z.boolean().optional().describe(`Read up to ${MAX_LOG_PAGES} pages. Use forward direction only.`),
      follow: z.boolean().optional().describe("Follow events within the bounded HTTP request."),
    }),
  },
  output: z.object(LOGS_OUTPUT).passthrough(),
  readOnly: true,
  destructive: false,
  audience: "agent",
  description:
    "Read the agent's events, oldest first. The default is one bounded page. Pass the returned cursor as cursor to read only what is new.",
  errors: readLogsErrors,
} as const satisfies Operation<z.ZodType, z.ZodType>;
