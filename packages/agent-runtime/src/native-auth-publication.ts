import type { RunnerExecutionOptions } from "./protocol.ts";

type NativeAuthPublication = Pick<RunnerExecutionOptions, "refreshNativeSecrets" | "publishNativeAuth">;

/** A no-inference handshake can rotate credentials; publish even on failure before acknowledging. */
export function withNativeAuthPublication<T>(execution: NativeAuthPublication, resume: () => Promise<T>): Promise<T> {
  // Read hooks from the original execution object, retaining their receiver and current values.
  const refresh = () => {
    const callback = Reflect.get(execution, "refreshNativeSecrets");
    if (callback === undefined) return;
    if (typeof callback !== "function" || Reflect.apply(callback, execution, []) !== undefined)
      throw Error("native_auth_state_unacknowledged");
  };
  const publish = async () => {
    const callback = Reflect.get(execution, "publishNativeAuth");
    if (callback === undefined) return;
    if (typeof callback !== "function") throw Error("native_auth_state_unacknowledged");
    await Reflect.apply(callback, execution, []);
  };
  return Promise.resolve().then(async () => {
    try {
      refresh();
    } catch {
      throw Error("native_auth_state_unacknowledged");
    }
    const outcome = await Promise.resolve()
      .then(resume)
      .then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );
    try {
      refresh();
      await publish();
    } catch {
      throw Error("native_auth_state_unacknowledged");
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  });
}
