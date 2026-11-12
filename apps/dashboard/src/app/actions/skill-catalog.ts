"use server";

import type { SkillCatalogPage, SkillCatalogSource } from "@armada/core";
import { ControlError, createControlClient } from "@/lib/control";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { mcpUrl } from "@/lib/env";
import { parseSkillCatalogPage, parseSkillVersions, skillPinProblem } from "@/lib/skills";

type Failure = { ok: false; error: string; code?: string };

async function catalogClient(org: string) {
  const viewer = await requireViewer();
  if (!(await isSelectedOrganization(org))) throw new ControlError("Switch to that organization first.");
  const serverUrl = mcpUrl();
  if (!serverUrl || !viewer.token) throw new ControlError("The Armada server is not configured for this dashboard.");
  return createControlClient({ serverUrl, token: viewer.token });
}

function failure(error: unknown): Failure {
  if (!(error instanceof ControlError)) throw error;
  // Known control errors are value-free. Never expose unexpected server-action exceptions.
  return { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) };
}

export async function listSkillCatalog(input: {
  org: string;
  source: SkillCatalogSource;
  offset?: number;
}): Promise<{ ok: true; page: SkillCatalogPage } | Failure> {
  if (
    !input ||
    typeof input.org !== "string" ||
    (input.source !== "private" && input.source !== "public") ||
    (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 10_000))
  )
    return { ok: false, error: "That skill catalog request is not valid." };
  try {
    const control = await catalogClient(input.org);
    const page = parseSkillCatalogPage(
      await control.post<unknown>("skillpack/catalog", input),
      input.source,
      input.offset ?? 0,
    );
    return page
      ? { ok: true, page }
      : { ok: false, error: "The skill catalog sent an unreadable response. Enter an exact pin or try again." };
  } catch (error) {
    return failure(error);
  }
}

export async function listSkillVersions(input: {
  org: string;
  source: SkillCatalogSource;
  reference: string;
}): Promise<{ ok: true; versions: string[] } | Failure> {
  if (
    !input ||
    typeof input.org !== "string" ||
    typeof input.reference !== "string" ||
    (input.source !== "private" && input.source !== "public") ||
    input.reference.includes("/") !== (input.source === "public") ||
    skillPinProblem([`${input.reference}@1.0.0`])
  )
    return { ok: false, error: "That skill reference is not valid." };
  try {
    const control = await catalogClient(input.org);
    const versions = parseSkillVersions(
      await control.post<unknown>("skillpack/versions", input),
      input.source,
      input.reference,
    );
    return versions
      ? { ok: true, versions }
      : { ok: false, error: "Skill versions could not be read. You can enter an exact pin instead." };
  } catch (error) {
    return failure(error);
  }
}
