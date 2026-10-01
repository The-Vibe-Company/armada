// The live route's answer (THE-853): the overview with an ETag, or 304 when
// the viewer already has it. The tag covers everything but the time the
// overview was built, so a poll that finds nothing new costs a few bytes.
// The live timeline's history (a day of reports per session) is not part of
// it: /api/fleet/timeline serves it, read only while the timeline is on
// screen (THE-880).
import { createHash } from "node:crypto";
import type { FleetOverview, FleetTimeline } from "@armada/core/read";

// Private data: never stored by a cache; the page sends the tag it holds itself.
const HEADERS = { "Cache-Control": "no-store" };

/** The ETag of a JSON answer: what `answerJson` sends, and what a page rendered with it already holds. */
export const jsonTag = (content: unknown) =>
  `"${createHash("sha256").update(JSON.stringify(content)).digest("base64url").slice(0, 27)}"`;

export function overviewTag(overview: FleetOverview): string {
  const { generatedAt: _, ...content } = overview;
  return jsonTag(content);
}

/** 304 when `If-None-Match` names `tag`, else `body`. */
function answerTagged(request: Request, body: unknown, tag: string): Response {
  const known = (request.headers.get("if-none-match") ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (known.includes(tag)) return new Response(null, { status: 304, headers: { ...HEADERS, ETag: tag } });
  return Response.json(body, { headers: { ...HEADERS, ETag: tag } });
}

/** The overview a page renders and polls: everything but the timeline's history. */
export function withoutTimeline(overview: FleetOverview): FleetOverview {
  const { timeline: _, ...live } = overview;
  return live;
}

/** 304 when `If-None-Match` names the overview's tag, else the overview, without the timeline's history. */
export function answerOverview(request: Request, overview: FleetOverview): Response {
  const live = withoutTimeline(overview);
  return answerTagged(request, live, overviewTag(live));
}

/** The timeline's history, tagged on its own: 304 while no row or coordinator moved. */
export function answerTimeline(request: Request, overview: FleetOverview): Response {
  const timeline: FleetTimeline = overview.timeline ?? { rows: [], coordinators: [] };
  return answerJson(request, timeline);
}

/** The same for any read an agent's page polls (its activity): tagged by its whole content. */
export function answerJson(request: Request, body: unknown): Response {
  return answerTagged(request, body, jsonTag(body));
}

/**
 * The answer of a polled route with its time on the server (THE-892): a
 * `Server-Timing` header for the browser, and one log line, `armada timing
 * <route> <status> <ms>ms`, from which the deployment's logs give the p75.
 */
export async function timed(
  route: string,
  answer: () => Promise<Response>,
  now: () => number = () => performance.now(),
  log: (line: string) => void = console.info,
): Promise<Response> {
  const start = now();
  const response = await answer();
  const ms = now() - start;
  response.headers.set("Server-Timing", `app;dur=${ms.toFixed(1)}`);
  log(`armada timing ${route} ${response.status} ${Math.round(ms)}ms`);
  return response;
}
