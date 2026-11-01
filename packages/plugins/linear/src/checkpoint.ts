import { activePhaseSchema, readerUsageSchema } from "@armada/protocol";
import { z } from "zod";

const status = z.enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"]);
const readingSchema = z.object({
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().optional(),
  tickets: z.array(
    z.object({
      uuid: z.string().min(1),
      id: z.string().min(1),
      title: z.string(),
      description: z.string().optional(),
      branchName: z.string().optional(),
      blockers: z.array(z.object({ id: z.string(), status })).optional(),
      status,
      phase: activePhaseSchema.nullable(),
      owner: z.string().nullable(),
      parent: z.string().nullable(),
      url: z.string(),
      labels: z.array(z.string()),
      attachments: z.array(z.object({ title: z.string(), url: z.string() })),
    }),
  ),
  comments: z.array(
    z.object({
      id: z.string(),
      ticket: z.string(),
      body: z.string(),
      author: z.string(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    }),
  ),
});

/** Usage-only checkpoints cannot erase the last successfully completed cursor. */
export const linearReaderCheckpointSchema = z.object({
  format: z.literal("armada.linear-reader"),
  version: z.literal(1),
  source: z.string(),
  quota: z.string(),
  cursor: z
    .object({
      reading: readingSchema,
      fullReadAt: z.iso.datetime(),
      replace: z.boolean(),
      removedTickets: z.array(z.string()),
      removedComments: z.array(z.string()),
    })
    .optional(),
  usage: readerUsageSchema.optional(),
});
