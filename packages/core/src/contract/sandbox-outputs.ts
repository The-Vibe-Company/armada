import { z } from "zod";
import {
  OUTPUT_DIRECTORY,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_FILE_BYTES,
  OUTPUT_MAX_FILES,
  OUTPUT_MAX_ORG_BYTES,
  OUTPUT_MAX_SANDBOX_BYTES,
  validOutputName,
} from "../sandbox-output-limits.ts";
import type { Operation } from "./index.ts";

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const name = z.string().min(1).refine(validOutputName);
const range = z.string().regex(/^bytes=(?:\d+-\d*|-\d+)$/);
const access =
  " Only the sandbox owner or an org admin can read it, the sandbox must not be deleted or application-secret tainted, and stopped compute is never read: the last snapshot taken while compute was live is served. See docs/sandbox-outputs.md.";
const errors = ["unauthorized", "not_found", "Use GET"] as const;
const binary = "application/octet-stream";

export const MCP_OUTPUT_MAX_BYTES = OUTPUT_MAX_BYTES;

export const sandboxOutputOperations = {
  listSandboxOutputs: {
    name: "listSandboxOutputs",
    toolName: "outputs_list",
    route: { method: "GET", path: "/api/v1/sandboxes/{id}/outputs" },
    input: { body: z.undefined(), path: { id } },
    output: z.strictObject({
      directory: z.string().describe("The declared outputs directory in the sandbox."),
      limits: z.strictObject({
        maxFiles: z.literal(OUTPUT_MAX_FILES),
        maxFileBytes: z.literal(OUTPUT_MAX_FILE_BYTES),
        maxSandboxBytes: z.literal(OUTPUT_MAX_SANDBOX_BYTES),
        maxOrgBytes: z.literal(OUTPUT_MAX_ORG_BYTES),
      }),
      unavailable: z.literal("collector_unsupported").optional(),
      files: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(255),
            size: z.int().min(0),
            sha256: z.string().nullable().describe("Hex SHA-256 digest of the file bytes. Null for skipped files."),
            skipped: z.enum(["too_large", "sandbox_limit", "org_limit"]).optional(),
            updatedAt: z.iso.datetime({ offset: true }),
          }),
        )
        .max(OUTPUT_MAX_FILES),
    }),
    readOnly: true,
    destructive: false,
    audience: "agent",
    description: `The files of the sandbox's last output snapshot, from its declared outputs directory (${OUTPUT_DIRECTORY} on every provider), in name order.${access} A sandbox.output.available webhook names a new or changed file.`,
    errors,
    errorOutput: z.object({ error: z.enum(errors) }),
  },
  readSandboxOutput: {
    name: "readSandboxOutput",
    toolName: "output_read",
    mcpDescription: `Read one file of the sandbox's last output snapshot as base64 (up to ${MCP_OUTPUT_MAX_BYTES} bytes). For larger files, use the REST download.${access}`,
    mcpOutput: z.strictObject({ base64: z.string() }),
    route: { method: "GET", path: "/api/v1/sandboxes/{id}/outputs/{name}" },
    input: { body: z.undefined(), path: { id, name }, headers: { Range: range, "If-Range": z.string() } },
    output: z.instanceof(ReadableStream).nullable(),
    outputMediaType: binary,
    readOnly: true,
    destructive: false,
    audience: "agent",
    description: `Download one file of the sandbox's last output snapshot as an attachment.${access}`,
    errors: [...errors, "invalid_name", "unavailable"],
    errorOutput: z.object({ error: z.enum([...errors, "invalid_name", "unavailable"]) }),
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType> & { mcpOutput?: z.ZodObject }>;
