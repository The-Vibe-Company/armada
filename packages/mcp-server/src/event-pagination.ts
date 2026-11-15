import type { Provider } from "@armada/core";

type Page = Awaited<ReturnType<Provider["events"]>>;
type ReadPage = (cursor: string | undefined) => Promise<Page>;
export const MAX_LOG_PAGES = 100;

/** Bounded traversal only; callers retain authorization, request projection and response policy. */
export async function readEventPages(read: ReadPage, cursor: string | undefined, all: boolean) {
  const events: Page["events"] = [];
  let hasMore = false;
  let source: Page["source"];
  let runtimeFailure: Page["runtimeFailure"];
  let olderCursor: string | undefined;
  for (let pageNumber = 0; pageNumber < (all ? MAX_LOG_PAGES : 1); pageNumber += 1) {
    const page = await read(cursor);
    if (page.source) source = page.source;
    runtimeFailure = page.runtimeFailure ?? runtimeFailure;
    olderCursor = page.olderCursor;
    events.push(...page.events);
    hasMore = page.hasMore;
    const next = page.cursor ?? cursor;
    if (!page.hasMore || !next || next === cursor) {
      cursor = next;
      break;
    }
    cursor = next;
  }
  return { events, cursor: cursor ?? null, hasMore, source, runtimeFailure, olderCursor };
}
