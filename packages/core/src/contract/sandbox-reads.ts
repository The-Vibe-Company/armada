import { z } from "zod";
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
            .describe('"golden" launches by golden name; "image" launches on a Docker host.'),
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
  route: { method: "POST", path: "/api/v1/launch/options" },
  input: { body: z.object({}) },
  output: launchOptionsOutput,
  readOnly: true,
  destructive: false,
  audience: "agent",
  description:
    "What a launch can ask for on this server: harnesses with their models and credential kinds, machine sizes, TTL limits, and each provider's launch sources and capabilities. Read it before offering launch choices.",
  errors: ["invalid", "unauthorized", "unavailable"],
} as const satisfies Operation<z.ZodType, z.ZodType>;

export const readLogsOperation = {
  name: "readLogs",
  route: { method: "POST", path: "/api/v1/logs/read" },
  input: {
    body: z.object({
      id: z
        .string({ error: ({ input }) => (input == null ? "id is required." : "id must be text.") })
        .describe("Armada sandbox ID returned by launch and list."),
      org: z.string({ error: "org must be text." }).nullish(),
      direction: z.enum(["forward", "backward"], { error: "Invalid event direction." }).optional(),
      limit: z
        .number({ error: "Invalid event pagination." })
        .optional()
        .describe("Docker requires an integer from 1 to 500."),
      maxBytes: z.number({ error: "Invalid event pagination." }).optional(),
      coalesce: z.boolean({ error: "Invalid coalesce option." }).optional(),
      cursor: z.string({ error: "cursor must be text." }).nullish().describe("The cursor of the previous page."),
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
  errors: [
    "invalid",
    "invalid_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "unavailable",
    "dependency_unavailable",
    "provider_mismatch",
    "provider_routing_unavailable",
    "rate_limited",
    "internal",
  ],
} as const satisfies Operation<z.ZodType, z.ZodType>;
