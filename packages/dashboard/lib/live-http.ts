// The live route's answer (THE-853): the overview with an ETag, or 304 when
// the viewer already has it. The tag covers everything but the time the
// overview was built, so a poll that finds nothing new costs a few bytes.
import { createHash } from "node:crypto";
import type { FleetOverview } from "@armada/core/read";

// Private data: never stored by a cache; the page sends the tag it holds itself.
const HEADERS = { "Cache-Control": "no-store" };

const tagOf = (content: unknown) =>
  `"${createHash("sha256").update(JSON.stringify(content)).digest("base64url").slice(0, 27)}"`;

export function overviewTag(overview: FleetOverview): string {
  const { generatedAt: _, ...content } = overview;
  return tagOf(content);
}

/** 304 when `If-None-Match` names `tag`, else `body`. */
function answerTagged(request: Request, body: unknown, tag: string): Response {
  const known = (request.headers.get("if-none-match") ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (known.includes(tag)) return new Response(null, { status: 304, headers: { ...HEADERS, ETag: tag } });
  return Response.json(body, { headers: { ...HEADERS, ETag: tag } });
}

/** 304 when `If-None-Match` names the overview's tag, else the overview. */
export function answerOverview(request: Request, overview: FleetOverview): Response {
  return answerTagged(request, overview, overviewTag(overview));
}

/** The same for any read an agent's page polls (its activity): tagged by its whole content. */
export function answerJson(request: Request, body: unknown): Response {
  return answerTagged(request, body, tagOf(body));
}
