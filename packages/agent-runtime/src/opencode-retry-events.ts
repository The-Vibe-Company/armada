// Keep the driver-facing module separate so driver fixture mocks cannot replace the wire-test subject.
export { createOpenCodeRetryObserver } from "./opencode-retry-observer.ts";
