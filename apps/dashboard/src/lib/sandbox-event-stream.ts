import { streamSandboxEvents } from "@armada/core/contract";

export function createSandboxEventReader(sandboxId: string, request = fetch) {
  let lastAppliedId: string | null = null;
  return async function readSandboxEventStream(
    signal: AbortSignal,
    apply: () => Promise<boolean>,
    connected: () => void,
  ) {
    const { route, outputMediaType } = streamSandboxEvents;
    const query = new URLSearchParams({ sandbox: sandboxId });
    const headers = new Headers({ accept: outputMediaType });
    if (lastAppliedId !== null) headers.set("Last-Event-ID", lastAppliedId);
    const response = await request(`${route.path}?${query}`, { headers, cache: "no-store", signal });
    if (!response.ok) {
      await response.body?.cancel();
      return response.status;
    }
    if (!response.body || response.headers.get("content-type")?.split(";")[0] !== outputMediaType) {
      await response.body?.cancel();
      throw new Error("The server returned an invalid sandbox stream.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done || signal.aborted) break;
        pending += decoder.decode(chunk.value, { stream: true });
        const boundary = pending.lastIndexOf("\n\n");
        if (boundary < 0) {
          if (pending.length > 4096) throw new Error("The sandbox event frame is too large.");
          continue;
        }
        const frames = pending.slice(0, boundary).split("\n\n");
        pending = pending.slice(boundary + 2);
        let newest = lastAppliedId;
        for (const frame of frames) {
          if (frame.startsWith(":")) {
            if (frame === ": heartbeat") connected();
            continue;
          }
          const match = /^id: ([0-9]+)\ndata: (.+)$/.exec(frame);
          if (!match) throw new Error("The server returned an invalid sandbox event.");
          const event = streamSandboxEvents.output.parse(JSON.parse(match[2]!));
          if (event.id !== match[1] || event.sandboxId !== sandboxId) {
            throw new Error("The server returned an unrelated sandbox event.");
          }
          if (newest === null || BigInt(event.id) > BigInt(newest)) newest = event.id;
        }
        if (newest !== null && newest !== lastAppliedId) {
          if (!(await apply())) break;
          lastAppliedId = newest;
          connected();
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return null;
  };
}
