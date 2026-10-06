/**
 * The command was understood but the tracker state forbids it (exit code 1).
 * `next` is the one command to run next, printed after the reason.
 */
export class Refusal extends Error {
  override name = "Refusal";
  constructor(
    message: string,
    readonly next: string,
    readonly transient = false,
    readonly paused = false,
  ) {
    super(message);
  }
}
