import { OUTPUT_DIRECTORY } from "@armada/core";
import { OutputCollectionError, readOutputArchive } from "@armada/core/server";

export const RETAINED_OUTPUT_PATH = OUTPUT_DIRECTORY.slice(1);

export function readRetainedOutputArchive(response: Response, signal: AbortSignal) {
  if (
    response.status !== 200 ||
    response.headers.get("x-snapshot-entry-kind") !== "dir" ||
    response.headers.get("x-snapshot-skipped-base-image-files") !== "0"
  ) {
    void response.body?.cancel().catch(() => {});
    throw new OutputCollectionError("output_unavailable");
  }
  return readOutputArchive(response.body, signal, {
    fileCount: response.headers.get("x-snapshot-file-count"),
    fileBytes: response.headers.get("x-snapshot-total-size-bytes"),
  });
}
