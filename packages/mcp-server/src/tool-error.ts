export class ToolError extends Error {
  override readonly name = "ToolError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
