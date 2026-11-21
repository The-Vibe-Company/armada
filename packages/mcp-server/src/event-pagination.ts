import { type Provider, ProviderError, VaultError } from "@armada/core";

import { MAX_LOG_PAGES } from "@armada/core/contract";

type Page = Awaited<ReturnType<Provider["events"]>>;
type ReadPage = (cursor: string | undefined) => Promise<Page>;

export class NativeOutputPending extends ProviderError {
  constructor(provider: Provider["id"]) {
    super({
      provider,
      code: "unavailable",
      retryable: true,
      message: "Native output synchronization is pending. Retry after the current operation finishes.",
    });
  }
}

export function validateLogPagination({ direction, all }: { direction?: unknown; all?: unknown }): void {
  if (direction === "backward" && all === true)
    throw new VaultError("invalid", "Backward reads cannot drain all pages.");
}

/** Bounded traversal only; callers retain authorization, request projection and response policy. */
export async function readEventPages(
  read: ReadPage,
  cursor: string | undefined,
  all: boolean,
  { pauseOnNativeLease = false }: { pauseOnNativeLease?: boolean } = {},
) {
  const events: Page["events"] = [];
  let hasMore = false;
  let paused = false;
  let source: Page["source"];
  let runtimeFailure: Page["runtimeFailure"];
  let olderCursor: string | undefined;
  for (let pageNumber = 0; pageNumber < (all ? MAX_LOG_PAGES : 1); pageNumber += 1) {
    let page: Page;
    try {
      page = await read(cursor);
    } catch (error) {
      if (!pauseOnNativeLease || !(error instanceof NativeOutputPending)) throw error;
      paused = true;
      break;
    }
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
  return { events, cursor: cursor ?? null, hasMore, source, runtimeFailure, olderCursor, paused };
}
