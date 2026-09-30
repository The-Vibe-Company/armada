import { recordedFetch } from "../../../core/test/support.ts";

globalThis.fetch = recordedFetch({
  linear: (recorded) => {
    const root = recorded.Root[0]?.data.issue;
    if (root) root.title = "café 🌊\n".repeat(50_000);
  },
}).fetch as typeof fetch;
