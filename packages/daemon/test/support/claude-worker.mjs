import { createInterface } from "node:readline";

const emit = (value) => console.log(JSON.stringify(value));
emit({ type: "system", subtype: "init" });
let held = false;
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const content = JSON.parse(line).message.content;
  if (held) {
    emit({ type: "result", result: "reply:hold" });
    held = false;
  }
  emit({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  if (content === "hold") held = true;
  if (content === "auth-error") emit({ type: "result", is_error: true, errors: ["Authentication unavailable"] });
  else if (content !== "hold") emit({ type: "result", result: `reply:${content}` });
});
