import { z } from "zod";
import { requestSchema, versionSchema } from "./envelope.js";

export const PROJECTS_MINOR = 12;
const text = z.string().trim().min(1).max(4096);
const identifier = z.string().trim().min(1).max(200);
const request = { version: versionSchema, id: identifier };
export const projectSchema = z.object({ id: identifier, name: text, repository: text, root: text.optional() });
export type Project = z.infer<typeof projectSchema>;
function addProjectInput() {
  return z.object({
    path: text,
    id: identifier.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: text,
    repository: text
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .refine((value) => value.split("/").every((part) => part !== "." && part !== "..")),
    programRoot: identifier.optional(),
    phaseGroup: identifier.optional(),
  });
}
export const addProjectInputSchema = /* @__PURE__ */ addProjectInput();
export type AddProjectInput = z.infer<typeof addProjectInputSchema>;
export const inspectProjectRequestSchema = /* @__PURE__ */ requestSchema("projects.inspect", { path: text });
// `id` is always the request correlation; projectId is the confirmed project's id.
function addProjectRequest() {
  return addProjectInputSchema.omit({ id: true }).extend({
    ...request,
    type: z.literal("projects.add"),
    projectId: addProjectInputSchema.shape.id,
  });
}
export const addProjectRequestSchema = /* @__PURE__ */ addProjectRequest();
export const removeProjectRequestSchema = /* @__PURE__ */ requestSchema("projects.remove", { project: identifier });
export const projectInspectionSchema = z.object({
  path: text,
  git: z.object({ remote: text.optional(), branch: text.optional(), clean: z.boolean() }).nullable(),
  toml: z
    .object({
      programRoot: text.optional(),
      phaseGroup: text.optional(),
      runtimeGroup: text.optional(),
      readyLabel: text.optional(),
      repository: text.optional(),
    })
    .nullable(),
  suggested: z.object({ id: identifier, name: text, repository: text.optional(), programRoot: text.optional() }),
  problems: z.array(z.string()),
});
export const projectsInspectionSchema = projectInspectionSchema.extend({
  ...request,
  type: z.literal("projects.inspection"),
});
export type ProjectInspection = z.infer<typeof projectInspectionSchema>;
export type ProjectsInspection = z.infer<typeof projectsInspectionSchema>;
export const projectRequestSchemas = [
  inspectProjectRequestSchema,
  addProjectRequestSchema,
  removeProjectRequestSchema,
] as const;
export type ProjectRequest = z.infer<(typeof projectRequestSchemas)[number]>;
