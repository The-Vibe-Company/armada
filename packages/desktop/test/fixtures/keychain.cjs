// Load the real platform binding before selecting the macOS adapter on Linux CI.
// Stub only the OS read: never read or write the developer's saved credentials.
const { AsyncEntry } = require("@napi-rs/keyring");
AsyncEntry.prototype.getPassword = async () => null;
Object.defineProperty(process, "platform", { value: "darwin" });
globalThis.fetch = async () => {
  throw new Error("offline fixture");
};
