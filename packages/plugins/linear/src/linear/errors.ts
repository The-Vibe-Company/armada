export class LinearReadError extends Error {}

export class LinearRateLimitError extends LinearReadError {
  readonly until: string;
  constructor(until: string) {
    super(`Linear paused by its rate limit until ${until}`);
    this.until = until;
  }
}
