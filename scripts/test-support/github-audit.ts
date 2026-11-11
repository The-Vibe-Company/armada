import { afterEach, beforeEach, spyOn } from "bun:test";

/** Capture credential audit records without silencing unrelated test diagnostics. */
export function captureGitHubAuditLogs(): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  let restore: (() => void) | undefined;
  beforeEach(() => {
    events.length = 0;
    const original = console.info;
    const log = spyOn(console, "info").mockImplementation((...args) => {
      if (typeof args[0] === "string") {
        try {
          const event = JSON.parse(args[0]);
          if (typeof event?.event === "string" && /^github_(token_|connection_)/.test(event.event)) {
            events.push(event);
            return;
          }
        } catch {
          /* Non-JSON diagnostics retain their normal output. */
        }
      }
      original(...args);
    });
    restore = () => log.mockRestore();
  });
  afterEach(() => restore?.());
  return events;
}
