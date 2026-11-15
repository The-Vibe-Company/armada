// Bun mocks propagate through live re-exports. Inject fixture dependencies instead of mocking this module.
export { createOpenCodeRetryObserver } from "./opencode-retry-observer.ts";
