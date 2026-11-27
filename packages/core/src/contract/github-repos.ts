import { z } from "zod";
import { GITHUB_SLUG_PATTERN } from "../github.ts";
import type { Operation } from "./index.ts";

const slug = z.string().trim().min(1).max(100).regex(GITHUB_SLUG_PATTERN);
const posInt = z.number().int().positive();
const scope = {
  accountLogin: slug,
  accountType: z.enum(["User", "Organization"]),
  repositorySelection: z.enum(["all", "selected"]),
};

export const githubReposRequest = z.strictObject({
  account: slug.optional(),
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export const githubReposResponse = z.strictObject({
  installations: z.array(z.strictObject({ id: posInt, appId: posInt, appSlug: slug, ...scope })),
  repositories: z.array(
    z.strictObject({
      id: posInt,
      owner: slug,
      name: z.string().min(1).max(200),
      fullName: z.string().min(1).max(301),
      private: z.boolean(),
      defaultBranch: z.string().min(1).max(255),
      installationId: posInt,
      archived: z.boolean(),
      pushedAt: z.string().nullable(),
      ...scope,
    }),
  ),
  truncated: z.boolean(),
});
export const githubReposOperation = {
  name: "listGitHubRepos",
  route: { method: "POST", path: "/api/v1/github/repos" },
  audience: "admin",
  readOnly: true,
  destructive: false,
  scopedAuth: ["personalSession"],
  description: "List accessible GitHub repositories across connected GitHub App installations.",
  input: { body: githubReposRequest },
  output: githubReposResponse,
  successHeaders: { "Cache-Control": z.literal("no-store") },
  errors: ["invalid", "unauthorized", "forbidden", "unavailable", "internal"],
} as const satisfies Operation<typeof githubReposRequest, typeof githubReposResponse>;
export type GitHubReposRequest = z.input<typeof githubReposRequest>;
export type GitHubReposResponse = z.infer<typeof githubReposResponse>;
